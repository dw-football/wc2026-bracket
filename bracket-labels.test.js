// bracket-labels.test.js — node:test
//
//   node --test bracket-labels.test.js
//
// SHAREABLE: tests the PURE label logic only. No personal/calendar data is read
// or asserted (the calendar binding lives in sync-calendar.mjs + the gitignored
// calendar-map.local.json, which this suite never touches).
//
// Covers (all renderers consume the per-slot occupancy [{code,p}] — the SAME
// numbers the bracket page shows, so the calendar can't disagree with the site):
//   R32 GROUP/THIRD slots (n-based tiers on the realistic >=0.5% set):
//     - 1 team   -> locked full name
//     - 2 teams  -> "FAV (NN%)/OTHER" (favorite-first; holds PAST 75%)
//     - 3+, top >=75% -> "slotCode (FAV NN%)"     (a real <1% 3rd keeps it a code)
//     - 3+, flat       -> bare slotCode ("K2","3rd E/H/I/J/K")
//   KNOCKOUT slots (highlighted-teams-only):
//     - single occupant >=99% -> locked full name
//     - highlighted teams >=5% -> "CODE (NN%)" favorite-first, then "/…"
//     - none highlighted        -> readable structural feeder code ("G1/?3")
//     - 3rd place                -> blank until BOTH semifinals are played
//   plus an end-to-end computeMatchLabels() smoke test on the live feed asserting
//   structural invariants (no exact wording pinned to volatile live data).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  renderR32Side,
  renderKoSide,
  koStructuralLabel,
  orderByProb,
  computeMatchLabels,
  groupRankSets,
  r32SlotCode,
  groupSlotCode,
  DOMINANT_THRESHOLD,
  HIGHLIGHTED_TEAMS,
} from './bracket-labels.mjs';
import { fetchRaw, toGroups } from './adapter.js';
import { rankThirdPlaceTeams } from './engine.js';
import { resolveThirdPlaceSlots } from './allocation.js';

// A trivial full-name resolver for rendering tests (identity-ish).
const NAMES = { USA: 'United States', POR: 'Portugal', BRA: 'Brazil', ESP: 'Spain' };
const fullName = (c) => NAMES[c] || c;
const mcMap = (obj) => new Map(Object.entries(obj));
// Per-slot occupancy as the renderers consume it: [{code, p}, …].
const occ = (obj) => Object.entries(obj).map(([code, p]) => ({ code, p }));
const HI = new Set(HIGHLIGHTED_TEAMS);
const r32 = (o, slot, opts) => renderR32Side(occ(o), slot, fullName, opts).label;
const ko = (o, structural) => renderKoSide(occ(o), structural, fullName, { highlighted: HI }).label;

// ---------------------------------------------------------------------------
// R32 GROUP SLOT — n-based tiers on the realistic (>=0.5%) set
// ---------------------------------------------------------------------------

// Slot codes are GROUP-FIRST per David's convention: "A1"=winner A, "K2"=runner-up K.
test('group slot codes are GROUP-FIRST (David convention): A1 winner, K2 runner-up', () => {
  assert.equal(groupSlotCode('A', 1), 'A1');
  assert.equal(groupSlotCode('K', 2), 'K2');
  assert.equal(r32SlotCode({ type: 'winner', group: 'F' }), 'F1');
  assert.equal(r32SlotCode({ type: 'runnerup', group: 'C' }), 'C2');
  assert.equal(r32SlotCode({ type: 'third', from: ['A', 'B', 'C', 'D', 'F'] }), '3rd A/B/C/D/F');
});

test('R32: one realistic team -> LOCKED full name', () => {
  assert.equal(r32({ USA: 1 }, 'D1'), 'United States');
});

test('R32: exactly two realistic -> "FAV (NN%)/OTHER", favorite-first', () => {
  assert.equal(r32({ POR: 0.62, COL: 0.38 }, 'K2'), 'POR (62%)/COL');
});

test('R32: two-name form holds PAST 75% (David: exactly-two always shows both)', () => {
  // FRA/NOR playoff: FRA 83% — still both names, NOT "I1 (FRA 83%)".
  assert.equal(r32({ FRA: 0.83, NOR: 0.17 }, 'I1'), 'FRA (83%)/NOR');
});

test('R32: 3+ realistic with a >=75% favorite -> "slotCode (FAV NN%)"', () => {
  // CZE at 0.6% keeps a 3rd team alive -> code form, not two-horse.
  assert.equal(r32({ KOR: 0.903, RSA: 0.09, CZE: 0.006 }, 'A2'), 'A2 (KOR 90%)');
});

test('R32: the <0.5% floor drops ~impossible longshots so a real two-horse reads as names', () => {
  // B2: SUI/CAN are the only realistic two; BIH/QAT (GD-swing flukes) drop out.
  assert.equal(r32({ SUI: 0.6, CAN: 0.4, BIH: 0.002, QAT: 0.001 }, 'B2'), 'SUI (60%)/CAN');
});

test('R32: 3+ realistic, nobody dominant -> bare slotCode', () => {
  assert.equal(r32({ BRA: 0.5, MAR: 0.3, SCO: 0.2 }, 'C1'), 'C1');
  assert.equal(r32({ JPN: 0.3, NED: 0.25, SWE: 0.2, CAN: 0.15, AUT: 0.1 }, '3rd E/H/I/J/K'), '3rd E/H/I/J/K');
});

test('R32: dominance is at the 75% boundary (74.9% -> bare code, 75% -> code+fav)', () => {
  assert.equal(r32({ A: DOMINANT_THRESHOLD - 0.001, B: 0.2, C: 0.05 }, 'X1'), 'X1');
  assert.equal(r32({ A: DOMINANT_THRESHOLD, B: 0.2, C: 0.05 }, 'X1'), `X1 (A ${Math.round(DOMINANT_THRESHOLD * 100)}%)`);
});

// ---------------------------------------------------------------------------
// KNOCKOUT SLOT — highlighted-teams-only, each "CODE (NN%)", "/…"
// ---------------------------------------------------------------------------

test('KO: a single occupant >=99% (feeder resolved) -> LOCKED full name', () => {
  const r = renderKoSide(occ({ USA: 1 }), 'W81', fullName, { highlighted: HI });
  assert.equal(r.label, 'United States');
  assert.equal(r.structural, false);
});

test('KO: names ONLY highlighted teams, favorite-first, with "/…"', () => {
  // ESP/POR highlighted and >=5%; COL is not highlighted -> omitted.
  assert.equal(ko({ ESP: 0.45, POR: 0.18, COL: 0.08 }, 'W93'), 'ESP (45%)/POR (18%)/…');
});

test('KO: a highlighted team below the 5% floor is NOT shown', () => {
  // USA 3% < floor -> no highlighted clears it -> structural.
  const r = renderKoSide(occ({ JPN: 0.4, USA: 0.03, NED: 0.2 }), 'W82', fullName, { highlighted: HI });
  assert.equal(r.label, 'W82');
  assert.equal(r.structural, true);
});

test('KO: no highlighted team at all -> structural feeder code (adds nothing)', () => {
  const r = renderKoSide(occ({ JPN: 0.3, NED: 0.25, BIH: 0.15 }), 'G1/?3', fullName, { highlighted: HI });
  assert.equal(r.label, 'G1/?3');
  assert.equal(r.structural, true);
});

// ---------------------------------------------------------------------------
// Readable structural feeder labels ("G1/?3", not "W82")
// ---------------------------------------------------------------------------

test('koStructuralLabel: winner-of an R32 (winner v third) reads "G1/?3"', () => {
  const matchByNo = {
    82: { match: 82, home: { type: 'winner', group: 'G' }, away: { type: 'third', from: ['A', 'E', 'H', 'I', 'J'] } },
  };
  assert.equal(koStructuralLabel({ type: 'winnerOf', match: 82 }, matchByNo), 'G1/?3');
});

test('koStructuralLabel: falls back to terse code when the feeder is unknown', () => {
  assert.equal(koStructuralLabel({ type: 'winnerOf', match: 999 }, {}), 'W999');
});

test('favorite-first ordering helper still orders by probability', () => {
  assert.equal(orderByProb(['XXX', 'YYY', 'ZZZ'], mcMap({ XXX: 0.7, YYY: 0.2, ZZZ: 0.1 }))[0], 'XXX');
});

// ---------------------------------------------------------------------------
// End-to-end: computeMatchLabels on the live feed (structural invariants only)
// ---------------------------------------------------------------------------

test('computeMatchLabels (live data): R32 fully labeled, knockout obeys the rules', async () => {
  const teams = JSON.parse(await readFile(new URL('./teams.json', import.meta.url), 'utf8'));
  const bracket = JSON.parse(await readFile(new URL('./bracket.json', import.meta.url), 'utf8'));
  const raw = await fetchRaw();
  const groups = toGroups(raw, teams);

  const labels = computeMatchLabels(
    { groups, bracket, teams, koResults: {}, resolveThirdPlaceSlots, rankThirdPlaceTeams,
      mcN: 8000 },
    { watchedTeams: ['USA'], maxPreview: 4 }
  );

  // Every R32 match (73-88) MUST produce a full label (never "unchanged").
  for (let m = 73; m <= 88; m++) {
    const lab = labels.get(m);
    assert.ok(lab, `label exists for M${m}`);
    assert.ok(lab.full && / v /.test(lab.full) && / R32$/.test(lab.full),
      `M${m} is a full R32 label: ${lab.full}`);
  }

  // Group winners that are mathematically locked TODAY must appear as real names.
  // (USA=Group D, Mexico=Group A, Germany=Group E, Argentina=Group J — all clinched
  //  1st per the project's standings; their R32 winner-side must be the full name.)
  assert.match(labels.get(81).full, /^USA v /, 'M81 home = USA locked');
  assert.match(labels.get(79).full, /^Mexico v /, 'M79 home = Mexico locked');
  assert.match(labels.get(74).full, /^Germany v /, 'M74 home = Germany locked');
  assert.match(labels.get(86).full, /^Argentina v /, 'M86 home = Argentina locked');

  // Knockout sides are highlighted-team breadcrumbs now: a side that LISTS teams
  // ends with "/…" and every named segment carries a "(NN%)"; otherwise it is a
  // structural feeder code ("G1/?3") or a single locked name. No bare name walls.
  for (let m = 89; m <= 103; m++) {
    const lab = labels.get(m);
    if (!lab || lab.full == null) continue; // unchanged is fine
    for (const side of [lab.home, lab.away]) {
      if (side == null || !side.includes('/…')) continue;
      for (const seg of side.replace('/…', '').split('/')) {
        assert.match(seg, /\(\d+%\)$/, `M${m} highlighted segment carries a %: "${seg}" in "${side}"`);
      }
    }
  }

  // USA breadcrumb: USA dominates M94 home (its R32 feeder M81), so M94 home names
  // USA with its reach-% and trails "/…".
  const m94 = labels.get(94);
  assert.ok(m94 && m94.full, 'M94 carries a label');
  assert.match(m94.home, /^USA \(\d+%\)/, `M94 home shows USA breadcrumb with %: ${m94.home}`);
});

// ---------------------------------------------------------------------------
// groupRankSets must survive ANY group stage (0, 1-2, or 3+ unplayed).
// REGRESSION: scenarioGrid throws on != 1-2 unplayed, so a group sitting at 3
// unplayed (or fully decided) once crashed the whole calendar tool. 0 unplayed
// -> exact standings; 3+ -> safe superset (every team can still finish 1/2/3).
// ---------------------------------------------------------------------------

const RR = (codes) => codes.map((c) => ({ code: c, name: c, elo: 1600 }));
// All 6 round-robin pairings for a 4-team group, in order.
const PAIRS = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
function groupWithPlayed(letter, codes, nPlayed) {
  const matches = PAIRS.map(([h, a], i) => {
    const played = i < nPlayed;
    return {
      home: codes[h], away: codes[a],
      homeGoals: played ? 1 : null, awayGoals: played ? 0 : null, played,
      date: '2026-06-2' + (i % 9), time: '12:00',
    };
  });
  return { name: 'Group ' + letter, teams: RR(codes), matches };
}

test('groupRankSets: a group with 3 unplayed yields the safe superset (no scenarioGrid throw)', () => {
  // 3 of 6 played -> 3 unplayed. Must NOT throw; every team can still place 1/2/3.
  const g = groupWithPlayed('K', ['POR', 'COD', 'UZB', 'COL'], 3);
  let rs;
  assert.doesNotThrow(() => { rs = groupRankSets([g]); }, 'must not throw on 3 unplayed');
  const K = rs.K;
  assert.ok(K, 'Group K rank sets present');
  for (const code of ['POR', 'COD', 'UZB', 'COL']) {
    assert.ok(K.r1.has(code) && K.r2.has(code) && K.r3.has(code),
      `${code} in the safe superset for all of 1st/2nd/3rd`);
  }
});

test('groupRankSets: a fully decided group (0 unplayed) uses exact final standings', () => {
  // All 6 played, seeded so c0 wins, c1 2nd, c2 3rd (1-0 wins down the order).
  const g = groupWithPlayed('K', ['AAA', 'BBB', 'CCC', 'DDD'], 6);
  const rs = groupRankSets([g]);
  const K = rs.K;
  // Exactly one team per rank — the deterministic finishers, not a superset.
  assert.equal(K.r1.size, 1, 'one clear winner');
  assert.equal(K.r2.size, 1, 'one runner-up');
  assert.equal(K.r3.size, 1, 'one third');
});

test('computeMatchLabels: KO previews are driven by HIGHLIGHTED teams (not watchedTeams); 3rd place blank until the SFs', async () => {
  const teams = JSON.parse(await readFile(new URL('./teams.json', import.meta.url), 'utf8'));
  const bracket = JSON.parse(await readFile(new URL('./bracket.json', import.meta.url), 'utf8'));
  const raw = await fetchRaw();
  const groups = toGroups(raw, teams);
  // watchedTeams is now IRRELEVANT to KO labels — the iconic HIGHLIGHTED_TEAMS set
  // drives them — so [] and ['USA'] must produce identical knockout labels.
  const base = { groups, bracket, teams, koResults: {}, resolveThirdPlaceSlots, rankThirdPlaceTeams, mcN: 8000 };
  const a = computeMatchLabels(base, { watchedTeams: [] });
  const b = computeMatchLabels(base, { watchedTeams: ['USA'] });
  for (let m = 89; m <= 103; m++) {
    assert.equal(a.get(m).full, b.get(m).full, `M${m} KO label independent of watchedTeams`);
  }
  // 3rd-place (103) is blank until BOTH semifinals are played (treated like the Final).
  assert.equal(a.get(103).full, null, 'M103 (3rd place) blank pre-SF');
  // Group stage in progress still surfaces highlighted teams in the knockout rounds.
  let named = 0;
  for (let m = 89; m <= 102; m++) if (a.get(m).full) named++;
  assert.ok(named > 0, 'highlighted-team previews appear in the knockout rounds');
});
