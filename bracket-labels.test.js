// bracket-labels.test.js — node:test
//
//   node --test bracket-labels.test.js
//
// SHAREABLE: tests the PURE label logic only. No personal/calendar data is read
// or asserted (the calendar binding lives in sync-calendar.mjs + the gitignored
// calendar-map.local.json, which this suite never touches).
//
// Covers:
//   R32 GROUP slots (4-tier rule):
//     - locked        -> real team name
//     - exactly-two   -> favorite-first "FAV/OTHER" pair
//     - 3+ dominant   -> "FAV/<slotCode>"
//     - 3+ flat       -> structural placeholder ("1L","2K","3rd E/H/I/J/K")
//     - favorite-first ordering; winner-slot vs runner-up-slot order opposite
//   KNOCKOUT slots (candidate-cap rule):
//     - feeder played / chain resolved -> single locked team
//     - 2..cap candidates              -> all, favorite-first, slash-joined
//     - > cap WITH a watched team       -> "USA?/…" breadcrumb
//     - > cap WITHOUT a watched team    -> structural feeder code (no wall)
//   plus an end-to-end computeMatchLabels() smoke test on the live feed asserting
//   structural invariants (no exact wording pinned to volatile live data).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  classifyR32Side,
  classifyKoSide,
  renderSideLabel,
  orderByProb,
  computeMatchLabels,
  r32SlotCode,
  groupSlotCode,
  DOMINANT_THRESHOLD,
  DEFAULT_MAX_PREVIEW,
} from './bracket-labels.mjs';
import { fetchRaw, toGroups } from './adapter.js';
import { rankThirdPlaceTeams } from './engine.js';
import { resolveThirdPlaceSlots } from './allocation.js';

// A trivial full-name resolver for rendering tests (identity-ish).
const NAMES = { USA: 'United States', POR: 'Portugal', BRA: 'Brazil', ESP: 'Spain' };
const fullName = (c) => NAMES[c] || c;
const mcMap = (obj) => new Map(Object.entries(obj));

// ---------------------------------------------------------------------------
// R32 GROUP SLOT — 4 tiers
// ---------------------------------------------------------------------------

// Slot codes are GROUP-FIRST per David's convention: "A1"=winner A, "K2"=runner-up K.
test('group slot codes are GROUP-FIRST (David convention): A1 winner, K2 runner-up', () => {
  assert.equal(groupSlotCode('A', 1), 'A1');
  assert.equal(groupSlotCode('K', 2), 'K2');
  assert.equal(r32SlotCode({ type: 'winner', group: 'F' }), 'F1');
  assert.equal(r32SlotCode({ type: 'runnerup', group: 'C' }), 'C2');
  // third-place codes are UNAFFECTED — keep the FIFA candidate-list style.
  assert.equal(r32SlotCode({ type: 'third', from: ['A', 'B', 'C', 'D', 'F'] }), '3rd A/B/C/D/F');
});

test('R32 tier 1: a single alive team -> LOCKED to its full name', () => {
  const res = classifyR32Side(['USA'], mcMap({ USA: 1 }), 'D1');
  assert.equal(res.kind, 'locked');
  assert.equal(renderSideLabel(res, fullName), 'United States');
});

test('R32 tier 2: exactly two alive -> favorite-first "FAV/OTHER" pair', () => {
  // POR favored over COL for this slot.
  const res = classifyR32Side(['COL', 'POR'], mcMap({ POR: 0.62, COL: 0.38 }), 'K1');
  assert.equal(res.kind, 'two');
  assert.deepEqual(res.codes, ['POR', 'COL']);
  assert.equal(renderSideLabel(res, fullName), 'POR/COL');
});

test('R32 tier 2 holds even at a lopsided 80/20 (two known names beat tier 3)', () => {
  const res = classifyR32Side(['COL', 'POR'], mcMap({ POR: 0.8, COL: 0.2 }), 'K1');
  assert.equal(res.kind, 'two');
  assert.equal(renderSideLabel(res, fullName), 'POR/COL');
});

test('R32 tier 3: 3+ alive with a >=75% favorite -> "FAV/<slotCode>" (group-first)', () => {
  const res = classifyR32Side(['KOR', 'RSA', 'CZE'], mcMap({ KOR: 0.90, RSA: 0.09, CZE: 0.01 }), 'A2');
  assert.equal(res.kind, 'dominant');
  assert.equal(res.dominantCode, 'KOR');
  assert.equal(renderSideLabel(res, fullName), 'KOR/A2');
});

