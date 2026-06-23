// _lambda-sweep.mjs (throwaway) — title odds vs KO-variance λ.
// Group stage = pure Mark2 (Elo-faithful); knockout edge shrunk by λ.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { toGroups, fetchRaw } from './adapter.js';
import { resolveThirdPlaceSlots } from './allocation.js';
import * as M1 from './_model-mark1.js';
import * as M2 from './model.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
const loadJSON = async (f) => JSON.parse(await readFile(join(__dirname, f), 'utf8'));
const teams = await loadJSON('teams.json');
const bracket = await loadJSON('bracket.json');
const nm = Object.fromEntries(teams.map((t) => [t.code, t.name]));
const raw = await fetchRaw();
const groups = toGroups(raw, teams);
const HOSTS = new Set(['USA', 'MEX', 'CAN']);
const NT = 150000;
const base = { n: NT, seed: 12345, hostCodes: HOSTS, resolveThirdPlaceSlots };

const lambdas = [1.0, 0.7, 0.6, 0.5, 0.4];
const titleOf = (mc) => new Map(mc.perTeam.map((t) => [t.code, t.pWinCup]));
const finalOf = (mc) => new Map(mc.perTeam.map((t) => [t.code, t.pReachFinal]));

console.error('Mark1 baseline…');
const m1 = M1.monteCarlo(groups, bracket, base);
const cols = [{ key: 'M1', title: titleOf(m1), final: finalOf(m1) }];
for (const L of lambdas) {
  console.error(`Mark2 λ=${L}…`);
  const mc = M2.monteCarlo(groups, bracket, { ...base, koLambda: L });
  cols.push({ key: `λ${L}`, title: titleOf(mc), final: finalOf(mc) });
}

const mkt = { ARG: 14, ESP: 14, FRA: 21, ENG: '', BRA: '', POR: '' };
const order = cols[cols.length - 1].title; // sort by pure-ish Mark2
const codes = [...order.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map((x) => x[0]);
const p1 = (x) => (x * 100).toFixed(1).padStart(5);

console.log('\n=== TITLE ODDS vs KO-variance λ  (group stage = pure Mark2) ===');
console.log('  λ=1.0 = pure Mark2 (Elo-faithful KO) · lower λ = more KO upset variance\n');
console.log('  ' + 'team'.padEnd(14) + cols.map((c) => c.key.padStart(7)).join('') + '    mkt');
for (const code of codes) {
  console.log('  ' + nm[code].padEnd(14) +
    cols.map((c) => p1(c.title.get(code) || 0).padStart(7)).join('') +
    '    ' + (mkt[code] ?? ''));
}
console.log('\n=== REACH FINAL vs λ (same runs) ===');
console.log('  ' + 'team'.padEnd(14) + cols.map((c) => c.key.padStart(7)).join(''));
for (const code of codes) {
  console.log('  ' + nm[code].padEnd(14) +
    cols.map((c) => p1(c.final.get(code) || 0).padStart(7)).join(''));
}
