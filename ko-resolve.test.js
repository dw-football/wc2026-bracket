// ko-resolve.test.js — node:test
//
//   node --test ko-resolve.test.js
//
// Regression guard for the "eliminated team in a later-round slot" bug (2026-07-04):
// the bracket renderer resolved played-KO winners from the R32 ONLY, so the FIRST
// R16 result (M90 MAR 3-0 CAN) did not propagate — the quarterfinal it fed fell back
// to a stale pre-tournament projection and displayed Netherlands (knocked out in the
// R32) as a quarterfinalist. These tests exercise winner propagation across EVERY
// round (R32 -> R16 -> QF -> SF -> Final) so the class of bug cannot silently return.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { makeOccupantResolver, koWinnersByMatch } from './ko-resolve.mjs';
import { makeKoSlotDist } from './ko-slot-dist.mjs';
import { knockoutResultsFromManual } from './bracket-labels.mjs';

const BRACKET = JSON.parse(readFileSync(new URL('./bracket.json', import.meta.url), 'utf8'));
const MANUAL_KO = JSON.parse(readFileSync(new URL('./manual-ko-results.json', import.meta.url), 'utf8'));

function everyMatch(bracket) {
  const out = [];
  for (const rd of Object.keys(bracket.rounds))
    for (const m of bracket.rounds[rd]) out.push({ ...m, round: rd });
  return out;
}
const NON_R32 = (rd) => rd !== 'R32';

// ---------------------------------------------------------------------------
// Real-data reproduction: the exact live state on 2026-07-04.
// ---------------------------------------------------------------------------
test('real data: M90 winner (MAR) propagates into the QF it feeds (M97 away)', () => {
  const koResults = knockoutResultsFromManual(MANUAL_KO);
  const occ = makeOccupantResolver(BRACKET, koResults, () => null);

  // sanity: the played results we depend on
  assert.equal(koResults[73].winner, 'CAN', 'M73 -> CAN');
  assert.equal(koResults[75].winner, 'MAR', 'M75 -> MAR (NED eliminated here)');
  assert.equal(koResults[90].winner, 'MAR', 'M90 -> MAR');

  // R16 box M90 is fed by the two PLAYED R32 winners.
  assert.equal(occ.sideCode(90, 'home'), 'CAN', 'M90 home = winner of M73');
  assert.equal(occ.sideCode(90, 'away'), 'MAR', 'M90 away = winner of M75');

  // THE FIX: the QF slot fed by the PLAYED R16 game shows its winner, not a stale
  // projection. Before the fix this resolved to null -> the renderer fell back to
  // the Monte-Carlo modal (Netherlands) and locked an eliminated team into the QF.
  assert.equal(occ.sideCode(97, 'away'), 'MAR', 'M97 away = winner of M90 (was NED)');
});

test('real data: Netherlands (out in the R32) appears in NO knockout slot from the R16 on', () => {
  const koResults = knockoutResultsFromManual(MANUAL_KO);
  const occ = makeOccupantResolver(BRACKET, koResults, () => null);
  for (const m of everyMatch(BRACKET)) {
    if (!NON_R32(m.round)) continue; // NED legitimately occupied its R32 match (M75)
    for (const side of ['home', 'away']) {
      assert.notEqual(occ.sideCode(m.match, side), 'NED',
        `NED must not occupy M${m.match} ${side} (${m.round})`);
    }
  }
});

test('real data: with M90 NOT yet played, the QF slot it feeds is undetermined (null)', () => {
  const koResults = knockoutResultsFromManual(MANUAL_KO.filter((r) => r.match !== 90));
  const occ = makeOccupantResolver(BRACKET, koResults, () => null);
  assert.equal(koResults[90], undefined, 'M90 removed from results');
  // both feeders known (CAN, MAR) but the game is unplayed -> the fed slot is TBD,
  // and the renderer shows the CAN/MAR contender pair (that pathway tested below).
  assert.equal(occ.sideCode(90, 'home'), 'CAN');
  assert.equal(occ.sideCode(90, 'away'), 'MAR');
  assert.equal(occ.sideCode(97, 'away'), null, 'QF slot fed by an UNPLAYED R16 is null');
});

// ---------------------------------------------------------------------------
// Synthetic full play-through: winners propagate correctly through ALL rounds,
// and no losing team ever appears downstream of the round it lost in.
// ---------------------------------------------------------------------------
// R32 leaf occupants: match n has teams H<n> (home) and A<n> (away). The home team
// wins every R32 game; then we advance the LOWER-numbered feeder's winner each later
// round, deterministically, all the way to the Final.
function syntheticPlaythrough() {
  const r32Occ = (no, side) =>
    no >= 73 && no <= 88 ? (side === 'home' ? 'H' + no : 'A' + no) : null;

  const idx = {};
  for (const rd of Object.keys(BRACKET.rounds))
    for (const m of BRACKET.rounds[rd]) idx[m.match] = m;

  const winners = {}; // matchNo -> code
  const koResults = {};
  const feederWinner = (def) =>
    def.type === 'winnerOf' ? winners[def.match] : (def === 'H' ? null : null);

  // resolve a side's concrete code given winners computed so far
  const sideOf = (m, side) => {
    const def = m[side];
    if (def && def.type === 'winnerOf') return winners[def.match];
    return side === 'home' ? 'H' + m.match : 'A' + m.match; // R32 leaf
  };

  for (const rd of ['R32', 'R16', 'QF', 'SF', 'ThirdPlace', 'Final']) {
    for (const m of BRACKET.rounds[rd] || []) {
      const home = sideOf(m, 'home');
      const away = sideOf(m, 'away');
      const winner = home; // home always advances
      const loser = away;
      winners[m.match] = winner;
      koResults[m.match] = { winner, loser, home, away, score: [1, 0], decider: 'reg', pens: null };
    }
  }
  return { r32Occ, koResults, winners, idx };
}

test('synthetic: a full R32->Final play-through resolves every fed slot to its feeder winner', () => {
  const { r32Occ, koResults, winners, idx } = syntheticPlaythrough();
  const occ = makeOccupantResolver(BRACKET, koResults, r32Occ);

  // every winnerOf slot equals the actual recorded winner of its feeder match
  for (const m of everyMatch(BRACKET)) {
    for (const side of ['home', 'away']) {
      const def = idx[m.match][side];
      if (def && def.type === 'winnerOf') {
        assert.equal(occ.sideCode(m.match, side), winners[def.match],
          `M${m.match} ${side} must equal winner of M${def.match}`);
      }
    }
  }
  // the Final (M104) is contended by the two semifinal winners
  assert.equal(occ.sideCode(104, 'home'), winners[101], 'Final home = SF1 winner');
  assert.equal(occ.sideCode(104, 'away'), winners[102], 'Final away = SF2 winner');
});

test('synthetic: a team eliminated in round R never appears in ANY later round', () => {
  const { r32Occ, koResults, winners, idx } = syntheticPlaythrough();
  const occ = makeOccupantResolver(BRACKET, koResults, r32Occ);
  const roundOrder = ['R32', 'R16', 'QF', 'SF', 'ThirdPlace', 'Final'];
  const roundOf = {};
  roundOrder.forEach((rd, i) => (BRACKET.rounds[rd] || []).forEach((m) => (roundOf[m.match] = i)));

  for (const m of everyMatch(BRACKET)) {
    const r = koResults[m.match];
    if (!r) continue;
    const loser = r.loser;
    // the loser of match m must not occupy any slot in a strictly later round
    for (const later of everyMatch(BRACKET)) {
      if (roundOf[later.match] <= roundOf[m.match]) continue;
      for (const side of ['home', 'away']) {
        assert.notEqual(occ.sideCode(later.match, side), loser,
          `loser of M${m.match} (${loser}) must not occupy later M${later.match} ${side}`);
      }
    }
  }
});

test('koWinnersByMatch spans all rounds (not just the R32)', () => {
  const { koResults } = syntheticPlaythrough();
  const w = koWinnersByMatch(BRACKET, koResults);
  // one winner per knockout match, R32 (73) through the Final (104)
  assert.equal(Object.keys(w).length, everyMatch(BRACKET).length);
  assert.ok(w[73] && w[90] && w[97] && w[101] && w[104], 'winners present across every round');
});

// ---------------------------------------------------------------------------
// Distribution side (ko-slot-dist): the chained-H2H must also exclude an
// eliminated team from every downstream slot, before AND after the fed game.
// ---------------------------------------------------------------------------
const R32_TEAMS = { 73: { home: 'RSA', away: 'CAN' }, 75: { home: 'NED', away: 'MAR' } };
function koDistWith(koResults) {
  return makeKoSlotDist({
    bracket: BRACKET,
    eloByCode: {}, // all equal -> h2h = 0.5, isolates the STRUCTURE (who can appear)
    koLambda: 0.6,
    hosts: new Set(),
    koVenueCountry: {},
    r32Occupant: (no, side) => (R32_TEAMS[no] ? R32_TEAMS[no][side] : null),
    koWinner: (no) => (koResults[no] ? koResults[no].winner : null),
  });
}

test('ko-slot-dist: NED (lost M75) carries ZERO probability in the QF slot, before M90', () => {
  const koResults = knockoutResultsFromManual(MANUAL_KO.filter((r) => r.match !== 90));
  const dist = koDistWith(koResults).slotDist(97, 'away'); // fed by M90 (unplayed here)
  const codes = dist.map((d) => d.code);
  assert.ok(!codes.includes('NED'), 'NED must not appear');
  assert.deepEqual(codes.sort(), ['CAN', 'MAR'], 'only the two live contenders appear');
  assert.ok(Math.abs(dist.reduce((s, d) => s + d.p, 0) - 1) < 1e-9, 'distribution sums to 1');
});

test('ko-slot-dist: after M90, the QF slot collapses to MAR at p=1 (NED still absent)', () => {
  const koResults = knockoutResultsFromManual(MANUAL_KO);
  const dist = koDistWith(koResults).slotDist(97, 'away');
  assert.equal(dist.length, 1);
  assert.equal(dist[0].code, 'MAR');
  assert.ok(Math.abs(dist[0].p - 1) < 1e-9);
});
