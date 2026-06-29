// autosync.mjs
// ============================================================================
// Unattended auto-sync orchestrator (#4) — the single job Windows Task Scheduler
// runs every 5 min on 520. Each tick:
//   1. poll ESPN (espn-poll.mjs, read-only) for finished SIMULTANEOUS SETS
//   2. for each newly-complete set: append to manual-results.json
//   3. node build-html.mjs --refresh   (re-bake 200k, single source of truth)
//   4. cp dist/index.html docs/index.html  +  git commit + push   (LIVE site)
//   5. node sync-calendar.mjs  ->  node calendar-apply.mjs --apply (LIVE calendar)
//   6. notify David — FAILURE-ONLY (silent on success, so a score is never spoiled;
//      he watches late games on replay in the morning). A push fails / ESPN is
//      ambiguous / a set is partial-flagged  ->  THEN he gets pinged.
//
// SAFETY: dry-run is the default and writes/pushes NOTHING. The live path runs
// ONLY with BOTH --arm AND env AUTOSYNC_LIVE=1 (double gate) — neither is set
// while we watch it. Processed set keys are remembered in autosync-state.json
// (gitignored) so repeated 5-min ticks don't re-report the same finished set.
//
//   node autosync.mjs                 # one dry-run tick (default)
//   node autosync.mjs --refresh       # re-pull the feed first
//   node autosync.mjs --at <iso>      # simulate "now" (testing)
//   node autosync.mjs --reset         # forget processed sets
//   node autosync.mjs --arm           # (later) live; also needs AUTOSYNC_LIVE=1
// ============================================================================

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, copyFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { pollReport } from './espn-poll.mjs';
import { sendFailureEmail } from './notify.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, 'autosync-state.json');
const MANUAL_FILE = join(__dirname, 'manual-results.json');
const MANUAL_KO_FILE = join(__dirname, 'manual-ko-results.json');
const EVENTS_CACHE = join(__dirname, 'data', 'match-events.json');

async function loadState() {
  if (!existsSync(STATE_FILE)) return { processedSetKeys: [], lastRun: null };
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); }
  catch { return { processedSetKeys: [], lastRun: null }; }
}
async function saveState(s) { await writeFile(STATE_FILE, JSON.stringify(s, null, 2) + '\n'); }

const today = (now) => now.toISOString().slice(0, 10);

