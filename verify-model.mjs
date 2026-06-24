// verify-model.mjs
// Node harness for model.js. Loads real data, runs a 20k-sim Monte Carlo with a
// fixed seed and hosts {USA, MEX, CAN}, and prints a readable sanity report.
//
//   node verify-model.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { toGroups, fetchRaw } from './adapter.js';
import { resolveThirdPlaceSlots } from './allocation.js';
import { monteCarlo, venueCountryOf } from './model.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const loadJSON = async (f) => JSON.parse(await readFile(join(__dirname, f), 'utf8'));

const pct = (p) => (p * 100).toFixed(1).padStart(5) + '%';

async function main() {
  const teams = await loadJSON('teams.json');
  const bracket = await loadJSON('bracket.json');
  const koSchedule = await loadJSON('knockout-schedule.json');
  const raw = await fetchRaw(); // uses cached data/raw/worldcup.json
  const groups = toGroups(raw, teams);

  // Venue-aware host bonus: map each knockout match to its host-country venue (or
  // null) so the +80 Elo only applies when USA/MEX/CAN actually play at home —
  // mirrors build-html.mjs's bake.
  const koVenueCountry = {};
  for (const k of Object.keys(koSchedule)) {
    koVenueCountry[k] = venueCountryOf(koSchedule[k].venue || koSchedule[k].ground);
  }

  const codeName = new Map(teams.map((t) => [t.code, t.name]));
  const N = 20000;

  const t0 = Date.now();
  const mc = monteCarlo(groups, bracket, {
    n: N,
    seed: 12345,
    hostCodes: new Set(['USA', 'MEX', 'CAN']),
    koLambda: 0.6, // mirror build-html KO_LAMBDA (live Mark2 model)
    koVenueCountry, // venue-aware host bonus (mirror build-html bake)
    resolveThirdPlaceSlots,
  });
  const elapsedMs = Date.now() - t0;

  const byCode = new Map(mc.perTeam.map((t) => [t.code, t]));

  // -- title odds ------------------------------------------------------------
  console.log(`\n=== 2026 World Cup Monte Carlo (${N.toLocaleString()} sims, seed 12345, hosts USA/MEX/CAN) ===\n`);
  console.log('Top 15 by title odds (pWinCup):');
  console.log('  ' + 'team'.padEnd(22) + '  title   reachF   reachSF');
  for (const t of mc.perTeam.slice(0, 15)) {
    console.log(
      '  ' + `${t.name} (${t.code})`.padEnd(22) +
      '  ' + pct(t.pWinCup) + '  ' + pct(t.pReachFinal) + '  ' + pct(t.pReachSF)
    );
  }

  // -- groups A, D, E --------------------------------------------------------
  const letterOf = (g) => /Group\s+([A-L])/i.exec(g.name)[1].toUpperCase();
  const groupByLetter = new Map(groups.map((g) => [letterOf(g), g]));
  for (const L of ['A', 'D', 'E']) {
    const g = groupByLetter.get(L);
    console.log(`\nGroup ${L} — pWinGroup / pReachR16:`);
    for (const team of g.teams) {
      const s = byCode.get(team.code);
      console.log(
        '  ' + `${team.name} (${team.code})`.padEnd(22) +
        '  win grp ' + pct(s.pWinGroup) + '   reach R16 ' + pct(s.pReachR16)
      );
    }
  }

  // -- modal R32 bracket -----------------------------------------------------
  console.log('\nModal Round-of-32 bracket (most-likely occupant each side):');
  for (const slot of mc.modalBracket) {
    const h = slot.home, a = slot.away;
    const hN = h.code ? `${codeName.get(h.code) ?? h.code}` : '—';
    const aN = a.code ? `${codeName.get(a.code) ?? a.code}` : '—';
    console.log(
      `  M${slot.match}: ` +
      `${hN} (${pct(h.p).trim()}) vs ${aN} (${pct(a.p).trim()})`
    );
  }

  // -- focus teams -----------------------------------------------------------
  console.log('\nFocus teams — pReachQF / pReachSF / pReachFinal / pWinCup:');
  for (const code of ['USA', 'MEX', 'GER']) {
    const s = byCode.get(code);
    if (!s) { console.log(`  ${code}: (not found in teams.json)`); continue; }
    console.log(
      '  ' + `${s.name} (${code})`.padEnd(22) +
      '  QF ' + pct(s.pReachQF) + '  SF ' + pct(s.pReachSF) +
      '  F ' + pct(s.pReachFinal) + '  Cup ' + pct(s.pWinCup)
    );
  }

  console.log(`\nWall-clock: ${elapsedMs} ms for ${N.toLocaleString()} sims ` +
    `(${(elapsedMs / N * 1000).toFixed(1)} µs/sim)\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
