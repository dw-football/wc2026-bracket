// espn-events.test.js — node:test
//
//   node --test espn-events.test.js
//
// Deterministic parse of the ESPN match-summary `keyEvents` into the popover's
// timeline shape (goals + red cards + shootout takers), oriented home/away. No
// network — a synthetic summary mirrors the real fifa.world shape (team={id},
// clock={displayValue,value}, scorer embedded in text incl own goals + stoppage).

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSummaryEvents, playerFromText, clockToMin } from './espn-events.mjs';

const summary = {
  header: { competitions: [{ competitors: [
    { homeAway: 'home', team: { id: '482', abbreviation: 'POR' } },
    { homeAway: 'away', team: { id: '2570', abbreviation: 'UZB' } },
  ] }] },
  keyEvents: [
    { type: { type: 'kickoff' }, text: 'First Half begins.', clock: { displayValue: '', value: 0 } },
    { type: { type: 'goal---volley' }, text: 'Goal! Portugal 1, Uzbekistan 0. Cristiano Ronaldo (Portugal) right footed shot.', clock: { displayValue: "6'", value: 6 }, team: { id: '482' } },
    { type: { type: 'yellow-card' }, text: 'Odiljon Khamrobekov (Uzbekistan) is shown the yellow card.', clock: { displayValue: "14'", value: 14 }, team: { id: '2570' } },
    { type: { type: 'goal' }, text: 'Own Goal by Abduvokhid Nematov, Uzbekistan. Portugal 2, Uzbekistan 0.', clock: { displayValue: "60'", value: 60 }, team: { id: '482' } },
    { type: { type: 'red-card' }, text: 'Some Defender (Uzbekistan) is shown the red card.', clock: { displayValue: "45'+2'", value: 45 }, team: { id: '2570' } },
  ],
};

test('clockToMin: leading whole minute (stoppage folds to the base minute)', () => {
  assert.equal(clockToMin("6'"), 6);
  assert.equal(clockToMin("45'+7'"), 45);
  assert.equal(clockToMin(''), 0);
});

test('playerFromText: scorer, booked player, and own goal', () => {
  assert.equal(playerFromText('Goal! Portugal 1, Uzbekistan 0. Cristiano Ronaldo (Portugal) shot.'), 'Cristiano Ronaldo');
  assert.equal(playerFromText('Odiljon Khamrobekov (Uzbekistan) is shown the yellow card.'), 'Odiljon Khamrobekov');
  assert.equal(playerFromText('Own Goal by Abduvokhid Nematov, Uzbekistan. Portugal 4, Uzbekistan 0.'), 'Abduvokhid Nematov (OG)');
  assert.equal(playerFromText('Match ends.'), null);
});

test('parseSummaryEvents: keeps goals + reds (drops kickoff/yellow), oriented home/away, sorted', () => {
  const r = parseSummaryEvents(summary);
  assert.equal(r.home, 'POR');
  assert.equal(r.away, 'UZB');
  // goals + the red card only — kickoff and the yellow are dropped.
  assert.equal(r.events.length, 3);
  // chronological (the red at 45 sorts before the 60' own goal)
  assert.deepEqual(r.events.map((e) => e.min), [6, 45, 60]);
  const goal = r.events.find((e) => e.who === 'Cristiano Ronaldo');
  assert.deepEqual({ type: goal.type, team: goal.team, minLabel: goal.minLabel }, { type: 'goal', team: 'home', minLabel: '6' });
  const red = r.events.find((e) => e.type === 'red');
  assert.equal(red.team, 'away');
  assert.equal(red.minLabel, "45'+2");
  const og = r.events.find((e) => /OG/.test(e.who || ''));
  assert.equal(og.team, 'home');
});

test('parseSummaryEvents: shootout takers captured with scored/missed', () => {
  const s = {
    header: { competitions: [{ competitors: [
      { homeAway: 'home', team: { id: '1', abbreviation: 'USA' } },
      { homeAway: 'away', team: { id: '2', abbreviation: 'GER' } },
    ] }] },
    keyEvents: [
      { type: { type: 'penalty-scored' }, text: 'Pulisic (USA) converts the penalty.', shootout: true, team: { id: '1' } },
      { type: { type: 'penalty-missed' }, text: 'Havertz (Germany) penalty saved.', shootout: true, team: { id: '2' } },
    ],
  };
  const r = parseSummaryEvents(s);
  assert.equal(r.events.length, 0, 'shootout penalties are not field events');
  assert.deepEqual(r.pens, [
    { team: 'home', who: 'Pulisic', ok: true },
    { team: 'away', who: 'Havertz', ok: false },
  ]);
});
