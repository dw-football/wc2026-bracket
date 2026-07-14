// ko-resolve.mjs
// ----------------------------------------------------------------------------
// Pure knockout OCCUPANT resolver. Given the bracket structure and the played
// knockout results (from ANY round), determine the concrete team on each match +
// side where it is known:
//   - a slot fed by winnerOf(feeder) is filled by that feeder's PLAYED winner
//     (recursively, in ANY round R32..Final);
//   - an R32 group / runner-up / third slot is filled by the caller-supplied
//     locked occupant (r32Occupant), or null when the group isn't decided.
// Returns null for a slot not yet determined.
//
// WHY THIS EXISTS AS ITS OWN MODULE: the winner map MUST span EVERY knockout
// round. An earlier R32-only shortcut meant a decided R16/QF/SF result never
// propagated into the round it feeds -> the fed slot fell back to a stale
// projection and could display an ELIMINATED team (a losing R32 side sitting in a
// quarterfinal). Extracting it here makes that propagation unit-testable across
// all rounds (see ko-resolve.test.js), so the regression cannot silently return.
//
// Pure: no DOM, no fs, no globals, no Date/Math.random.
// ----------------------------------------------------------------------------

// Winner CODE of every DECIDED knockout match, keyed by matchNo, across all rounds.
export function koWinnersByMatch(bracket, koResults) {
  const out = {};
  const kr = koResults || {};
  for (const rd of Object.keys(bracket.rounds)) {
    for (const m of bracket.rounds[rd]) {
      const r = kr[m.match] || kr[String(m.match)];
      if (r && r.winner) out[m.match] = r.winner;
    }
  }
  return out;
}

// Loser CODE of every DECIDED knockout match, keyed by matchNo, across all rounds.
// Needed by the 3rd-place match (M103), whose two sides are loserOf the semifinals:
// once a semi is played its beaten team is the concrete occupant of a 3rd-place slot.
export function koLosersByMatch(bracket, koResults) {
  const out = {};
  const kr = koResults || {};
  for (const rd of Object.keys(bracket.rounds)) {
    for (const m of bracket.rounds[rd]) {
      const r = kr[m.match] || kr[String(m.match)];
      if (r && r.loser) out[m.match] = r.loser;
    }
  }
  return out;
}

// @param r32Occupant (matchNo, side) => code|null : locked R32 leaf occupant, or
//        null when the feeding group isn't decided. Only ever consulted for a
//        non-winnerOf side (R32 group/runner-up/third); winnerOf sides resolve
//        purely from the played-winner map.
export function makeOccupantResolver(bracket, koResults, r32Occupant) {
  const KOIDX = {};
  for (const rd of Object.keys(bracket.rounds)) {
    for (const m of bracket.rounds[rd]) KOIDX[m.match] = m;
  }
  const winners = koWinnersByMatch(bracket, koResults);
  const losers = koLosersByMatch(bracket, koResults);

  function sideCode(matchNo, sideName) {
    const m = KOIDX[matchNo];
    if (!m) return null;
    const def = m[sideName];
    if (def && def.type === 'winnerOf') return winners[def.match] || null;
    if (def && def.type === 'loserOf') return losers[def.match] || null;
    return (r32Occupant ? r32Occupant(matchNo, sideName) : null) || null;
  }

  function sideCodes(matchNo) {
    return { home: sideCode(matchNo, 'home'), away: sideCode(matchNo, 'away') };
  }

  return { sideCode, sideCodes, winners, losers, KOIDX };
}
