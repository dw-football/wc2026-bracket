// _compare-models.mjs  (throwaway — do not commit)
// Side-by-side Mark1 vs Mark2 at the CURRENT data state (44/104, ALG in).
//   PART A: remaining group-stage games — W / D / L per game.
//   PART B: per-team reach-round + title odds.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { toGroups, fetchRaw } from './adapter.js';
import { resolveThirdPlaceSlots } from './allocation.js';
import * as M1 from './_model-mark1.js';
import * as M2 from './model.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const loadJSON = async (f) => JSON.parse(await readFile(join(__dirname, f), 'utf8'));
const HOSTS = new Set(['USA', 'MEX', 'CAN']);
const HOST_BONUS = 80;
const hb = (code) => (HOSTS.has(code) ? HOST_BONUS : 0);
const p0 = (x) => (x * 100).toFixed(0).padStart(2);
const p1 = (x) => (x * 100).toFixed(1);

const teams = await loadJSON('teams.json');
const bracket = await loadJSON('bracket.json');
const elo = Object.fromEntries(teams.map((t) => [t.code, t.elo]));
const nm = Object.fromEntries(teams.map((t) => [t.code, t.name]));
const raw = await fetchRaw();
const groups = toGroups(raw, teams);
const letterOf = (g) => /Group\s+([A-L])/i.exec(g.name)[1].toUpperCase();

// ---- PART A: remaining group games, W/D/L under each model ----------------
const NG = 200000;
console.log('\n=== PART A — REMAINING GROUP GAMES: home-win / draw / away-win ===');
console.log('    (Mark1  vs  Mark2)        N=' + NG.toLocaleString() + '/game\n');
console.log('  ' + 'game'.padEnd(24) + '   Mark1 W/D/L      Mark2 W/D/L');
const wdl = (Model, eA, eB, oA, oB, seed) => {
  const rng = Model.makeRng(seed);
  let w = 0, d = 0, l = 0;
  for (let i = 0; i < NG; i++) {
    const { ga, gb } = Model.sampleMatch(eA, eB, rng, { hostBonusA: oA, hostBonusB: oB });
    if (ga > gb) w++; else if (ga === gb) d++; else l++;
  }
  return [w / NG, d / NG, l / NG];
};
let seed = 1000;
for (const g of [...groups].sort((a, b) => letterOf(a).localeCompare(letterOf(b)))) {
  const rem = g.matches.filter((m) => !m.played);
  if (!rem.length) continue;
  console.log(`\n Group ${letterOf(g)}:`);
  for (const m of rem) {
    const eA = elo[m.home], eB = elo[m.away], oA = hb(m.home), oB = hb(m.away);
    const a = wdl(M1, eA, eB, oA, oB, ++seed);
    const b = wdl(M2, eA, eB, oA, oB, seed); // same seed -> common random numbers
    const lab = `${nm[m.home]} v ${nm[m.away]}`;
    console.log('  ' + lab.padEnd(24) +
      `   ${p0(a[0])}/${p0(a[1])}/${p0(a[2])}        ${p0(b[0])}/${p0(b[1])}/${p0(b[2])}`);
  }
}

// ---- PART B: tournament Monte Carlo, both models --------------------------
const NT = 200000;
const run = (Model) => Model.monteCarlo(groups, bracket, {
  n: NT, seed: 12345, hostCodes: HOSTS, resolveThirdPlaceSlots,
});
console.error('running tournament MC (Mark1)…');
const r1 = run(M1);
console.error('running tournament MC (Mark2)…');
const r2 = run(M2);
const by1 = new Map(r1.perTeam.map((t) => [t.code, t]));
const by2 = new Map(r2.perTeam.map((t) => [t.code, t]));

// title market David cited (one-way, illustrative)
const mktTitle = { ARG: 14, ESP: 14, FRA: 21 };

const rows = r2.perTeam.slice().sort((a, b) => b.pWinCup - a.pWinCup).slice(0, 20);
console.log('\n\n=== PART B — REACH ROUND & TITLE  (Mark1 → Mark2, %), N=' + NT.toLocaleString() + ' ===\n');
console.log('  ' + 'team'.padEnd(16) + '  Adv(R32)    QF        SF       Final      Win    mkt');
const cell = (x, y) => `${p0(x)}→${p0(y)}`.padEnd(9);
for (const t of rows) {
  const a = by1.get(t.code), b = by2.get(t.code);
  const mk = mktTitle[t.code] != null ? String(mktTitle[t.code]) : '';
  console.log('  ' + `${nm[t.code]}`.padEnd(16) + '  ' +
    cell(a.pAdvance, b.pAdvance) + ' ' +
    cell(a.pReachQF, b.pReachQF) + ' ' +
    cell(a.pReachSF, b.pReachSF) + ' ' +
    cell(a.pReachFinal, b.pReachFinal) + ' ' +
    `${p1(a.pWinCup)}→${p1(b.pWinCup)}`.padEnd(11) + ' ' + mk);
}
console.log('\n  (Win column shows 1 decimal; mkt = one-way title market David cited)');
