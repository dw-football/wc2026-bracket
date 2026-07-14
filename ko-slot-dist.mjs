// ko-slot-dist.mjs
// ----------------------------------------------------------------------------
// SHARED chained head-to-head KO slot-distribution — the SINGLE source of the
// knockout contender %s. Imported by BOTH the bracket render (build-html.mjs,
// inlined into the page) and the calendar label resolver (bracket-labels.mjs), so
// the two can NEVER disagree on a knockout slot's odds. Pure: no DOM, no fs, no
// globals, no Date/Math.random.
//
// A knockout slot is filled by the winner of its feeder match. winnerDist() folds
// P(each team wins a match) up the tree using the advance model the bracket shows:
// an Elo logistic squeezed by koLambda (E' = 0.5 + λ·(E − 0.5)), with a venue-aware
// host bonus. A PLAYED knockout match collapses to its actual winner (p = 1), so an
// eliminated team carries 0 everywhere and can neither appear nor distort survivors.
// R32 group/runner-up/third slots are leaves resolved by the caller's r32Occupant()
// (the locked team CODE, or null when not yet determined).
//
// @param opts.bracket          {rounds:{R32,R16,...:[{match,home,away}]}}
// @param opts.eloByCode        Map<code,elo> | {code:elo}
// @param opts.koLambda         number  (KO variance knob; MUST match the model bake)
// @param opts.hosts            Set<code> | code[]   (host nations, +80 in own country)
// @param opts.koVenueCountry   {matchNo: 'USA'|'MEX'|'CAN'|null}  (venue-aware bonus)
// @param opts.r32Occupant      (matchNo, side) => code|null   (locked R32 leaf occupant)
// @param opts.koWinner         (matchNo) => code|null         (played KO winner)
// @param opts.koLoser          (matchNo) => code|null         (played KO loser; feeds
//                                the 3rd-place match, whose sides are loserOf the semis)
// @returns { slotDist(matchNo, side) -> [{code,p}], winnerDist(matchNo) -> [{code,p}],
//            loserDist(matchNo) -> [{code,p}], h2hAdvanceProb(a, b, matchNo) -> number }
//            (distributions sorted desc)
// ----------------------------------------------------------------------------

export function makeKoSlotDist(opts) {
  const { bracket, eloByCode, koLambda, koVenueCountry, r32Occupant, koWinner, koLoser } = opts;
  const hostSet = opts.hosts instanceof Set ? opts.hosts : new Set(opts.hosts || []);
  const eloOf = (c) => {
    const v = eloByCode && (eloByCode.get ? eloByCode.get(c) : eloByCode[c]);
    return v == null ? 1500 : v;
  };
  const KOIDX = {};
  for (const rd of Object.keys(bracket.rounds)) {
    for (const m of bracket.rounds[rd]) KOIDX[m.match] = m;
  }

  function hostBonus(code, matchNo) {
    if (!hostSet.has(code)) return 0;
    const vc = koVenueCountry
      ? (koVenueCountry[matchNo] != null ? koVenueCountry[matchNo] : koVenueCountry[String(matchNo)])
      : null;
    if (vc != null && code !== vc) return 0; // a host only gets the bonus IN its own country
    return 80;
  }
  function h2hAdvanceProb(a, b, matchNo) {
    const eA = eloOf(a) + hostBonus(a, matchNo);
    const eB = eloOf(b) + hostBonus(b, matchNo);
    const E = 1 / (1 + Math.pow(10, -(eA - eB) / 400));
    return 0.5 + koLambda * (E - 0.5);
  }

  const cache = {};
  function winnerDist(matchNo) {
    const ck = 'W' + matchNo;
    if (cache[ck]) return cache[ck];
    const w = koWinner(matchNo);
    if (w) return (cache[ck] = [{ code: w, p: 1 }]); // played -> fixed
    const hd = slotDist(matchNo, 'home');
    const ad = slotDist(matchNo, 'away');
    const win = {};
    for (const x of hd) {
      for (const y of ad) {
        const pxy = x.p * y.p;
        const px = h2hAdvanceProb(x.code, y.code, matchNo);
        win[x.code] = (win[x.code] || 0) + pxy * px;
        win[y.code] = (win[y.code] || 0) + pxy * (1 - px);
      }
    }
    const arr = Object.keys(win)
      .map((c) => ({ code: c, p: win[c] }))
      .sort((a, b) => b.p - a.p);
    return (cache[ck] = arr);
  }
  // LOSER distribution — the complement of winnerDist: P(team reaches this match AND
  // loses it). Feeds the 3rd-place match (M103), whose two sides are loserOf the two
  // semifinals. A PLAYED match collapses to its actual loser (p = 1), so once the
  // semis are decided the 3rd-place slots pin to the two beaten semifinalists; before
  // that they carry only the four semifinalists at their P(reach-and-lose-the-semi) —
  // never an eliminated team (which is how the raw MC occupancy had leaked NED/USA/GER
  // into the 3rd-place box).
  function loserDist(matchNo) {
    const ck = 'L' + matchNo;
    if (cache[ck]) return cache[ck];
    const l = koLoser ? koLoser(matchNo) : null;
    if (l) return (cache[ck] = [{ code: l, p: 1 }]); // played -> fixed loser
    const hd = slotDist(matchNo, 'home');
    const ad = slotDist(matchNo, 'away');
    const lose = {};
    for (const x of hd) {
      for (const y of ad) {
        const pxy = x.p * y.p;
        const px = h2hAdvanceProb(x.code, y.code, matchNo); // P(x beats y)
        lose[y.code] = (lose[y.code] || 0) + pxy * px;       // x won -> y is the loser
        lose[x.code] = (lose[x.code] || 0) + pxy * (1 - px); // x lost
      }
    }
    const arr = Object.keys(lose)
      .map((c) => ({ code: c, p: lose[c] }))
      .sort((a, b) => b.p - a.p);
    return (cache[ck] = arr);
  }
  function slotDist(matchNo, sideName) {
    const sk = matchNo + ':' + sideName;
    if (cache[sk]) return cache[sk];
    const m = KOIDX[matchNo];
    if (!m) return (cache[sk] = []);
    const def = m[sideName];
    let dist;
    if (def && def.type === 'winnerOf') dist = winnerDist(def.match);
    else if (def && def.type === 'loserOf') dist = loserDist(def.match);
    else {
      const c = r32Occupant(matchNo, sideName); // group/runner-up/third leaf
      dist = c ? [{ code: c, p: 1 }] : [];
    }
    return (cache[sk] = dist);
  }

  return { slotDist, winnerDist, loserDist, h2hAdvanceProb };
}
