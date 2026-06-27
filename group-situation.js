// group-situation.js
// Stage-aware "what's locked / what's needed / what the next round makes
// official" analyzer for a 4-team World Cup group that is NOT yet at its final
// round (i.e. teams still have 2+ games left).
//
// Pure ES module, browser-safe (no Node-only APIs). May import
// computeGroupStanding from engine.js for current points/played aggregation.
//
// COMPLEMENT to scenario-summary.js: that module handles the final round (1-2
// unplayed matches). This one answers the questions a fan asks BEFORE the final
// round: who has clinched/been eliminated, the magic-number points each
// contender needs, and what the very next round of games can make official.
//
// HONESTY CONTRACT (matches the rest of the project):
//   - WITHIN-GROUP facts only. Reason on POINTS. Top 2 advance; a 3rd-place berth
//     is CROSS-GROUP and is asserted ONLY when it is a DETERMINISTIC certainty —
//     i.e. the team's worst possible 3rd-place points total is high enough that,
//     even if every other group simultaneously maximises its own 3rd-place team,
//     at most 7 of them can match-or-beat it, so it is mathematically locked into
//     the top-8 thirds. This is never a probability — it's a guarantee, computed
//     by brute-forcing each group's third-place points ceiling (see thirdCeilings
//     / advanceClinchInfo). Requires opts.allGroups; without it we stay silent on
//     best-thirds exactly as before.
//   - No drawing of lots (abolished for 2026). Where the top-2/3rd boundary in a
//     scenario is a POINTS TIE involving the team, we treat it as NOT-yet-settled
//     and surface it as a "could come down to goal difference" caveat rather than
//     fabricating a goal-difference outcome.
//
// Public API:
//   groupSituation(group) -> {
//     teams: [ { code, name, points, played, remaining, status, statusLine,
//                magicNumber, eliminationThreshold, needLine } ],
//     nextRound: { matchKeys:[...], date, triggers:[ string ] },
//     decided: bool
//   }
//
// Data shapes (engine schema):
//   group = { name, teams:[{code,name,elo}],
//             matches:[{home,away,homeGoals,awayGoals,played,date,time}] }
//   home/away are team CODES. A match "key" is `${home}-${away}`.

import { computeGroupStanding, compareThirdPlace } from './engine.js';

const TOP_N = 2; // top 2 advance directly

const matchKey = (m) => `${m.home}-${m.away}`;

// ----------------------------------------------------------------------------
// Points bookkeeping
// ----------------------------------------------------------------------------

/** Current POINTS and games-played for each team, from PLAYED matches only. */
function currentPoints(group) {
  const pts = new Map();
  const played = new Map();
  for (const t of group.teams) {
    pts.set(t.code, 0);
    played.set(t.code, 0);
  }
  for (const m of group.matches) {
    if (!m.played) continue;
    if (!pts.has(m.home) || !pts.has(m.away)) continue;
    played.set(m.home, played.get(m.home) + 1);
    played.set(m.away, played.get(m.away) + 1);
    if (m.homeGoals > m.awayGoals) pts.set(m.home, pts.get(m.home) + 3);
    else if (m.homeGoals < m.awayGoals) pts.set(m.away, pts.get(m.away) + 3);
    else {
      pts.set(m.home, pts.get(m.home) + 1);
      pts.set(m.away, pts.get(m.away) + 1);
    }
  }
  return { pts, played };
}

const COARSE = ['home', 'draw', 'away']; // outcome of an unplayed match

/** Points delta applied to a points-map for one coarse outcome of a match. */
function applyOutcome(ptsMap, match, outcome) {
  if (outcome === 'home') ptsMap.set(match.home, ptsMap.get(match.home) + 3);
  else if (outcome === 'away') ptsMap.set(match.away, ptsMap.get(match.away) + 3);
  else {
    ptsMap.set(match.home, ptsMap.get(match.home) + 1);
    ptsMap.set(match.away, ptsMap.get(match.away) + 1);
  }
}

/**
 * Enumerate every coarse (W/D/L) combination of a list of unplayed matches.
 * Yields a fresh final-points Map for each combo (base points + outcome deltas).
 * k matches -> 3^k combos (k<=6 -> <=729).
 */
function* enumeratePoints(basePts, unplayed) {
  const k = unplayed.length;
  const total = 3 ** k;
  for (let n = 0; n < total; n++) {
    const final = new Map(basePts);
    let x = n;
    for (let i = 0; i < k; i++) {
      applyOutcome(final, unplayed[i], COARSE[x % 3]);
      x = Math.floor(x / 3);
    }
    yield final;
  }
}

// ----------------------------------------------------------------------------
// Points-only top-2 test for ONE final-points map
// ----------------------------------------------------------------------------

/**
 * Given a final-points Map (code -> pts), classify a team's standing on POINTS
 * ALONE. Returns:
 *   'in'     -> strictly inside top 2 (fewer than TOP_N teams have MORE points,
 *               and it is not tied with anyone on the cut line below it)
 *   'tie'    -> on the top-2/3rd boundary as a POINTS TIE involving this team
 *               (would-be in, but a goal-difference tiebreak could intrude)
 *   'out'    -> strictly outside top 2 on points
 *
 * Cut-line semantics for a 4-team group (top 2 advance):
 *   - strictlyAbove = teams with MORE points than this team.
 *   - If strictlyAbove >= TOP_N            -> 'out' (cannot be top 2 here).
 *   - Else (strictlyAbove < TOP_N): this team is at worst the (strictlyAbove+1)th
 *     seed before tiebreaks. It is strictly 'in' only if granting EVERY team
 *     level with it the benefit of the doubt still leaves it inside the top 2,
 *     i.e. there is no points tie spanning the 2nd/3rd boundary that includes it.
 *     Concretely: let `equal` = teams with the SAME points (excluding itself).
 *     The block [strictlyAbove .. strictlyAbove+equal] occupies seeds
 *     (strictlyAbove+1) .. (strictlyAbove+equal+1). If that block's top seed
 *     (strictlyAbove+1) <= TOP_N but its bottom seed > TOP_N, the block straddles
 *     the cut -> 'tie'. If the whole block is within top 2 -> 'in'. If the block
 *     starts beyond top 2 -> 'out'.
 */
function classifyPoints(finalPts, code) {
  const mine = finalPts.get(code);
  let strictlyAbove = 0;
  let equal = 0;
  for (const [c, p] of finalPts) {
    if (c === code) continue;
    if (p > mine) strictlyAbove++;
    else if (p === mine) equal++;
  }
  const topSeed = strictlyAbove + 1;            // best seed this team could hold
  const bottomSeed = strictlyAbove + equal + 1; // worst seed within its points block
  if (topSeed > TOP_N) return 'out';            // even best case is below the cut
  if (bottomSeed <= TOP_N) return 'in';         // whole block clears the cut
  return 'tie';                                 // block straddles the 2nd/3rd line
}

/** Best seed (1-based) the team holds on points alone (strictlyAbove + 1). */
function bestSeed(finalPts, code) {
  const mine = finalPts.get(code);
  let strictlyAbove = 0;
  for (const [c, p] of finalPts) {
    if (c === code) continue;
    if (p > mine) strictlyAbove++;
  }
  return strictlyAbove + 1;
}

/**
 * True if this team is STRICTLY ahead of every other team on points (sole 1st).
 * Per spec, a points TIE at the top is NOT "won the group" — only a clear,
 * tiebreak-free lead clinches 1st. So we require every other team to have
 * strictly FEWER points (no equal-on-points rival at the top).
 */
function isSoleTopOnPoints(finalPts, code) {
  const mine = finalPts.get(code);
  for (const [c, p] of finalPts) {
    if (c === code) continue;
    if (p >= mine) return false; // anyone level-or-above blocks a clean 1st
  }
  return true;
}

// ----------------------------------------------------------------------------
// Clinch / eliminate tests over ALL remaining combinations
// ----------------------------------------------------------------------------

/**
 * Evaluate a team across all combinations of the given unplayed matches.
 * Returns flags used to derive status:
 *   clinchedTop2  : 'in' in EVERY combination (never even a tie on the cut).
 *   wonGroup      : top on points in EVERY combination (no one can pass it).
 *   eliminated    : 'in'/'tie' never reachable -> top 2 impossible in all combos.
 *   reachableTie  : at least one combo where it is exactly on the cut-line tie.
 */
function evaluateTeam(basePts, unplayed, code) {
  let clinchedTop2 = true;
  let wonGroup = true;
  let canReachTop2 = false; // 'in' OR 'tie' in at least one combo
  for (const finalPts of enumeratePoints(basePts, unplayed)) {
    const cls = classifyPoints(finalPts, code);
    if (cls !== 'in') clinchedTop2 = false;     // a tie or out breaks the clinch
    if (!isSoleTopOnPoints(finalPts, code)) wonGroup = false;
    if (cls === 'in' || cls === 'tie') canReachTop2 = true;
  }
  return {
    clinchedTop2,
    wonGroup,
    eliminated: !canReachTop2,
  };
}

// ----------------------------------------------------------------------------
// Magic number / elimination threshold (per contender)
// ----------------------------------------------------------------------------

/**
 * For a team, compute over its OWN remaining matches:
 *   magicNumber          : the minimum FINAL points total P such that, IF the
 *                          team finishes on >= P, it is GUARANTEED top 2 on
 *                          points regardless of all OTHER results. null if even
 *                          winning out is not guaranteed-safe (a points tie could
 *                          still intrude at the max) — flagged via tieAtMagic.
 *   tieAtMagic           : true if, at the magicNumber total, the guarantee rests
 *                          on a points tie (could come down to goal difference).
 *   eliminationThreshold : the smallest FINAL points total at which the team can
 *                          STILL reach top 2 (in/tie) under some other-results
 *                          combination. Finishing strictly BELOW this -> out.
 *   maxFinal             : the maximum final points the team can reach (win out).
 *
 * Method: separate the team's OWN remaining matches from the OTHERS'. For each
 * coarse outcome set of the team's own matches we get a candidate final total
 * for the team; for each such total we test, across ALL combinations of the
 * OTHER matches, whether the team is always 'in' (guaranteed-safe), sometimes
 * only 'tie' (tie-dependent), or can be 'out' (not safe).
 */
function magicAndThreshold(basePts, unplayed, code) {
  const own = unplayed.filter((m) => m.home === code || m.away === code);
  const others = unplayed.filter((m) => m.home !== code && m.away !== code);

  // Map: team's own-final-points total -> aggregate safety across other combos.
  // safety: 'safe' (always in), 'tie' (always in-or-tie, at least one tie),
  //         'unsafe' (some combo out).
  const byTotal = new Map(); // total -> { everIn:bool, everTie:bool, everOut:bool }

  for (const ownPts of enumeratePoints(basePts, own)) {
    const myTotal = ownPts.get(code);
    // Now vary the OTHER matches on top of this own-result state.
    let everIn = false, everTie = false, everOut = false;
    for (const finalPts of enumeratePoints(ownPts, others)) {
      const cls = classifyPoints(finalPts, code);
      if (cls === 'in') everIn = true;
      else if (cls === 'tie') everTie = true;
      else everOut = true;
    }
    const agg = byTotal.get(myTotal) || { everIn: false, everTie: false, everOut: false };
    agg.everIn = agg.everIn || everIn;
    agg.everTie = agg.everTie || everTie;
    agg.everOut = agg.everOut || everOut;
    byTotal.set(myTotal, agg);
  }

  const totals = [...byTotal.keys()].sort((a, b) => a - b);
  const maxFinal = totals[totals.length - 1];

  // magicNumber: the smallest finishing total P such that finishing on >= P
  // GUARANTEES top 2 — i.e. P AND EVERY reachable total above it are safe (no
  // losing branch).
  //
  // ⚠️ Points-total safety is NOT monotone, so we cannot take the first safe
  // total bottom-up. A team's remaining games are AGAINST its rivals, so the
  // PATH to a total matters, not just the total: a draw denies a rival 2 points
  // while a loss hands them 3. A lower total reached by drawing rivals can be
  // safe while a HIGHER total reached by beating a minnow but losing to a rival
  // is not. (Real case: Egypt on 1 pt — two draws → 3 pts is tie-safe, but a
  // win + a loss → 4 pts can leave them 3rd behind two rivals on 5.) So we
  // require the WHOLE upper tail to be safe before declaring a guarantee.
  let magicNumber = null;
  let tieAtMagic = false;
  for (let i = 0; i < totals.length; i++) {
    let tailSafe = true;
    for (let j = i; j < totals.length; j++) {
      if (byTotal.get(totals[j]).everOut) { tailSafe = false; break; }
    }
    if (!tailSafe) continue;    // some reachable total >= this one can still go out
    const t = totals[i];
    const a = byTotal.get(t);
    magicNumber = t;
    // tieAtMagic: at the threshold total itself, does the guarantee rest only on
    // a points tie at the cut (could come down to goal difference)? A clean 'in'
    // branch at that total means the magic line itself is unconditional.
    tieAtMagic = a.everTie && !a.everIn ? true : false;
    break;
  }

  // eliminationThreshold: smallest total at which top 2 is still REACHABLE
  // (everIn or everTie under some other combo). Below it -> mathematically out.
  let eliminationThreshold = null;
  for (const t of totals) {
    const a = byTotal.get(t);
    if (a.everIn || a.everTie) {
      eliminationThreshold = t;
      break;
    }
  }

  return { magicNumber, tieAtMagic, eliminationThreshold, maxFinal, ownCount: own.length };
}

// ----------------------------------------------------------------------------
// Result-based safety (handles NON-MONOTONE safe-sets — the rock-paper-scissors
// trap). A points threshold ("≥N guarantees top-2") is WRONG when a higher total
// reached via a win-AND-a-loss drops the team into a 3-way tie that can finish
// 3rd, while a lower total from two draws is safe. (Real case, Group I: Norway on
// 3 pts — two draws → 5 is safe, but a win+loss → 6 can be 3rd in a NOR/FRA/SEN
// cycle, yet a win+draw → 7 is safe again.) When the guaranteed-safe own-result
// set is not a clean points-suffix, we describe it BY RESULT instead.
// ----------------------------------------------------------------------------

/** The subject team's own result ('win'/'draw'/'loss') for a coarse outcome. */
function ownResultOf(match, coarse, code) {
  if (coarse === 'draw') return 'draw';
  if (coarse === 'home') return match.home === code ? 'win' : 'loss';
  return match.away === code ? 'win' : 'loss'; // 'away'
}

/** A 3rd place on P points is a GUARANTEED top-8 third iff at most 7 OTHER groups
 *  can field a third with >= P points (worst case: every other group maxes out). */
export function thirdOnPointsClinches(P, ownLetter, ceilings) {
  let canMatch = 0;
  for (const [L, ceil] of ceilings) {
    if (L === ownLetter) continue;
    if (ceil >= P) canMatch++;
  }
  return canMatch <= 7;
}

/**
 * The SYMMETRIC floor side: a group's best-possible 3rd (on Pmax points) is
 * MATHEMATICALLY ELIMINATED from the top-8 thirds iff at least 8 OTHER groups
 * GUARANTEE a third with strictly MORE points than Pmax — i.e. their floor
 * (minThirdPoints) > Pmax. Groups are independent, so 8 such groups each fielding
 * a higher third simultaneously is achievable, pushing this group's third to 9th
 * or worse no matter what. Returns true iff that count is >= 8.
 */
export function thirdOnPointsEliminated(Pmax, ownLetter, floors) {
  let beatenForSure = 0;
  for (const [L, floor] of floors) {
    if (L === ownLetter) continue;
    if (floor > Pmax) beatenForSure++;
  }
  return beatenForSure >= 8;
}

/**
 * The team's path to a GUARANTEED place in the Round of 32 — the SOLE source of
 * the safe clause. "advances" in a completion = worst-case top-2 (loses every
 * tie), OR worst-case 3rd on a points total that is a guaranteed top-8 third
 * (cross-group, via `ceilings`). Framing the requirement around ADVANCEMENT (not
 * just top-2) folds in the best-third cushion: e.g. a team that can only reach a
 * 3-way tie on 6 still ADVANCES (a 6-pt third always qualifies), so two wins do
 * guarantee it — which a top-2-only test wrongly denied.
 * Returns the bare CONDITION that guarantees the target, for the caller to compose:
 *   { cond:'two draws (or better)' | 'a win' | 'avoiding defeat in both games' | … }
 *   { cond:null }  -> nothing the team can do yet guarantees the target.
 * `advanceMode` true tests ADVANCEMENT (top-2 OR a guaranteed-qualifying 3rd via
 * `ceilings`); false tests TOP-2 only. Splitting the two lets the needLine say
 * e.g. "two draws (or better) guarantees a Round-of-32 place; avoiding defeat in
 * both games clinches a top-2 seed".
 */
function safeRequirement(basePts, unplayed, code, curPts, opts) {
  const { target, ceilings, ownLetter } = opts; // target: 'r32' | 'top2' | 'first'
  const own = unplayed.filter((m) => m.home === code || m.away === code);
  const others = unplayed.filter((m) => m.home !== code && m.away !== code);
  const k = own.length;
  if (k === 0) return { cond: null };

  // Does the team reach the target in this final-points map (worst-case tiebreak)?
  const reaches = (fp) => {
    if (target === 'first') return isSoleTopOnPoints(fp, code); // sole top -> wins the group
    const mine = fp.get(code);
    let above = 0, equal = 0;
    for (const [c, p] of fp) { if (c === code) continue; if (p > mine) above++; else if (p === mine) equal++; }
    const worstRank = 1 + above + equal;
    if (worstRank <= 2) return true;            // top-2 even losing every tie
    if (target === 'top2') return false;        // top-2 needs worstRank <= 2
    if (worstRank >= 4) return false;           // R32: could be 4th
    return ceilings ? thirdOnPointsClinches(mine, ownLetter, ceilings) : false; // worst-case 3rd
  };

  const rows = [];
  for (let n = 0; n < 3 ** k; n++) {
    let x = n;
    const ownPts = new Map(basePts);
    const results = [];
    for (let i = 0; i < k; i++) {
      const oc = COARSE[x % 3]; x = Math.floor(x / 3);
      applyOutcome(ownPts, own[i], oc);
      results.push(ownResultOf(own[i], oc, code));
    }
    let safe = true;
    for (const fp of enumeratePoints(ownPts, others)) {
      if (!reaches(fp)) { safe = false; break; }
    }
    rows.push({ results, total: ownPts.get(code), safe });
  }

  const safeRows = rows.filter((r) => r.safe);
  if (safeRows.length === 0) return { cond: null };

  const minSafe = Math.min(...safeRows.map((r) => r.total));
  if (rows.every((r) => r.safe === (r.total >= minSafe))) {
    const rp = resultsForDelta(minSafe - curPts, k);
    return { cond: rp || `${minSafe}+ points` };
  }

  // Non-monotone (arises for TOP-2 in the rock-paper-scissors trap): by result.
  if (k === 2) {
    const losses = (r) => r.results.filter((x) => x === 'loss').length;
    const wins = (r) => r.results.filter((x) => x === 'win').length;
    if (rows.every((r) => (losses(r) === 0) === r.safe)) return { cond: 'avoiding defeat in both games' };
    if (rows.every((r) => (wins(r) >= 1) === r.safe)) return { cond: 'a win in either game' };
    if (rows.every((r) => (wins(r) === 2) === r.safe)) return { cond: 'winning both games' };
  }
  return { cond: null };
}

// ----------------------------------------------------------------------------
// Next-round identification + triggers
// ----------------------------------------------------------------------------

/**
 * The next chronological round = unplayed matches sharing the EARLIEST date.
 * Tie-break ordering within the round by time (string compare is adequate for
 * the "HH:MM UTC±N" format only loosely; date is the grouping key that matters).
 */
function nextRoundMatches(unplayed) {
  if (unplayed.length === 0) return [];
  const dated = unplayed.filter((m) => m.date);
  const pool = dated.length ? dated : unplayed;
  let earliest = null;
  for (const m of pool) {
    if (earliest === null || (m.date && m.date < earliest)) earliest = m.date;
  }
  const round = pool.filter((m) => m.date === earliest);
  round.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  return round;
}

const ord = (n) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);

/**
 * Re-run the clinch/eliminate test on the POST-NEXT-ROUND state to generate
 * AUTOMATIC, VERIFIED trigger strings: what becomes OFFICIAL after the next
 * round (with later games still to play).
 *
 * Approach: enumerate the coarse outcomes of JUST the next-round matches. For
 * each post-round points state, re-evaluate every team over the STILL-remaining
 * matches. We collect, per team, the SET of next-round coarse outcomes that
 * (a) clinch top 2, (b) clinch 1st, or (c) eliminate it — then describe the
 * trigger in terms of that team's own next-round result when it is the clean
 * driver, else as a combined condition.
 */
function buildTriggers(group, basePts, unplayed, teamMeta) {
  const round = nextRoundMatches(unplayed);
  if (round.length === 0) return { matchKeys: [], date: null, triggers: [] };

  const date = round[0].date || null;
  const roundKeys = new Set(round.map(matchKey));
  const later = unplayed.filter((m) => !roundKeys.has(matchKey(m)));

  // Enumerate next-round coarse outcomes; for each, compute the post-round base
  // points and evaluate every team over the LATER matches.
  const k = round.length;
  const combos = []; // { outcomes:[{key,outcome}], post:Map, perTeam:{code:{clinch,won,elim}} }
  for (let n = 0; n < 3 ** k; n++) {
    const post = new Map(basePts);
    const outcomes = [];
    let x = n;
    for (let i = 0; i < k; i++) {
      const oc = COARSE[x % 3];
      applyOutcome(post, round[i], oc);
      outcomes.push({ match: round[i], outcome: oc });
      x = Math.floor(x / 3);
    }
    const perTeam = {};
    for (const t of group.teams) {
      const ev = evaluateTeam(post, later, t.code);
      perTeam[t.code] = {
        clinch: ev.clinchedTop2,
        won: ev.wonGroup,
        elim: ev.eliminated,
      };
    }
    combos.push({ outcomes, perTeam });
  }

  // Helper: for a given team and a target predicate (clinch/won/elim), find the
  // set of next-round combos satisfying it, and try to express it compactly in
  // terms of that team's OWN next-round result (win/draw/loss), noting any
  // dependency on the other match.
  const teamName = (code) => (teamMeta.get(code)?.name) || code;

  // The team's OWN next-round result (win/draw/loss) within a specific combo.
  // We find the combo entry for the match the team actually plays and translate
  // THAT match's outcome — never apply another match's outcome to it.
  const ownResultInCombo = (code, combo) => {
    for (const o of combo.outcomes) {
      const m = o.match;
      if (m.home === code) return o.outcome === 'home' ? 'win' : o.outcome === 'away' ? 'loss' : 'draw';
      if (m.away === code) return o.outcome === 'away' ? 'win' : o.outcome === 'home' ? 'loss' : 'draw';
    }
    return null; // team does not play this round
  };
  const playsThisRound = (code) => round.some((r) => r.home === code || r.away === code);

  const triggers = [];

  for (const t of group.teams) {
    const code = t.code;
    const meta = teamMeta.get(code);
    // Already settled before the round? Then nothing NEW triggers for it.
    if (meta.status === 'won-group' || meta.status === 'qualified' || meta.status === 'advanced' || meta.status === 'eliminated') {
      continue;
    }

    // CLINCH-1st trigger (lead with the strongest fact).
    addTrigger(triggers, code, 'won', combos, round, ownResultInCombo, playsThisRound, teamName, group);
    // CLINCH top-2 trigger.
    addTrigger(triggers, code, 'clinch', combos, round, ownResultInCombo, playsThisRound, teamName, group);
    // ELIMINATION trigger.
    addTrigger(triggers, code, 'elim', combos, round, ownResultInCombo, playsThisRound, teamName, group);
  }

  if (triggers.length === 0) {
    triggers.push('Nothing is settled until the final round.');
  }

  return { matchKeys: round.map(matchKey), date, triggers };
}

/**
 * Build (and push, if true & compact) a single trigger for one team & predicate.
 * predicate: 'won' (clinch 1st) | 'clinch' (clinch top 2) | 'elim' (eliminated).
 *
 * We look at the subset of next-round combos where the predicate holds. If that
 * subset is exactly characterized by the team's OWN result(s) in the round
 * (independent of the other match), we phrase it cleanly ("X clinch a top-2 place
 * with a win or draw"). If it additionally requires the other match to go a
 * certain way, we phrase the dependency ("X can clinch with a win if Y lose").
 * If it's true only in scattered combos not cleanly describable, we conservatively
 * describe it as conditional on both results, listing the own-result and the
 * required other-match outcome(s). Triggers that never hold are skipped.
 */