// Hour-of-day in New York (handles EDT/EST automatically).
function etHour(now) {
  const s = new Intl.DateTimeFormat('en-US',
    { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(now);
  return parseInt(s, 10) % 24;
}
// David's window: active from ~the first kickoff through the last game, hard-stop
// at 4am NY (past that, assume something broke and he handles it manually). No WC
// game kicks off before ~noon ET, so 4am-11am ET is the safe overnight OFF window.
// (The per-match "due at KO+115" gate is what actually opens polling each evening.)
const inDeadWindow = (now) => { const h = etHour(now); return h >= 4 && h < 11; };

/** Append finished-set results to manual-results.json (LIVE only). */
async function appendManualResults(matches, now) {
  const cur = JSON.parse(await readFile(MANUAL_FILE, 'utf8'));
  for (const m of matches) {
    cur.push({
      group: m.group, team1: m.team1, team2: m.team2, ft: m.ft,
      note: `Full time ${m.ft[0]}-${m.ft[1]}, auto-synced from ESPN fifa.world FT on ${today(now)}.`,
    });
  }
  await writeFile(MANUAL_FILE, JSON.stringify(cur, null, 2) + '\n');
}

/** One-line description of a KO deploy item (shared by commit msg + dry-run). */
const koLine = (d) => {
  const tag = d.decider === 'pens' ? ` (${d.pens[0]}-${d.pens[1]} pens)` : d.decider === 'aet' ? ' AET' : '';
  return `M${d.match} ${d.home} ${d.score[0]}-${d.score[1]} ${d.away}${tag} -> ${d.winner}`;
};

/** Append a finished KNOCKOUT result to manual-ko-results.json (LIVE only).
 *  Same shared shape the build + poller use; the (AET-blind) feed supersedes it
 *  next refresh, self-correcting any mis-entry exactly like the group path. */
async function appendKnockoutResult(d, now) {
  const cur = existsSync(MANUAL_KO_FILE)
    ? JSON.parse(await readFile(MANUAL_KO_FILE, 'utf8')) : [];
  cur.push({
    match: d.match, home: d.home, away: d.away,
    score: d.score, decider: d.decider, pens: d.pens,
    note: `${koLine(d)}, auto-synced from ESPN fifa.world FT on ${today(now)}.`,
  });
  await writeFile(MANUAL_KO_FILE, JSON.stringify(cur, null, 2) + '\n');
}

const sh = (cmd, args) =>
  execFileSync(cmd, args, { cwd: __dirname, stdio: 'inherit', shell: false });

/** Number of matches in the events cache (keys); -1 if unreadable. */
function eventCacheKeyCount() {
  try { return Object.keys(JSON.parse(readFileSync(EVENTS_CACHE, 'utf8'))).length; }
  catch { return -1; }
}

// How long we'll wait on the INLINE ESPN events fetch before deploying the score
// without it. The fetch is normally a few seconds (3 scoreboard days + 1 summary);
// the 200k bake that follows is ~90s, so a fast fetch is effectively free. If ESPN
// is slow/hung we kill it here and let the catch-up fallback backfill on a later
// tick — a score is NEVER materially delayed by events.
const EVENTS_TIMEOUT_MS = 20000;

/** INLINE, time-boxed, non-fatal events fetch folded into the score deploy. Pulls
 *  the just-finished match's goal scorers into the cache BEFORE the single bake, so
 *  the score + popover ship in ONE deploy. Returns the count of NEW matches cached
 *  (0 = not ready / skipped / errored — never throws, score still deploys). */
function fetchEventsInline(log) {
  const before = Math.max(0, eventCacheKeyCount());
  try {
    execFileSync('node', ['build-events.mjs'], {
      cwd: __dirname, stdio: 'inherit', shell: false, timeout: EVENTS_TIMEOUT_MS,
    });
  } catch (e) {
    log(`  events: inline fetch skipped (non-fatal, score still deploys): ${e.message || e}`);
    return 0;
  }
  return Math.max(0, eventCacheKeyCount()) - before;
}

// --- Pages publish verification + self-heal ---------------------------------
// GitHub's Pages "deploy" job occasionally FLAKES: the build job succeeds and our
// `git push` is happy, but the deploy job fails and Pages keeps serving the PRIOR
// artifact — so the live site goes stale while the calendar (a separate REST sink)
// is correctly updated. git can't see this. So after each score push we VERIFY the
// live site actually carries the artifact we just built (matched by its unique
// builtAtISO stamp); if not, we RE-TRIGGER Pages with an empty commit (bounded). On
// exhaustion we return an error string so David gets the failure email — never a
// silent stale site. (First observed 2026-06-29, M76 BRA 2-1 JPN.)
const LIVE_URL = 'https://dw-football.github.io/wc2026-bracket/';
const VERIFY_POLL_MS = 12000;       // gap between live-site checks
const VERIFY_WINDOW_MS = 108000;    // how long to wait for ONE deploy to publish (~9 checks)
const VERIFY_MAX_TRIGGERS = 2;      // empty-commit re-triggers before giving up

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The builtAtISO stamp baked into the artifact we just pushed (unique per build). */
function builtStamp() {
  try {
    const m = readFileSync(join(__dirname, 'docs', 'index.html'), 'utf8')
      .match(/"builtAtISO":"([^"]+)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

/** Fetch the live site (cache-busted) and report whether it carries `stamp`.
 *  true=yes, false=reachable but stale, null=network error (can't tell). */
async function liveHasStamp(stamp) {
  try {
    const res = await fetch(`${LIVE_URL}?cb=${encodeURIComponent(stamp)}`,
      { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
    if (!res.ok) return false;
    return (await res.text()).includes(stamp);
  } catch { return null; }
}

/** Poll the live site up to VERIFY_WINDOW_MS for `stamp`.
 *  true=published, false=window elapsed while reachable, null=never reachable. */
async function awaitPublish(stamp) {
  const deadline = Date.now() + VERIFY_WINDOW_MS;
  let everReachable = false;
  while (Date.now() < deadline) {
    await sleep(VERIFY_POLL_MS);
    const hit = await liveHasStamp(stamp);
    if (hit === true) return true;
    if (hit !== null) everReachable = true;
  }
  return everReachable ? false : null;
}

/** After a successful push, confirm Pages actually PUBLISHED our artifact; if the
 *  deploy job flaked, re-trigger with an empty commit (bounded). Returns null on
 *  success, or an error string (-> failure email) if it never published. Treats a
 *  network/unreachable result as "assume ok" so our own connectivity blips never
 *  spam empty re-trigger commits. Does NOT throw — the score is already live in git;
 *  we never want to re-run the whole deploy (that would double-append the result). */
async function verifyPagesPublished(log) {
  const stamp = builtStamp();
  if (!stamp) { log('  verify: no builtAtISO stamp found — skipping live check.'); return null; }
  for (let trigger = 0; trigger <= VERIFY_MAX_TRIGGERS; trigger++) {
    const ok = await awaitPublish(stamp);
    if (ok === true) { log(`  verify: live site published build ${stamp}.`); return null; }
    if (ok === null) { log('  verify: live site unreachable from 520 — assuming ok (no re-trigger).'); return null; }
    if (trigger < VERIFY_MAX_TRIGGERS) {
      log(`  verify: live site STILL STALE after ${VERIFY_WINDOW_MS / 1000}s — GitHub Pages deploy flaked; re-triggering (attempt ${trigger + 1}/${VERIFY_MAX_TRIGGERS}).`);
      try {
        sh('git', ['commit', '--allow-empty', '-m',
          `Re-trigger Pages deploy: deploy job flaked; artifact ${stamp} is correct, re-publishing`]);
        sh('git', ['push', 'origin', 'main']);
      } catch (e) {
        return `Pages re-trigger push failed: ${e.message || e} (live site stale on build ${stamp})`;
      }
    }
  }
  return `GitHub Pages deploy kept failing — live site still does not show build ${stamp} ` +
         `after ${VERIFY_MAX_TRIGGERS} re-trigger(s). Re-run the Pages workflow or push manually.`;
}

/** The LIVE deploy chain. Runs ONLY behind the double gate. Events are folded in:
 *  fetch goal-scorer popovers INLINE, then a SINGLE bake + push carries both score
 *  and popovers. Returns { got, verifyError }: got = count of event-matches captured
 *  (0 => a catch-up is still owed); verifyError = null, or a string if Pages never
 *  published (the caller surfaces it as a failure-email problem). */
async function deployLive(matches, now, log) {
  await appendManualResults(matches, now);
  const got = fetchEventsInline(log);
  sh('node', ['build-html.mjs', '--refresh']);
  copyFileSync(join(__dirname, 'dist', 'index.html'), join(__dirname, 'docs', 'index.html'));
  // Stage ONLY the score-deploy files (incl. the events cache) — never `git add -A`
  // (which would sweep the unpushed auto-sync feature code + log + state into a live
  // public push). An unchanged events cache adds nothing; the commit still proceeds.
  sh('git', ['add', 'manual-results.json', 'data/match-events.json', 'docs/index.html', 'dist/index.html']);
  sh('git', ['commit', '-m', `Auto-sync: ${matches.map((m) => `${m.team1} ${m.ft[0]}-${m.ft[1]} ${m.team2}`).join('; ')}${got ? ` (+${got} popover${got > 1 ? 's' : ''})` : ''}`]);
  // push uses the headless git credential (Windows Credential Manager / gh auth)
  sh('git', ['push', 'origin', 'main']);
  sh('node', ['sync-calendar.mjs']);
  sh('node', ['calendar-apply.mjs', '--apply']);
  const verifyError = await verifyPagesPublished(log);   // self-heal a flaked Pages deploy
  return { got, verifyError };
}

/** The LIVE KO deploy chain — same as deployLive but stages manual-ko-results.json. */
async function deployLiveKo(d, now, log) {
  await appendKnockoutResult(d, now);
  const got = fetchEventsInline(log);
  sh('node', ['build-html.mjs', '--refresh']);
  copyFileSync(join(__dirname, 'dist', 'index.html'), join(__dirname, 'docs', 'index.html'));
  sh('git', ['add', 'manual-ko-results.json', 'data/match-events.json', 'docs/index.html', 'dist/index.html']);
  sh('git', ['commit', '-m', `Auto-sync KO: ${koLine(d)}${got ? ` (+${got} popover${got > 1 ? 's' : ''})` : ''}`]);
  sh('git', ['push', 'origin', 'main']);
  sh('node', ['sync-calendar.mjs']);
  sh('node', ['calendar-apply.mjs', '--apply']);
  const verifyError = await verifyPagesPublished(log);   // self-heal a flaked Pages deploy
  return { got, verifyError };
}

/** FALLBACK catch-up for match-event popovers. Events are normally folded INLINE
 *  into the score deploy (fetchEventsInline -> single bake + push). This pass now
 *  runs ONLY on a QUIET tick (no new score this tick), to backfill the rare game
 *  whose ESPN summary wasn't ready at score-deploy time — it gets picked up on a
 *  later tick (true tape-delay). Fully best-effort + non-fatal: it rebuilds + pushes
 *  a SEPARATE commit ONLY if NEW matches were actually cached. When the cache is
 *  already complete it does nothing (build-events makes zero network calls and the
 *  key-count is unchanged -> no rebuild/push). Gating it to quiet ticks also avoids
 *  a same-tick second deploy (which would re-create the Pages concurrency race). */
function deployEventsCatchUp(log) {
  const before = eventCacheKeyCount();
  try { sh('node', ['build-events.mjs']); }
  catch (e) { log(`  events: backfill skipped (non-fatal): ${e.message || e}`); return; }
  const after = eventCacheKeyCount();
  if (after <= before) { log('  events: cache up to date.'); return; }
  try {
    sh('node', ['build-html.mjs']);   // no --refresh: the score path already pulled the feed
    copyFileSync(join(__dirname, 'dist', 'index.html'), join(__dirname, 'docs', 'index.html'));
    sh('git', ['add', 'data/match-events.json', 'docs/index.html', 'dist/index.html']);
    sh('git', ['commit', '-m', `Auto-sync: match-event popovers (+${after - before})`]);
    sh('git', ['push', 'origin', 'main']);
    log(`  events: popovers deployed (+${after - before} match${after - before > 1 ? 'es' : ''}).`);
  } catch (e) { log(`  events: deploy failed (non-fatal): ${e.message || e}`); }
}

function describeDryRun(set, log) {
  const line = set.matches.map((m) => `${m.team1} ${m.ft[0]}-${m.ft[1]} ${m.team2} (${m.group})`).join('  |  ');
  log(`  NEW SET READY: ${line}${set.partial ? `   [PARTIAL — ${set.flag}]` : ''}`);
  log('    WOULD: append above to manual-results.json');
  log('    WOULD: node build-events.mjs   (INLINE, time-boxed — fold goal-scorer popovers into this build)');
  log('    WOULD: node build-html.mjs --refresh   (single re-bake 200k: score + popovers)');
  log('    WOULD: cp dist/index.html docs/index.html');
  log('    WOULD: git add manual-results.json data/match-events.json docs/ dist/ && commit && push   (ONE LIVE deploy)');
  log('    WOULD: node sync-calendar.mjs && node calendar-apply.mjs --apply   (LIVE calendar)');
  log('    WOULD: verify the live site published this build (by builtAtISO); re-trigger Pages on a flaked deploy');
  log('    WOULD: notify David — failure-only, so SILENT on this success (no spoiler)');
}

function describeDryRunKo(d, log) {
  log(`  NEW KO RESULT READY: ${koLine(d)}${d.partial ? `   [PARTIAL — ${d.flag}]` : ''}`);
  log('    WOULD: append above to manual-ko-results.json');
  log('    WOULD: node build-events.mjs   (INLINE, time-boxed — fold goal-scorer popovers into this build)');
  log('    WOULD: node build-html.mjs --refresh   (single re-bake 200k: score + popovers)');
  log('    WOULD: cp dist/index.html docs/index.html');
  log('    WOULD: git add manual-ko-results.json data/match-events.json docs/ dist/ && commit && push   (ONE LIVE deploy)');
  log('    WOULD: node sync-calendar.mjs && node calendar-apply.mjs --apply   (LIVE calendar)');
  log('    WOULD: verify the live site published this build (by builtAtISO); re-trigger Pages on a flaked deploy');
  log('    WOULD: notify David — failure-only, so SILENT on this success (no spoiler)');
}

async function main() {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh');
  const reset = args.includes('--reset');
  const arm = args.includes('--arm');
  const live = arm && process.env.AUTOSYNC_LIVE === '1';   // double gate
  const force = args.includes('--force');
  const atIx = args.indexOf('--at');
  const nowArg = atIx >= 0 ? args[atIx + 1] : undefined;

  const log = (s) => console.log(s);

  // Overnight stop: between 4am and 11am NY, exit instantly without polling.
  const nowNow = nowArg ? new Date(nowArg) : new Date();
  if (inDeadWindow(nowNow) && !force) {
    log(`\n=== autosync tick — ${nowNow.toISOString()} — OFF (overnight 4-11am NY; nothing scheduled) ===\n`);
    return;
  }

  let state = reset ? { processedSetKeys: [], lastRun: null } : await loadState();
  const processed = new Set(state.processedSetKeys);

  const { now, sets, deployable, alerts, koSets, koDeployable } = await pollReport({ refresh, now: nowArg });

  log(`\n=== autosync tick — ${now.toISOString()} — ${live ? 'LIVE (ARMED)' : 'DRY-RUN'} ===`);
  const waiting = [...sets, ...(koSets || [])].filter((s) => s.status === 'waiting' || s.status === 'not-due');
  if (waiting.length) {
    log(`  ${waiting.length} set(s) pending: ` +
      waiting.map((s) => `${s.status}${s.inEt ? '/ET' : ''}`).join(', '));
  }

  let failure = null;
  let didDeploy = false;   // a score shipped this tick -> events were folded in inline

  // --- group sets ----------------------------------------------------------
  const fresh = deployable.filter((d) => !processed.has(d.key));
  if (!fresh.length) {
    log(`  no new finished group sets.${deployable.length ? ` (${deployable.length} already processed)` : ''}`);
  }
  for (const set of fresh) {
    if (live) {
      try {
        log(`  DEPLOYING: ${set.matches.map((m) => `${m.team1} ${m.ft[0]}-${m.ft[1]} ${m.team2}`).join('; ')}`);
        const { got, verifyError } = await deployLive(set.matches, now, log);
        didDeploy = true;
        log(got ? `  events: +${got} popover(s) folded into this deploy.`
                : `  events: not ready at deploy — a quiet tick will backfill.`);
        if (verifyError) failure = (failure ? failure + '; ' : '') + verifyError;
      } catch (e) {
        failure = `deploy failed for set ${set.key}: ${e.message || e}`;
        break;   // leave it UNprocessed so the next tick retries
      }
    } else {
      describeDryRun(set, log);
    }
    if (set.partial) failure = (failure ? failure + '; ' : '') + `partial set: ${set.flag}`;
    processed.add(set.key);
  }

  // --- knockout matches (each its own deploy) ------------------------------
  const freshKo = (koDeployable || []).filter((d) => !processed.has(d.key));
  if (koDeployable && koDeployable.length && !freshKo.length) {
    log(`  no new finished KO matches. (${koDeployable.length} already processed)`);
  }
  for (const d of freshKo) {
    if (live) {
      try {
        log(`  DEPLOYING KO: ${koLine(d)}`);
        const { got, verifyError } = await deployLiveKo(d, now, log);
        didDeploy = true;
        log(got ? `  events: +${got} popover(s) folded into this deploy.`
                : `  events: not ready at deploy — a quiet tick will backfill.`);
        if (verifyError) failure = (failure ? failure + '; ' : '') + verifyError;
      } catch (e) {
        failure = (failure ? failure + '; ' : '') + `KO deploy failed for ${d.key}: ${e.message || e}`;
        break;   // leave it UNprocessed so the next tick retries
      }
    } else {
      describeDryRunKo(d, log);
    }
    if (d.partial) failure = (failure ? failure + '; ' : '') + `partial KO: ${d.flag}`;
    processed.add(d.key);
  }

  // FAILURE-ONLY notification (spoiler-safe). Success = silence. The message
  // carries the PROBLEM, never a score, so a finished game is never spoiled.
  const problems = [failure, ...alerts.map((a) => a.flag)].filter(Boolean);
  if (problems.length) {
    log(`  !! ${live ? 'NOTIFYING' : 'WOULD notify'} David (failure-only): ${problems.join(' | ')}`);
    if (live) {
      try {
        await sendFailureEmail(
          `[WC2026 auto-sync] FAILURE ${today(now)}`,
          `The unattended auto-sync hit a problem and needs a look:\n\n` +
          problems.map((p) => `  • ${p}`).join('\n') +
          `\n\n(Tick ${now.toISOString()} on 520. The failing item was left UNprocessed ` +
          `so the next tick retries; no score was spoiled.)`,
        );
        log('  notified David (Gmail REST).');
      } catch (e) {
        log(`  !! notify FAILED too: ${e.message || e}`);   // last resort — only the log has it
      }
    }
  }

  // --- match-event popovers ------------------------------------------------
  // Events are folded INLINE into each score deploy (single bake + push). The
  // standalone catch-up now runs ONLY on a QUIET tick (no new score this tick) to
  // backfill a game whose ESPN summary wasn't ready at deploy time — this avoids a
  // same-tick second deploy (the Pages concurrency race). Skipped on a failure tick.
  if (live && !failure && !didDeploy) {
    deployEventsCatchUp(log);
  } else if (live && didDeploy) {
    log('  events: folded into the score deploy(s) this tick — no separate pass.');
  } else if (!live) {
    log('  WOULD: fetch events INLINE with each score (single deploy); a separate catch-up runs only on a quiet tick if an event was missing.');
  }

  state = { processedSetKeys: [...processed], lastRun: now.toISOString() };
  if (!nowArg) await saveState(state);   // don't persist when simulating a fake "now"
  log('');
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });
