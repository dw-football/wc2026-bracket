// claims-validator.test.js — node:test
//
//   node --test claims-validator.test.js
//
// CROSS-VALIDATION SUITE. The scenario prose (group-situation / scenario-summary)
// makes FALSIFIABLE claims — "X guarantees a top-2 place", "Clinched", "out of the
// top two". Hand-written expectations have themselves been wrong (a synthetic test
// once enshrined a false "two draws (or better)" guarantee). So instead of trusting
// hand-math, we check every claim against INDEPENDENT oracles:
//
//   ORACLE 1 (exhaustive enumeration): re-derive group standings from scratch over
//     ALL completions of the remaining matches, with a worst-case tiebreak rule
//     reimplemented here (NOT the code under test). Every "guarantees top-2" claim
//     must hold in every completion satisfying its stated condition; this catches
//     false guarantees automatically (the rock-paper-scissors / "(or better)" bug).
//
//   ORACLE 2 (Monte Carlo): a deterministic "Clinched / through / won-group" claim
//     must be 100% in the sim; an "out of the top two" claim must be 0% to top-2.
//
// Run across all 12 real groups + a battery of synthetic groups (incl. the RPS
// structure). If the prose ever asserts something the scenario space contradicts,
// THIS test fails — pointing at the exact team and counterexample.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fetchRaw, toGroups } from './adapter.js';
import { groupSituation } from './group-situation.js';
import { summarizeGroup } from './scenario-summary.js';
import { monteCarlo } from './model.js';
import { resolveThirdPlaceSlots } from './allocation.js';

// ---------------------------------------------------------------------------
// Independent helpers (deliberately NOT importing the engine's classification).
// ---------------------------------------------------------------------------

function basePoints(group) {
  const p = {};
  for (const t of group.teams) p[t.code] = 0;
  for (const m of group.matches) {
    if (!m.played) continue;
    if (m.homeGoals > m.awayGoals) p[m.home] += 3;
    else if (m.homeGoals < m.awayGoals) p[m.away] += 3;
    else { p[m.home] += 1; p[m.away] += 1; }
  }
  return p;
}

// Enumerate every coarse W/D/L completion of the unplayed matches.
// o: 0 = home win, 1 = away win, 2 = draw.
function* completions(group) {
  const base = basePoints(group);
  const unplayed = group.matches.filter((m) => !m.played);
  const k = unplayed.length;
  for (let n = 0; n < 3 ** k; n++) {
    const pts = { ...base };
    const own = {}; // code -> array of 'W'/'D'/'L' for that team's unplayed games
    for (const t of group.teams) own[t.code] = [];
    let x = n;
    for (let i = 0; i < k; i++) {
      const o = x % 3; x = Math.floor(x / 3);
      const m = unplayed[i];
      if (o === 0) { pts[m.home] += 3; own[m.home].push('W'); own[m.away].push('L'); }
      else if (o === 1) { pts[m.away] += 3; own[m.away].push('W'); own[m.home].push('L'); }
      else { pts[m.home] += 1; pts[m.away] += 1; own[m.home].push('D'); own[m.away].push('D'); }
    }
    yield { pts, own };
  }
}

// WORST-CASE rank for a team on POINTS in a completion: assume it loses every tie
// (1 + teams strictly above + teams level). Guaranteed top-2 iff worstRank <= 2.
// "strictly out" (a definite miss, not a GD tie) iff teams strictly above >= 2.
function rankFacts(pts, code) {
  const mine = pts[code];
  let above = 0, equal = 0;
  for (const c of Object.keys(pts)) {
    if (c === code) continue;
    if (pts[c] > mine) above++;
    else if (pts[c] === mine) equal++;
  }
  return { above, worstRank: 1 + above + equal };
}

// --- cross-group ceilings (independent reimplementation) -------------------
function maxThirdPoints(group) {
  const base = basePoints(group);
  const unplayed = group.matches.filter((m) => !m.played);
  const k = unplayed.length;
  let mx = -1;
  for (let n = 0; n < 3 ** k; n++) {
    const pts = { ...base }; let x = n;
    for (let i = 0; i < k; i++) {
      const o = x % 3; x = Math.floor(x / 3); const m = unplayed[i];
      if (o === 0) pts[m.home] += 3; else if (o === 1) pts[m.away] += 3; else { pts[m.home]++; pts[m.away]++; }
    }
    const s = Object.values(pts).sort((a, b) => b - a);
    if (s[2] > mx) mx = s[2];
  }
  return mx;
}
function ceilingsOf(groups) {
  const m = {};
  for (const g of groups) { const L = /Group\s+([A-L])/i.exec(g.name)?.[1]; if (L) m[L] = maxThirdPoints(g); }
  return m;
}
function thirdQualifies(P, ownL, ceil) {
  let c = 0;
  for (const L of Object.keys(ceil)) { if (L === ownL) continue; if (ceil[L] >= P) c++; }
  return c <= 7;
}
// Worst-case ADVANCEMENT: top-2, or a guaranteed top-8 third.
function advancesWorst(pts, code, ownL, ceil) {
  const f = rankFacts(pts, code);
  if (f.worstRank <= 2) return true;
  if (f.worstRank >= 3 + 1) return false;
  return thirdQualifies(pts[code], ownL, ceil);
}
// Sole top on points (wins the group outright).
function soleTop(pts, code) {
  const mine = pts[code];
  return Object.keys(pts).every((c) => c === code || pts[c] < mine);
}

// A bare condition phrase -> predicate(own[], delta, total).
function condPredicate(cond) {
  if (/two draws \(or better\)/.test(cond)) return (_o, d) => d >= 2;
  if (/a single draw \(or better\)|a draw \(or better\)/.test(cond)) return (_o, d) => d >= 1;
  if (/a win and a draw/.test(cond)) return (_o, d) => d >= 4;
  if (/two wins|winning both games/.test(cond)) return (own) => own.length > 0 && own.every((r) => r === 'W');
  if (/at least one win|a win in either game|^a win$/.test(cond)) return (own) => own.includes('W');
  if (/avoiding defeat in both games/.test(cond)) return (own) => own.every((r) => r !== 'L');
  const ptsM = cond.match(/(\d+)\+ points/);
  if (ptsM) { const N = +ptsM[1]; return (_o, _d, total) => total >= N; }
  return null;
}

// Parse a needLine into falsifiable clauses: { cond, target } where target is
// 'r32' (advancement) or 'top2'. Strips the trailing "— X% to advance overall".
function parseClaims(needLine) {
  const body = needLine.replace(/\s*—\s*[\d.]+%.*$/, '').replace(/\.$/, '');
  const out = [];
  for (const seg of body.split('; ')) {
    let m = seg.match(/^(.+?) guarantees a Round-of-32 place$/i);
    if (m) { out.push({ cond: m[1].toLowerCase(), target: 'r32' }); continue; }
    m = seg.match(/^(.+?) guarantees a top-2 place$/i);
    if (m) { out.push({ cond: m[1].toLowerCase(), target: 'top2' }); continue; }
    m = seg.match(/^(.+?) clinches a top-2 (?:seed|place)$/i);
    if (m) { out.push({ cond: m[1].toLowerCase(), target: 'top2' }); continue; }
    m = seg.match(/^(.+?) clinches top spot$/i);
    if (m) { out.push({ cond: m[1].toLowerCase(), target: 'first' }); continue; }
  }
  return out;
}

function loadGroups() {
  return (async () => {
    const teams = JSON.parse(await readFile(new URL('./teams.json', import.meta.url), 'utf8'));
    const raw = await fetchRaw();
    return { groups: toGroups(raw, teams), teams };
  })();
}

// Synthetic battery: include the RPS structure (two teams on 3, two on 0, each
// with 2 games left) — the exact non-monotone trap.
const T = (code) => ({ code, name: code, elo: 1700 });
const MK = (home, away, hg, ag) => ({
  home, away, homeGoals: hg, awayGoals: ag, played: hg != null && ag != null,
  date: '2026-06-15', time: '12:00',
});
function rpsGroup(letter) {
  const t = [letter + '1', letter + '2', letter + '3', letter + '4'];
  // t0 beat t2, t1 beat t3 (round 1). Remaining: t0-t1, t0-t3, t1-t2, t2-t3.
  return {
    name: 'Group ' + letter,
    teams: t.map(T),
    matches: [
      MK(t[0], t[2], 1, 0), MK(t[1], t[3], 1, 0),
      MK(t[0], t[1], null, null), MK(t[0], t[3], null, null),
      MK(t[1], t[2], null, null), MK(t[2], t[3], null, null),
    ],
  };
}