function addTrigger(out, code, predicate, combos, round, ownResult, playsThisRound, teamName, group) {
  const holds = (c) => c.perTeam[code][predicate];

  const satisfying = combos.filter(holds);
  if (satisfying.length === 0) return;            // predicate never triggers next round
  if (satisfying.length === combos.length) {
    // Already true in every outcome -> it was already settled (shouldn't reach
    // here for unsettled teams), skip to avoid noise.
    return;
  }

  const name = teamName(code);
  const verb =
    predicate === 'won' ? 'clinch top spot' :
    predicate === 'clinch' ? 'clinch a top-2 place' :
    'drop out of the top-two race';

  // Map each combo to (ownResult, otherKey->otherResultLabel).
  const otherMatches = round.filter((r) => r.home !== code && r.away !== code);

  // Group satisfying combos by the team's own result (combo-aware; reads the
  // outcome of the match THIS team plays, not whichever outcome comes last).
  const byOwn = new Map(); // ownResult -> array of combos
  for (const c of satisfying) {
    const key = ownResult(code, c) || 'n/a';
    if (!byOwn.has(key)) byOwn.set(key, []);
    byOwn.get(key).push(c);
  }

  // For each own-result, is the predicate true for ALL other-match outcomes
  // (i.e. own result alone is sufficient)? Count combos per own-result vs how
  // many TOTAL combos share that own-result.
  const totalByOwn = new Map();
  for (const c of combos) {
    const key = ownResult(code, c) || 'n/a';
    totalByOwn.set(key, (totalByOwn.get(key) || 0) + 1);
  }

  const sufficientOwn = []; // own-results that ALONE guarantee the predicate
  const conditionalOwn = []; // own-results that only sometimes trigger (need other match)
  for (const [own, list] of byOwn) {
    if (list.length === totalByOwn.get(own)) sufficientOwn.push(own);
    else conditionalOwn.push(own);
  }

  const resultPhrase = (r) => (r === 'win' ? 'a win' : r === 'draw' ? 'a draw' : 'a loss');
  const order = { win: 0, draw: 1, loss: 2 };

  // Clean case: own result(s) alone are sufficient, nothing conditional.
  if (sufficientOwn.length > 0 && conditionalOwn.length === 0 && playsThisRound(code)) {
    const sorted = sufficientOwn.sort((a, b) => order[a] - order[b]);
    const phrase = sorted.map(resultPhrase).join(' or ');
    out.push(`${name} ${verb} with ${phrase}.`);
    return;
  }

  // Conditional case: own result needs help from the other match. Describe the
  // smallest such combo cleanly when there is exactly one own-result that needs a
  // single other-match condition.
  if (conditionalOwn.length > 0 && otherMatches.length === 1 && playsThisRound(code)) {
    const om = otherMatches[0];
    const describeOther = (outcome) => {
      if (outcome === 'draw') return `${teamName(om.home)} and ${teamName(om.away)} draw`;
      const winner = outcome === 'home' ? om.home : om.away;
      const loser = outcome === 'home' ? om.away : om.home;
      return `${teamName(winner)} beat ${teamName(loser)}`;
    };
    // Take the conditional own-result(s) and, for each, the required other outcomes.
    const clauses = [];
    for (const own of conditionalOwn.sort((a, b) => order[a] - order[b])) {
      const list = byOwn.get(own);
      const otherOutcomes = new Set();
      for (const c of list) {
        for (const o of c.outcomes) {
          if (o.match === om) otherOutcomes.add(o.outcome);
        }
      }
      const others = [...otherOutcomes].map(describeOther).join(' or ');
      clauses.push(`with ${resultPhrase(own)} if ${others}`);
    }
    // Prepend any unconditional own-results.
    let lead = '';
    if (sufficientOwn.length > 0) {
      const sorted = sufficientOwn.sort((a, b) => order[a] - order[b]);
      lead = `with ${sorted.map(resultPhrase).join(' or ')}`;
    }
    const body = [lead, ...clauses].filter(Boolean).join(', or ');
    out.push(`${name} can ${verb} ${body}.`);
    return;
  }

  // Team does NOT play this round (its fate turns purely on others' results), or
  // a shape we won't try to pretty-print. Describe it as conditional on the round.
  if (!playsThisRound(code)) {
    // Characterize the satisfying combos by the other matches' outcomes.
    const clauses = satisfying.map((c) =>
      c.outcomes
        .map((o) => {
          if (o.outcome === 'draw') return `${teamName(o.match.home)}-${teamName(o.match.away)} draw`;
          const w = o.outcome === 'home' ? o.match.home : o.match.away;
          const l = o.outcome === 'home' ? o.match.away : o.match.home;
          return `${teamName(w)} beat ${teamName(l)}`;
        })
        .join(' & ')
    );
    // Only emit if compact (<=2 clauses) to avoid noise.
    if (clauses.length <= 2) {
      out.push(`${name} ${verb} if ${clauses.join(' OR ')}.`);
    }
    return;
  }
  // Fallback: mixed/complex own+other shape we won't enumerate verbosely. Emit a
  // conservative conditional headline so the fact isn't lost.
  out.push(`${name} can ${verb} next round (result-dependent).`);
}

// ----------------------------------------------------------------------------
// needLine / statusLine phrasing
// ----------------------------------------------------------------------------

function buildStatusLine(status, mc) {
  switch (status) {
    case 'won-group': return mc ? 'Won the group' : 'Clinched 1st';
    case 'advanced': {
      // DETERMINISTICALLY through to the R32 (via a locked top-8 third place),
      // but the group seed (1st/2nd/3rd) is not yet settled. Lead with the clinch.
      if (mc && (mc.pWinGroup ?? 0) > 0.005) {
        return `Clinched a Round-of-32 place — ${pctMC(mc.pWinGroup)} to win the group`;
      }
      return 'Clinched a Round-of-32 place';
    }
    case 'qualified': {
      if (!mc) return 'Through to the R32';
      // Through on points; note any live chance to win the group.
      if ((mc.pWinGroup ?? 0) > 0.005) {
        return `Qualified for the Round of 32 — ${pctMC(mc.pWinGroup)} to win the group`;
      }
      return 'Qualified for the Round of 32';
    }
    case 'eliminated': {
      // Top 2 is gone. That is NOT tournament elimination — a best-third berth
      // (cross-group) may still be live, so reflect the MC advance odds when we
      // have them rather than declaring the team dead.
      if (mc) {
        const pAdv = mc.pAdvance ?? 0;
        if (pAdv > 0.005) return `Out of the top two — ${pctMC(pAdv)} to advance as a best-third`;
      }
      return 'Out of the top two';
    }
    default: {
      // Contention: drive a realistic headline from the Monte-Carlo advance odds,
      // never claiming top-2 when it is realistically impossible.
      if (mc) {
        const pAdv = mc.pAdvance ?? 0;
        const pTop2 = (mc.pGroup1 ?? 0) + (mc.pGroup2 ?? 0);
        if (pAdv >= 0.99) return `Virtually through — ${pctMC(pAdv)} to qualify`;
        if (pTop2 < 0.01) return `Realistically fighting for 3rd — ${pctMC(pAdv)} to advance`;
        if (pAdv >= 0.85) return `In good shape — ${pctMC(pAdv)} to qualify`;
        return `In contention — ${pctMC(pAdv)} to qualify`;
      }
      return 'Still alive';
    }
  }
}

