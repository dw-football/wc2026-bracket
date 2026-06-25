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
import { existsSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { pollReport } from './espn-poll.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, 'autosync-state.json');
const MANUAL_FILE = join(__dirname, 'manual-results.json');
const MANUAL_KO_FILE = join(__dirname, 'manual-ko-results.json');

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

/** The LIVE deploy chain. Runs ONLY behind the double gate. */
async function deployLive(matches, now) {
  await appendManualResults(matches, now);
  sh('node', ['build-html.mjs', '--refresh']);
  copyFileSync(join(__dirname, 'dist', 'index.html'), join(__dirname, 'docs', 'index.html'));
  // Stage ONLY the score-deploy files — never `git add -A` (which would sweep the
  // unpushed auto-sync feature code + log + state into a live public push).
  sh('git', ['add', 'manual-results.json', 'docs/index.html', 'dist/index.html']);
  sh('git', ['commit', '-m', `Auto-sync: ${matches.map((m) => `${m.team1} ${m.ft[0]}-${m.ft[1]} ${m.team2}`).join('; ')}`]);
  // push uses the headless git credential (Windows Credential Manager / gh auth)
  sh('git', ['push', 'origin', 'main']);
  sh('node', ['sync-calendar.mjs']);
  sh('node', ['calendar-apply.mjs', '--apply']);
}

/** The LIVE KO deploy chain — same as deployLive but stages manual-ko-results.json. */
async function deployLiveKo(d, now) {
  await appendKnockoutResult(d, now);
  sh('node', ['build-html.mjs', '--refresh']);
  copyFileSync(join(__dirname, 'dist', 'index.html'), join(__dirname, 'docs', 'index.html'));
  sh('git', ['add', 'manual-ko-results.json', 'docs/index.html', 'dist/index.html']);
  sh('git', ['commit', '-m', `Auto-sync KO: ${koLine(d)}`]);
  sh('git', ['push', 'origin', 'main']);
  sh('node', ['sync-calendar.mjs']);
  sh('node', ['calendar-apply.mjs', '--apply']);
}

function describeDryRun(set, log) {
  const line = set.matches.map((m) => `${m.team1} ${m.ft[0]}-${m.ft[1]} ${m.team2} (${m.group})`).join('  |  ');
  log(`  NEW SET READY: ${line}${set.partial ? `   [PARTIAL — ${set.flag}]` : ''}`);
  log('    WOULD: append above to manual-results.json');
  log('    WOULD: node build-html.mjs --refresh   (re-bake 200k)');
  log('    WOULD: cp dist/index.html docs/index.html');
  log('    WOULD: git add -A && git commit && git push origin main   (LIVE site)');
  log('    WOULD: node sync-calendar.mjs && node calendar-apply.mjs --apply   (LIVE calendar)');
  log('    WOULD: notify David — failure-only, so SILENT on this success (no spoiler)');
}

function describeDryRunKo(d, log) {
  log(`  NEW KO RESULT READY: ${koLine(d)}${d.partial ? `   [PARTIAL — ${d.flag}]` : ''}`);
  log('    WOULD: append above to manual-ko-results.json');
  log('    WOULD: node build-html.mjs --refresh   (re-bake 200k)');
  log('    WOULD: cp dist/index.html docs/index.html');
  log('    WOULD: git add manual-ko-results.json docs/ dist/ && commit && push   (LIVE site)');
  log('    WOULD: node sync-calendar.mjs && node calendar-apply.mjs --apply   (LIVE calendar)');
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

  // --- group sets ----------------------------------------------------------
  const fresh = deployable.filter((d) => !processed.has(d.key));
  if (!fresh.length) {
    log(`  no new finished group sets.${deployable.length ? ` (${deployable.length} already processed)` : ''}`);
  }
  for (const set of fresh) {
    if (live) {
      try {
        log(`  DEPLOYING: ${set.matches.map((m) => `${m.team1} ${m.ft[0]}-${m.ft[1]} ${m.team2}`).join('; ')}`);
        await deployLive(set.matches, now);
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
        await deployLiveKo(d, now);
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

  // FAILURE-ONLY notification (spoiler-safe). Success = silence.
  const problems = [failure, ...alerts.map((a) => a.flag)].filter(Boolean);
  if (problems.length) {
    log(`  !! ${live ? 'NOTIFYING' : 'WOULD notify'} David (failure-only): ${problems.join(' | ')}`);
    // TODO(arm): send via Gmail REST using the same gsuite token (mail scope present).
  }

  state = { processedSetKeys: [...processed], lastRun: now.toISOString() };
  if (!nowArg) await saveState(state);   // don't persist when simulating a fake "now"
  log('');
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });
