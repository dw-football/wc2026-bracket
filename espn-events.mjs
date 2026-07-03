// espn-events.mjs
// ============================================================================
// ESPN match-events pipeline (#3) — turns a played match into the event timeline
// the match-detail popover renders: goals (scorer + minute, incl "45'+7'"), red
// cards, and penalty-shootout takers. Oriented home/away to the match itself.
//
// Source: site.api.espn.com .../fifa.world/summary?event={id} -> `keyEvents`.
// ESPN does NOT populate athletesInvolved here, so the scorer/booked player is
// parsed out of the human-readable `text`. team is an ESPN team id; we map it to
// a side via the summary's own competitors. We keep ONLY goals + red cards in
// `events` (the popover icon is goal-or-red), plus the shootout takers in `pens`.
//
//   node espn-events.mjs <eventId>                 # print parsed events for one event
//   node espn-events.mjs --date YYYYMMDD           # list that day's events + ids
// ============================================================================

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SUMMARY = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event=';
const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=';

/** "6'" -> 6 ; "45'+7'" -> 45 (leading whole minute, for chronological sort). */
export function clockToMin(clock) {
  const m = /(\d+)/.exec(String(clock || ''));
  return m ? parseInt(m[1], 10) : 0;
}

/** Pull the player name out of an ESPN event `text`. The player always reads
 *  "<Name> (<Team>) …"; a goal text is prefixed by a "Goal! A n, B m." score
 *  clause, so take the clause right before the first "(". */
export function playerFromText(text) {
  if (!text) return null;
  // Own goal reads "Own Goal by <Name>, <Team>." — no "(Team)" parenthetical.
  const og = /Own Goal by ([^,]+),/i.exec(text);
  if (og) return og[1].trim() + ' (OG)';
  const i = text.indexOf('(');
  if (i < 0) return null;
  const pre = text.slice(0, i).trim();
  const parts = pre.split(/\.\s+/);            // drop a leading score / "Penalty" clause
  const cand = (parts[parts.length - 1] || '').trim();
  return cand || null;
}

/**
 * Parse one ESPN match `summary` into { home, away, events, pens } oriented to the
 * summary's own home/away competitors. Pure.
 *   events: [{min, minLabel, type:'goal'|'red', team:'home'|'away', who}]
 *   pens:   [{team:'home'|'away', who, ok}]   (only when a shootout happened)
 */
export function parseSummaryEvents(summary) {
  const comp = summary?.header?.competitions?.[0];
  const comps = comp?.competitors || [];
  const sideById = {}, sideByName = {};
  let home = null, away = null;
  for (const c of comps) {
    const id = String(c.team?.id ?? '');
    if (id) sideById[id] = c.homeAway;
    // The shootout block keys takers by full team NAME ("Germany"), not id — map
    // every name variant to the side so we can orient them.
    for (const nm of [c.team?.displayName, c.team?.name, c.team?.location, c.team?.shortDisplayName])
      if (nm) sideByName[String(nm).toLowerCase()] = c.homeAway;
    if (c.homeAway === 'home') home = c.team?.abbreviation || null;
    else if (c.homeAway === 'away') away = c.team?.abbreviation || null;
  }
  const events = [], pens = [], kePens = [];
  for (const e of summary?.keyEvents || []) {
    const t = String(e.type?.type || e.type?.text || '').toLowerCase();
    // ESPN nests these: team = {id}, clock = {displayValue:"45'+7'", value:45}.
    const teamId = String(e.team?.id ?? e.team ?? '');
    const side = sideById[teamId] || null;
    const who = playerFromText(e.text);
    if (e.shootout) {
      // Fallback only: some feeds MIGHT flag takers inline in keyEvents. In practice
      // fifa.world does NOT (keyEvents carries only a "Start Shootout" marker); the
      // real taker list is the dedicated summary.shootout block parsed below.
      const ok = !/missed|saved|miss\b/i.test(String(e.text || ''));
      kePens.push({ team: side, who, ok });
      continue;
    }
    const clockStr = e.clock?.displayValue ?? e.clock ?? '';
    const min = Number.isFinite(e.clock?.value) ? e.clock.value : clockToMin(clockStr);
    const minLabel = String(clockStr).replace(/'+$/, '') || String(min);
    // Goal detection: trust ESPN's own `scoringPlay` flag when present — it is true
    // for "Goal", "Goal - Header", "Own Goal", AND "Penalty - Scored" (an in-play
    // penalty converted), false for a disallowed/VAR-cancelled goal. Fall back to the
    // type text only when the flag is absent.
    // Red-card detection MUST use a word boundary: a loose t.includes('red') matches
    // the "red" inside "Penalty - Sco[red]" and turns a scored penalty into a phantom
    // sending-off (dropping the goal). \bred\b matches "Red Card" but not "Scored".
    const isGoal = e.scoringPlay === true || (e.scoringPlay == null && t.includes('goal'));
    const isRed = /\bred\b/.test(t);
    if (isGoal) {
      events.push({ min, minLabel, type: 'goal', team: side, who });
    } else if (isRed) {
      events.push({ min, minLabel, type: 'red', team: side, who });
    }
  }
  events.sort((a, b) => a.min - b.min);

  // Penalty shootout takers live in a DEDICATED top-level `summary.shootout`:
  //   [{ team:"Germany", shots:[{player, shotNumber, didScore, id}, …] }, …]
  // Flatten both teams and order by shot id (ESPN numbers them in firing order),
  // orient to home/away. This is the canonical source; keyEvents pens are a fallback.
  if (Array.isArray(summary?.shootout) && summary.shootout.length) {
    const shots = [];
    for (const entry of summary.shootout) {
      const side = sideByName[String(entry.team || '').toLowerCase()] || null;
      for (const sh of entry.shots || [])
        shots.push({ team: side, who: sh.player || null, ok: !!sh.didScore, ord: Number(sh.id) || sh.shotNumber || 0 });
    }
    shots.sort((a, b) => a.ord - b.ord);
    for (const sh of shots) pens.push({ team: sh.team, who: sh.who, ok: sh.ok });
  } else {
    pens.push(...kePens);
  }
  return { home, away, events, pens };
}

async function fetchJson(url, fetchImpl = fetch) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

/** Fetch + parse one event's timeline. */
export async function fetchMatchEvents(eventId, fetchImpl = fetch) {
  return parseSummaryEvents(await fetchJson(SUMMARY + eventId, fetchImpl));
}

/** ESPN scoreboard events for a YYYYMMDD date (id + competitor abbreviations). */
export async function scoreboardEvents(ymd, fetchImpl = fetch) {
  const j = await fetchJson(SCOREBOARD + ymd, fetchImpl);
  return (j.events || []).map((e) => ({
    id: e.id,
    completed: !!e.status?.type?.completed,
    codes: (e.competitions?.[0]?.competitors || []).map((c) =>
      (c.team?.abbreviation || '').toUpperCase()),
  }));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const dIx = args.indexOf('--date');
  if (dIx >= 0) {
    const evs = await scoreboardEvents(args[dIx + 1]);
    for (const e of evs) console.log(`${e.id}  ${e.completed ? 'FT ' : '   '}${e.codes.join(' v ')}`);
    return;
  }
  const id = args[0];
  if (!id) { console.error('usage: node espn-events.mjs <eventId> | --date YYYYMMDD'); process.exit(1); }
  const r = await fetchMatchEvents(id);
  console.log(`${r.home} v ${r.away}`);
  for (const e of r.events) console.log(`  ${e.minLabel}'  ${e.type === 'red' ? '🟥' : '⚽'}  ${e.team}  ${e.who}`);
  if (r.pens.length) { console.log('  shootout:'); for (const p of r.pens) console.log(`    ${p.ok ? '✅' : '❌'} ${p.team} ${p.who}`); }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });
