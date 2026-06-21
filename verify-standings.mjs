// verify-standings.mjs — eyeball the data layer against reality.
//
// Run:  node verify-standings.mjs
//
// Loads teams.json, fetches raw openfootball data, builds the 12 groups, runs
// computeGroupStanding on each, prints a standings table per group, then the
// rankThirdPlaceTeams top-8.

import { readFile } from 'node:fs/promises';
import { computeGroupStanding, rankThirdPlaceTeams } from './engine.js';
import { fetchRaw, toGroups } from './adapter.js';

function pad(s, w, right = false) {
  s = String(s);
  return right ? s.padStart(w) : s.padEnd(w);
}

function printGroup(group) {
  const standing = computeGroupStanding(group);
  console.log(`\n${group.name}`);
  console.log(
    `  ${pad('#', 2)} ${pad('Team', 4)} ${pad('P', 2, true)} ${pad('W', 2, true)} ${pad('D', 2, true)} ${pad('L', 2, true)} ${pad('GF', 3, true)} ${pad('GA', 3, true)} ${pad('GD', 3, true)} ${pad('Pts', 3, true)}`
  );
  for (const t of standing) {
    const flag = t.tiedByLots ? ' (lots)' : '';
    console.log(
      `  ${pad(t.rank, 2)} ${pad(t.code, 4)} ${pad(t.played, 2, true)} ${pad(t.won, 2, true)} ${pad(t.drawn, 2, true)} ${pad(t.lost, 2, true)} ${pad(t.gf, 3, true)} ${pad(t.ga, 3, true)} ${pad((t.gd >= 0 ? '+' : '') + t.gd, 3, true)} ${pad(t.points, 3, true)}${flag}`
    );
  }
}

async function main() {
  const teamsTable = JSON.parse(await readFile('teams.json', 'utf8'));
  const raw = await fetchRaw();
  const groups = toGroups(raw, teamsTable);

  // sanity
  if (groups.length !== 12) throw new Error(`expected 12 groups, got ${groups.length}`);
  for (const g of groups) {
    if (g.teams.length !== 4) throw new Error(`${g.name} has ${g.teams.length} teams`);
  }
  const playedCount = groups.reduce(
    (n, g) => n + g.matches.filter((m) => m.played).length,
    0
  );
  console.log('=== WC2026 group standings (data-layer verification) ===');
  console.log(`teams: ${teamsTable.length}  groups: ${groups.length}  group matches played: ${playedCount}`);

  for (const g of groups) printGroup(g);

  console.log('\n=== Third-place ranking (top 8 qualify) ===');
  const thirds = rankThirdPlaceTeams(groups);
  console.log(
    `  ${pad('#', 2)} ${pad('Team', 4)} ${pad('Grp', 8)} ${pad('P', 2, true)} ${pad('GD', 3, true)} ${pad('GF', 3, true)} ${pad('Pts', 3, true)} Q`
  );
  for (const t of thirds) {
    const flag = t.tiedByLots ? ' (lots)' : '';
    console.log(
      `  ${pad(t.rank, 2)} ${pad(t.code, 4)} ${pad(t.group, 8)} ${pad(t.played, 2, true)} ${pad((t.gd >= 0 ? '+' : '') + t.gd, 3, true)} ${pad(t.gf, 3, true)} ${pad(t.points, 3, true)} ${t.qualifies ? 'YES' : 'no '}${flag}`
    );
  }
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