/** Compact percent formatter, matching the UI / scenario-summary. */
function pctMC(p) {
  if (p == null) return '';
  if (p >= 0.995) return '99%';
  if (p > 0 && p <= 0.005) return '<1%';
  const v = p * 100;
  return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + '%';
}

/**
 * Express the MINIMAL set of own remaining results that GUARANTEES a final point
 * total of at least `delta` ABOVE the team's current total, over `remaining`
 * games. Returns a result phrase ("two wins", "a win and a draw", "two draws",
 * "a single draw", "at least one win") or null if not cleanly expressible.
 *
 * This is result language, never "needs N points FROM its last games".
 */
function resultsForDelta(delta, remaining) {
  if (delta <= 0) return null; // already safe
  if (remaining === 1) {
    if (delta > 3) return null;            // unreachable in one game
    if (delta === 3) return 'a win';        // only a win reaches 3
    if (delta === 2) return 'a win';        // a draw (1) falls short of 2
    if (delta === 1) return 'a draw (or better)';
    return null;
  }
  if (remaining === 2) {
    if (delta > 6) return null;
    if (delta === 6) return 'two wins';
    if (delta >= 4) return 'a win and a draw';   // 4 needs ≥ W+D; 5 same minimal guarantee
    if (delta === 3) return 'at least one win';   // a win (3) or fall short with draws
    if (delta === 2) return 'two draws (or better)';
    if (delta === 1) return 'a single draw (or better)';
    return null;
  }
  return null;
}

/**
 * The minimal own result needed to keep a TOP-2 finish mathematically alive —
 * i.e. to reach the (top-2) elimination threshold. Expressed as the negative:
 * what drops the team OUT OF THE TOP TWO.
 *
 * ⚠️ HONESTY: this module computes TOP-2 reachability only. Falling below the
 * threshold means top 2 is gone — NOT that the team is eliminated. A best-third
 * berth (cross-group, never asserted here) may still be live. So the phrasing
 * is always "out of the top two", never a bare "out" / "eliminated".
 */
function eliminationResultPhrase(deltaToFloor, remaining) {
  if (deltaToFloor <= 0) return null; // floor already secured -> no risk of dropping
  if (remaining === 2) {
    if (deltaToFloor === 3) return 'out of the top two without a win';
    if (deltaToFloor === 6) return 'out of the top two unless they win both';
    if (deltaToFloor === 2) return 'out of the top two with fewer than two points';
    if (deltaToFloor === 1) return 'out of the top two if winless';
  }
  if (remaining === 1) {
    if (deltaToFloor === 3) return 'out of the top two with anything less than a win';
    if (deltaToFloor >= 1) return 'out of the top two with a loss';
  }
  return null;
}

function buildNeedLine(status, remaining, curPts, mc, reqR32, reqTop2, reqFirst) {
  if (status === 'won-group') return 'Already won the group.';
  if (status === 'qualified') return 'Already through to the knockout round.';
  if (status === 'eliminated') return 'Cannot finish in the top two (a best-third place would be its only route through).';

  const overall = mc && mc.pAdvance != null ? ` — ${pctMC(mc.pAdvance)} to advance overall` : '';

  // A reward LADDER: what guarantees ADVANCEMENT (R32, with the best-third
  // cushion) → what clinches a TOP-2 seed → what clinches TOP SPOT (best seed).
  // Each rung carries its minimal own-result condition; adjacent rungs sharing a
  // condition collapse to the higher reward (same cost, better prize).
  const rungs = [];
  if (reqR32 && reqR32.cond) rungs.push({ cond: reqR32.cond, label: 'a Round-of-32 place' });
  if (reqTop2 && reqTop2.cond) rungs.push({ cond: reqTop2.cond, label: 'a top-2 place' });
  if (reqFirst && reqFirst.cond) rungs.push({ cond: reqFirst.cond, label: 'top spot' });

  const kept = [];
  for (const r of rungs) {
    if (kept.length && kept[kept.length - 1].cond === r.cond) kept[kept.length - 1] = r; // same cost → keep better prize
    else kept.push(r);
  }

  let safeClause;
  if (kept.length === 0) {
    safeClause = 'Can reach the Round of 32, but no result yet guarantees it';
  } else {
    safeClause = kept
      .map((r, i) => (i === 0 ? `${cap(r.cond)} guarantees ${r.label}` : `${cap(r.cond)} clinches ${r.label}`))
      .join('; ');
  }

  return `${safeClause}${overall}.`;
}

/** Capitalize first letter. */
function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// ----------------------------------------------------------------------------
// Cross-group best-third clinch (DETERMINISTIC only — see HONESTY CONTRACT)
// ----------------------------------------------------------------------------

const groupLetter = (g) => {
  const m = /Group\s+([A-L])/i.exec(g.name || '');
  return m ? m[1].toUpperCase() : null;
};

/**
 * Max points a THIRD-place team in this group can still finish on, over every
 * completion of its unplayed matches. (4-team group → sorted[2] is 3rd.) This is
 * the per-group ceiling used to bound how many other groups could field a third
 * that matches-or-beats a given team's worst-case third-place total.
 */
export function maxThirdPoints(group) {
  const { pts } = currentPoints(group);
  const unplayed = group.matches.filter((m) => !m.played);
  let mx = -1;
  for (const finalPts of enumeratePoints(pts, unplayed)) {
    const sorted = [...finalPts.values()].sort((a, b) => b - a);
    if (sorted[2] > mx) mx = sorted[2];
  }
  return mx;
}

/**
 * MINIMUM points a THIRD-place team in this group can finish on, over every
 * completion of its unplayed matches. Mirror of maxThirdPoints tracking the
 * minimum of sorted[2]. Returns 0 if there are no completions to evaluate.
 */
export function minThirdPoints(group) {
  const { pts } = currentPoints(group);
  const unplayed = group.matches.filter((m) => !m.played);
  let mn = Infinity;
  for (const finalPts of enumeratePoints(pts, unplayed)) {
    const sorted = [...finalPts.values()].sort((a, b) => b - a);
    if (sorted[2] < mn) mn = sorted[2];
  }
  return mn === Infinity ? 0 : mn;
}

