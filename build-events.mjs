// build-events.mjs
// ============================================================================
// ESPN match-events BACKFILL/cache builder (#3). Walks every PLAYED match (group
// + knockout), finds its ESPN event id from the scoreboard for that date, fetches
// + parses the event timeline (espn-events.mjs), orients it to OUR home/away, and
// writes an INCREMENTAL cache to data/match-events.json:
//   - knockout match  -> key "<matchNo>"           (e.g. "73")
//   - group match     -> key "g:<HOME>-<AWAY>"     (e.g. "g:MEX-RSA")
// each value = { home, away, events:[…], pens:[…] }.
//
// Incremental: a key already in the cache is skipped (re-runs only fetch NEW
// matches) unless --all forces a re-fetch. build-html.mjs READS this cache and
// bakes koDetails (offline + fast); this script is the only thing that hits ESPN.
//
//   node build-events.mjs              # backfill any newly-played matches
//   node build-events.mjs --all        # re-fetch everything (rebuild the cache)
//   node build-events.mjs --refresh    # re-pull the openfootball feed first
// ============================================================================

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { fetchRaw, toGroups, nameToCode } from './adapter.js';
import { resolveThirdPlaceSlots } from './allocation.js';
import {
  knockoutResultsFromRaw, knockoutResultsFromManual, mergeKnockoutResults,
  resolveKnockoutFixtures,
} from './bracket-labels.mjs';
import { scoreboardEvents, fetchMatchEvents } from './espn-events.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const loadJSON = async (f) => JSON.parse(await readFile(join(__dirname, f), 'utf8'));
const CACHE = join(__dirname, 'data', 'match-events.json');

const norm = (s) => String(s || '').toUpperCase();
/** Reorient a parsed timeline (relative to ESPN's home/away) to OUR home code. */
function orientTo(parsed, ourHome) {
  if (!parsed.home || norm(parsed.home) === norm(ourHome)) return parsed;
  const flip = (side) => (side === 'home' ? 'away' : side === 'away' ? 'home' : side);
  return {
    home: ourHome, away: parsed.home === ourHome ? parsed.away : parsed.home,
    events: parsed.events.map((e) => ({ ...e, team: flip(e.team) })),
    pens: parsed.pens.map((p) => ({ ...p, team: flip(p.team) })),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const refresh = args.includes('--refresh');

  const [teams, bracket, koSchedule] = await Promise.all([
    loadJSON('teams.json'), loadJSON('bracket.json'), loadJSON('knockout-schedule.json'),
  ]);
  const n2c = nameToCode(teams);
  const raw = await fetchRaw({ refresh });
  const groups = toGroups(raw, teams);
  const manualKo = existsSync(join(__dirname, 'manual-ko-results.json'))
    ? await loadJSON('manual-ko-results.json') : [];
  const koResults = mergeKnockoutResults(
    knockoutResultsFromManual(manualKo), knockoutResultsFromRaw(raw, teams));
  const fixtures = resolveKnockoutFixtures(groups, bracket, koResults, { resolveThirdPlaceSlots });

  // Worklist: { key, date, home, away } for every PLAYED match.
  const work = [];
  for (const m of raw.matches || []) {
    const played = m.score && Array.isArray(m.score.ft) && m.score.ft.length === 2;
    if (!played) continue;
    if (/^Group [A-L]$/.test(m.group || '')) {
      const home = n2c.get(m.team1), away = n2c.get(m.team2);
      if (home && away) work.push({ key: `g:${home}-${away}`, date: m.date, home, away });
    } else {
      const num = m.num ?? m.match;
      const fx = fixtures[num] || (koResults[num] && { home: koResults[num].home, away: koResults[num].away });
      const date = (koSchedule[num] && koSchedule[num].date) || m.date;
      if (num != null && fx && fx.home && fx.away) work.push({ key: String(num), date, home: fx.home, away: fx.away });
    }
  }

  const cache = existsSync(CACHE) ? await loadJSON('data/match-events.json') : {};
  const todo = work.filter((w) => all || !cache[w.key]);
  console.log(`${work.length} played match(es); ${todo.length} to fetch${all ? ' (--all)' : ''}.`);

  // Group the work by date so we hit each scoreboard once, then a summary per match.
  const byDate = new Map();
  for (const w of todo) { if (!byDate.has(w.date)) byDate.set(w.date, []); byDate.get(w.date).push(w); }

  // Scoreboard for a YYYY-MM-DD plus the day either side (a KO/late game can land
  // on the adjacent UTC date), merged + de-duped by event id.
  async function boardWindow(date) {
    const base = Date.parse(`${date}T12:00:00Z`);
    const seen = new Map();
    for (let d = -1; d <= 1; d++) {
      const t = new Date(base + d * 86400000);
      const ymd = `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}${String(t.getUTCDate()).padStart(2, '0')}`;
      try { for (const e of await scoreboardEvents(ymd)) seen.set(e.id, e); }
      catch (e) { console.warn(`  scoreboard ${ymd}: ${e.message}`); }
    }
    return [...seen.values()];
  }

  let fetched = 0, missed = 0;
  for (const [date, items] of byDate) {
    let board = [];
    try { board = await boardWindow(date); } catch (e) { console.warn(`  scoreboard ${date}: ${e.message}`); }
    for (const w of items) {
      const want = new Set([norm(w.home), norm(w.away)]);
      const ev = board.find((e) => { const s = new Set(e.codes); return [...want].every((c) => s.has(c)); });
      if (!ev) { console.warn(`  no ESPN event for ${w.key} (${w.home} v ${w.away}) on ${ymd}`); missed++; continue; }
      try {
        const parsed = orientTo(await fetchMatchEvents(ev.id), w.home);
        cache[w.key] = { home: w.home, away: w.away, events: parsed.events, pens: parsed.pens };
        fetched++;
        process.stdout.write(`  ${w.key} ${w.home} v ${w.away}: ${parsed.events.length} ev${parsed.pens.length ? ` +${parsed.pens.length} pens` : ''}\n`);
      } catch (e) { console.warn(`  summary ${w.key}: ${e.message}`); missed++; }
    }
  }

  await mkdir(join(__dirname, 'data'), { recursive: true });
  await writeFile(CACHE, JSON.stringify(cache, null, 1) + '\n');
  console.log(`\nWrote data/match-events.json — ${Object.keys(cache).length} cached (${fetched} new, ${missed} missed).`);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });
