// espn-poll.mjs
// ============================================================================
// READ-ONLY score poller for the unattended auto-sync (#4).
//
// Division of labour (settled with David 2026-06-24):
//   - OUR repo is the SCHEDULE source. The openfootball feed (data/raw/worldcup.json,
//     loaded via adapter.fetchRaw) carries every match's date + time WITH an explicit
//     UTC offset, and knockout-schedule.json covers 73-104. The clock gate
//     (scheduledKO + FIRST_CHECK_MIN) is computed locally from this — so we never
//     call ESPN for a match that is still days away.
//   - ESPN's fifa.world scoreboard is the LIVE STATUS / RESULT source only: is it
//     full-time, did it go to extra time, was it postponed/abandoned.
//
// This module NEVER writes a file and NEVER touches a calendar. It returns a
// structured report; the orchestrator (autosync.mjs) decides what to do with it.
//
// Rain-delay doctrine (a 2hr delay already happened; summer storms across 11 US
// venues = expect more):
//   - The clock ONLY decides when to START polling. "Done" is ESPN
//     status.completed === true, full stop. A delayed game just keeps reading
//     in/delayed and we keep polling — we never give up on the clock, never
//     false-deploy.
//   - We HOLD a simultaneous set as long as a not-yet-FT sibling is legitimately
//     still coming (pre/in/delayed). We only deploy-partial-and-FLAG on an explicit
//     postponed/abandoned/canceled status, or a very generous ABANDON_BACKSTOP.
//
//   node espn-poll.mjs            # print the dry-run poll table (cached feed)
//   node espn-poll.mjs --refresh  # re-pull the openfootball feed first
//   node espn-poll.mjs --at 2026-06-24T23:30Z   # simulate "now" for testing
// ============================================================================

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { fetchRaw } from './adapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const loadJSON = async (f) => JSON.parse(await readFile(join(__dirname, f), 'utf8'));

// --- tunables (David's polling design) -------------------------------------
export const FIRST_CHECK_MIN = 115;     // start checking 115 min after scheduled KO
export const ET_BACKOFF_MIN = 30;       // (KO only) if a game is in extra time, skip ~30 min
export const ABANDON_BACKSTOP_MIN = 360; // 6h: a sibling that never resolves -> deploy partial + flag

const ESPN_SCOREBOARD =
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** "bosnia & herzegovina" / "Bosnia-Herzegovina" -> "bosniaherzegovina" */
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

/** Parse openfootball "19:00 UTC-6" (+ a "2026-06-24" date) into a UTC Date.
 *  local = UTC + offset  =>  UTC = local - offset. Returns null if unparseable. */
function parseFeedKO(date, time) {
  if (!date) return null;
  const m = /^(\d{1,2}):(\d{2})\s*UTC([+-]\d{1,2})?/.exec(String(time || '').trim());
  if (!m) {
    // No time given — treat as midnight UTC of that date (gate will just be loose).
    const d = new Date(`${date}T00:00:00Z`);
    return isNaN(d) ? null : d;
  }
  const [, hh, mm, off] = m;
  const offset = off ? parseInt(off, 10) : 0;
  // local wall-clock at that offset, expressed as UTC
  const utcMs = Date.parse(`${date}T${hh.padStart(2, '0')}:${mm}:00Z`) - offset * 3600 * 1000;
  const d = new Date(utcMs);
  return isNaN(d) ? null : d;
}

/** Flatten the openfootball object into a flat match array regardless of shape
 *  (some dumps are {matches:[...]}, others {rounds:[{matches:[...]}]}). */
function rawMatches(raw) {
  if (Array.isArray(raw?.matches)) return raw.matches;
  if (Array.isArray(raw?.rounds)) return raw.rounds.flatMap((r) => r.matches || []);
  return [];
}

/** YYYYMMDD strings for the ESPN query window: the day before through the day
 *  after `now`, so a midnight-crossing delayed game is never missed. */
function espnDateWindow(now) {
  const out = [];
  for (let d = -1; d <= 1; d++) {
    const t = new Date(now.getTime() + d * 86400000);
    out.push(`${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}${String(t.getUTCDate()).padStart(2, '0')}`);
  }
  return out;
}

async function fetchEspnEvents(now, fetchImpl = fetch) {
  const events = [];
  for (const ymd of espnDateWindow(now)) {
    try {
      const res = await fetchImpl(ESPN_SCOREBOARD + ymd);
      if (!res.ok) continue;
      const j = await res.json();
      for (const e of j.events || []) events.push(e);
    } catch { /* network hiccup — skip this date, the next tick retries */ }
  }
  return events;
}

