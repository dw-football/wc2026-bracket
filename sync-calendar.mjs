// sync-calendar.mjs
// THIN GLUE: binds the pure, shareable label resolver (bracket-labels.mjs) to
// David's personal Google Calendar via the GITIGNORED calendar-map.local.json.
// It NEVER calls a calendar/Google API and never writes to any calendar — it
// only prints a dry-run table and writes calendar-sync-plan.json, which a human
// (or a separate apply step) uses to update the Sports calendar.
//
//   node sync-calendar.mjs            # cached feed + manual-results (fast, offline)
//   node sync-calendar.mjs --dry-run  # same (explicit; there is no apply mode)
//   node sync-calendar.mjs --refresh  # re-pull the openfootball feed first
//
// SCOPE: all 32 knockout events (R32 73-88, R16 89-96, QF 97-100, SF 101-102,
// 3rd-place 103, Final 104). Every KO event — including the 3rd-place match and
// the Final — auto-updates on the Sports calendar the same way. A knockout event
// whose feeders aren't ready to reveal is emitted with summary:null +
// unchanged:true so the apply step LEAVES THAT EVENT AS-IS. (Copying an event to
// another calendar, e.g. Family shared, is a manual choice — not this tool's job.)
//
// ALL calendar/personal data lives in calendar-map.local.json (gitignored). The
// label logic itself is in bracket-labels.mjs (pure, committed, shareable).

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { toGroups, fetchRaw } from './adapter.js';
import { rankThirdPlaceTeams } from './engine.js';
import { venueCountryOf } from './model.js';
import { resolveThirdPlaceSlots } from './allocation.js';
import {
  computeMatchLabels,
  knockoutResultsFromRaw,
  knockoutResultsFromManual,
  mergeKnockoutResults,
} from './bracket-labels.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const loadJSON = async (f) => JSON.parse(await readFile(join(__dirname, f), 'utf8'));

const LOCAL_MAP = 'calendar-map.local.json';
const EXAMPLE_MAP = 'calendar-map.example.json';

// Venue -> stadium description (the calendar "notes" string). Kept here (glue),
// not in the shareable label module. Matches the existing event descriptions.
const VENUE_DESCRIPTION = {
  'Los Angeles (SoFi)': 'SoFi Stadium, Inglewood, CA (Los Angeles)',
  'Boston': 'Gillette Stadium, Foxborough, MA (Boston)',
  'Monterrey': 'Estadio BBVA, Guadalupe, Nuevo León (Monterrey)',
  'Houston': 'NRG Stadium, Houston, TX',
  'NY/NJ': 'MetLife Stadium, East Rutherford, NJ (New York/New Jersey)',
  'Dallas': 'AT&T Stadium, Arlington, TX (Dallas)',
  'Mexico City': 'Estadio Azteca, Mexico City',
  'Atlanta': 'Mercedes-Benz Stadium, Atlanta, GA',
  'SF Bay Area': "Levi's Stadium, Santa Clara, CA (San Francisco Bay Area)",
  'Seattle': 'Lumen Field, Seattle, WA',
  'Toronto': 'BMO Field, Toronto, ON',
  'Vancouver': 'BC Place, Vancouver, BC',
  'Miami': 'Hard Rock Stadium, Miami Gardens, FL',
  'Kansas City': 'Arrowhead Stadium, Kansas City, MO',
  'Philadelphia': 'Lincoln Financial Field, Philadelphia, PA',
};

/** Load the personal calendar map, preferring the gitignored local file. */
async function loadCalendarMap() {
  if (existsSync(join(__dirname, LOCAL_MAP))) {
    return { map: await loadJSON(LOCAL_MAP), source: LOCAL_MAP };
  }
  if (existsSync(join(__dirname, EXAMPLE_MAP))) {
    console.warn(`WARNING: ${LOCAL_MAP} not found — falling back to ${EXAMPLE_MAP} ` +
      `(placeholder event IDs; copy it to ${LOCAL_MAP} and fill in your real IDs to apply).`);
    return { map: await loadJSON(EXAMPLE_MAP), source: EXAMPLE_MAP };
  }
  throw new Error(`No calendar map found (${LOCAL_MAP} or ${EXAMPLE_MAP}).`);
}

