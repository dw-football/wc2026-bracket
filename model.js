// model.js
// Probabilistic projection engine for the 2026 World Cup bracket:
//   - an Elo-driven Poisson scoreline model ("supremacy" model), and
//   - a Monte Carlo tournament simulator built on top of engine.js + allocation.
//
// BROWSER-SAFE ES module. NO node: imports, no fs/process in exported logic.
// It imports ONLY from engine.js (pure) and receives the Annex-C allocation
// resolution as an injected dependency, so it never touches the filesystem.
//
// The caller (verify-model.mjs in Node, or the HTML build in the browser) is
// responsible for loading bracket.json/allocation.json and passing in a
// `resolveThirdPlaceSlots(groupLetters, bracket)` function via opts.
//
// All randomness flows through an injected rng function ()->[0,1). We NEVER
// call Math.random internally, so a fixed seed reproduces a run exactly.

import { computeGroupStanding, rankThirdPlaceTeams } from './engine.js';

// ----------------------------------------------------------------------------
// Tunable constants (exported so they can be overridden / re-fit)
// ----------------------------------------------------------------------------

// Elo points -> goal-supremacy slope. 0.0036 goals per Elo point ≈ 1.44 goals
// of expected-margin per 400 Elo (a 400-Elo gap is the classic "10x odds" gap).
export const ELO_SUPREMACY_COEF = 0.0036;

// League-average total goals per match (both teams). World Cup group/KO games
// historically average ~2.5–2.7; 2.6 is a reasonable central value.
export const BASE_TOTAL_GOALS = 2.6;

// Floor on either side's Poisson mean so even a huge underdog can score.
export const MIN_LAMBDA = 0.15;

// Default host-nation Elo bonus (points). Applied to USA/MEX/CAN in every match
// via opts.hostCodes. Home-field in soccer is worth roughly +0.3–0.4 goals;
// at the supremacy slope above, ~80 Elo ≈ +0.29 goals of supremacy. Kept modest
// because co-hosting across 3 countries dilutes a true single-venue advantage.
export const DEFAULT_HOST_BONUS = 80;

// Round index map for "furthest round reached".
export const ROUND_INDEX = Object.freeze({
  R32: 0,
  R16: 1,
  QF: 2,
  SF: 3,
  Final: 4,
  Champion: 5,
});

// ----------------------------------------------------------------------------
// 1. Seedable PRNG — mulberry32
// ----------------------------------------------------------------------------

/**
 * mulberry32 — a tiny, fast, decent-quality seedable PRNG.
 * @param {number} seed  any 32-bit-ish integer
 * @returns {() => number} function returning a float in [0, 1)
 */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ----------------------------------------------------------------------------
// 2. Poisson sampler — Knuth's algorithm
// ----------------------------------------------------------------------------

/**
 * Sample a Poisson(lambda) integer using Knuth's multiplicative method.
 * Fine for the small lambdas (~0.2–2.5) we draw here.
 * @param {number} lambda  mean (>= 0)
 * @param {() => number} rng
 * @returns {number} non-negative integer goal count
 */
export function samplePoisson(lambda, rng) {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L);
  return k - 1;
}

// ----------------------------------------------------------------------------
// 3. Expected goals — the "supremacy" model
// ----------------------------------------------------------------------------

/**
 * Map two Elo ratings (plus optional per-side host bonuses) to a pair of
 * Poisson means.
 * @param {number} eloA
 * @param {number} eloB
 * @param {object} [opts]
 *   opts.hostBonusA, opts.hostBonusB  additive Elo bonuses (default 0)
 *   opts.eloSupremacyCoef, opts.baseTotalGoals, opts.minLambda  overrides
 * @returns {{lambdaA:number, lambdaB:number}}
 */
export function expectedGoals(eloA, eloB, opts = {}) {
  const coef = opts.eloSupremacyCoef ?? ELO_SUPREMACY_COEF;
  const total = opts.baseTotalGoals ?? BASE_TOTAL_GOALS;
  const minL = opts.minLambda ?? MIN_LAMBDA;

  const effA = eloA + (opts.hostBonusA ?? 0);
  const effB = eloB + (opts.hostBonusB ?? 0);

  const supremacy = coef * (effA - effB);
  const lambdaA = Math.max(minL, (total + supremacy) / 2);
  const lambdaB = Math.max(minL, (total - supremacy) / 2);
  return { lambdaA, lambdaB };
}

// ----------------------------------------------------------------------------
// 4 & 5. Scoreline samplers
// ----------------------------------------------------------------------------

/**
 * Sample a group-stage scoreline (independent Poisson draws).
 * @returns {{ga:number, gb:number}}
 */