/** Map group-letter -> maxThirdPoints, across all groups. */
export function thirdCeilings(allGroups) {
  const m = new Map();
  for (const g of allGroups) {
    const L = groupLetter(g);
    if (L) m.set(L, maxThirdPoints(g));
  }
  return m;
}

/** Map group-letter -> minThirdPoints, across all groups (mirror thirdCeilings). */
export function thirdFloors(allGroups) {
  const m = new Map();
  for (const g of allGroups) {
    const L = groupLetter(g);
    if (L) m.set(L, minThirdPoints(g));
  }
  return m;
}

/** The fixed 3rd-place standing of a DONE group, else null. */
function doneThirdOf(group) {
  if (!group.matches.every((m) => m.played)) return null;
  return computeGroupStanding(group).find((s) => s.rank === 3) || null;
}

/**
 * TIEBREAKER-AWARE third-place outlook for one group — the deterministic answer
 * the third-place RACE panel needs ("QUALIFIED" / "OUT" / still live). Supersedes
 * the points-only thirdOnPointsClinches/Eliminated, which were tiebreak-blind: they
 * counted any group that could MATCH a points total as a threat, so e.g. Sweden
 * (4 pts, GD +0, GF 7) was wrongly held short of clinching by Bosnia/Ecuador, who
 * are done on the SAME 4 points but rank strictly BELOW on GD/GF and can never pass.
 *
 * Returns 'qualified' | 'eliminated' | null.
 *
 *  - QUALIFIED (clinched a top-8 third place): only decidable once THIS group is
 *    done (its 3rd is then a fixed standing T). T is locked top-8 iff AT MOST 7
 *    other groups can still field a third ranking strictly ABOVE T —
 *      • other DONE group: its actual 3rd outranks T   (exact, full FIFA cascade)
 *      • other LIVE group: maxThirdPoints >= T.points  (conservative: a points tie
 *        MIGHT win the GD/GF tiebreak, so we count it as a possible passer)
 *    Groups are independent, so all of them hitting their ceiling at once is the
 *    real worst case; <= 7 possible passers ⇒ T can finish no worse than 8th.
 *
 *  - ELIMINATED: even this group's BEST-possible third (maxThirdPoints) is beaten
 *    for sure by AT LEAST 8 other groups —
 *      • other DONE group: its 3rd has strictly MORE points than our max
 *      • other LIVE group: minThirdPoints strictly MORE than our max
 *    (strictly-more points always outranks regardless of tiebreak ⇒ no false call).
 */
export function thirdPlaceOutlook(group, allGroups) {
  const ownL = groupLetter(group);
  const others = allGroups.filter((g) => groupLetter(g) !== ownL);

  // --- CLINCH (own group must be done so its 3rd is a fixed standing) ---
  const T = doneThirdOf(group);
  if (T) {
    let possiblePassers = 0;
    for (const g of others) {
      const their = doneThirdOf(g);
      if (their) {
        if (compareThirdPlace(their, T) < 0) possiblePassers++; // strictly above
      } else if (maxThirdPoints(g) >= T.points) {
        possiblePassers++; // live group could match-or-beat T's points
      }
    }
    if (possiblePassers <= 7) return 'qualified';
  }

  // --- ELIMINATION (this group's best-possible third still beaten for sure by
  //     >= 8 other groups) ---
  // (a) Own group DONE -> its 3rd is the fixed standing T: tiebreaker-AWARE,
  //     symmetric with the clinch test above. A finished other-group is a sure
  //     passer when its actual 3rd strictly OUTRANKS T on the FULL FIFA cascade
  //     (points -> GD -> GF), NOT points alone — the points-only test missed a
  //     goal-difference elimination (e.g. SCO 3pts/-3 is buried by IRN 3/0,
  //     KOR 3/-1, SEN 3/+2, who tie on points but win on GD). A live group counts
  //     only if its MINIMUM third already has strictly more points (can't lose).
  if (T) {
    let beaten = 0;
    for (const g of others) {
      const their = doneThirdOf(g);
      if (their) { if (compareThirdPlace(their, T) < 0) beaten++; }
      else if (minThirdPoints(g) > T.points) beaten++;
    }
    if (beaten >= 8) return 'eliminated';
  }

  // (b) Own group still LIVE -> no fixed third yet, so fall back to a points-only
  //     best-case bound (can't apply GD/GF to a team that doesn't exist yet).
  //     Conservative: only strictly-more-points counts, so never a false call.
  const ownMax = maxThirdPoints(group);
  let beatenForSure = 0;
  for (const g of others) {
    const their = doneThirdOf(g);
    if (their) {
      if (their.points > ownMax) beatenForSure++;
    } else if (minThirdPoints(g) > ownMax) {
      beatenForSure++;
    }
  }
  if (beatenForSure >= 8) return 'eliminated';

  return null;
}

/**
 * Is `code` DETERMINISTICALLY guaranteed to reach the R32 — even if it cannot
 * lock a top-2 seed? Over every completion of its own group:
 *   - worstRank = it loses all ties (strictlyAbove + equal + 1).
 *   - If it can ever finish 4th -> NOT guaranteed (4th never advances).
 *   - If it can finish 3rd, take its LOWEST 3rd-place points total (the hardest
 *     case). It is a locked top-8 third iff at most 7 OTHER groups have a
 *     third-place ceiling >= that total (groups are independent, so all of them
 *     hitting their ceiling at once is achievable — the tight worst case).
 * Returns { clinched, viaThird, worstThirdPts } (clinched=false if no ceilings).
 */
function advanceClinchInfo(basePts, unplayed, code, ceilings, ownLetter) {
  if (!ceilings) return { clinched: false };
  let everFourth = false, everThird = false, worstThirdPts = Infinity;
  for (const finalPts of enumeratePoints(basePts, unplayed)) {
    const mine = finalPts.get(code);
    let strictlyAbove = 0, equal = 0;
    for (const [c, p] of finalPts) {
      if (c === code) continue;
      if (p > mine) strictlyAbove++;
      else if (p === mine) equal++;
    }
    const worstRank = strictlyAbove + equal + 1;
    if (worstRank >= 4) everFourth = true;
    else if (worstRank === 3) { everThird = true; if (mine < worstThirdPts) worstThirdPts = mine; }
  }
  if (everFourth) return { clinched: false };       // a 4th-place finish is possible
  if (!everThird) return { clinched: false };        // never below 2nd -> top-2 clinch path
  let canMatchOrBeat = 0;
  for (const [letter, ceil] of ceilings) {
    if (letter === ownLetter) continue;
    if (ceil >= worstThirdPts) canMatchOrBeat++;
  }
  return { clinched: canMatchOrBeat <= 7, viaThird: true, worstThirdPts, canMatchOrBeat };
}