// ---------------------------------------------------------------------------
// ORACLE 1 — every "guarantees top-2" claim holds over all completions.
// ---------------------------------------------------------------------------

function validateGuarantees(group, allGroups, sit) {
  const ceil = ceilingsOf(allGroups);
  const ownL = /Group\s+([A-L])/i.exec(group.name)?.[1];
  const base = basePoints(group);
  for (const tm of sit.teams) {
    const claims = parseClaims(tm.needLine || '');
    for (const { cond, target } of claims) {
      const pred = condPredicate(cond);
      assert.ok(pred, `${group.name} ${tm.code}: unparseable guarantee condition "${cond}" in "${tm.needLine}"`);
      for (const comp of completions(group)) {
        const own = comp.own[tm.code];
        const delta = comp.pts[tm.code] - base[tm.code];
        if (!pred(own, delta, comp.pts[tm.code])) continue;
        const ok = target === 'r32'
          ? advancesWorst(comp.pts, tm.code, ownL, ceil)
          : target === 'first'
            ? soleTop(comp.pts, tm.code)
            : rankFacts(comp.pts, tm.code).worstRank <= 2;
        assert.ok(
          ok,
          `${group.name} ${tm.code}: "${tm.needLine}" claims "${cond}" => ${target}, but a ` +
          `completion satisfying it FAILS (own=${own.join('')}, pts=${JSON.stringify(comp.pts)}).`
        );
      }
    }
  }
}

test('ORACLE 1: real groups — every guarantee (R32 / top-2) holds in all completions', async () => {
  const { groups } = await loadGroups();
  for (const g of groups) validateGuarantees(g, groups, groupSituation(g, { allGroups: groups }));
});

test('ORACLE 1: synthetic RPS battery — guarantees hold and are honest', () => {
  const groups = ['A', 'B', 'C'].map(rpsGroup);
  for (const g of groups) {
    const sit = groupSituation(g, { allGroups: groups });
    // No team may claim a TOP-2 guarantee on a points threshold (the RPS trap):
    // a "(or better) … top-2" claim is exactly the bug. (R32 thresholds are fine.)
    for (const tm of sit.teams) {
      assert.doesNotMatch(tm.needLine, /\(or better\) guarantees a top-2/,
        `${g.name} ${tm.code}: must not claim a points-threshold TOP-2 guarantee`);
    }
    validateGuarantees(g, groups, sit);
  }
});

// ---------------------------------------------------------------------------
// ORACLE 2 — Monte Carlo must agree with deterministic "through" / "out" prose.
// ---------------------------------------------------------------------------

test('ORACLE 2: MC agrees with clinch / elimination prose', async () => {
  const { groups, teams } = await loadGroups();
  const bracket = JSON.parse(await readFile(new URL('./bracket.json', import.meta.url), 'utf8'));
  const mc = monteCarlo(groups, bracket, {
    n: 20000, seed: 7, hostCodes: new Set(['USA', 'MEX', 'CAN']), resolveThirdPlaceSlots,
  });
  const byCode = new Map(mc.perTeam.map((t) => [t.code, t]));

  for (const g of groups) {
    const sit = groupSituation(g, { mcByCode: Object.fromEntries(byCode), allGroups: groups });
    for (const tm of sit.teams) {
      const e = byCode.get(tm.code);
      const top2 = (e.pGroup1 ?? 0) + (e.pGroup2 ?? 0);
      const through = /Clinched a Round-of-32 place|Through to the R32|Qualified for the Round|Won the group|Clinched 1st/.test(tm.statusLine);
      if (through) {
        assert.ok(e.pAdvance >= 0.9995,
          `${g.name} ${tm.code}: prose says "${tm.statusLine}" but MC pAdvance=${(e.pAdvance * 100).toFixed(2)}% (< 100%).`);
      }
      if (tm.status === 'won-group') {
        assert.ok(e.pGroup1 >= 0.9995,
          `${g.name} ${tm.code}: prose says won-group but MC pGroup1=${(e.pGroup1 * 100).toFixed(2)}%.`);
      }
      if (/Out of the top two|Eliminated/.test(tm.statusLine)) {
        assert.ok(top2 <= 0.0005,
          `${g.name} ${tm.code}: prose says out of top two but MC top-2=${(top2 * 100).toFixed(2)}%.`);
      }
    }
  }
});