export function sampleMatch(eloA, eloB, rng, opts = {}) {
  const { lambdaA, lambdaB } = expectedGoals(eloA, eloB, opts);
  return { ga: samplePoisson(lambdaA, rng), gb: samplePoisson(lambdaB, rng) };
}

/**
 * Sample a knockout scoreline; if drawn, resolve by an Elo-weighted shootout.
 * The drawn scoreline is preserved in {ga,gb}; only `winner` reflects the
 * shootout. Penalties use effective Elo (host bonus included).
 * @returns {{ga:number, gb:number, winner:'A'|'B'}}
 */
export function sampleKnockout(eloA, eloB, rng, opts = {}) {
  const { ga, gb } = sampleMatch(eloA, eloB, rng, opts);
  if (ga > gb) return { ga, gb, winner: 'A' };
  if (gb > ga) return { ga, gb, winner: 'B' };
  // Tied -> shootout modeled as an Elo-weighted coin.
  const effA = eloA + (opts.hostBonusA ?? 0);
  const effB = eloB + (opts.hostBonusB ?? 0);
  const pA = 1 / (1 + Math.pow(10, -(effA - effB) / 400));
  return { ga, gb, winner: rng() < pA ? 'A' : 'B' };
}

// ----------------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------------

/** Host bonus for a given team code under opts.hostCodes (a Set). */
function hostBonusFor(code, opts) {
  if (opts.hostCodes && opts.hostCodes.has && opts.hostCodes.has(code)) {
    return opts.hostBonus ?? DEFAULT_HOST_BONUS;
  }
  return 0;
}

/** Group letter ("A".."L") from a group object whose name is "Group X". */
function groupLetter(group) {
  const m = /Group\s+([A-L])/i.exec(group.name);
  return m ? m[1].toUpperCase() : group.name.trim().slice(-1).toUpperCase();
}

/**
 * Deep-ish copy of the groups array sufficient for a single sim: teams are kept
 * by reference (read-only: code/name/elo), matches are cloned (we mutate goals
 * + played). Avoids cloning the immutable team records every sim.
 */
function cloneGroupsForSim(groups) {
  return groups.map((g) => ({
    name: g.name,
    teams: g.teams,
    matches: g.matches.map((m) => ({
      home: m.home,
      away: m.away,
      homeGoals: m.homeGoals,
      awayGoals: m.awayGoals,
      played: m.played,
    })),
  }));
}

// ----------------------------------------------------------------------------
// 6. One full tournament simulation
// ----------------------------------------------------------------------------

/**
 * Simulate ONE complete tournament from the current state.
 *
 * @param {Array} groups   engine-schema group objects (teams carry `elo`)
 * @param {object} bracket parsed bracket.json
 * @param {() => number} rng
 * @param {object} opts
 *   opts.hostCodes   Set<code> of host countries (always get host bonus)
 *   opts.hostBonus   Elo bonus magnitude (default DEFAULT_HOST_BONUS)
 *   opts.resolveThirdPlaceSlots(groupLetters, bracket) -> [{match,group,...}]
 *       (injected so this module stays browser/fs-free)
 *   plus any expectedGoals overrides.
 * @returns {{
 *   groupRank: Record<string,number>,
 *   qualifiedAs: Record<string,'winner'|'runnerup'|'third'|null>,
 *   r32: Array<{match:number, home:string, away:string}>,
 *   reached: Record<string,number>,
 *   champion: string,
 *   knockout: Array<{match:number, round:string, home:string, away:string, winner:string}>
 * }}
 */
export function simulateTournament(groups, bracket, rng, opts = {}) {
  const resolveThirds = opts.resolveThirdPlaceSlots;
  if (typeof resolveThirds !== 'function') {
    throw new Error('opts.resolveThirdPlaceSlots(groupLetters, bracket) is required');
  }

  const eloByCode = new Map();
  for (const g of groups) for (const t of g.teams) eloByCode.set(t.code, t.elo);
  const eloOf = (code) => eloByCode.get(code);

  // --- group stage: sample every unplayed match -----------------------------
  const sim = cloneGroupsForSim(groups);
  for (const g of sim) {
    for (const m of g.matches) {
      if (m.played) continue;
      const hb = hostBonusFor(m.home, opts);
      const ab = hostBonusFor(m.away, opts);
      const { ga, gb } = sampleMatch(eloOf(m.home), eloOf(m.away), rng, {
        ...opts,
        hostBonusA: hb,
        hostBonusB: ab,
      });
      m.homeGoals = ga;
      m.awayGoals = gb;
      m.played = true;
    }
  }

  // --- standings -------------------------------------------------------------
  const winnerOfGroup = {};   // letter -> code
  const runnerUpOfGroup = {}; // letter -> code
  const groupRank = {};       // code -> 1..4
  const qualifiedAs = {};     // code -> role | null
  const standings = {};       // letter -> ranked array

  for (const g of sim) {
    const letter = groupLetter(g);
    const standing = computeGroupStanding(g);
    standings[letter] = standing;
    for (const s of standing) {
      groupRank[s.code] = s.rank;
      qualifiedAs[s.code] = null;
      if (s.rank === 1) winnerOfGroup[letter] = s.code;
      else if (s.rank === 2) runnerUpOfGroup[letter] = s.code;
    }
    qualifiedAs[winnerOfGroup[letter]] = 'winner';
    qualifiedAs[runnerUpOfGroup[letter]] = 'runnerup';
  }

  // --- best 8 third-place teams ---------------------------------------------
  const thirds = rankThirdPlaceTeams(sim); // each has .group (= "Group X"), .qualifies
  const qualifiedThirds = thirds.filter((t) => t.qualifies);
  // map group LETTER -> qualifying third-place team code
  const thirdCodeByLetter = {};
  const qualifiedLetters = [];
  for (const t of qualifiedThirds) {
    const letter = /Group\s+([A-L])/i.exec(t.group)?.[1]?.toUpperCase()
      ?? String(t.group).trim().slice(-1).toUpperCase();
    thirdCodeByLetter[letter] = t.code;
    qualifiedLetters.push(letter);
    qualifiedAs[t.code] = 'third';
  }

  // --- Annex C: which group's third fills each R32 third slot ---------------
  const thirdSlots = resolveThirds(qualifiedLetters, bracket); // [{match, group}]
  const thirdCodeForMatch = {};
  for (const s of thirdSlots) thirdCodeForMatch[s.match] = thirdCodeByLetter[s.group];

  // --- build the 16 R32 fixtures --------------------------------------------
  const slotCode = (side, matchNo) => {
    if (side.type === 'winner') return winnerOfGroup[side.group];
    if (side.type === 'runnerup') return runnerUpOfGroup[side.group];
    if (side.type === 'third') return thirdCodeForMatch[matchNo];
    throw new Error(`unexpected R32 slot type: ${side.type}`);
  };

  const r32 = bracket.rounds.R32.map((m) => ({
    match: m.match,
    home: slotCode(m.home, m.match),
    away: slotCode(m.away, m.match),
  }));

  // --- knockout bracket ------------------------------------------------------
  // winnerByMatch / loserByMatch: match number -> team code.
  const winnerByMatch = {};
  const loserByMatch = {};
  const reached = {};

  // Collect EVERY knockout match's resolved occupants + winner for this sim,
  // so the aggregator can build true per-round occupancy frequencies.
  const knockout = []; // [{match, round, home, away, winner}]

  // Seed "reached" for everyone who made the R32.
  for (const fx of r32) {
    reached[fx.home] = ROUND_INDEX.R32;
    reached[fx.away] = ROUND_INDEX.R32;
  }

  const bump = (code, roundIdx) => {
    if (reached[code] === undefined || roundIdx > reached[code]) reached[code] = roundIdx;
  };

  // Resolve a winnerOf/loserOf side to a concrete team code (R16+ rounds).
  const sideCode = (side) => {
    if (side.type === 'winnerOf') return winnerByMatch[side.match];
    if (side.type === 'loserOf') return loserByMatch[side.match];
    throw new Error(`unexpected knockout side type: ${side.type}`);
  };

  // R32: play each fixture.
  const playKnockout = (homeCode, awayCode) => {
    const hb = hostBonusFor(homeCode, opts);
    const ab = hostBonusFor(awayCode, opts);
    const res = sampleKnockout(eloOf(homeCode), eloOf(awayCode), rng, {
      ...opts,
      hostBonusA: hb,
      hostBonusB: ab,
    });
    const winner = res.winner === 'A' ? homeCode : awayCode;
    const loser = res.winner === 'A' ? awayCode : homeCode;
    return { winner, loser };
  };

  for (const fx of r32) {
    const { winner, loser } = playKnockout(fx.home, fx.away);
    winnerByMatch[fx.match] = winner;
    loserByMatch[fx.match] = loser;
    bump(winner, ROUND_INDEX.R16); // winning R32 => reached R16
    knockout.push({ match: fx.match, round: 'R32', home: fx.home, away: fx.away, winner });
  }

  // Helper to run a round whose sides are winnerOf references.
  const runRound = (roundMatches, roundName, advanceRoundIdx) => {
    for (const m of roundMatches) {
      const homeCode = sideCode(m.home);
      const awayCode = sideCode(m.away);
      const { winner, loser } = playKnockout(homeCode, awayCode);
      winnerByMatch[m.match] = winner;
      loserByMatch[m.match] = loser;
      bump(winner, advanceRoundIdx);
      knockout.push({ match: m.match, round: roundName, home: homeCode, away: awayCode, winner });
    }
  };

  runRound(bracket.rounds.R16, 'R16', ROUND_INDEX.QF);   // win R16 => reached QF
  runRound(bracket.rounds.QF, 'QF', ROUND_INDEX.SF);     // win QF  => reached SF
  runRound(bracket.rounds.SF, 'SF', ROUND_INDEX.Final);  // win SF  => reached Final

  // Final.
  const finalM = bracket.rounds.Final[0];
  const fHome = winnerByMatch[finalM.home.match];
  const fAway = winnerByMatch[finalM.away.match];
  const { winner: champion } = playKnockout(fHome, fAway);
  winnerByMatch[finalM.match] = champion;
  bump(champion, ROUND_INDEX.Champion);
  knockout.push({ match: finalM.match, round: 'Final', home: fHome, away: fAway, winner: champion });

  // Third-place playoff is simulated for completeness (does not affect `reached`
  // beyond the SF appearance the two losers already have).
  const tpM = bracket.rounds.ThirdPlace?.[0];
  if (tpM) {
    const a = loserByMatch[tpM.home.match];
    const b = loserByMatch[tpM.away.match];
    if (a && b) {
      const { winner } = playKnockout(a, b);
      winnerByMatch[tpM.match] = winner;
      knockout.push({ match: tpM.match, round: 'ThirdPlace', home: a, away: b, winner });
    }
  }

  return { groupRank, qualifiedAs, r32, reached, champion, knockout };
}

// ----------------------------------------------------------------------------
// 7. Monte Carlo aggregation
// ----------------------------------------------------------------------------

/**
 * Run n simulations and aggregate per-team and per-R32-slot statistics.
 *
 * @param {Array} groups
 * @param {object} bracket
 * @param {object} opts  { n=10000, seed=1, hostCodes, hostBonus,
 *                          resolveThirdPlaceSlots, ...expectedGoals overrides }
 * @returns {{
 *   n:number,
 *   perTeam: Array<object>,             // sorted by pWinCup desc
 *   perR32Slot: Array<{match,home:[{code,p}],away:[{code,p}]}>,
 *   modalBracket: Array<{match, home:{code,p}, away:{code,p}}>,
 *   perSlot: Array<{match,round,home:[{code,p}],away:[{code,p}]}>,   // ALL ko rounds, true freqs
 *   modalKnockout: Array<{match,round,home:{code,p},away:{code,p}}>  // argmax each side
 * }}
 */
export function monteCarlo(groups, bracket, opts = {}) {
  const n = opts.n ?? 10000;
  const seed = opts.seed ?? 1;
  const rng = makeRng(seed);

  // team metadata
  const nameByCode = new Map();
  for (const g of groups) for (const t of g.teams) nameByCode.set(t.code, t.name);

  // per-team counters
  const C = {}; // code -> counter object
  const ensure = (code) => {
    if (!C[code]) {
      C[code] = {
        code,
        name: nameByCode.get(code),
        winGroup: 0, runnerUp: 0, thirdQualify: 0,
        g1: 0, g2: 0, g3: 0, g4: 0, // full final group-position distribution
        reachR32: 0, reachR16: 0, reachQF: 0, reachSF: 0, reachFinal: 0, winCup: 0,
      };
    }
    return C[code];
  };
  for (const code of nameByCode.keys()) ensure(code);

  // per-R32-slot tallies: 16 matches x {home: Map<code,count>, away: Map<code,count>}
  const r32Matches = bracket.rounds.R32.map((m) => m.match);
  const slotTally = {};
  for (const mNo of r32Matches) slotTally[mNo] = { home: new Map(), away: new Map() };
  const inc = (map, code) => map.set(code, (map.get(code) || 0) + 1);

  // per-knockout-match occupancy tallies for ALL rounds (R32/R16/QF/SF/Final/ThirdPlace).
  // Keyed by match number; each holds the round name and home/away occupant counts.
  const koOrder = ['R32', 'R16', 'QF', 'SF', 'ThirdPlace', 'Final'];
  const koTally = {}; // matchNo -> {round, home: Map<code,count>, away: Map<code,count>}
  const koMatchOrder = []; // preserve a stable, round-then-match ordering for output
  for (const rd of koOrder) {
    for (const m of bracket.rounds[rd] || []) {
      koTally[m.match] = { round: rd, home: new Map(), away: new Map() };
      koMatchOrder.push(m.match);
    }
  }

  const simOpts = { ...opts };

  for (let i = 0; i < n; i++) {
    const r = simulateTournament(groups, bracket, rng, simOpts);

    // group roles
    for (const [code, role] of Object.entries(r.qualifiedAs)) {
      if (role === 'winner') C[code].winGroup++;
      else if (role === 'runnerup') C[code].runnerUp++;
      else if (role === 'third') C[code].thirdQualify++;
    }

    // full final group-position distribution (1..4), independent of qualification
    for (const [code, rk] of Object.entries(r.groupRank)) {
      const c = C[code];
      if (rk === 1) c.g1++;
      else if (rk === 2) c.g2++;
      else if (rk === 3) c.g3++;
      else c.g4++;
    }

    // furthest round reached (cumulative: reaching SF implies reached R16, etc.)
    for (const [code, idx] of Object.entries(r.reached)) {
      const c = C[code];
      if (idx >= ROUND_INDEX.R32) c.reachR32++;
      if (idx >= ROUND_INDEX.R16) c.reachR16++;
      if (idx >= ROUND_INDEX.QF) c.reachQF++;
      if (idx >= ROUND_INDEX.SF) c.reachSF++;
      if (idx >= ROUND_INDEX.Final) c.reachFinal++;
    }
    C[r.champion].winCup++;

    // R32 slot occupancy (legacy tallies, kept for perR32Slot/modalBracket)
    for (const fx of r.r32) {
      inc(slotTally[fx.match].home, fx.home);
      inc(slotTally[fx.match].away, fx.away);
    }

    // ALL knockout matches: true per-round occupancy for each side.
    for (const k of r.knockout) {
      const t = koTally[k.match];
      if (!t) continue;
      if (k.home) inc(t.home, k.home);
      if (k.away) inc(t.away, k.away);
    }
  }

  const perTeam = Object.values(C)
    .map((c) => ({
      code: c.code,
      name: c.name,
      pWinGroup: c.winGroup / n,
      pRunnerUp: c.runnerUp / n,
      pThirdQualify: c.thirdQualify / n,
      pGroup1: c.g1 / n, // full final group-position distribution (Elo model)
      pGroup2: c.g2 / n,
      pGroup3: c.g3 / n,
      pGroup4: c.g4 / n,
      pReachR32: c.reachR32 / n,
      pReachR16: c.reachR16 / n,
      pReachQF: c.reachQF / n,
      pReachSF: c.reachSF / n,
      pReachFinal: c.reachFinal / n,
      pWinCup: c.winCup / n,
    }))
    .sort((a, b) => b.pWinCup - a.pWinCup);

  // per-R32-slot distributions (top candidates) + modal bracket
  const TOP = opts.topCandidates ?? 4;
  const topOf = (map) =>
    [...map.entries()]
      .map(([code, count]) => ({ code, p: count / n }))
      .sort((a, b) => b.p - a.p);

  const perR32Slot = r32Matches.map((mNo) => {
    const home = topOf(slotTally[mNo].home);
    const away = topOf(slotTally[mNo].away);
    return { match: mNo, home: home.slice(0, TOP), away: away.slice(0, TOP) };
  });

  const modalBracket = r32Matches.map((mNo) => {
    const home = topOf(slotTally[mNo].home);
    const away = topOf(slotTally[mNo].away);
    return {
      match: mNo,
      home: home[0] ?? { code: null, p: 0 },
      away: away[0] ?? { code: null, p: 0 },
    };
  });

  // ---- TRUE per-round occupancy across ALL knockout matches ----------------
  // p = count/n is the unconditional probability the team occupies that exact
  // slot in that round (i.e. reaches and fills it). home/away counts each sum
  // to n (every match has two occupants every sim).
  const perSlot = koMatchOrder.map((mNo) => {
    const t = koTally[mNo];
    return {
      match: mNo,
      round: t.round,
      home: topOf(t.home).slice(0, TOP),
      away: topOf(t.away).slice(0, TOP),
    };
  });

  const modalKnockout = koMatchOrder.map((mNo) => {
    const t = koTally[mNo];
    const home = topOf(t.home);
    const away = topOf(t.away);
    return {
      match: mNo,
      round: t.round,
      home: home[0] ?? { code: null, p: 0 },
      away: away[0] ?? { code: null, p: 0 },
    };
  });

  return { n, perTeam, perR32Slot, modalBracket, perSlot, modalKnockout };
}
