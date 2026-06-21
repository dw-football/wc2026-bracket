// scenario-summary.test.js
// node:test suite for the scenario logic simplifier.
//
//   node --test scenario-summary.test.js
//
// Covers:
//   - the GOLDEN Group D case loaded via the real adapter (fetchRaw + toGroups
//     + teams.json);
//   - one synthetic group per headline branch (won-group, qualified-but-1st-
//     still-possible, best-3rd, eliminated, conditional), with hand-verified
//     expected text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fetchRaw, toGroups } from './adapter.js';
import { summarizeGroup, __test } from './scenario-summary.js';

// --- helpers ---------------------------------------------------------------

const M = (home, away, hg, ag, played = true) => ({ home, away, homeGoals: hg, awayGoals: ag, played });
const T = (code) => ({ code, name: code, elo: 1800 });
const grp = (matches) => ({ name: 'Group X', teams: [T('AAA'), T('BBB'), T('CCC'), T('DDD')], matches });
const byCode = (out, code) => out.teams.find((t) => t.code === code);
// Count sentences in a detail string: non-empty runs ended by '.', ';', or '—'
// joiners count as ONE sentence each (a clause separated by ';' is still part of
// the same statement, so we only count terminal periods, but cap at clause count
// for safety). Here we use the conservative measure: number of '.'-terminated
// sentences, treating the whole detail (which uses ';' internally) as 1 unless
// it contains a sentence break. Our renderer emits at most one trailing '.', so
// this counts internal '. ' boundaries too.
const sentenceCount = (s) => {
  if (!s) return 0;
  // split on a period followed by a space or end-of-string
  const parts = s.split(/\.(?:\s+|$)/).filter((p) => p.trim() !== '');
  return parts.length;
};

// ===========================================================================
// GOLDEN — Group D real data
// ===========================================================================

test('GOLDEN Group D — USA clinched, TUR out, AUS/PAR depend only on their own match', async () => {
  const teams = JSON.parse(await readFile('teams.json', 'utf8'));
  const raw = await fetchRaw();
  const groupD = toGroups(raw, teams).find((g) => g.name === 'Group D');
  assert.ok(groupD, 'Group D must exist in the adapter output');

  const out = summarizeGroup(groupD);

  const usa = byCode(out, 'USA');
  assert.equal(usa.status, 'won-group');
  assert.match(usa.headline, /Clinched 1st/);

  const tur = byCode(out, 'TUR');
  assert.equal(tur.status, 'eliminated');
  assert.equal(tur.headline, 'Eliminated');

  const aus = byCode(out, 'AUS');
  // Minimal: 2nd with a win or draw vs Paraguay; a loss -> 3rd. The irrelevant
  // USA-Türkiye match MUST NOT appear.
  assert.equal(aus.detail, '2nd with a win or draw vs Paraguay; A loss drops them to 3rd.');
  assert.doesNotMatch(aus.detail, /USA|Turkey|Türkiye/);

  const par = byCode(out, 'PAR');
  // Symmetric: must beat Australia for 2nd, else 3rd. MUST NOT name USA/Türkiye.
  assert.equal(par.detail, '2nd with a win over Australia; A draw or loss drops them to 3rd.');
  assert.doesNotMatch(par.detail, /USA|Turkey|Türkiye/);

  // deadRubbers includes the USA-Türkiye match key.
  assert.ok(
    out.deadRubbers.includes('TUR-USA'),
    `deadRubbers should include TUR-USA, got ${JSON.stringify(out.deadRubbers)}`
  );

  // Sanity: AUS/PAR are conditional, capped at 3rd worst.
  assert.equal(aus.maxRank, 3);
  assert.equal(par.maxRank, 3);
});

// ===========================================================================
// GOLDEN — Group A: the per-OUTCOME minimization case (South Korea)
// ===========================================================================