/**
 * Minimal OWN result that guarantees finishing SOLE top on points (winning the
 * group), or null if no own result can guarantee it yet. Same own/others split
 * as magicAndThreshold, tested against isSoleTopOnPoints, phrased via
 * resultsForDelta ("a draw (or better)", "a win", "two wins", …).
 */
function clinchFirstResult(basePts, unplayed, code, curPts) {
  const own = unplayed.filter((m) => m.home === code || m.away === code);
  const others = unplayed.filter((m) => m.home !== code && m.away !== code);
  const byTotal = new Map(); // own-final-total -> { everNotFirst }
  for (const ownPts of enumeratePoints(basePts, own)) {
    const myTotal = ownPts.get(code);
    let everNotFirst = false;
    for (const finalPts of enumeratePoints(ownPts, others)) {
      if (!isSoleTopOnPoints(finalPts, code)) { everNotFirst = true; break; }
    }
    const agg = byTotal.get(myTotal) || { everNotFirst: false };
    agg.everNotFirst = agg.everNotFirst || everNotFirst;
    byTotal.set(myTotal, agg);
  }
  const totals = [...byTotal.keys()].sort((a, b) => a - b);
  let magicFirst = null;
  for (let i = 0; i < totals.length; i++) {
    let tailOK = true;
    for (let j = i; j < totals.length; j++) {
      if (byTotal.get(totals[j]).everNotFirst) { tailOK = false; break; }
    }
    if (tailOK) { magicFirst = totals[i]; break; }
  }
  if (magicFirst == null) return null;
  return resultsForDelta(magicFirst - curPts, own.length);
}

// ----------------------------------------------------------------------------
// Public entry
// ----------------------------------------------------------------------------

/**
 * @param {{name,teams,matches}} group
 * @returns {{teams:Array, nextRound:{matchKeys,date,triggers}, decided:boolean}}
 */
export function groupSituation(group, opts = {}) {
  const mcByCode = opts.mcByCode || null; // code -> perTeam entry, or null
  const { pts, played } = currentPoints(group);
  const unplayed = group.matches.filter((m) => !m.played);

  // Cross-group third-place ceilings (DETERMINISTIC best-third clinch). Only when
  // the caller supplies all 12 groups; otherwise we stay silent on best-thirds.
  const ceilings = opts.allGroups ? thirdCeilings(opts.allGroups) : null;
  const ownLetter = groupLetter(group);

  const teamMeta = new Map();

  // First pass: status + magic numbers for each team.
  for (const t of group.teams) {
    const code = t.code;
    const remaining = unplayed.filter((m) => m.home === code || m.away === code).length;

    const ev = evaluateTeam(pts, unplayed, code);
    let status;
    if (ev.eliminated) status = 'eliminated';
    else if (ev.wonGroup) status = 'won-group';
    else if (ev.clinchedTop2) status = 'qualified';
    else status = 'contention';

    // DETERMINISTIC R32 clinch via a locked top-8 third place (cross-group). This
    // can upgrade BOTH a 'contention' team (e.g. could be 3rd-on-6 in a 3-way tie
    // but that 6 is guaranteed top-8) AND an 'eliminated'-from-top-2 team that is
    // nonetheless locked into a qualifying third. Never overrides a top-2 clinch.
    let advancedNeedLine = null;
    if (status !== 'won-group' && status !== 'qualified') {
      const ac = advanceClinchInfo(pts, unplayed, code, ceilings, ownLetter);
      if (ac.clinched) {
        const canTop2 = !ev.eliminated;
        const firstPhrase = canTop2 ? clinchFirstResult(pts, unplayed, code, pts.get(code)) : null;
        advancedNeedLine = 'Through to the Round of 32.';
        if (firstPhrase) advancedNeedLine += ` ${cap(firstPhrase)} clinches top spot in the group.`;
        else if (canTop2) advancedNeedLine += ' Group seeding still to be decided.';
        else advancedNeedLine += ' Locked into a best-third place.';
        status = 'advanced';
      }
    }

    const mt = status === 'contention'
      ? magicAndThreshold(pts, unplayed, code)
      : { magicNumber: null, tieAtMagic: false, eliminationThreshold: null, maxFinal: null };

    // Two requirements (contention only): what guarantees ADVANCEMENT (R32, with
    // the best-third cushion) vs what clinches TOP-2. Advancement uses the
    // cross-group ceilings; top-2 is within-group only.
    const cur = pts.get(code);
    const reqR32 = status === 'contention'
      ? safeRequirement(pts, unplayed, code, cur, { target: 'r32', ceilings, ownLetter })
      : null;
    const reqTop2 = status === 'contention'
      ? safeRequirement(pts, unplayed, code, cur, { target: 'top2', ceilings: null, ownLetter })
      : null;
    const reqFirst = status === 'contention'
      ? safeRequirement(pts, unplayed, code, cur, { target: 'first', ceilings: null, ownLetter })
      : null;

    teamMeta.set(code, {
      code,
      name: t.name,
      points: pts.get(code),
      played: played.get(code),
      remaining,
      status,
      mt,
      reqR32,
      reqTop2,
      reqFirst,
      advancedNeedLine,
    });
  }

  // Build next-round triggers (needs statuses already set).
  const nextRound = buildTriggers(group, pts, unplayed, teamMeta);

  // decided: every team's position settled (no contention left). A group is
  // "decided" on POINTS when everyone is won-group / qualified / eliminated.
  const decided = [...teamMeta.values()].every(
    (m) => m.status !== 'contention'
  );

  const teams = group.teams.map((t) => {
    const m = teamMeta.get(t.code);
    return {
      code: m.code,
      name: m.name,
      points: m.points,
      played: m.played,
      remaining: m.remaining,
      status: m.status,
      statusLine: buildStatusLine(m.status, mcByCode ? mcByCode[m.code] || null : null),
      magicNumber: m.mt.magicNumber,
      eliminationThreshold: m.mt.eliminationThreshold,
      needLine: m.status === 'advanced'
        ? m.advancedNeedLine
        : buildNeedLine(
            m.status,
            m.remaining,
            m.points,
            mcByCode ? mcByCode[m.code] || null : null,
            m.reqR32,
            m.reqTop2,
            m.reqFirst
          ),
    };
  });

  return { teams, nextRound, decided };
}
