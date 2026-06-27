// group-situation.test.js — node:test
//
// Run: node --test group-situation.test.js
//
// Covers:
//  - Real Group L (LIVE data): prints the full groupSituation output VERBATIM for
//    human review and asserts only DATA-INDEPENDENT structural + policy invariants
//    (the live standings change every match, so exact wording is NOT pinned here).
//  - Synthetic golden tests with hand-verified expectations:
//    (a) a team mathematically ELIMINATED with 2 games left
//    (b) a team that has CLINCHED top-2 with a game to spare
//    (c) a 'contention' team with a hand-computed magic number

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fetchRaw, toGroups } from './adapter.js';
import { groupSituation, thirdPlaceOutlook } from './group-situation.js';

const VALID_STATUS = new Set(['won-group', 'qualified', 'advanced', 'contention', 'eliminated']);

// ----------------------------------------------------------------------------
// Real data: Group L
// ----------------------------------------------------------------------------

test('Group L (real data) — verbatim output + invariants', async () => {
  const teams = JSON.parse(await readFile(new URL('./teams.json', import.meta.url), 'utf8'));
  const raw = await fetchRaw();
  const groups = toGroups(raw, teams);
  const L = groups.find((g) => g.name === 'Group L');
  assert.ok(L, 'Group L present');

  const sit = groupSituation(L);

  // ---- VERBATIM dump for human review ----
  console.log('\n===== GROUP L — groupSituation() output =====');
  console.log(JSON.stringify(sit, null, 2));
  console.log('\n--- TEAM LINES ---');
  for (const t of sit.teams) {
    console.log(`${t.code} ${t.name}: ${t.points} pts, played ${t.played}, ` +
      `${t.remaining} left | [${t.status}] ${t.statusLine}`);
    console.log(`    magic=${t.magicNumber} elimThresh=${t.eliminationThreshold}`);
    console.log(`    needLine: ${t.needLine}`);
  }
  console.log('\n--- NEXT ROUND ---');
  console.log(`date: ${sit.nextRound.date}`);
  console.log(`matchKeys: ${JSON.stringify(sit.nextRound.matchKeys)}`);
  console.log('triggers:');
  for (const tr of sit.nextRound.triggers) console.log(`  - ${tr}`);
  console.log(`decided: ${sit.decided}`);
  console.log('=============================================\n');

  // ---- invariants ----
  assert.equal(sit.teams.length, 4, 'four teams');
  for (const t of sit.teams) {
    assert.ok(VALID_STATUS.has(t.status), `valid status: ${t.status}`);
    assert.ok(t.magicNumber === null || typeof t.magicNumber === 'number',
      'magicNumber is number or null');
    assert.ok(t.eliminationThreshold === null || typeof t.eliminationThreshold === 'number',
      'eliminationThreshold is number or null');
    assert.equal(typeof t.statusLine, 'string');
    assert.equal(typeof t.needLine, 'string');
  }

  // nextRound.matchKeys length matches the earliest-date set.
  const unplayed = L.matches.filter((m) => !m.played);
  let earliest = null;
  for (const m of unplayed) if (m.date && (earliest === null || m.date < earliest)) earliest = m.date;
  const earliestSet = unplayed.filter((m) => m.date === earliest);
  assert.equal(sit.nextRound.matchKeys.length, earliestSet.length,
    'nextRound matches the earliest-date set');
  assert.equal(sit.nextRound.date, earliest);

  assert.equal(typeof sit.nextRound.triggers, 'object');
  assert.ok(Array.isArray(sit.nextRound.triggers), 'triggers is an array');

  // NOTE: this test runs on LIVE Group L data, which changes after every match.
  // It therefore asserts ONLY data-independent structural invariants + a string
  // POLICY invariant (never assert bare tournament "elimination"; best-third is
  // cross-group and never decided within one group). It does NOT pin exact
  // scenario wording to today's standings — that is the trap that made this test
  // break on every new result. The correctness of the wording (own-result
  // mapping, non-monotone magic number, RPS false-guarantee) is locked down on
  // FROZEN synthetic fixtures in tests (c) and (d) below, and exhaustively by
  // claims-validator.test.js, neither of which depends on live data.
  for (const s of sit.nextRound.triggers) {
    assert.equal(typeof s, 'string');
    assert.doesNotMatch(s, /be eliminated/, 'no bare tournament-elimination wording');
  }
});

// ----------------------------------------------------------------------------
// Synthetic helpers
// ----------------------------------------------------------------------------

function team(code, elo = 1500) {
  return { code, name: code, elo };
}

// 4-team round robin, 6 matches. We construct match lists by hand.
function mk(home, away, hg, ag, date, time) {
  const played = hg != null && ag != null;
  return { home, away, homeGoals: played ? hg : null, awayGoals: played ? ag : null, played, date, time };
}

// ----------------------------------------------------------------------------
// (a) ELIMINATED with 2 games left
// ----------------------------------------------------------------------------
//
// Group: A,B,C,D. After round 1 & round 2 (each team has played 2, 1 left),
// D has 0 points and can finish on at most 3. A,B,C all already have >=6.
// Wait — 2 games left each means only 1 round played. Build so D has 2 games
// LEFT but is already mathematically eliminated.
//
// Construct: D loses both played games; A,B,C all sit high enough that even D
// winning out (max 6) cannot reach top 2 on points.
//   Played (round1+round2 partial):
//     A beat D, A beat C  -> A = 6 (played 2)
//     B beat D, B beat C  -> B = 6 (played 2)
//   So A=6, B=6, C=0(played2, lost twice), D=0(played2, lost twice).
//   Remaining: A-B? No — round robin has 6 matches: AB AC AD BC BD CD.
//   Played: AD,AC,BD,BC (4). Remaining: AB, CD (2). Each of A,B has 1 left;
//   C,D each have 1 left. That's only 1 game left each — not 2.
//
// To get 2 games left each we can only have played 1 match per team => 2 played
// matches total. With only 2 results it's impossible to eliminate anyone (max
// other points still low). So a clean "eliminated with exactly 2 games left"
// in a pure 4-team RR is impossible after round 1. We therefore test the
// achievable strong case: a team eliminated with games remaining where the
// number remaining for IT is what we assert, using a 3-played configuration in
// which the eliminated team has 1 left — and ADD a separate construction below.
//
// Cleaner: use a config where one team has played 1 (2 left) yet is already
// eliminated is impossible; so test elimination with the maximum games-left a
// pure RR allows it (1) but ALSO build a non-RR synthetic with 2 unplayed for
// that team to honor the spec's "2 games left" literally.