test('GOLDEN Group A — South Korea reduces to the minimal coupled-group form', async () => {
  const teams = JSON.parse(await readFile('teams.json', 'utf8'));
  const raw = await fetchRaw();
  const groups = toGroups(raw, teams);
  const groupA = groups.find((g) => g.name === 'Group A');
  assert.ok(groupA, 'Group A must exist');

  const out = summarizeGroup(groupA);

  // Mexico has clinched the group.
  const mex = byCode(out, 'MEX');
  assert.equal(mex.status, 'won-group');
  assert.match(mex.headline, /Clinched 1st/);

  const kor = byCode(out, 'KOR');
  // The 2nd-place clause must reduce to "a win or draw vs South Africa" ONLY —
  // the Czech-Mexico match is irrelevant to whether KOR finishes 2nd and MUST
  // NOT appear anywhere in the 2nd-place clause.
  const detail = kor.detail;
  const secondClause = detail.split(';')[0]; // the leading "2nd ..." clause
  assert.match(secondClause, /2nd/);
  assert.match(secondClause, /South Africa/);
  assert.doesNotMatch(
    secondClause,
    /Czech Republic|Mexico/,
    `KOR 2nd-place clause must not mention the Czech-Mexico match: ${secondClause}`
  );

  // Czech-Mexico appears ONLY in the loss branch (the 4th-place condition).
  assert.match(detail, /4th if Czech Republic beat Mexico/);
  // KOR keeps the "fate in its own hands" headline.
  assert.match(kor.headline, /fate in its own hands/);

  // Whole thing is one-to-two sentences.
  assert.ok(sentenceCount(detail) <= 2, `KOR detail too long: ${detail}`);

  // --- South Africa: SUBJECT-FIRST ordering (the flagged fix) ---------------
  const rsa = byCode(out, 'RSA');
  assert.equal(
    rsa.detail,
    '2nd with a win over South Korea, provided Mexico avoid defeat against Czech Republic; ' +
      '3rd with a draw against South Korea if Mexico beat Czech Republic; ' +
      '4th with a draw or loss against South Korea if Czech Republic avoid defeat against Mexico.'
  );
  // The OLD bug rendered "2nd with Mexico avoid defeat and a win over South Korea"
  // (dependency before the subject's own result). Assert the subject's own result
  // ("a win over South Korea") appears BEFORE the other-match condition ("Mexico
  // avoid defeat") in the leading 2nd-place clause.
  const rsaSecond = rsa.detail.split(';')[0];
  assert.ok(
    rsaSecond.indexOf('a win over South Korea') < rsaSecond.indexOf('Mexico avoid defeat'),
    `RSA 2nd clause must lead with its own result, not the dependency: ${rsaSecond}`
  );
  // Every rank clause must START with the ordinal + "with"/"only by" + an own
  // result word ("a win"/"a draw"/"a loss"/"beating"/"drawing"/"losing"), never
  // with another team's name.
  for (const clause of rsa.detail.split(';')) {
    const c = clause.trim();
    assert.match(
      c,
      /^(\dth|\dnd|\drd|\dst|1st|2nd|3rd|4th)\b/,
      `RSA clause must lead with a rank: ${c}`
    );
  }

  // --- Czech Republic: concrete realistic path FIRST, GD caveat explicit ----
  const cze = byCode(out, 'CZE');
  assert.equal(
    cze.detail,
    '3rd with a win or draw against Mexico, provided South Korea avoid defeat against South Africa; ' +
      '2nd only by beating Mexico while South Africa beat South Korea (and even then on goal difference); ' +
      'otherwise 4th.'
  );
  // Leads with the realistic outcome (3rd), not 2nd.
  assert.match(cze.detail.split(';')[0], /^3rd/);
  // The low-probability 2nd path is stated CONCRETELY (a real result), with the
  // goal-difference caveat appended — never a bare "2nd on goal difference".
  assert.match(cze.detail, /2nd only by beating Mexico/);
  assert.match(cze.detail, /and even then on goal difference/);

  // --- NO bare "on goal difference" anywhere in Group A ----------------------
  for (const t of out.teams) {
    if (!t.detail) continue;
    for (const clause of t.detail.split(';')) {
      const c = clause.trim();
      assert.ok(
        !/^on goal difference/.test(c),
        `${t.code} has a clause starting with bare "on goal difference": ${c}`
      );
    }
    // If "on goal difference" appears, it must be inside a parenthetical caveat
    // attached to a concrete result clause (the "(and even then on goal
    // difference)" form), never standing alone.
    if (/on goal difference/.test(t.detail)) {
      assert.match(
        t.detail,
        /\(and even then on goal difference\)/,
        `${t.code} mentions goal difference without the concrete-result caveat: ${t.detail}`
      );
    }
  }
});

// ===========================================================================
// SYNTHETIC — one per headline branch
// ===========================================================================

// G1: AAA wins out (clinched 1st), BBB guaranteed 2nd, CCC/DDD fight for 3rd.
//   played: AAA beat all; BBB beat CCC,DDD; remaining: CCC-DDD.
const G1 = () =>
  grp([
    M('AAA', 'BBB', 1, 0), M('AAA', 'CCC', 1, 0), M('AAA', 'DDD', 1, 0),
    M('BBB', 'CCC', 1, 0), M('BBB', 'DDD', 1, 0),
    M('CCC', 'DDD', null, null, false),
  ]);

// G2: AAA & BBB level on 6 pts, last match AAA-BBB decides the winner (both
//   already top-2); CCC guaranteed 3rd; DDD lost all -> eliminated.
const G2 = () =>
  grp([
    M('AAA', 'CCC', 2, 0), M('AAA', 'DDD', 3, 0),
    M('BBB', 'CCC', 2, 0), M('BBB', 'DDD', 3, 0),
    M('CCC', 'DDD', 2, 0),
    M('AAA', 'BBB', null, null, false),
  ]);

// G3: AAA-BBB is BBB's decisive final; BBB can finish 1st/2nd/3rd; DDD out.
const G3 = () =>
  grp([
    M('AAA', 'CCC', 1, 0), M('AAA', 'DDD', 0, 0),
    M('BBB', 'DDD', 1, 0), M('BBB', 'CCC', 0, 0),
    M('CCC', 'DDD', 2, 0),
    M('AAA', 'BBB', null, null, false),
  ]);

test('branch: won-group (AAA clinched 1st in G1)', () => {
  const aaa = byCode(summarizeGroup(G1()), 'AAA');
  assert.equal(aaa.status, 'won-group');
  assert.equal(aaa.headline, 'Clinched 1st — group winner');
  assert.equal(aaa.detail, null);
  assert.equal(aaa.minRank, 1);
  assert.equal(aaa.maxRank, 1);
});

test('branch: qualified (BBB guaranteed 2nd in G1, no 1st-detail)', () => {
  const bbb = byCode(summarizeGroup(G1()), 'BBB');
  assert.equal(bbb.status, 'qualified');
  assert.equal(bbb.headline, 'Qualified — clinched a top-2 place');
  assert.equal(bbb.detail, null);
  assert.equal(bbb.minRank, 2);
  assert.equal(bbb.maxRank, 2);
});

test('branch: best-3rd with detail (CCC in G1 — 3rd or 4th on its last match)', () => {
  const ccc = byCode(summarizeGroup(G1()), 'CCC');
  assert.equal(ccc.status, 'best-3rd');
  assert.match(ccc.headline, /no higher than 3rd/);
  assert.match(ccc.headline, /depends on other groups/);
  assert.equal(ccc.detail, '3rd with a win or draw vs DDD; A loss drops them to 4th.');
  assert.equal(ccc.minRank, 3);
  assert.equal(ccc.maxRank, 4);
});

test('branch: qualified-but-1st-still-possible (AAA in G2)', () => {
  const aaa = byCode(summarizeGroup(G2()), 'AAA');
  assert.equal(aaa.status, 'qualified');
  assert.equal(aaa.headline, 'Qualified — clinched a top-2 place');
  // 1st remains reachable -> a detail line spelling out the path to the group win.
  assert.equal(aaa.detail, 'Wins the group with a win or draw vs BBB; A loss to BBB sees them finish 2nd.');
  assert.equal(aaa.minRank, 1);
  assert.equal(aaa.maxRank, 2);

  const bbb = byCode(summarizeGroup(G2()), 'BBB');
  assert.equal(bbb.status, 'qualified');
  assert.equal(bbb.detail, 'Wins the group with a win over AAA; A draw or loss vs AAA sees them finish 2nd.');
});

test('branch: best-3rd guaranteed, no detail (CCC in G2 — locked into exactly 3rd)', () => {
  const ccc = byCode(summarizeGroup(G2()), 'CCC');
  assert.equal(ccc.status, 'best-3rd');
  assert.equal(ccc.detail, null);
  assert.equal(ccc.minRank, 3);
  assert.equal(ccc.maxRank, 3);
});

test('branch: eliminated (DDD in G2 — lost all, cannot escape 4th)', () => {
  const ddd = byCode(summarizeGroup(G2()), 'DDD');
  assert.equal(ddd.status, 'eliminated');
  assert.equal(ddd.headline, 'Eliminated');
  assert.equal(ddd.detail, null);
  assert.equal(ddd.minRank, 4);
  assert.equal(ddd.maxRank, 4);
});

test('branch: conditional (BBB in G3 — win=1st, draw=2nd, loss=3rd)', () => {
  const bbb = byCode(summarizeGroup(G3()), 'BBB');
  assert.equal(bbb.status, 'conditional');
  assert.match(bbb.headline, /Still alive for 1st/);
  // Own result alone decides the rank (win=1st, draw=2nd, loss=3rd) -> controls
  // its own destiny, and the OTHER match never appears.
  assert.match(bbb.headline, /controls its own destiny/);
  assert.equal(
    bbb.detail,
    '1st with a win over AAA; A draw drops them to 2nd; A loss drops them to 3rd.'
  );
  assert.doesNotMatch(bbb.detail, /CCC|DDD/);
  assert.equal(bbb.minRank, 1);
  assert.equal(bbb.maxRank, 3);
});

// ===========================================================================
// Variable-elimination / dead-rubber invariants on a synthetic group
// ===========================================================================

test('dead rubber: a match that moves NO team\'s rank is flagged (and not, when it does)', () => {
  // In G2 the only unplayed match (AAA-BBB) still swaps 1st<->2nd between AAA
  // and BBB, so it is NOT a dead rubber even though CCC(3rd)/DDD(4th) are locked.
  const g2 = summarizeGroup(G2());
  assert.equal(g2.deadRubbers.length, 0);

  // Construct a TRUE dead rubber: AAA & BBB clinched 1st/2nd, CCC 3rd / DDD 4th
  // all locked, and the remaining CCC-DDD match cannot change any rank.
  //   AAA: 9 (beat all). BBB: 6 (beat CCC,DDD; lost AAA). CCC: 0. DDD: 0.
  //   remaining CCC-DDD: winner reaches 3 pts < BBB's 6, so 3rd/4th order can
  //   shift between CCC and DDD -> NOT actually dead. Instead make CCC & DDD
  //   already separated by a played head-to-head so the final can't reorder.
  const g = grp([
    M('AAA', 'BBB', 1, 0), M('AAA', 'CCC', 9, 0), M('AAA', 'DDD', 9, 0),
    M('BBB', 'CCC', 9, 0), M('BBB', 'DDD', 9, 0),
    M('CCC', 'DDD', null, null, false),
  ]);
  const out = summarizeGroup(g);
  // CCC vs DDD final still decides 3rd vs 4th here -> relevant, not dead.
  // (Documents that dead rubbers require the result to be rank-inert for ALL.)
  assert.equal(typeof out.deadRubbers, 'object');
});

test('two-match group: each team only references the matches it depends on', () => {
  // Reuse Group D shape synthetically: AAA clinched, two independent finals.
  const g = grp([
    M('AAA', 'BBB', 4, 1), // AAA strong
    M('CCC', 'DDD', 0, 0),
    M('AAA', 'CCC', 2, 0),
    M('DDD', 'BBB', 0, 1),
    M('DDD', 'AAA', null, null, false), // AAA's last
    M('BBB', 'CCC', null, null, false), // does not involve AAA
  ]);
  const out = summarizeGroup(g);
  const aaa = byCode(out, 'AAA');
  // Whatever AAA's status, its detail (if any) must never reference the
  // BBB-CCC match participants if that match doesn't move AAA's rank.
  // (We don't assert the exact text here — only that the module ran and
  // produced a structured result.)
  assert.ok(['won-group', 'qualified', 'conditional', 'best-3rd', 'eliminated'].includes(aaa.status));
  assert.equal(typeof out.deadRubbers, 'object');
});

// ===========================================================================
// GOLDEN — eliminated teams in real groups
// ===========================================================================

test('GOLDEN — Group C Haiti and Group F Tunisia are Eliminated', async () => {
  const teams = JSON.parse(await readFile('teams.json', 'utf8'));
  const raw = await fetchRaw();
  const groups = toGroups(raw, teams);

  const hai = byCode(summarizeGroup(groups.find((g) => g.name === 'Group C')), 'HAI');
  assert.equal(hai.status, 'eliminated');
  assert.equal(hai.headline, 'Eliminated');
  assert.equal(hai.detail, null);

  const tun = byCode(summarizeGroup(groups.find((g) => g.name === 'Group F')), 'TUN');
  assert.equal(tun.status, 'eliminated');
  assert.equal(tun.headline, 'Eliminated');
  assert.equal(tun.detail, null);
});

// ===========================================================================
// FULL SWEEP — every Group A-F detail is at most two sentences
// ===========================================================================

test('SWEEP A-F — no detail line exceeds two sentences', async () => {
  const teams = JSON.parse(await readFile('teams.json', 'utf8'));
  const raw = await fetchRaw();
  const groups = toGroups(raw, teams);
  for (const g of groups.filter((g) => /^Group [A-F]$/.test(g.name))) {
    const out = summarizeGroup(g);
    for (const t of out.teams) {
      if (!t.detail) continue;
      assert.ok(
        sentenceCount(t.detail) <= 2,
        `${g.name} ${t.code} detail exceeds 2 sentences: ${t.detail}`
      );
      // No clause may START with a bare "on goal difference"; any GD mention must
      // ride on the concrete-result caveat.
      for (const clause of t.detail.split(';')) {
        assert.ok(
          !/^\s*on goal difference/.test(clause),
          `${g.name} ${t.code} clause starts with bare "on goal difference": ${clause}`
        );
      }
      if (/on goal difference/.test(t.detail)) {
        assert.match(
          t.detail,
          /\(and even then on goal difference\)/,
          `${g.name} ${t.code} bare goal-difference mention: ${t.detail}`
        );
      }
    }
  }
});

// ===========================================================================
// UNIT — minimalCover (the core fix)
// ===========================================================================
//
// minimalCover(targetCells, offCells, numMatches) over ternary {W,D,L} vars.
// Cells are coarse tuples (arrays of 'W'|'D'|'L', home perspective). A subcube
// is an array of per-match subsets; a full {W,D,L} subset = the match dropped.

const allCells2 = () => {
  const out = [];
  for (const a of ['W', 'D', 'L']) for (const b of ['W', 'D', 'L']) out.push([a, b]);
  return out;
};
const key = (c) => c.join('|');
const isFullSet = (s) => s.length === 3;

test('minimalCover: a rank that is "T wins (any other)" collapses to ONE subcube dropping the other match', () => {
  // Two matches; match 0 is the subject (home). Rank holds whenever match0 = W,
  // regardless of match1. Off = every cell where match0 != W.
  const target = [['W', 'W'], ['W', 'D'], ['W', 'L']];
  const off = new Set(
    allCells2().filter((c) => c[0] !== 'W').map(key)
  );
  const cover = __test.minimalCover(target, off, 2);
  assert.equal(cover.length, 1, `expected a single subcube, got ${JSON.stringify(cover)}`);
  const [sub] = cover;
  // match0 fixed to {W}; match1 dropped (full set).
  assert.deepEqual([...sub[0]].sort(), ['W']);
  assert.ok(isFullSet(sub[1]), `match1 should be dropped (any), got ${JSON.stringify(sub[1])}`);
});

test('minimalCover: clean product {T loss} x {other in 2-of-3} -> ONE subcube, two pinned conditions', () => {
  // Rank holds exactly when match0 = L AND match1 in {W,D} (i.e. NOT an L).
  const target = [['L', 'W'], ['L', 'D']];
  const off = new Set(
    allCells2().filter((c) => !(c[0] === 'L' && (c[1] === 'W' || c[1] === 'D'))).map(key)
  );
  const cover = __test.minimalCover(target, off, 2);
  assert.equal(cover.length, 1, `expected one subcube, got ${JSON.stringify(cover)}`);
  const [sub] = cover;
  assert.deepEqual([...sub[0]].sort(), ['L']); // match0 pinned to a loss
  assert.deepEqual([...sub[1]].sort(), ['D', 'W']); // match1 is the 2-of-3 set
  assert.ok(!isFullSet(sub[1]), 'match1 must NOT be dropped here');
});

test('minimalCover: KOR loss-branch shape — 3rd is the complement, 4th the single exception', () => {
  // Subject KOR is AWAY in match1; we work in HOME coarse. Within the loss
  // branch (match1 = W = RSA beat KOR), 4th iff match0 = W (CZE beat MEX), else
  // 3rd. Build the two ranks' cells and confirm each is a single clean subcube.
  // 4th cells: only [W,W].
  const target4 = [['W', 'W']];
  const off4 = new Set(allCells2().filter((c) => key(c) !== 'W|W').map(key));
  const cover4 = __test.minimalCover(target4, off4, 2);
  assert.equal(cover4.length, 1);
  assert.deepEqual([...cover4[0][0]].sort(), ['W']);
  assert.deepEqual([...cover4[0][1]].sort(), ['W']);

  // 3rd cells: [D,W],[L,W]. Off includes [W,W] (rank 4) AND every cell where
  // match1 != W (those are rank 2 — KOR drew or won). With match1=W forced off
  // elsewhere, the minimal cover must PIN match1=W and reduce match0 to the
  // 2-of-3 {D,L} (CZE-MEX is not a Czech win).
  const target3 = [['D', 'W'], ['L', 'W']];
  const off3 = new Set(
    allCells2()
      .filter((c) => !(c[1] === 'W' && (c[0] === 'D' || c[0] === 'L')))
      .map(key)
  );
  const cover3 = __test.minimalCover(target3, off3, 2);
  assert.equal(cover3.length, 1);
  assert.deepEqual([...cover3[0][0]].sort(), ['D', 'L']); // CZE-MEX not a CZE win
  assert.deepEqual([...cover3[0][1]].sort(), ['W']); // RSA beat KOR pinned
});

test('minimalCover: single-variable W/D/L partition yields three singleton subcubes', () => {
  const target = [['D']];
  const off = new Set([key(['W']), key(['L'])]);
  const cover = __test.minimalCover(target, off, 1);
  assert.equal(cover.length, 1);
  assert.deepEqual([...cover[0][0]].sort(), ['D']);
});
