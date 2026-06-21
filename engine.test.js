// engine.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGroupStanding, rankThirdPlaceTeams, scenarioGrid } from './engine.js';

// Helper: build a match.
const M = (home, away, hg, ag, played = true) => ({ home, away, homeGoals: hg, awayGoals: ag, played });

// FIFA 2026 group tiebreaker cascade for teams level on POINTS:
//   1. head-to-head points (among the tied teams only)
//   2. head-to-head goal difference
//   3. head-to-head goals scored
//   (re-apply 1-3 to any still-tied subset)
//   4. overall goal difference
//   5. overall goals scored
//   6. fair play (disciplinary; lower = better)
//   7. FIFA World Ranking (engine proxies via Elo, higher = better)
// KEY 2026 CHANGE: head-to-head OUTRANKS overall goal difference. Drawing of
// lots is ABOLISHED — there is no `tiedByLots` flag any more.

// ---------------------------------------------------------------------------
// 1. Level on points, decided by OVERALL GD then GF — with head-to-head LEVEL.
// ---------------------------------------------------------------------------
test('group ordering: points equal, decided by overall GD then GF (H2H leveled)', () => {
  // To genuinely isolate the OVERALL GD/GF fallback (criteria 4-5) we must make
  // the head-to-head among the tied teams LEVEL, otherwise we'd secretly be
  // testing head-to-head. So AAA, BBB, CCC all DRAW each other 0-0 (their h2h
  // mini-table is dead level: each 2 draws, 0 GD, 0 GF). They are then split
  // purely by their results against the sink team DDD:
  //   AAA beat DDD 3-0  -> overall GD +3, GF 3   (best GD -> 1st)
  //   BBB beat DDD 3-1  -> overall GD +2, GF 3   (ties CCC on GD, more GF -> 2nd)
  //   CCC beat DDD 2-0  -> overall GD +2, GF 2   (3rd on GF)
  //   DDD loses all                              -> 4th
  // All of AAA/BBB/CCC finish on 5 pts (two draws + one win).
  const matches = [
    M('AAA', 'BBB', 0, 0),
    M('AAA', 'CCC', 0, 0),
    M('BBB', 'CCC', 0, 0),
    M('AAA', 'DDD', 3, 0),
    M('BBB', 'DDD', 3, 1),
    M('CCC', 'DDD', 2, 0),
  ];
  const group = { name: 'G', teams: [
    { code: 'AAA', name: 'Alpha', elo: 1500 }, { code: 'BBB', name: 'Bravo', elo: 1500 },
    { code: 'CCC', name: 'Charlie', elo: 1500 }, { code: 'DDD', name: 'Delta', elo: 1500 },
  ], matches };

  const st = computeGroupStanding(group);
  // All of top 3 have 5 points; DDD has 0.
  assert.equal(st[3].code, 'DDD');
  assert.equal(st[3].points, 0);
  for (const code of ['AAA', 'BBB', 'CCC']) {
    assert.equal(st.find((t) => t.code === code).points, 5);
  }
  // Head-to-head among AAA/BBB/CCC is level (they all drew each other), so the
  // OVERALL goal-difference fallback decides.
  // AAA has the best overall GD (+3) -> 1st.
  assert.equal(st[0].code, 'AAA');
  assert.equal(st[0].gd, 3);
  // BBB and CCC are level on overall GD (+2); BBB ranks ahead on overall GF.
  assert.equal(st[1].code, 'BBB');
  assert.equal(st[1].gd, 2);
  assert.equal(st[2].code, 'CCC');
  assert.equal(st[2].gd, 2);
  assert.ok(st[1].gf > st[2].gf, 'BBB ahead of CCC on goals scored');
  // ranks assigned 1..4
  assert.deepEqual(st.map((t) => t.rank), [1, 2, 3, 4]);
});

test('group ordering: equal points & overall GD, decided by goals scored (GF)', () => {
  // X and Y are level on points AND overall GD; only goals scored separates them.
  // Critically they DREW their head-to-head, so h2h is level and the GF fallback
  // is what actually decides — not head-to-head.
  //   X: drew Y 1-1, beat Z 3-0 -> pts4 GF4 GA1 GD+3
  //   Y: drew X 1-1, beat Z 4-1 -> pts4 GF5 GA2 GD+3   (== pts, == GD, GF 5>4)
  //   Z: lost both              -> pts0 GF1 GA7 GD-6
  // Y ranks ahead of X purely on goals scored.
  const group = { name: 'G2', teams: [
    { code: 'XXX', name: 'Xray', elo: 1500 }, { code: 'YYY', name: 'Yankee', elo: 1500 },
    { code: 'ZZZ', name: 'Zulu', elo: 1400 },
  ], matches: [ M('XXX', 'YYY', 1, 1), M('XXX', 'ZZZ', 3, 0), M('YYY', 'ZZZ', 4, 1) ] };

  const st = computeGroupStanding(group);
  const x = st.find((t) => t.code === 'XXX');
  const y = st.find((t) => t.code === 'YYY');
  assert.equal(x.points, 4); assert.equal(y.points, 4);
  assert.equal(x.gd, 3); assert.equal(y.gd, 3);
  assert.equal(y.gf, 5); assert.equal(x.gf, 4);
  // Y ranks ahead of X purely on goals scored.
  assert.equal(st[0].code, 'YYY');
  assert.equal(st[1].code, 'XXX');
});

// ---------------------------------------------------------------------------
// 2. 2-team tie broken by head-to-head (level on overall pts/GD/GF, decisive h2h).
// ---------------------------------------------------------------------------
test('2-team tie broken by head-to-head', () => {
  // P and Q level on overall pts/GD/GF; P beat Q head-to-head -> P ranks ahead.
  //   P: beat Q 1-0, lost S 1-2, beat T 2-0 -> pts6 GF4 GA2 GD+2
  //   Q: lost P 0-1, beat S 2-0, beat T 2-1 -> pts6 GF4 GA2 GD+2  (identical overall)
  //   S,T are sinks below them.
  const group = { name: 'H2H', teams: [
    { code: 'PPP', name: 'Papa', elo: 1500 }, { code: 'QQQ', name: 'Quebec', elo: 1500 },
    { code: 'SSS', name: 'Sierra', elo: 1500 }, { code: 'TTT', name: 'Tango', elo: 1500 },
  ], matches: [
    M('PPP', 'QQQ', 1, 0),
    M('SSS', 'PPP', 2, 1),   // P lost to S 1-2
    M('PPP', 'TTT', 2, 0),
    M('QQQ', 'SSS', 2, 0),
    M('QQQ', 'TTT', 2, 1),
    M('SSS', 'TTT', 0, 0),
  ] };

  const st = computeGroupStanding(group);
  const p = st.find((t) => t.code === 'PPP');
  const q = st.find((t) => t.code === 'QQQ');
  // Verify they are exactly level on the overall criteria.
  assert.equal(p.points, 6); assert.equal(q.points, 6);
  assert.equal(p.gd, 2); assert.equal(q.gd, 2);
  assert.equal(p.gf, 4); assert.equal(q.gf, 4);
  // Head-to-head: P beat Q, so P must rank ahead.
  assert.ok(p.rank < q.rank, `expected P ahead of Q, got P=${p.rank} Q=${q.rank}`);
  assert.equal(st[0].code, 'PPP');
  assert.equal(st[1].code, 'QQQ');
});

// ---------------------------------------------------------------------------
// 3. 3-team tie where h2h leaves two level, split by fair-play.
// ---------------------------------------------------------------------------
test('3-team tie: h2h drops one, remaining two split by fair-play', () => {
  // A and B finish level on overall pts/GD/GF; they DREW their head-to-head, so
  // h2h cannot separate them and the cascade runs to fair-play (criterion 6):
  //   A drew B 1-1, beat C 2-1, beat D 1-0 -> pts7 GF4 GA2 GD+2, fairPlay 1
  //   B drew A 1-1, beat C 2-1, beat D 1-0 -> pts7 GF4 GA2 GD+2, fairPlay 5
  //   A's lower (better) fair-play puts it ahead of B with NO lots.
  //   C (pts3) and D (pts0) are clearly below.
  const group = { name: 'TRIO', teams: [
    { code: 'AAA', name: 'A', fairPlay: 1, elo: 1500 },   // better discipline -> ahead of B
    { code: 'BBB', name: 'B', fairPlay: 5, elo: 1500 },
    { code: 'CCC', name: 'C', elo: 1400 },
    { code: 'DDD', name: 'D', elo: 1300 },
  ], matches: [
    M('AAA', 'BBB', 1, 1),
    M('AAA', 'CCC', 2, 1),
    M('BBB', 'CCC', 2, 1),
    M('AAA', 'DDD', 1, 0),
    M('BBB', 'DDD', 1, 0),
    M('CCC', 'DDD', 1, 0),
  ] };

  const st = computeGroupStanding(group);
  const a = st.find((t) => t.code === 'AAA');
  const b = st.find((t) => t.code === 'BBB');
  assert.equal(a.points, 7); assert.equal(b.points, 7);
  assert.equal(a.gd, b.gd); assert.equal(a.gf, b.gf);
  // A and B level on pts/overall GD/GF and their h2h was a draw -> fair-play
  // (A=1 < B=5) puts A ahead. Drawing of lots is gone.
  assert.equal(st[0].code, 'AAA');
  assert.equal(st[1].code, 'BBB');
  // No team ever carries a tiedByLots flag in 2026.
  for (const t of st) assert.ok(!('tiedByLots' in t), 'no lots in 2026');
});

// ---------------------------------------------------------------------------
// 3a. NEW: head-to-head OUTRANKS overall goal difference (the 2026 change).
//     This is THE test that would have caught the bug.
// ---------------------------------------------------------------------------
test('head-to-head outranks overall goal difference', () => {
  // Mirror the real Group D shape: the head-to-head WINNER has the WORSE overall
  // goal difference, yet still finishes ABOVE the loser (Paraguay -3-ish GD above
  // Turkey because Paraguay won head-to-head).
  //   PAR: beat TUR 1-0, lost AAA 0-3, drew DDD 1-1 -> pts4 GF2 GA4 GD-2
  //   TUR: lost PAR 0-1, drew AAA 1-1, beat DDD 2-0 -> pts4 GF3 GA2 GD+1
  //   PAR and TUR are level on POINTS (4 each). TUR has the BETTER overall GD (+1
  //   vs -2) AND the higher Elo (1750 > 1700) — under the OLD rules (GD before
  //   h2h) TUR would rank above. Under 2026 rules PAR beat TUR head-to-head, so
  //   PAR ranks ABOVE despite worse GD. AAA tops the group; DDD is last.
  const group = { name: 'GROUPD', teams: [
    { code: 'PAR', name: 'Paraguay', elo: 1700 },
    { code: 'TUR', name: 'Turkey', elo: 1750 },
    { code: 'AAA', name: 'Strong', elo: 1900 },
    { code: 'DDD', name: 'Weak', elo: 1500 },
  ], matches: [
    M('PAR', 'TUR', 1, 0),   // head-to-head: PAR beat TUR
    M('AAA', 'PAR', 3, 0),
    M('PAR', 'DDD', 1, 1),
    M('AAA', 'TUR', 1, 1),
    M('TUR', 'DDD', 2, 0),
    M('AAA', 'DDD', 2, 0),
  ] };

  const st = computeGroupStanding(group);
  const par = st.find((t) => t.code === 'PAR');
  const tur = st.find((t) => t.code === 'TUR');
  // Level on points; PAR has the WORSE overall GD.
  assert.equal(par.points, 4); assert.equal(tur.points, 4);
  assert.equal(par.gd, -2); assert.equal(tur.gd, 1);
  assert.ok(par.gd < tur.gd, 'h2h winner PAR has the worse overall GD');
  assert.ok(tur.elo > par.elo, 'and even the worse Elo would favour TUR');
  // 2026 rule: head-to-head beats overall GD -> PAR ranks ABOVE TUR.
  assert.ok(par.rank < tur.rank, `PAR (h2h winner) must outrank TUR; got PAR=${par.rank} TUR=${tur.rank}`);
});

// ---------------------------------------------------------------------------
// 3b. NEW: head-to-head LEVEL -> fall back to overall goal difference.
// ---------------------------------------------------------------------------
test('head-to-head level (drew) falls back to overall goal difference', () => {
  // EEE and FFF level on points and DREW each other, so h2h cannot separate them;
  // the overall GD fallback (criterion 4) decides, higher GD first.
  //   EEE: drew FFF 1-1, beat HHH 3-0, lost GGG 0-1 -> pts4 GF4 GA2 GD+2
  //   FFF: drew EEE 1-1, beat HHH 1-0, lost GGG 0-2 -> pts4 GF2 GA3 GD-1
  //   GGG tops the group; HHH is last.
  const group = { name: 'GDFB', teams: [
    { code: 'EEE', name: 'Echo', elo: 1600 }, { code: 'FFF', name: 'Foxtrot', elo: 1600 },
    { code: 'GGG', name: 'Golf', elo: 1500 }, { code: 'HHH', name: 'Hotel', elo: 1400 },
  ], matches: [
    M('EEE', 'FFF', 1, 1),   // head-to-head DRAW
    M('EEE', 'HHH', 3, 0),
    M('FFF', 'HHH', 1, 0),
    M('EEE', 'GGG', 0, 1),
    M('FFF', 'GGG', 0, 2),
    M('GGG', 'HHH', 0, 0),
  ] };

  const st = computeGroupStanding(group);
  const e = st.find((t) => t.code === 'EEE');
  const f = st.find((t) => t.code === 'FFF');
  assert.equal(e.points, 4); assert.equal(f.points, 4);
  // h2h was a draw, so overall GD decides: EEE (+2) ahead of FFF (-1).
  assert.ok(e.gd > f.gd, 'EEE has higher overall GD');
  assert.ok(e.rank < f.rank, `EEE must rank ahead on overall GD; got EEE=${e.rank} FFF=${f.rank}`);
});

// ---------------------------------------------------------------------------
// 3c. NEW: no drawing of lots in 2026 — an otherwise-dead tie resolves by Elo.
// ---------------------------------------------------------------------------
test('no drawing of lots in 2026: dead tie resolves by World Ranking (Elo)', () => {
  // A perfectly symmetric 3-cycle: every team beats one and loses one by 1-0.
  // They are dead level on points (3), overall GD (0), overall GF (1), and their
  // head-to-head mini-table is the same symmetric cycle, so criteria 1-5 cannot
  // separate them. No fair-play is set, so the ONLY remaining criterion is the
  // FIFA World Ranking (criterion 7), proxied by Elo. The OLD engine would have
  // sent this to a drawing of lots; 2026 resolves it deterministically by Elo
  // and flags NO team `tiedByLots`.
  const group = { name: 'CYCLE', teams: [
    { code: 'AAA', name: 'A', elo: 1500 },
    { code: 'BBB', name: 'B', elo: 1700 },   // highest Elo -> 1st
    { code: 'CCC', name: 'C', elo: 1600 },
  ], matches: [ M('AAA', 'BBB', 1, 0), M('BBB', 'CCC', 1, 0), M('CCC', 'AAA', 1, 0) ] };

  const st = computeGroupStanding(group);
  // All dead level through criterion 5.
  for (const t of st) {
    assert.equal(t.points, 3);
    assert.equal(t.gd, 0);
    assert.equal(t.gf, 1);
  }
  // World Ranking (Elo) decides: B (1700) > C (1600) > A (1500).
  assert.deepEqual(st.map((t) => t.code), ['BBB', 'CCC', 'AAA']);
  // Drawing of lots is abolished: no team carries a tiedByLots flag.
  for (const t of st) assert.ok(!('tiedByLots' in t), 'no team should be tiedByLots in 2026');
});

// ---------------------------------------------------------------------------
// 4. Third-place ranking across 12 synthetic groups picking the correct 8.
// ---------------------------------------------------------------------------
test('third-place ranking across 12 groups selects correct top 8', () => {
  // Build 12 groups. We only care about each group's 3rd-place team, so make
  // each group trivially ordered (1st > 2nd > 3rd > 4th by points) and control
  // the 3rd-place team's points/GD/GF precisely.
  const specs = [
    { pts: 4, gd: 2, gf: 5 },  // 1st — best
    { pts: 4, gd: 2, gf: 4 },  // 2nd
    { pts: 4, gd: 1, gf: 3 },  // 3rd
    { pts: 3, gd: 3, gf: 6 },  // 4th
    { pts: 3, gd: 1, gf: 4 },  // 5th
    { pts: 3, gd: 1, gf: 3 },  // 6th
    { pts: 3, gd: 0, gf: 4 },  // 7th
    { pts: 3, gd: 0, gf: 3 },  // 8th — last qualifier
    { pts: 1, gd: -2, gf: 3 }, // 9th — first eliminated
    { pts: 1, gd: -2, gf: 2 }, // 10th
    { pts: 1, gd: -3, gf: 2 }, // 11th
    { pts: 1, gd: -4, gf: 1 }, // 12th — worst
  ];

  function buildGroup(idx, spec) {
    const g = `G${idx}`;
    const t1 = `${g}A`, t2 = `${g}B`, t3 = `${g}C`, t4 = `${g}D`;
    const teams = [
      { code: t1, name: `${g} A` }, { code: t2, name: `${g} B` },
      { code: t3, name: `${g} C` }, { code: t4, name: `${g} D` },
    ];

    const targetGf = spec.gf;
    const targetGa = spec.gf - spec.gd;

    let t2For = 0, t2Against, t4For, t4Against;
    let t1Against = 0; // t1 beats t3; t3 concedes here

    if (spec.pts === 4) {
      t2Against = 0; // 0-0 draw
      t4For = targetGf; t4Against = 0;          // win, clean sheet
      if (t4For < 1) t4For = 1;                  // ensure a real win
      t1Against = targetGa;                      // all conceded in t1 loss
    } else if (spec.pts === 3) {
      t2Against = 1;
      t4For = targetGf; t4Against = 0;
      if (t4For < 1) t4For = 1;
      t1Against = targetGa - 1;                  // 1 conceded already in t2 loss
    } else if (spec.pts === 1) {
      t2Against = 1;
      t4For = targetGf; t4Against = targetGf;    // draw GF-GF
      t1Against = targetGa - 1 - t4Against;
    } else {
      t2Against = 1;
      t4For = targetGf; t4Against = targetGf + 1; // loss
      t1Against = targetGa - 1 - t4Against;
    }
    if (t1Against < 1) throw new Error(`spec ${idx} not realizable: t1Against ${t1Against}`);

    const m = [
      M(t1, t3, t1Against, 0),       // t1 beats t3 (t3 scores 0, concedes t1Against)
      M(t2, t3, t2Against, t2For),   // t2 vs t3
      M(t3, t4, t4For, t4Against),   // t3 vs t4
      M(t1, t2, 1, 0),
      M(t1, t4, 7, 0),
      M(t2, t4, 7, 0),
    ];

    return { name: g, teams, matches: m, _wantThird: t3, _spec: spec };
  }

  const groups = specs.map((s, i) => buildGroup(i + 1, s));

  // Sanity: each group's 3rd place really is the intended t3 with the EXACT
  // record we specified.
  for (const g of groups) {
    const st = computeGroupStanding(g);
    const third = st.find((t) => t.rank === 3);
    assert.equal(third.code, g._wantThird, `group ${g.name} 3rd should be ${g._wantThird}, got ${third.code}`);
    assert.equal(third.points, g._spec.pts, `${g.name} 3rd pts`);
    assert.equal(third.gd, g._spec.gd, `${g.name} 3rd gd`);
    assert.equal(third.gf, g._spec.gf, `${g.name} 3rd gf`);
  }

  const ranked = rankThirdPlaceTeams(groups);
  assert.equal(ranked.length, 12);
  // Exactly 8 qualify.
  assert.equal(ranked.filter((t) => t.qualifies).length, 8);
  // The top entry corresponds to the strongest spec (group 1) and the bottom to
  // group 12.
  assert.equal(ranked[0].group, 'G1');
  assert.equal(ranked[11].group, 'G12');
  // Ranks are a clean 1..12 with monotonic non-increasing points.
  for (let i = 1; i < ranked.length; i++) {
    const prev = ranked[i - 1], cur = ranked[i];
    const better =
      prev.points > cur.points ||
      (prev.points === cur.points && prev.gd > cur.gd) ||
      (prev.points === cur.points && prev.gd === cur.gd && prev.gf >= cur.gf);
    assert.ok(better, `ranking not monotonic at ${i}: ${JSON.stringify(prev)} vs ${JSON.stringify(cur)}`);
  }
  // The 8th (last qualifier) and 9th (first out) straddle the cut.
  assert.equal(ranked[7].qualifies, true);
  assert.equal(ranked[8].qualifies, false);
});

