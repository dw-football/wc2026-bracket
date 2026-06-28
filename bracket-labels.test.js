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
import { readFileSync } from 'node:fs';

import {
  renderR32Side,
  renderKoSide,
  koStructuralLabel,
  orderByProb,
  computeMatchLabels,
  groupRankSets,
  r32SlotCode,
  groupSlotCode,
  resolveKnockoutFixtures,
  knockoutResultsFromManual,
  mergeKnockoutResults,
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
// Old group-stage preview format lives under the 'highlighted' toggle now.
const ko = (o, structural) => renderKoSide(occ(o), structural, fullName, { highlighted: HI, mode: 'highlighted' }).label;
// Default (bracket-mirror) contender-pair format.
const koC = (o, structural) => renderKoSide(occ(o), structural, fullName).label;

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
  const r = renderKoSide(occ({ JPN: 0.4, USA: 0.03, NED: 0.2 }), 'W82', fullName, { highlighted: HI, mode: 'highlighted' });
  assert.equal(r.label, 'W82');
  assert.equal(r.structural, true);
});

test('KO: no highlighted team at all -> structural feeder code (adds nothing)', () => {
  const r = renderKoSide(occ({ JPN: 0.3, NED: 0.25, BIH: 0.15 }), 'G1/?3', fullName, { highlighted: HI, mode: 'highlighted' });
  assert.equal(r.label, 'G1/?3');
  assert.equal(r.structural, true);
});

// ---------------------------------------------------------------------------
// KO contender-pair labels — DEFAULT mode, mirrors the bracket
// ---------------------------------------------------------------------------

test('KO contenders (default): a 2-team slot names BOTH with %, favorite-first', () => {
  assert.equal(koC({ BRA: 0.57, JPN: 0.43 }, 'W76'), 'BRA 57%/JPN 43%');
});

test('KO contenders (default): >2 contenders -> top 2 + "/…"', () => {
  assert.equal(koC({ FRA: 0.52, GER: 0.28, NED: 0.12, CAN: 0.08 }, 'W97'), 'FRA 52%/GER 28%/…');
});

test('KO contenders (default): sub-floor longshot dropped; top 2 named, no "/…"', () => {
  // COL 0.3% < 0.5% floor -> not a contender; ESP/POR named, no ellipsis.
  assert.equal(koC({ ESP: 0.6, POR: 0.397, COL: 0.003 }, 'W93'), 'ESP 60%/POR 40%');
});

test('KO contenders (default): a locked occupant still shows the full name', () => {
  assert.equal(koC({ USA: 1 }, 'W81'), 'United States');
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

  // Knockout sides now MIRROR THE BRACKET (default 'contenders' mode): a side that
  // lists teams shows "CODE NN%" segments, favorite-first, capped at 2 with a trailing
  // "/…" if more contenders exist. (A locked side is a full name; a never-ready side
  // is a structural feeder code.) No bare "(NN%)" parens, no name walls.
  for (let m = 89; m <= 103; m++) {
    const lab = labels.get(m);
    if (!lab || lab.full == null) continue; // unchanged is fine
    for (const side of [lab.home, lab.away]) {
      if (side == null || !/\d%/.test(side)) continue; // skip locked names / structural codes
      for (const seg of side.replace('/…', '').split('/')) {
        assert.match(seg, /^[A-Z]{2,4} \d+%$/, `M${m} contender segment is "CODE NN%": "${seg}" in "${side}"`);
      }
    }
  }

  // R32 is set, so M94 home (fed by the decided M81 = USA v BIH) mirrors the bracket:
  // its two contenders with %, USA favorite-first — NOT a "/…" breadcrumb.
  const m94 = labels.get(94);
  assert.ok(m94 && m94.full, 'M94 carries a label');
  assert.match(m94.home, /^USA \d+%\/[A-Z]{2,4} \d+%$/, `M94 home is the USA contender pair: ${m94.home}`);
});

test('computeMatchLabels: koLabelMode "highlighted" restores the iconic-team preview (toggle preserved for next tournament)', async () => {
  const teams = JSON.parse(await readFile(new URL('./teams.json', import.meta.url), 'utf8'));
  const bracket = JSON.parse(await readFile(new URL('./bracket.json', import.meta.url), 'utf8'));
  const raw = await fetchRaw();
  const groups = toGroups(raw, teams);
  const labels = computeMatchLabels(
    { groups, bracket, teams, koResults: {}, resolveThirdPlaceSlots, rankThirdPlaceTeams, mcN: 8000 },
    { watchedTeams: ['USA'], koLabelMode: 'highlighted' }
  );
  // In highlighted mode a KO side that lists teams uses the "(NN%)" parens format + "/…".
  let sawHi = false;
  for (let m = 89; m <= 103; m++) {
    const lab = labels.get(m); if (!lab || lab.full == null) continue;
    for (const side of [lab.home, lab.away]) {
      if (side == null || !side.includes('/…')) continue;
      sawHi = true;
      for (const seg of side.replace('/…', '').split('/')) {
        assert.match(seg, /\(\d+%\)$/, `highlighted-mode segment carries "(NN%)": "${seg}"`);
      }
    }
  }
  assert.ok(sawHi, 'highlighted mode produced at least one "(NN%)/…" KO side');
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

// ---------------------------------------------------------------------------
// resolveKnockoutFixtures — DETERMINISTIC matchNo -> {home,away} resolution.
// The inverse map the ESPN poller uses to turn a KO team-pair into a match
// number. Monotone: a match appears only once BOTH sides are mathematically
// fixed (group complete for R32; feeder result present for R16+).
// ---------------------------------------------------------------------------

const BRACKET = JSON.parse(readFileSync(new URL('./bracket.json', import.meta.url), 'utf8'));
const LETTERS12 = 'ABCDEFGHIJKL'.split('');
// 12 fully-played groups, codes unique per group (e.g. A1..A4). 1-0 wins down
// the order => winner=x1, runner-up=x2, third=x3 deterministically.
function allGroupsComplete() {
  return LETTERS12.map((L) =>
    groupWithPlayed(L, [L + '1', L + '2', L + '3', L + '4'], 6));
}

test('resolveKnockoutFixtures: no R32 match resolves while any group is incomplete', () => {
  const bracket = BRACKET;
  const groups = allGroupsComplete();
  groups[3].matches[5].played = false; // Group D one match short
  const fx = resolveKnockoutFixtures(groups, bracket, {}, { resolveThirdPlaceSlots });
  // A 3rd-place slot can't resolve (cross-group), and any match feeding off D is out.
  // Specifically no match should carry a 'third' code, and matches with a D winner/
  // runner-up side are omitted. Assert the whole-tournament invariant via count.
  const full = resolveKnockoutFixtures(allGroupsComplete(), bracket, {}, { resolveThirdPlaceSlots });
  assert.ok(Object.keys(fx).length < Object.keys(full).length,
    'incomplete group resolves strictly fewer R32 fixtures');
});

test('resolveKnockoutFixtures: all 16 R32 fixtures resolve once every group is complete', () => {
  const bracket = BRACKET;
  const fx = resolveKnockoutFixtures(allGroupsComplete(), bracket, {}, { resolveThirdPlaceSlots });
  const r32 = bracket.rounds.R32.map((m) => m.match);
  for (const n of r32) {
    assert.ok(fx[n], `M${n} resolved`);
    assert.equal(fx[n].round, 'R32');
    assert.ok(fx[n].home && fx[n].away && fx[n].home !== fx[n].away, `M${n} two distinct teams`);
  }
  // No R16+ match resolves yet (no koResults supplied).
  assert.equal(fx[89], undefined, 'R16 unresolved without feeder results');
});

test('resolveKnockoutFixtures: R16 side resolves from a feeder koResult (winnerOf)', () => {
  const bracket = BRACKET;
  const groups = allGroupsComplete();
  const r32 = resolveKnockoutFixtures(groups, bracket, {}, { resolveThirdPlaceSlots });
  // M89 = winnerOf 74 v winnerOf 77. Feed both winners.
  const ko = {
    74: { winner: r32[74].home, loser: r32[74].away, home: r32[74].home, away: r32[74].away, score: [1, 0], decider: 'reg', pens: null },
    77: { winner: r32[77].away, loser: r32[77].home, home: r32[77].home, away: r32[77].away, score: [0, 0], decider: 'pens', pens: [4, 2] },
  };
  const fx = resolveKnockoutFixtures(groups, bracket, ko, { resolveThirdPlaceSlots });
  assert.ok(fx[89], 'M89 resolves once both feeders have results');
  assert.equal(fx[89].home, r32[74].home, 'M89 home = winner of M74');
  assert.equal(fx[89].away, r32[77].away, 'M89 away = pens winner of M77');
  assert.equal(fx[89].round, 'R16');
});

test('resolveKnockoutFixtures: matches live feed — M73 is the two complete-group runners-up', async () => {
  const teams = JSON.parse(await readFile(new URL('./teams.json', import.meta.url), 'utf8'));
  const bracket = JSON.parse(await readFile(new URL('./bracket.json', import.meta.url), 'utf8'));
  const raw = await fetchRaw();
  const groups = toGroups(raw, teams);
  const fx = resolveKnockoutFixtures(groups, bracket, {}, { resolveThirdPlaceSlots });
  // M73 = runnerup A v runnerup B; Groups A & B are complete in the live feed.
  const aDone = groups.find((g) => g.name === 'Group A').matches.every((m) => m.played);
  const bDone = groups.find((g) => g.name === 'Group B').matches.every((m) => m.played);
  if (aDone && bDone) {
    assert.ok(fx[73], 'M73 resolved (A & B complete)');
    assert.equal(fx[73].round, 'R32');
  }
});

// ---------------------------------------------------------------------------
// knockoutResultsFromManual + mergeKnockoutResults — the manual/auto KO source
// and the feed-wins merge that produces the baked koResults map.
// ---------------------------------------------------------------------------

test('knockoutResultsFromManual: regulation win derives winner/loser', () => {
  const r = knockoutResultsFromManual([{ match: 73, home: 'RSA', away: 'CAN', score: [1, 2] }]);
  assert.deepEqual(r[73], { winner: 'CAN', loser: 'RSA', home: 'RSA', away: 'CAN', score: [1, 2], decider: 'reg', pens: null });
});

test('knockoutResultsFromManual: AET tag is honored on a decided score', () => {
  const r = knockoutResultsFromManual([{ match: 74, home: 'USA', away: 'ITA', score: [2, 1], decider: 'aet' }]);
  assert.equal(r[74].decider, 'aet');
  assert.equal(r[74].winner, 'USA');
  assert.equal(r[74].pens, null);
});

test('knockoutResultsFromManual: level score resolves ONLY via a decisive shootout', () => {
  const pens = knockoutResultsFromManual([{ match: 81, home: 'USA', away: 'GER', score: [1, 1], decider: 'pens', pens: [4, 3] }]);
  assert.deepEqual(pens[81], { winner: 'USA', loser: 'GER', home: 'USA', away: 'GER', score: [1, 1], decider: 'pens', pens: [4, 3] });
  // level, no shootout -> unresolved (skipped)
  assert.equal(knockoutResultsFromManual([{ match: 82, home: 'A', away: 'B', score: [0, 0] }])[82], undefined);
  // level, tied shootout (bad data) -> unresolved
  assert.equal(knockoutResultsFromManual([{ match: 82, home: 'A', away: 'B', score: [0, 0], pens: [3, 3] }])[82], undefined);
});

test('knockoutResultsFromManual: a decided score can never be tagged pens', () => {
  const r = knockoutResultsFromManual([{ match: 73, home: 'A', away: 'B', score: [2, 0], decider: 'pens', pens: [5, 4] }]);
  assert.equal(r[73].decider, 'reg');
  assert.equal(r[73].pens, null);
});

test('knockoutResultsFromManual: skips incomplete entries', () => {
  const r = knockoutResultsFromManual([
    { home: 'A', away: 'B', score: [1, 0] },      // no match
    { match: 75, away: 'B', score: [1, 0] },       // no home
    { match: 76, home: 'A', away: 'B' },           // no score
    { match: 77, home: 'A', away: 'B', score: [3] }, // bad score
  ]);
  assert.deepEqual(r, {});
});

test('mergeKnockoutResults: later source wins (feed supersedes manual), gaps preserved', () => {
  const manual = knockoutResultsFromManual([
    { match: 73, home: 'RSA', away: 'CAN', score: [0, 1], decider: 'aet' }, // typo'd manual
    { match: 74, home: 'USA', away: 'ITA', score: [2, 1] },                  // feed not in yet
  ]);
  const feed = { 73: { winner: 'CAN', loser: 'RSA', home: 'RSA', away: 'CAN', score: [1, 2], decider: 'reg', pens: null } };
  const merged = mergeKnockoutResults(manual, feed); // manual first, feed last
  assert.deepEqual(merged[73].score, [1, 2], 'feed corrects the manual typo');
  assert.equal(merged[74].winner, 'USA', 'manual-only match preserved where feed is silent');
});