test('(a) synthetic: team mathematically ELIMINATED with 2 games left', () => {
  // Non-RR synthetic tuned to the spec: focal team D has 2 games left and is
  // already eliminated. We give A and B commanding leads from extra played
  // games so that D maxing out at 6 still cannot make top 2 on points.
  //
  // Teams A,B,C,D. Played:
  //   A beat C, A beat D, A beat B  -> A = 9 (played 3, done)
  //   B beat C, B beat D            -> B = 6 (played 2... has it played B-A? yes lost) => B played 3, pts 6
  //   C lost to A,B                 -> C played 2
  //   D lost to A,B                 -> D played 2, 0 pts
  // Remaining for D: D-C and D-? give D two games (D-C, D-someone). To keep it
  // clean we let the remaining matches be C-D and a second D game vs a phantom
  // rematch is not RR-legal, so instead: remaining = {C-D, B-D-rematch}? Not RR.
  //
  // Simplest faithful construction: 5 teams is out of scope. So we use a 4-team
  // set but let D have TWO unplayed (C-D and A-D), meaning A-D is treated as not
  // yet played. Then A has played 2 (beat B, beat C) = 6, B played 2 (lost A,
  // beat C)=3, C played 2 (lost A, lost B)=0, D played 0. Remaining: A-D, B-D,
  // C-D => D has 3 left. Trim to 2 by marking B-D played (B beat D):
  //   Played: A-B (A win), A-C (A win), B-C (B win), B-D (B win).
  //   A=6(p2), B=6(p3), C=0(p2), D=0(p1). Remaining: A-D, C-D => D has 2 left.
  // D max = 6. A already 6 with a game vs D left (A>=6, could be 9). B=6 fixed.
  // For D (max 6) to be top 2 on points it must finish >=  the 2nd-place line.
  // A and B are both at >=6 and only A can be passed by D head to head on pts:
  // if D wins out D=6; A if loses to D stays 6, B stays 6 => three teams on 6
  // and C on <=3. Then D is in a 3-way tie for top on points => NOT eliminated!
  // So this isn't a clean elimination. Push leaders higher:
  //   Make A and B each have an extra win so both are >=7 fixed and D's max 6
  //   can't catch either. Add played A-C(2nd meeting)? not RR.
  //
  // Accept a 5-match played skeleton (non-RR is fine for a unit test of the
  // points math): teams A,B,C,D.
  const teams = [team('A'), team('B'), team('C'), team('D')];
  const matches = [
    mk('A', 'B', 1, 0, '2026-06-10', '12:00 UTC+0'), // A win  -> A3 B0
    mk('A', 'C', 1, 0, '2026-06-10', '15:00 UTC+0'), // A win  -> A6 C0
    mk('B', 'C', 1, 0, '2026-06-13', '12:00 UTC+0'), // B win  -> B3 C0
    mk('B', 'D', 1, 0, '2026-06-13', '15:00 UTC+0'), // B win  -> B6 D0
    mk('A', 'D', 1, 0, '2026-06-16', '12:00 UTC+0'), // A win  -> A9 D0
    // Remaining for D: C-D and D vs ... only C-D in RR. Give D a 2nd unplayed
    // by leaving an A-? no. Use C-D plus a phantom second D fixture:
    mk('C', 'D', null, null, '2026-06-20', '12:00 UTC+0'), // unplayed
    mk('D', 'C', null, null, '2026-06-20', '15:00 UTC+0'), // 2nd unplayed (test-only)
  ];
  const group = { name: 'Synthetic A-elim', teams, matches };
  // State: A=9 (done), B=6 (done), C=0 (2 left: vs D twice), D=0 (2 left).
  // D max = 6. To be top 2 on points D needs to outrank two of {A=9,B=6,C}.
  // A=9 is unreachable. B=6: D could tie at 6 (a tie, not strictly out) — so D
  // is NOT cleanly eliminated here either. Lift B too:
  matches[3] = mk('B', 'D', 3, 0, '2026-06-13', '15:00 UTC+0'); // still 3 pts; pts unaffected
  // Points only count W/D/L, so margins don't change B's 6. The honest fact is:
  // D maxing to 6 ties B at 6 -> classified 'tie', hence 'contention', NOT
  // eliminated. This is CORRECT points-math. To get a clean elimination we must
  // make the two leaders unreachable on POINTS by D's max.
  //
  // Final clean construction: A and B each finish on 9 (both done), D max 6.
  group.matches = [
    mk('A', 'B', 0, 0, '2026-06-10', '12:00 UTC+0'), // draw A1 B1  (so neither is "done" yet via this)
    mk('A', 'C', 1, 0, '2026-06-10', '15:00 UTC+0'), // A win A4 C0
    mk('A', 'D', 1, 0, '2026-06-16', '12:00 UTC+0'), // A win A7 D0
    mk('B', 'C', 1, 0, '2026-06-13', '12:00 UTC+0'), // B win B4 C0
    mk('B', 'D', 1, 0, '2026-06-13', '15:00 UTC+0'), // B win B7 D0
    mk('C', 'D', null, null, '2026-06-20', '12:00 UTC+0'), // unplayed (C & D each have this)
    mk('D', 'C', null, null, '2026-06-20', '15:00 UTC+0'), // 2nd unplayed (test-only): D & C
  ];
  // Now: A=7 (played A-B,A-C,A-D = done, 3 games), B=7 (played B-C,B-D,A-B =done),
  // C=0 (played A-C,B-C; 2 left: C-D,D-C), D=0 (played A-D,B-D; 2 left).
  // A and B are FIXED at 7. D max = 6 < 7 for both -> D can never reach top 2
  // on points. ELIMINATED. C max = 6 as well -> C also eliminated. Good golden.

  const sit = groupSituation(group);
  const D = sit.teams.find((t) => t.code === 'D');
  const C = sit.teams.find((t) => t.code === 'C');
  assert.equal(D.remaining, 2, 'D has 2 games left');
  assert.equal(D.status, 'eliminated', 'D cannot finish top 2 (internal status key)');
  assert.equal(C.status, 'eliminated', 'C cannot finish top 2 (internal status key)');
  // Honest wording: "Out of the top two", NOT a bare "Eliminated" (best-third
  // qualification is cross-group and never asserted by this module).
  assert.equal(D.statusLine, 'Out of the top two');
  assert.equal(D.magicNumber, null);

  // A and B: with both fixed on 7 and the other two maxing at 6, A & B have
  // each clinched top 2 (indeed clinched 1st-or-2nd). They have 0 games left.
  const A = sit.teams.find((t) => t.code === 'A');
  const B = sit.teams.find((t) => t.code === 'B');
  assert.ok(['won-group', 'qualified'].includes(A.status), `A clinched: ${A.status}`);
  assert.ok(['won-group', 'qualified'].includes(B.status), `B clinched: ${B.status}`);
});

// ----------------------------------------------------------------------------
// (b) CLINCHED top-2 with a game to spare
// ----------------------------------------------------------------------------

test('(b) synthetic: team CLINCHED top-2 with a game to spare', () => {
  // A has 6 points after 2 games and 1 left. B,C,D are low enough that A is
  // mathematically top-2 regardless of its last game.
  // Played: A-B (A win), A-C (A win), B-C (draw), then D has lost both.
  //   A: beat B, beat C       -> 6 (played 2, 1 left vs D)
  //   B: lost A, drew C       -> 1 (played 2, 1 left vs D)
  //   C: lost A, drew B       -> 1 (played 2, 1 left ... vs D? )
  //   D: lost to ? need D played 2.
  // RR matches: AB AC AD BC BD CD.
  //   Played: AB(Awin), AC(Awin), BC(draw), BD(Bwin), CD(Cwin)
  //     A=6 (p2: AB,AC) , 1 left: AD
  //     B=1+3=4? B: lost AB(0), drew BC(1), beat BD(3) => 4 (p3) -> 0 left. Hmm
  // Let's just pick a clean set where A has 1 left and is already top-2.
  const teams = [team('A'), team('B'), team('C'), team('D')];
  const matches = [
    mk('A', 'B', 2, 0, '2026-06-10', '12:00 UTC+0'), // A3 B0
    mk('A', 'C', 2, 0, '2026-06-13', '12:00 UTC+0'), // A6 C0
    mk('B', 'C', 0, 0, '2026-06-13', '15:00 UTC+0'), // B1 C1
    mk('B', 'D', 0, 0, '2026-06-16', '12:00 UTC+0'), // B2 D1
    mk('C', 'D', 0, 0, '2026-06-16', '15:00 UTC+0'), // C2 D2
    mk('A', 'D', null, null, '2026-06-20', '12:00 UTC+0'), // unplayed: A & D have 1 left
  ];
  // State: A=6 (p2, 1 left), B=2 (p3, done), C=2 (p3, done), D=2 (p2, 1 left).
  // A is on 6; B,C fixed at 2; D max = 2+3 = 5. So A (>=6) is guaranteed >= all
  // others' max (5) -> top 2 (in fact A could even clinch 1st: can anyone reach
  // 7? no, max other is 5). A has clinched 1st => 'won-group'.
  const group = { name: 'Synthetic A-clinch', teams, matches };
  const sit = groupSituation(group);
  const A = sit.teams.find((t) => t.code === 'A');
  assert.equal(A.remaining, 1, 'A has a game to spare');
  assert.ok(['won-group', 'qualified'].includes(A.status), `A clinched top-2: ${A.status}`);
  // Since no one can reach 6, A has actually won the group.
  assert.equal(A.status, 'won-group', 'A has clinched 1st');
  assert.equal(A.statusLine, 'Clinched 1st');
  assert.equal(A.magicNumber, null, 'clinched team has no magic number');
});

// ----------------------------------------------------------------------------
// (c) CONTENTION team with a hand-computed magic number
// ----------------------------------------------------------------------------

test('(c) synthetic: contention team with hand-computed magic number', () => {
  // Mirror of Group L's shape, fully synthetic.
  // Teams A,B,C,D. Round 1 results:
  //   A beat C (A=3), B beat D (B=3), C=0, D=0.
  // Remaining (2 each): A-B (A&B), C-D (C&D), and the cross fixtures
  //   A-D, B-C. RR = AB AC AD BC BD CD. Played: AC, BD. Remaining: AB,AD,BC,CD.
  //   A has 2 left (AB, AD), B has 2 left (AB, BC), C has 2 left (BC, CD),
  //   D has 2 left (AD, CD). Good — 2 each.
  //
  // HAND COMPUTE A's magic number (min final points guaranteeing top-2 on pts):
  //   A currently 3 (beat C), plays B and D. Per-game adds are {0,1,3}, so A's
  //   possible finals are 3,4,5,6,7,9. The leaders A could be passed by are B
  //   (start 3, plays A & C; max 9) and C (start 0, plays B & D; max 6) and D
  //   (start 0, plays A & C; max 6).
  //
  //   Is A=5 (draw B AND draw D) guaranteed top-2? At A=5, the teams that could
  //   even reach >5 are B (max, if it beats C: drew A=4, +3 = 7) and C (max, if
  //   it wins both: 6). But B beating C and C winning both are mutually
  //   exclusive (B-C has one result). So AT MOST ONE of {B,C} can finish strictly
  //   above 5 in any single branch; D (drew A=1, + at most beat C = 4) can never
  //   exceed 5. Therefore at A=5 at most one team is strictly above A -> A is
  //   guaranteed 1st or 2nd. (A=5 vs a B=5 tie sits on the 1st/2nd line, not the
  //   2nd/3rd cut, so it's still 'in'.) => A=5 is SAFE.
  //
  //   Is A=4 (draw one, lose one) safe? Take A draws B, loses to D. Then D beat
  //   A (D=3) and can beat C (D=6); B drew A (4) and can beat C (7). Branch B=7,
  //   D=6: two teams strictly above A=4 -> A is 3rd. NOT safe.
  //
  //   ⚠️ THE TRAP (this is the bug that "didn't take" before): A=6 via a WIN AND
  //   A LOSS is NOT safe either. A beats B, loses to D -> A=6; B beats C -> B=6;
  //   D beats C -> D=6 (B beat D in round 1, D beat A, A beat B: a perfect H2H
  //   cycle). Three teams on 6, A can be 3rd on goal difference. So the safe-set
  //   is NON-MONOTONE: 5 (two draws) safe, 6 (win+loss) NOT safe, 7 (win+draw)
  //   safe. A points threshold ("5 or better") is therefore FALSE — the honest
  //   guarantee is RESULT-based: AVOID DEFEAT in both matches.
  //   (The structured magicNumber still carries 5; the PROSE must not say
  //   "two draws or better".)
  const teams = [team('A'), team('B'), team('C'), team('D')];
  const matches = [
    mk('A', 'C', 1, 0, '2026-06-10', '12:00 UTC+0'), // A3 C0
    mk('B', 'D', 1, 0, '2026-06-10', '15:00 UTC+0'), // B3 D0
    mk('A', 'B', null, null, '2026-06-15', '12:00 UTC+0'),
    mk('A', 'D', null, null, '2026-06-20', '12:00 UTC+0'),
    mk('B', 'C', null, null, '2026-06-15', '15:00 UTC+0'),
    mk('C', 'D', null, null, '2026-06-20', '15:00 UTC+0'),
  ];
  const group = { name: 'Synthetic contention', teams, matches };
  const sit = groupSituation(group);
  const A = sit.teams.find((t) => t.code === 'A');
  assert.equal(A.status, 'contention', 'A is in contention');
  assert.equal(A.remaining, 2);
  assert.equal(A.magicNumber, 5, 'A magic number is 5 (hand-computed)');

  // Elimination threshold for A: the smallest final at which A can still reach
  // top-2 under some other-results combo. A on 3 (lose both): can A still be
  // top-2? A=3; if B,C,D all stumble... B is already 3 and plays A(beat,+3=6).
  // If A loses both, B beat A => B>=6 > A. Need one more team <=3 to keep A in
  // 2nd via tie. Plausibly A=3 can still tie for 2nd in some collapse, so the
  // threshold may be 3 or 4 — assert it is a number and <= magic.
  assert.ok(typeof A.eliminationThreshold === 'number');
  assert.ok(A.eliminationThreshold <= A.magicNumber);

  // needLine must express the NON-MONOTONE guarantee by RESULT — "avoiding defeat
  // in both games" — and must NEVER claim "two draws (or better)" (a win+loss
  // reaches 6 pts but can finish 3rd in the H2H cycle).
  assert.match(A.needLine, /Avoiding defeat in both games guarantees a top-2 place/);
  assert.doesNotMatch(A.needLine, /or better/);
  assert.doesNotMatch(A.needLine, /from its last/);
});

// ----------------------------------------------------------------------------
// needLine language lock: no "from its last", floors phrased as results/totals
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// (d) Non-monotone magic number + honest "out of the top two" wording.
//     Real Group G shape: BEL 0-0 IRN, BEL 1-1 EGY, IRN 2-2 NZL.
//     Standings: IRN 2, BEL 2, NZL 1, EGY 1. Remaining: BEL-NZL, EGY-IRN, EGY-NZL.
// ----------------------------------------------------------------------------

test('(d) magic number respects non-monotone safety; never asserts bare elimination', () => {
  const teams = [team('BEL'), team('IRN'), team('EGY'), team('NZL')];
  const matches = [
    mk('BEL', 'IRN', 0, 0, '2026-06-15', '12:00 UTC+0'),
    mk('BEL', 'EGY', 1, 1, '2026-06-16', '12:00 UTC+0'),
    mk('IRN', 'NZL', 2, 2, '2026-06-17', '12:00 UTC+0'),
    mk('BEL', 'NZL', null, null, '2026-06-21', '12:00 UTC+0'),
    mk('EGY', 'IRN', null, null, '2026-06-21', '15:00 UTC+0'),
    mk('EGY', 'NZL', null, null, '2026-06-26', '12:00 UTC+0'),
  ];
  const sit = groupSituation({ name: 'Group G-like', teams, matches });
  const EGY = sit.teams.find((t) => t.code === 'EGY');

  // Egypt on 1 pt with 2 to play. Points-safety is NON-MONOTONE: two draws (3 pts)
  // is tie-safe, but win+loss (4 pts) can finish 3rd behind IRN(5) and BEL(5).
  // So the guarantee is NOT "two draws" — it is a win and a draw (magic 5).
  assert.equal(EGY.magicNumber, 5, 'Egypt magic number is 5, not 3 (4 pts is unsafe)');
  assert.match(EGY.needLine, /A win and a draw guarantees a top-2 place/);
  // The old false claim must be gone.
  assert.doesNotMatch(EGY.needLine, /[Tt]wo draws \(or better\) guarantees/);

  // IRN/BEL on 2 with 1 to play: a win guarantees a top-2 place; never a bare
  // "eliminated" (a best-third berth could still be live).
  for (const code of ['IRN', 'BEL']) {
    const t = sit.teams.find((x) => x.code === code);
    assert.match(t.needLine, /A win guarantees a top-2 place/, `${code} honest wording`);
    assert.doesNotMatch(t.needLine, /\beliminated\b/, `${code} never says eliminated`);
  }

  // Sweep: no bare tournament-elimination language anywhere in this group.
  for (const t of sit.teams) {
    assert.doesNotMatch(t.needLine, /\beliminated\b/);
  }
});

test('needLine never says "from its last" (the confusing-accumulation phrasing)', async () => {
  const teams = JSON.parse(await readFile(new URL('./teams.json', import.meta.url), 'utf8'));
  const raw = await fetchRaw();
  const groups = toGroups(raw, teams);
  for (const g of groups) {
    const sit = groupSituation(g);
    for (const t of sit.teams) {
      assert.doesNotMatch(
        t.needLine,
        /from its last/,
        `${g.name} ${t.code} needLine uses banned phrasing: ${t.needLine}`
      );
    }
  }
});

// ----------------------------------------------------------------------------
// DETERMINISTIC best-third clinch (opts.allGroups) — the ARG/Group-J case.
// ----------------------------------------------------------------------------
//
// Focal group J mirrors the real situation after Argentina 2-0 Austria:
//   ARG beat ALG, AUT beat JOR, ARG beat AUT.  ARG=6 (1 game left, vs JOR).
// ARG's only path to 3rd is the 3-way cycle (lose to JOR; AUT & JOR both win
// their last games) -> three teams on 6, ARG possibly 3rd ON 6. Because 6 is the
// MAX a third can ever score, and few other groups can even reach a 6-pt third,
// ARG is mathematically locked into the top-8 thirds => CLINCHED for the R32.

function decidedGroup(letter) {
  // Fully played; third place ends on 3 pts -> third-place ceiling = 3 (< 6).
  const T = [letter + '1', letter + '2', letter + '3', letter + '4'];
  return {
    name: 'Group ' + letter,
    teams: T.map((c) => team(c)),
    matches: [
      mk(T[0], T[1], 1, 0, '2026-06-10', '12:00'), mk(T[0], T[2], 1, 0, '2026-06-10', '12:00'),
      mk(T[0], T[3], 1, 0, '2026-06-10', '12:00'), mk(T[1], T[2], 1, 0, '2026-06-10', '12:00'),
      mk(T[1], T[3], 1, 0, '2026-06-10', '12:00'), mk(T[2], T[3], 1, 0, '2026-06-10', '12:00'),
    ],
  };
}

function hiThirdGroup(letter) {
  // Fully played; third (T2) ends on 3 pts but with a BIG goals-for (beat T3 9-0),
  // so it ranks strictly ABOVE a decidedGroup third (3 pts, GF 1) on the GF tiebreak.
  const T = [letter + '1', letter + '2', letter + '3', letter + '4'];
  return {
    name: 'Group ' + letter,
    teams: T.map((c) => team(c)),
    matches: [
      mk(T[0], T[1], 1, 0, '2026-06-10', '12:00'), mk(T[0], T[2], 1, 0, '2026-06-10', '12:00'),
      mk(T[0], T[3], 1, 0, '2026-06-10', '12:00'), mk(T[1], T[2], 1, 0, '2026-06-10', '12:00'),
      mk(T[1], T[3], 1, 0, '2026-06-10', '12:00'), mk(T[2], T[3], 9, 0, '2026-06-10', '12:00'),
    ],
  };
}

function weakGroup(letter) {
  // Fully played; the bottom two draw 0-0, so the third finishes on just 1 pt
  // (third-place floor and ceiling both = 1).
  const T = [letter + '1', letter + '2', letter + '3', letter + '4'];
  return {
    name: 'Group ' + letter,
    teams: T.map((c) => team(c)),
    matches: [
      mk(T[0], T[1], 1, 0, '2026-06-10', '12:00'), mk(T[0], T[2], 1, 0, '2026-06-10', '12:00'),
      mk(T[0], T[3], 1, 0, '2026-06-10', '12:00'), mk(T[1], T[2], 1, 0, '2026-06-10', '12:00'),
      mk(T[1], T[3], 1, 0, '2026-06-10', '12:00'), mk(T[2], T[3], 0, 0, '2026-06-10', '12:00'),
    ],
  };
}

// thirdPlaceOutlook: tiebreaker-aware deterministic clinch/elimination. REGRESSION
// for the Sweden bug — the old points-only test counted any group that could MATCH
// the points as a threat, so a high-GF third tied on points with several others was
// wrongly held short of clinching. Here group A's third (3 pts, GF 9) sits strictly
// above eight decidedGroup thirds (3 pts, GF 1): zero of them can actually pass it,
// so it has CLINCHED — even though all eight "match" on points.
test('thirdPlaceOutlook: a high-GF third clinches over equal-points-but-lower thirds (tiebreaker-aware)', () => {
  const focal = hiThirdGroup('A');                                   // A3: 3 pts, GF 9
  const below = ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'].map(decidedGroup); // 3 pts, GF 1 (below A3)
  const weak = ['J', 'K', 'L'].map(weakGroup);                       // thirds on 1 pt
  const allGroups = [focal, ...below, ...weak];

  // A's third has clinched: no other group can field a third that outranks 3 pts/GF 9.
  assert.equal(thirdPlaceOutlook(focal, allGroups), 'qualified');

  // A weak group's best-possible third (1 pt) is beaten for sure by the nine 3-pt
  // thirds (focal + eight below) — at least 8 above it => mathematically eliminated.
  assert.equal(thirdPlaceOutlook(weak[0], allGroups), 'eliminated');
});

// REGRESSION for the Scotland bug — ELIMINATION must be tiebreaker-aware too, not
// just points. Focal third (A3: 3 pts, GD -1, GF 1) is beaten by EIGHT thirds that
// TIE it on points (3) but rank strictly above on goal difference / goals-for. The
// old points-only elimination counted 0 teams with strictly-MORE points and wrongly
// left it "live" (the <1% MC sliver); the full FIFA cascade sees all 8 above it, so
// it is mathematically OUT. (Mirror of the high-GF clinch test above.)
test('thirdPlaceOutlook: a third beaten only on the GD/GF tiebreak by 8 equal-points thirds is eliminated', () => {
  const focal = decidedGroup('A');                                   // A3: 3 pts, GD -1, GF 1
  const above = ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'].map(hiThirdGroup); // each 3 pts but GD +7/GF 9 -> strictly above on tiebreak
  const weak = ['J', 'K', 'L'].map(weakGroup);                       // 1 pt, below focal
  const allGroups = [focal, ...above, ...weak];
  assert.equal(thirdPlaceOutlook(focal, allGroups), 'eliminated');
});

function openGroup(letter) {
  // No games played -> a 6-6-6-0 finish is still reachable -> third ceiling = 6.
  const T = [letter + '1', letter + '2', letter + '3', letter + '4'];
  return {
    name: 'Group ' + letter,
    teams: T.map((c) => team(c)),
    matches: [
      mk(T[0], T[1], null, null, '2026-06-30', '12:00'), mk(T[0], T[2], null, null, '2026-06-30', '12:00'),
      mk(T[0], T[3], null, null, '2026-06-30', '12:00'), mk(T[1], T[2], null, null, '2026-06-30', '12:00'),
      mk(T[1], T[3], null, null, '2026-06-30', '12:00'), mk(T[2], T[3], null, null, '2026-06-30', '12:00'),
    ],
  };
}

function focalGroupJ() {
  return {
    name: 'Group J',
    teams: ['ARG', 'AUT', 'JOR', 'ALG'].map((c) => team(c)),
    matches: [
      mk('ARG', 'ALG', 2, 0, '2026-06-16', '12:00'),
      mk('AUT', 'JOR', 1, 0, '2026-06-16', '12:00'),
      mk('ARG', 'AUT', 2, 0, '2026-06-22', '12:00'),
      mk('ALG', 'AUT', null, null, '2026-06-27', '12:00'),
      mk('JOR', 'ARG', null, null, '2026-06-27', '12:00'),
      mk('ALG', 'JOR', null, null, '2026-06-27', '12:00'),
    ],
  };
}

test('clinch: ARG is "advanced" (locked top-8 third) when other groups cannot field a 6-pt third', () => {
  const J = focalGroupJ();
  const fillers = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'K', 'L'].map(decidedGroup);
  const allGroups = [J, ...fillers];

  const sit = groupSituation(J, { allGroups });
  const arg = sit.teams.find((t) => t.code === 'ARG');

  assert.equal(arg.status, 'advanced', 'ARG deterministically clinched the R32');
  assert.match(arg.statusLine, /Clinched a Round-of-32 place/, 'headline asserts the clinch');
  assert.match(arg.needLine, /Through to the Round of 32/, 'needLine leads with the clinch');
  assert.match(arg.needLine, /clinches top spot/, 'needLine talks about clinching 1st, not "being safe"');
  // The buffoon guard: never the old "needs 6+ to be safe" phrasing once clinched.
  assert.doesNotMatch(arg.needLine, /to be safe/);
  assert.doesNotMatch(arg.needLine, /6\+ points/);
});

test('clinch: backward-compatible — without allGroups, ARG stays "contention"', () => {
  const sit = groupSituation(focalGroupJ()); // no allGroups
  const arg = sit.teams.find((t) => t.code === 'ARG');
  assert.equal(arg.status, 'contention', 'no cross-group context -> no best-third assertion');
});

test('clinch: counting boundary — 8 possible 6-pt thirds blocks the clinch, 7 allows it', () => {
  const J = focalGroupJ();

  // 8 OTHER groups that CAN field a 6-pt third (open) -> ARG could be 9th -> not clinched.
  const eightOpen = [
    ...['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map(openGroup),
    ...['I', 'K', 'L'].map(decidedGroup),
  ];
  const sit8 = groupSituation(J, { allGroups: [J, ...eightOpen] });
  assert.equal(sit8.teams.find((t) => t.code === 'ARG').status, 'contention',
    '8 other groups can match the 6 -> ARG only 9th-best third -> not clinched');

  // 7 OTHER groups that CAN -> ARG at worst 8th -> still top-8 -> clinched.
  const sevenOpen = [
    ...['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(openGroup),
    ...['H', 'I', 'K', 'L'].map(decidedGroup),
  ];
  const sit7 = groupSituation(J, { allGroups: [J, ...sevenOpen] });
  assert.equal(sit7.teams.find((t) => t.code === 'ARG').status, 'advanced',
    '7 other groups can match the 6 -> ARG at worst 8th -> clinched');
});