test('R32 tier 4: 3+ alive, nobody dominant -> structural placeholder (group-first)', () => {
  const res = classifyR32Side(['BRA', 'MAR', 'SCO'], mcMap({ BRA: 0.5, MAR: 0.3, SCO: 0.2 }), 'C1');
  assert.equal(res.kind, 'multi');
  assert.equal(renderSideLabel(res, fullName), 'C1');
});

test('R32 tier 4: a third slot placeholder keeps the FIFA group-list style', () => {
  const res = classifyR32Side(
    ['JPN', 'NED', 'SWE', 'CAN', 'AUT'],
    mcMap({ JPN: 0.3, NED: 0.25, SWE: 0.2, CAN: 0.15, AUT: 0.1 }),
    '3rd E/H/I/J/K'
  );
  assert.equal(res.kind, 'multi');
  assert.equal(renderSideLabel(res, fullName), '3rd E/H/I/J/K');
});

test('R32 dominance is strictly at the threshold boundary (74.9% -> placeholder)', () => {
  const below = classifyR32Side(['A', 'B', 'C'], mcMap({ A: DOMINANT_THRESHOLD - 0.001, B: 0.2, C: 0.05 }), 'X1');
  assert.equal(below.kind, 'multi');
  const at = classifyR32Side(['A', 'B', 'C'], mcMap({ A: DOMINANT_THRESHOLD, B: 0.2, C: 0.05 }), 'X1');
  assert.equal(at.kind, 'dominant');
});

test('favorite-first ordering: winner-slot and runner-up-slot order OPPOSITE', () => {
  // In a group where X is the strong side, X is the most likely WINNER but the
  // least likely RUNNER-UP (it usually wins outright), so the two slots order the
  // shared candidate set in opposite directions.
  const codes = ['XXX', 'YYY', 'ZZZ'];
  const winnerProbs = mcMap({ XXX: 0.7, YYY: 0.2, ZZZ: 0.1 }); // X tops the winner slot
  const runnerProbs = mcMap({ XXX: 0.1, YYY: 0.5, ZZZ: 0.4 }); // X bottoms the runner-up slot
  const win = orderByProb(codes, winnerProbs);
  const run = orderByProb(codes, runnerProbs);
  assert.equal(win[0], 'XXX');
  assert.equal(run[run.length - 1], 'XXX');
  assert.notEqual(win[0], run[0]);
});

// ---------------------------------------------------------------------------
// KNOCKOUT SLOT — candidate-cap rule
// ---------------------------------------------------------------------------

test('KO case 1: a single candidate (feeder resolved) -> LOCKED team name', () => {
  const res = classifyKoSide(['USA'], mcMap({ USA: 1 }), new Set(), DEFAULT_MAX_PREVIEW, 'W81');
  assert.equal(res.kind, 'locked');
  assert.equal(renderSideLabel(res, fullName), 'United States');
});

test('KO case 2: 2..cap candidates -> all, favorite-first, slash-joined', () => {
  const res = classifyKoSide(
    ['USA', 'BIH', 'ESP', 'POR'],
    mcMap({ ESP: 0.4, USA: 0.3, POR: 0.2, BIH: 0.1 }),
    new Set(),
    4,
    'W90'
  );
  assert.equal(res.kind, 'list');
  assert.equal(renderSideLabel(res, fullName), 'ESP/USA/POR/BIH'); // favorite-first
});

test('KO case 2: exactly cap (4) candidates still lists; cap+1 does not', () => {
  const four = classifyKoSide(['A', 'B', 'C', 'D'], mcMap({ A: 0.4, B: 0.3, C: 0.2, D: 0.1 }), new Set(), 4, 'W1');
  assert.equal(four.kind, 'list');
  const five = classifyKoSide(['A', 'B', 'C', 'D', 'E'], mcMap({ A: 0.4, B: 0.3, C: 0.15, D: 0.1, E: 0.05 }), new Set(), 4, 'W1');
  assert.notEqual(five.kind, 'list');
});

test('KO case 3a: > cap WITH a watched team -> "USA?/…" breadcrumb', () => {
  const res = classifyKoSide(
    ['JPN', 'NED', 'SWE', 'USA', 'BIH', 'CAN'],
    mcMap({ JPN: 0.3, NED: 0.25, SWE: 0.2, USA: 0.15, BIH: 0.07, CAN: 0.03 }),
    new Set(['USA']),
    4,
    'W81'
  );
  assert.equal(res.kind, 'watched');
  assert.equal(renderSideLabel(res, fullName), 'USA?/…');
});

test('KO case 3a: multiple watched teams -> "USA?/MEX?/…"', () => {
  const res = classifyKoSide(
    ['JPN', 'NED', 'SWE', 'USA', 'MEX', 'CAN'],
    mcMap({ USA: 0.4, MEX: 0.2, JPN: 0.15, NED: 0.1, SWE: 0.1, CAN: 0.05 }),
    new Set(['USA', 'MEX']),
    4,
    'W81'
  );
  assert.equal(res.kind, 'watched');
  // breadcrumb ordered favorite-first among the watched set
  assert.equal(renderSideLabel(res, fullName), 'USA?/MEX?/…');
});

test('KO case 3b: > cap WITHOUT a watched team -> structural feeder code (no wall)', () => {
  const res = classifyKoSide(
    ['JPN', 'NED', 'SWE', 'BIH', 'CAN', 'AUT'],
    mcMap({ JPN: 0.3, NED: 0.25, SWE: 0.2, BIH: 0.15, CAN: 0.07, AUT: 0.03 }),
    new Set(['USA']), // USA not in the candidate set
    4,
    'W82'
  );
  assert.equal(res.kind, 'structural');
  assert.equal(renderSideLabel(res, fullName), 'W82');
});

test('KO breadcrumb shows even at LOW odds (any nonzero deterministic possibility)', () => {
  const res = classifyKoSide(
    ['JPN', 'NED', 'SWE', 'BIH', 'CAN', 'USA'],
    mcMap({ JPN: 0.4, NED: 0.3, SWE: 0.2, BIH: 0.06, CAN: 0.03, USA: 0.01 }),
    new Set(['USA']),
    4,
    'W81'
  );
  assert.equal(res.kind, 'watched');
  assert.equal(renderSideLabel(res, fullName), 'USA?/…');
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

  // No knockout side label may ever contain 3+ slash-joined TEAM names (cap=4 means
  // at most 4 in a list; the breadcrumb is "USA?/…", structural is a feeder code).
  for (let m = 89; m <= 103; m++) {
    const lab = labels.get(m);
    if (!lab || lab.full == null) continue; // unchanged is fine
    for (const side of [lab.home, lab.away]) {
      if (side == null) continue;
      // A team-name list is slash-joined; ensure no side exceeds the cap of 4.
      const parts = side.replace('/…', '').split('/').filter(Boolean);
      assert.ok(parts.length <= 4, `M${m} side "${side}" within cap`);
    }
  }

  // USA breadcrumb invariant: USA is a deterministic possible occupant of the
  // R16 match fed by its R32 slot (M81 -> R16 M94 home), and >4 teams share it,
  // so M94 must carry the USA breadcrumb on the home side.
  const m94 = labels.get(94);
  assert.ok(m94 && m94.full, 'M94 carries a label (USA breadcrumb)');
  assert.match(m94.home, /USA\?/, `M94 home shows USA breadcrumb: ${m94.home}`);
});

test('computeMatchLabels: WITHOUT a watched team, deep knockout slots stay unchanged', async () => {
  const teams = JSON.parse(await readFile(new URL('./teams.json', import.meta.url), 'utf8'));
  const bracket = JSON.parse(await readFile(new URL('./bracket.json', import.meta.url), 'utf8'));
  const raw = await fetchRaw();
  const groups = toGroups(raw, teams);

  const labels = computeMatchLabels(
    { groups, bracket, teams, koResults: {}, resolveThirdPlaceSlots, rankThirdPlaceTeams,
      mcN: 8000 },
    { watchedTeams: [], maxPreview: 4 } // no watched team
  );

  // With no watched team and the group stage in progress, EVERY knockout event
  // (89-103) must be left unchanged (both sides over-cap structural).
  for (let m = 89; m <= 103; m++) {
    const lab = labels.get(m);
    assert.equal(lab.full, null, `M${m} unchanged when no watched team (got: ${lab.full})`);
  }
});