/** Classify one ESPN event into the states the orchestrator cares about. */
function classifyEspn(ev) {
  const t = ev?.status?.type || {};
  const state = t.state;                     // 'pre' | 'in' | 'post'
  const name = String(t.name || '');         // STATUS_FULL_TIME, STATUS_POSTPONED, ...
  const detail = String(t.detail || t.shortDetail || '');
  const blob = (name + ' ' + detail).toUpperCase();
  return {
    state,
    completed: !!t.completed,
    isET: /EXTRA|\bET\b|PENALT/.test(blob),
    isDead: /POSTPON|ABANDON|CANCEL|SUSPEND/.test(blob),
    detail: detail || name,
  };
}

// ---------------------------------------------------------------------------
// core: build the poll report
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{now:Date, sets:Array, deployable:Array, alerts:Array}>}
 *  sets:       every remaining group set with its per-match status
 *  deployable: sets that are COMPLETE (all due members FT) -> ready to process,
 *              each as { key, matches:[{group,team1,team2,ft}], partial, flag }
 *  alerts:     human-attention items (postponed/abandoned/backstop-tripped)
 */
export async function pollReport(opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const teams = await loadJSON('teams.json');
  const byCode = new Map(teams.map((t) => [t.code.toUpperCase(), t]));
  const byName = new Map(teams.map((t) => [norm(t.name), t]));

  const raw = await fetchRaw({ refresh: !!opts.refresh });
  const matches = rawMatches(raw);

  // Remaining GROUP matches only (knockout result mapping is a separate, marked
  // TODO — feeders/team names aren't fixed until R32; group stage is finishing now).
  const remaining = [];
  for (const m of matches) {
    if (!m.group) continue;                          // group stage only
    const ft = m.score?.ft;
    const played = Array.isArray(ft) && ft[0] != null && ft[1] != null;
    if (played) continue;                            // feed already has the result
    const ko = parseFeedKO(m.date, m.time);
    const t1 = byName.get(norm(m.team1));
    const t2 = byName.get(norm(m.team2));
    const koMs = ko ? ko.getTime() : Infinity;
    remaining.push({
      group: m.group,
      team1: m.team1, team2: m.team2,
      code1: t1?.code, code2: t2?.code,
      ko, koMs,
      due: now.getTime() >= koMs + FIRST_CHECK_MIN * 60000,
    });
  }

  // Only hit ESPN once at least one match is past its 115-min check time. Until
  // then every tick is a free no-op — no network call (answers "why poll before
  // 115 min past kickoff?"). Not-due matches simply carry no ESPN status.
  const anyDue = remaining.some((r) => r.due);
  const espnEvents = opts.espnEvents ||
    (anyDue ? await fetchEspnEvents(now, opts.fetchImpl || fetch) : []);

  // attach ESPN status to each remaining match (match by FIFA code pair, fallback name)
  const codeSet = (ev) => new Set(
    (ev.competitions?.[0]?.competitors || []).map((c) =>
      (c.team?.abbreviation || c.code || '').toUpperCase())
  );
  const nameSet = (ev) => new Set(
    (ev.competitions?.[0]?.competitors || []).map((c) =>
      norm(c.team?.displayName || c.name))
  );
  for (const r of remaining) {
    const want = new Set([r.code1, r.code2].filter(Boolean).map((c) => c.toUpperCase()));
    let ev = r.code1 && r.code2
      ? espnEvents.find((e) => { const s = codeSet(e); return want.size === 2 && [...want].every((c) => s.has(c)); })
      : null;
    if (!ev) {
      const wn = new Set([norm(r.team1), norm(r.team2)]);
      ev = espnEvents.find((e) => { const s = nameSet(e); return [...wn].every((n) => s.has(n)); });
    }
    if (ev) {
      const cls = classifyEspn(ev);
      r.espn = cls;
      // orient score to our team1/team2
      const comps = ev.competitions?.[0]?.competitors || [];
      const scoreByCode = {};
      for (const c of comps) scoreByCode[(c.team?.abbreviation || c.code || '').toUpperCase()] = Number(c.score);
      const scoreByName = {};
      for (const c of comps) scoreByName[norm(c.team?.displayName || c.name)] = Number(c.score);
      const s1 = r.code1 ? scoreByCode[r.code1.toUpperCase()] : scoreByName[norm(r.team1)];
      const s2 = r.code2 ? scoreByCode[r.code2.toUpperCase()] : scoreByName[norm(r.team2)];
      r.ft = (cls.completed && Number.isFinite(s1) && Number.isFinite(s2)) ? [s1, s2] : null;
      r.koEspn = ev.date ? new Date(ev.date) : null;   // ESPN's scheduled KO (cross-check)
    } else {
      r.espn = null;
    }
  }

  // group remaining matches into simultaneous SETS by KO instant
  const setMap = new Map();
  for (const r of remaining) {
    const key = r.ko ? r.ko.toISOString() : `unscheduled:${r.group}`;
    if (!setMap.has(key)) setMap.set(key, []);
    setMap.get(key).push(r);
  }

  const sets = [];
  const deployable = [];
  const alerts = [];
  for (const [key, members] of [...setMap.entries()].sort()) {
    const due = members.filter((m) => m.due);
    const ftMembers = members.filter((m) => m.ft);
    const dead = members.filter((m) => m.espn?.isDead);
    const inEt = members.filter((m) => m.espn?.isET && !m.ft);
    const backstopTripped = members.some(
      (m) => !m.ft && m.koMs !== Infinity && now.getTime() >= m.koMs + ABANDON_BACKSTOP_MIN * 60000);

    let status, flag = null;
    if (!due.length) {
      status = 'not-due';
    } else if (members.every((m) => m.ft)) {
      status = 'complete';
    } else if (dead.length || backstopTripped) {
      status = 'partial-flagged';
      flag = dead.length
        ? `sibling status: ${dead.map((m) => `${m.team1}-${m.team2} (${m.espn.detail})`).join('; ')}`
        : `>${ABANDON_BACKSTOP_MIN}min past KO with no FT`;
    } else {
      status = 'waiting';          // legitimately still coming (pre/in/delayed/ET) -> HOLD
    }

    const setRow = { key, ko: members[0].ko, status, members, inEt: inEt.length > 0 };
    sets.push(setRow);

    if (status === 'complete' || status === 'partial-flagged') {
      const ready = (status === 'complete' ? members : ftMembers).filter((m) => m.ft);
      if (ready.length) {
        deployable.push({
          key,
          partial: status === 'partial-flagged',
          flag,
          matches: ready.map((m) => ({ group: m.group, team1: m.team1, team2: m.team2, ft: m.ft })),
        });
      }
      if (flag) alerts.push({ key, flag, ready: ready.length, of: due.length });
    }
  }

  return { now, sets, deployable, alerts };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function pad(s, w) { s = String(s); return s.length >= w ? s : s + ' '.repeat(w - s.length); }
const etState = (m) =>
  !m.espn ? 'no-espn'
    : m.ft ? `FT ${m.ft[0]}-${m.ft[1]}`
      : m.espn.isDead ? m.espn.detail
        : m.espn.isET ? 'EXTRA TIME'
          : m.espn.state === 'in' ? `in (${m.espn.detail})`
            : m.espn.state === 'pre' ? 'scheduled'
              : m.espn.detail || m.espn.state;

async function main() {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh');
  const atIx = args.indexOf('--at');
  const now = atIx >= 0 ? args[atIx + 1] : undefined;

  const { now: nowD, sets, deployable, alerts } = await pollReport({ refresh, now });

  console.log(`\n=== ESPN poll (READ-ONLY dry-run) — now=${nowD.toISOString()} — first-check ${FIRST_CHECK_MIN}min after KO ===\n`);
  console.log('  ' + pad('KO (UTC)', 18) + pad('Set status', 17) + 'Matches');
  console.log('  ' + '-'.repeat(70));
  for (const s of sets) {
    const koStr = s.ko ? s.ko.toISOString().slice(5, 16).replace('T', ' ') : '(unscheduled)';
    const head = '  ' + pad(koStr, 18) + pad(s.status + (s.inEt ? ' *ET' : ''), 17);
    s.members.forEach((m, i) => {
      const line = `${pad(m.group.replace('Group ', 'Grp '), 7)} ${pad(m.team1 + ' v ' + m.team2, 30)} ${etState(m)}`;
      console.log((i === 0 ? head : '  ' + pad('', 18 + 17)) + line);
    });
  }

  console.log(`\n${deployable.length} set(s) ready to deploy:`);
  for (const d of deployable) {
    console.log(`  - ${d.matches.map((m) => `${m.team1} ${m.ft[0]}-${m.ft[1]} ${m.team2}`).join('  |  ')}` +
      (d.partial ? `   [PARTIAL — ${d.flag}]` : ''));
  }
  if (alerts.length) {
    console.log(`\n!! ${alerts.length} alert(s) needing attention:`);
    for (const a of alerts) console.log(`  - ${a.flag} (deploying ${a.ready}/${a.of})`);
  }
  console.log('');
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });
