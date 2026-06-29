// espn-poll.test.js — node:test
//
//   node --test espn-poll.test.js
//
// Covers the KNOCKOUT result extraction added for #1 (build the KO-result shape
// from an ESPN event: regulation / AET / penalty shootout / winnerless-hold) and
// one end-to-end pass through pollReport with an injected ESPN event (no network)
// confirming a completed R32 match surfaces as a deployable KO result.

import test from 'node:test';
import assert from 'node:assert/strict';

import { koResultFromEvent, pollReport } from './espn-poll.mjs';

// Minimal ESPN event in the shape the poller reads.
function espnEvent({ home, away, hs, as, status = 'STATUS_FULL_TIME', detail = 'FT',
  completed = true, hShoot, aShoot, id = '999' }) {
  const comp = (code, score, winner, shoot) => ({
    homeAway: code === home ? 'home' : 'away',
    team: { abbreviation: code },
    score, winner,
    ...(shoot != null ? { shootoutScore: shoot } : {}),
  });
  return {
    id, date: '2026-06-28T19:00Z',
    status: { type: { state: completed ? 'post' : 'in', name: status, detail, completed } },
    competitions: [{ competitors: [comp(home, hs, hs > as, hShoot), comp(away, as, as > hs, aShoot)] }],
  };
}

test('koResultFromEvent: regulation win, oriented to our home/away', () => {
  const r = koResultFromEvent(espnEvent({ home: 'RSA', away: 'CAN', hs: 2, as: 1 }), 'RSA', 'CAN');
  assert.deepEqual(r, { completed: true, score: [2, 1], decider: 'reg', pens: null, winner: 'RSA' });
});

test('koResultFromEvent: orientation flips when ESPN home != our home', () => {
  // ESPN lists CAN as home; our fixture home is RSA. Score must reorient.
  const r = koResultFromEvent(espnEvent({ home: 'CAN', away: 'RSA', hs: 1, as: 2 }), 'RSA', 'CAN');
  assert.deepEqual(r.score, [2, 1]);
  assert.equal(r.winner, 'RSA');
});

test('koResultFromEvent: AET tagged from the status detail', () => {
  const r = koResultFromEvent(espnEvent({ home: 'USA', away: 'ITA', hs: 2, as: 1, detail: 'AET' }), 'USA', 'ITA');
  assert.equal(r.decider, 'aet');
  assert.equal(r.winner, 'USA');
});

test('koResultFromEvent: penalty shootout from competitor shootoutScore', () => {
  const ev = espnEvent({ home: 'USA', away: 'GER', hs: 1, as: 1, detail: 'FT-Pens', hShoot: 4, aShoot: 3 });
  const r = koResultFromEvent(ev, 'USA', 'GER');
  assert.deepEqual(r, { completed: true, score: [1, 1], decider: 'pens', pens: [4, 3], winner: 'USA' });
});

test('koResultFromEvent: level FT with no shootout numbers is HELD (winnerless)', () => {
  const r = koResultFromEvent(espnEvent({ home: 'A', away: 'B', hs: 1, as: 1 }), 'A', 'B');
  assert.equal(r.completed, true);
  assert.equal(r.ambiguous, 'level-no-shootout');
  assert.equal(r.winner, undefined);
});

test('koResultFromEvent: level FT resolves once the SUMMARY supplies the shootout', () => {
  const ev = espnEvent({ home: 'A', away: 'B', hs: 1, as: 1 });
  const summary = { header: { competitions: [{ competitors: [
    { team: { abbreviation: 'A' }, shootoutScore: 5 },
    { team: { abbreviation: 'B' }, shootoutScore: 4 },
  ] }] } };
  const r = koResultFromEvent(ev, 'A', 'B', summary);
  assert.equal(r.decider, 'pens');
  assert.deepEqual(r.pens, [5, 4]);
  assert.equal(r.winner, 'A');
});

test('koResultFromEvent: not completed -> {completed:false}', () => {
  const r = koResultFromEvent(espnEvent({ home: 'A', away: 'B', hs: 0, as: 0, completed: false, status: 'STATUS_IN_PROGRESS', detail: '2H' }), 'A', 'B');
  assert.equal(r.completed, false);
});

test('pollReport (injected event, no network): a completed KO match surfaces as a deployable result', async () => {
  // De-brittled: do NOT hardcode a match number. Any specific match goes stale the
  // moment it's actually played (M73 — the old fixture — is now a real result, so it
  // is no longer pollable). Instead pick WHATEVER KO match is currently pollable with
  // both teams resolved, and assert the poller's match-agnostic logic on it: a
  // resolved, completed KO match must surface as deployable with the right shape. A
  // late `now` makes the resolved R32 matches "due"; if every resolved KO match has
  // already been played (end of tournament), there's nothing to assert and we skip.
  const NOW = '2026-07-15T00:00:00Z';
  const fix = await pollReport({ now: NOW, espnEvents: [] });
  const target = (fix.koSets || []).find((s) => s.home && s.away);
  if (!target) return; // no pollable, resolved, unplayed KO match in the cached feed
  const { match, home, away } = target;

  const ev = espnEvent({ home, away, hs: 3, as: 0 });
  const live = await pollReport({ now: NOW, espnEvents: [ev] });
  const dep = live.koDeployable.find((d) => d.match === match);
  assert.ok(dep, `M${match} deployable once ESPN says FT`);
  assert.deepEqual(dep.score, [3, 0]);
  assert.equal(dep.decider, 'reg');
  assert.equal(dep.winner, home);
  assert.equal(dep.key, `ko:${match}`);
});