// ---------------------------------------------------------------------------
// 4a. NEW: third-place ranking uses overall GD->GF->fairplay->Elo, no h2h, no lots.
// ---------------------------------------------------------------------------
test('third-place ranking: GD->GF->fairplay->Elo, no head-to-head, no lots', () => {
  // Third-place teams come from DIFFERENT groups and never met, so there is no
  // head-to-head step. Build two groups whose 3rd-place teams are IDENTICAL on
  // points/GD/GF, equal on fair-play, so the only separator is the FIFA World
  // Ranking (Elo). Confirm the higher-Elo third ranks first and no lots flag.
  function grp(name, codes, thirdElo, thirdFp) {
    const [t1, t2, t3, t4] = codes;
    return { name, teams: [
      { code: t1, name: `${name} 1` }, { code: t2, name: `${name} 2` },
      { code: t3, name: `${name} 3`, elo: thirdElo, fairPlay: thirdFp },
      { code: t4, name: `${name} 4` },
    ], matches: [
      // t3: lost t1 0-3, lost t2 0-1, beat t4 2-0 -> pts3 GD-2 GF2 (3rd)
      M(t1, t2, 1, 0), M(t1, t3, 3, 0), M(t1, t4, 5, 0),
      M(t2, t3, 1, 0), M(t2, t4, 4, 0),
      M(t3, t4, 2, 0),
    ] };
  }
  const ranked = rankThirdPlaceTeams([
    grp('GX', ['XA', 'XB', 'XC', 'XD'], 1500, 3),
    grp('GY', ['YA', 'YB', 'YC', 'YD'], 1800, 3),
  ]);
  // Both thirds: pts3, GD-2, GF2, fairPlay 3 -> only Elo separates.
  for (const t of ranked) {
    assert.equal(t.points, 3); assert.equal(t.gd, -2);
    assert.equal(t.gf, 2); assert.equal(t.fairPlay, 3);
  }
  // Higher Elo (GY's third, 1800) ranks first.
  assert.equal(ranked[0].group, 'GY');
  assert.equal(ranked[1].group, 'GX');
  // No drawing of lots.
  for (const t of ranked) assert.ok(!('tiedByLots' in t), 'no lots among thirds in 2026');
});

// ---------------------------------------------------------------------------
// 5. scenarioGrid — single decisive match, hand-computed under 2026 rules.
// ---------------------------------------------------------------------------
test('scenarioGrid single match: collapsed conditions & describe()', () => {
  // Teams W, X, Y, Z. Played going into the final W-vs-X match:
  //   W beat Y 1-0, W lost Z 0-1   -> W: pts3 GF1 GA1 GD0
  //   X beat Z 2-0, X drew Y 1-1   -> X: pts4 GF3 GA1 GD+2
  //   Y: lost W 0-1, drew X 1-1, beat Z 2-0 -> pts4 GF3 GA2 GD+1
  //   Z: beat W 1-0, lost X 0-2, lost Y 0-2 -> pts3 GF1 GA4 GD-3
  //   Upcoming: W vs X.
  // Note for the 2026 cascade: W beat Y head-to-head, and Z beat W head-to-head.
  // Reasoning for W's final rank:
  //   WIN  -> W 6 pts, tops the group (X stays 4, Y locked 4) -> 1st, any margin.
  //   DRAW -> W 4 pts, X 5 pts (1st). W and Y both on 4 -> W beat Y h2h -> W 2nd,
  //           Y 3rd. (Overall GD would have put Y first, but h2h outranks it now.)
  //   LOSS -> W stays 3 pts, level with Z. Z beat W head-to-head, so Z ranks
  //           ABOVE W regardless of goal difference -> W 4th on ANY loss.
  const teams = [
    { code: 'WWW', name: 'W', elo: 1500 }, { code: 'XXX', name: 'X', elo: 1500 },
    { code: 'YYY', name: 'Y', elo: 1500 }, { code: 'ZZZ', name: 'Z', elo: 1400 },
  ];
  const matches = [
    M('WWW', 'YYY', 1, 0),
    M('ZZZ', 'WWW', 1, 0),
    M('XXX', 'ZZZ', 2, 0),
    M('XXX', 'YYY', 1, 1),
    M('YYY', 'ZZZ', 2, 0),
    M('WWW', 'XXX', 0, 0, false), // upcoming
  ];
  const group = { name: 'FINAL', teams, matches };

  // Verify pre-table assumptions via computeGroupStanding ignoring the unplayed.
  const pre = computeGroupStanding(group);
  assert.equal(pre.find((t) => t.code === 'XXX').points, 4);
  assert.equal(pre.find((t) => t.code === 'YYY').points, 4);
  assert.equal(pre.find((t) => t.code === 'WWW').points, 3);
  assert.equal(pre.find((t) => t.code === 'ZZZ').points, 3);

  const grid = scenarioGrid(group, ['WWW-XXX'], 6);
  const w = grid.teams['WWW'];

  // WIN: always 1st.
  assert.deepEqual(w.byOutcome.win.ranks, [1]);
  // DRAW: 2nd (W beats Y on head-to-head).
  assert.deepEqual(w.byOutcome.draw.ranks, [2]);
  // LOSS: always 4th (Z beat W head-to-head, so W can never climb above Z).
  assert.deepEqual(w.byOutcome.loss.ranks, [4]);

  // describe() should mention 1st with any win, 2nd on a draw, 4th with any loss.
  const desc = grid.describe('WWW');
  assert.match(desc, /1st with any win/);
  assert.match(desc, /2nd on a draw/);
  assert.match(desc, /4th/); // any loss drops to last

  // Cross-check specific scorelines.
  const synth4 = matches.filter((m) => m.played).concat([M('WWW', 'XXX', 0, 4)]);
  const st4 = computeGroupStanding({ ...group, matches: synth4 });
  assert.equal(st4.find((t) => t.code === 'WWW').rank, 4); // big loss -> 4th
  const synth1 = matches.filter((m) => m.played).concat([M('WWW', 'XXX', 0, 1)]);
  const st1 = computeGroupStanding({ ...group, matches: synth1 });
  assert.equal(st1.find((t) => t.code === 'WWW').rank, 4); // narrow loss ALSO 4th (h2h)
});

test('scenarioGrid two simultaneous matches: joint outcomes & needs', () => {
  // Final round: two matches kick off together. Group of 4: P,Q,R,S.
  // Played (rounds 1 & 2):
  //   P beat R 1-0, P beat S 1-0  -> P: pts6 GF2 GA0 GD+2
  //   Q beat R 1-0, Q lost S 0-1  -> Q: pts3 GF1 GA1 GD0
  //   R: lost P, lost Q           -> pts0 GF0 GA2
  //   S: lost P, beat Q 1-0       -> pts3 GF1 GA1 GD0
  //   Final round: P-Q and R-S.
  // Elo is set so the one genuinely tied scenario resolves deterministically:
  //   Q(1700) > P(1600) > S(1500) > R(1400).
  const teams = [
    { code: 'PPP', name: 'P', elo: 1600 }, { code: 'QQQ', name: 'Q', elo: 1700 },
    { code: 'RRR', name: 'R', elo: 1400 }, { code: 'SSS', name: 'S', elo: 1500 },
  ];
  const matches = [
    M('PPP', 'RRR', 1, 0),
    M('PPP', 'SSS', 1, 0),
    M('QQQ', 'RRR', 1, 0),
    M('SSS', 'QQQ', 1, 0),
    M('PPP', 'QQQ', 0, 0, false), // upcoming 1
    M('RRR', 'SSS', 0, 0, false), // upcoming 2
  ];
  const group = { name: 'FINAL2', teams, matches };

  const pre = computeGroupStanding(group);
  assert.equal(pre.find((t) => t.code === 'PPP').points, 6);
  assert.equal(pre.find((t) => t.code === 'QQQ').points, 3);
  assert.equal(pre.find((t) => t.code === 'SSS').points, 3);
  assert.equal(pre.find((t) => t.code === 'RRR').points, 0);

  const grid = scenarioGrid(group, ['PPP-QQQ', 'RRR-SSS'], 6);
  const p = grid.teams['PPP'];

  assert.ok(p.ranks.includes(1), 'P can be 1st');

  // If P does NOT lose (P-Q is a P win or draw), P is 1st in every joint.
  for (const j of p.joint) {
    const a = j.outcomes[0]; // P-Q, P is home
    if (a.result === 'win') {
      assert.deepEqual(j.ranks, [1], `P win should be 1st, got ${JSON.stringify(j)}`);
    }
    if (a.result === 'draw') {
      assert.deepEqual(j.ranks, [1], `P draw should be 1st, got ${JSON.stringify(j)}`);
    }
  }

  // Concrete check: P loses 0-1, S beats R 1-0 -> P6, Q6, S6 three-way tie.
  //   Q: beat R, beat P (h2h), lost S -> pts6 GF2 GA1 GD+1
  //   S: lost P, beat Q, beat R       -> pts6 GF2 GA1 GD+1
  //   P: beat R, beat S, lost Q       -> pts6 GF2 GA1 GD+1
  //   h2h among P,Q,S is the symmetric cycle (P beat S, Q beat P, S beat Q),
  //   so criteria 1-5 cannot separate them. 2026 resolves by Elo (criterion 7):
  //   Q(1700) > P(1600) > S(1500). R is 4th. NO drawing of lots.
  const synth = matches.filter((m) => m.played).concat([
    M('PPP', 'QQQ', 0, 1), M('RRR', 'SSS', 0, 1),
  ]);
  const st = computeGroupStanding({ ...group, matches: synth });
  assert.equal(st.find((t) => t.code === 'RRR').rank, 4);
  // The three-way tie resolves deterministically by World Ranking (Elo), not lots.
  assert.deepEqual(
    st.filter((t) => t.code !== 'RRR').map((t) => t.code),
    ['QQQ', 'PPP', 'SSS'],
    'tie resolves by Elo: Q > P > S'
  );
  for (const t of st) assert.ok(!('tiedByLots' in t), 'no drawing of lots in 2026');

  // describe for P should be a non-empty string mentioning 1st.
  const dp = grid.describe('PPP');
  assert.match(dp, /1st/);
});