/** Load the canonical baked Monte Carlo written by build-html.mjs, so the calendar
 *  uses the EXACT numbers the bracket page shows (single source of truth) instead
 *  of re-simulating. Returns null if no bake exists yet (caller falls back to a
 *  fresh sim inside computeMatchLabels). */
async function loadBakedMc() {
  const p = join(__dirname, 'dist', 'baked-mc.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}

export async function buildPlan(opts = {}) {
  const teams = await loadJSON('teams.json');
  const bracket = await loadJSON('bracket.json');
  // Venue-aware host bonus map (matchNo -> 'USA'|'MEX'|'CAN'|null) — built the SAME
  // way build-html does, so the shared KO slot-distribution applies the identical
  // bonus and the calendar %s match the page exactly.
  const koSchedule = await loadJSON('knockout-schedule.json');
  const koVenueCountry = {};
  for (const k of Object.keys(koSchedule)) {
    koVenueCountry[k] = venueCountryOf(koSchedule[k].venue || koSchedule[k].ground);
  }
  const { map, source } = await loadCalendarMap();
  const raw = await fetchRaw({ refresh: !!opts.refresh });
  const groups = toGroups(raw, teams);
  // Merged KO results (manual/auto first, feed last) so the calendar reflects a
  // near-real-time KO score before the feed publishes it — same source the page bakes.
  const manualKo = existsSync(join(__dirname, 'manual-ko-results.json'))
    ? await loadJSON('manual-ko-results.json') : [];
  const koResults = mergeKnockoutResults(
    knockoutResultsFromManual(manualKo),
    knockoutResultsFromRaw(raw, teams),
  );
  const bakedMc = await loadBakedMc();

  const labels = computeMatchLabels(
    { groups, bracket, teams, koResults, resolveThirdPlaceSlots, rankThirdPlaceTeams,
      koVenueCountry, mc: bakedMc || undefined, mcN: opts.mcN },
    { watchedTeams: map.watchedTeams || [], maxPreview: opts.maxPreview }
  );
  if (!bakedMc) {
    console.warn('WARNING: dist/baked-mc.json not found — re-simulating (numbers may ' +
      'differ slightly from the page). Run `node build-html.mjs` first for an exact match.');
  }

  const plan = [];
  for (const [matchStr, ev] of Object.entries(map.events)) {
    const match = Number(matchStr);
    const lab = labels.get(match);
    const venue = ev.venue;
    const description = VENUE_DESCRIPTION[venue] || venue;
    const unchanged = !lab || lab.full == null;
    plan.push({
      match,
      round: ev.round,
      venue,
      eventId: ev.eventId,
      calendarId: map.calendarId,
      summary: unchanged ? null : lab.full,
      description,
      unchanged,
    });
  }
  plan.sort((a, b) => a.match - b.match);

  const playedCount = groups.reduce((n, g) => n + g.matches.filter((m) => m.played).length, 0);
  return { plan, playedCount, mapSource: source };
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------

function pad(s, w) { s = String(s); return s.length >= w ? s : s + ' '.repeat(w - s.length); }

async function main() {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh');
  const { plan, playedCount, mapSource } = await buildPlan({ refresh });

  console.log(`\n=== WC2026 calendar label resolver (dry-run) — ${playedCount}/104 played — map: ${mapSource} ===\n`);
  console.log('  ' + pad('M#', 4) + pad('Round', 7) + pad('Venue', 22) + 'Label');
  console.log('  ' + '-'.repeat(4 + 7 + 22 + 40));
  for (const p of plan) {
    const label = p.unchanged ? '(unchanged — feeders not ready)' : p.summary;
    console.log('  ' + pad(p.match, 4) + pad(p.round, 7) + pad(p.venue, 22) + label);
  }

  const changed = plan.filter((p) => !p.unchanged);
  const unchanged = plan.filter((p) => p.unchanged);
  console.log(`\n${changed.length} events to set, ${unchanged.length} left unchanged.`);
  if (unchanged.length) {
    console.log('Unchanged: ' + unchanged.map((p) => p.match).join(', '));
  }

  const outPath = join(__dirname, 'calendar-sync-plan.json');
  const out = plan.map((p) => ({
    match: p.match,
    eventId: p.eventId,
    calendarId: p.calendarId,
    summary: p.summary,
    description: p.description,
    unchanged: p.unchanged,
  }));
  await writeFile(outPath, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nWrote ${outPath}`);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
