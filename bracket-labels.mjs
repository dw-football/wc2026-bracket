// bracket-labels.mjs
// PURE, SHAREABLE bracket-label resolver for the 2026 World Cup knockout stage.
//
// Given the current tournament state (groups + bracket + any played knockout
// results) it computes the best human-readable label for every knockout match
// side, following a deterministic correctness contract:
//
//   - "still possible" / "locked" is decided DETERMINISTICALLY (full within-group
//     scoreline enumeration + recursive feeder-tree union for knockout rounds).
//   - The Monte-Carlo distribution is used ONLY to (a) order candidates
//     favorite-first and (b) run the dominance (>= threshold) test. A team that is
//     deterministically eliminated is excluded even if MC happened to sample it; a
//     team deterministically alive is kept even if MC never sampled it.
//
// THIS FILE CONTAINS NO PERSONAL DATA: no calendar IDs, no event IDs, no Google,
// nothing user-specific. `watchedTeams` and `maxPreview` are PARAMETERS. It is
// safe to commit and share publicly. The calendar binding lives entirely in
// sync-calendar.mjs + the (gitignored) calendar-map.local.json.
//
// LABELING RULES
// --------------
// R32 GROUP SLOTS (each side = winner/runnerup/third of a group) — 4-tier rule:
//   1. Mathematically LOCKED                                  -> real team name
//   2. Exactly TWO teams still possible                       -> "FAV/OTHER" (fav first)
//   3. 3+ possible AND one >= DOMINANT_THRESHOLD to fill it   -> "FAV/<slotCode>"
//   4. 3+ possible, nobody dominant                           -> structural placeholder
//                                                               ("1L","2K","3rd E/H/I/J/K")
// KNOCKOUT SLOTS (each side = winnerOf/loserOf a match) — candidate-cap rule with
// CANDIDATES = the deterministic union of teams that can reach the slot through
// the feeder subtree, ordered favorite-first:
//   1. exactly 1 candidate                                    -> that team name
//   2. 2..maxPreview candidates                               -> all, fav-first, slashed
//   3. > maxPreview candidates:
//        a. any WATCHED team possible -> "USA?/…" (each watched + "?", then ellipsis)
//        b. else                      -> null (caller keeps the existing label)
//
// Browser-safe ES module: imports only the pure engine/model layers. The caller
// injects resolveThirdPlaceSlots (Annex C) so this file never touches the fs.

import { computeGroupStanding, rankThirdPlaceTeams, scenarioGrid } from './engine.js';
import { monteCarlo } from './model.js';
import { makeKoSlotDist } from './ko-slot-dist.mjs';
// (koStructuralCode is defined below and used within this module.)

// ----------------------------------------------------------------------------
// Tunable constants
// ----------------------------------------------------------------------------

// Tier-3 (R32 group slots): with 3+ teams possible, a team at least this likely
// to fill the slot is shown as "NAME/<slotCode>" instead of the bare placeholder.
export const DOMINANT_THRESHOLD = 0.75;

// Default knockout preview cap: a knockout side lists at most this many candidate
// teams; beyond it, fall back to a watched-team breadcrumb or the existing label.
export const DEFAULT_MAX_PREVIEW = 4;

// Default Monte-Carlo budget for the ordering/dominance signal.
export const DEFAULT_MC_N = 60000;
export const DEFAULT_MC_SEED = 12345;
export const DEFAULT_KO_LAMBDA = 0.6; // mirrors the live Mark2 model
export const DEFAULT_HOSTS = ['USA', 'MEX', 'CAN'];

// David's "highlighted"/iconic teams — the ONLY teams named in a knockout-slot
// preview (each shown "CODE (NN%)" favorite-first, then "/…"). Overridable.
export const HIGHLIGHTED_TEAMS = ['USA', 'FRA', 'ESP', 'MEX', 'ARG', 'BRA', 'GER', 'POR'];
// An R32 slot occupant below this per-slot probability is dropped from the slot's
// "realistic" set. Collapses the ~impossible goal-difference-swing longshots, so a
// slot that is genuinely a two-horse race reads as the two teams (e.g. SUI/CAN),
// not a wide-open code — but a real 3rd outsider (CZE ~1%) keeps the slot a code.
export const R32_REALISTIC_FLOOR = 0.005;
// A knockout slot names a highlighted team only when it is at least this likely.
export const KO_SHOW_FLOOR = 0.05;
// A slot occupant at/above this probability is treated as locked (shown by name).
export const LOCKED_THRESHOLD = 0.99;

// Round -> label suffix.
export const ROUND_SUFFIX = {
  R32: ' R32',
  R16: ' R16',
  QF: ' QF',
  SF: ' SF',
  ThirdPlace: ' 3rd place',
  Final: ' Final',
};

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const groupLetterOf = (g) => {
  const m = /Group\s+([A-L])/i.exec(g.name || '');
  return m ? m[1].toUpperCase() : null;
};

/** Order a set of codes favorite-first by per-slot reach prob; stable code tie-break. */
export function orderByProb(codes, mcP) {
  return [...codes].sort((a, b) => {
    const pa = mcP.get(a) ?? 0;
    const pb = mcP.get(b) ?? 0;
    if (pb !== pa) return pb - pa;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * Group slot code in DAVID'S GROUP-FIRST convention: `${GROUP}${POSITION}`,
 * position 1 = winner, 2 = runner-up — e.g. winner A = "A1", runner-up K = "K2".
 * This matches his original calendar labels. A forker who prefers FIFA's
 * placement-first style ("1A"/"2A") only needs to flip this one helper.
 */
export function groupSlotCode(groupLetter, position) {
  return `${groupLetter}${position}`;
}

/** Structural placeholder for an R32 group slot. Group slots use the group-first
 *  convention above; third-place slots keep the FIFA candidate-list style
 *  ("3rd E/H/I/J/K"), which is intentionally left UNAFFECTED. */
export function r32SlotCode(side) {
  if (side.type === 'winner') return groupSlotCode(side.group, 1);
  if (side.type === 'runnerup') return groupSlotCode(side.group, 2);
  if (side.type === 'third') return '3rd ' + (side.from || []).join('/');
  return '?';
}

// ----------------------------------------------------------------------------
// DETERMINISTIC within-group rank-possibility sets (margin-aware full enumeration
// via engine.scenarioGrid, the project's tested enumerator).
// Returns letter -> { r1:Set, r2:Set, r3:Set } of codes able to finish 1/2/3.
// ----------------------------------------------------------------------------

export function groupRankSets(groups) {
  const out = {};
  for (const g of groups) {
    const L = groupLetterOf(g);
    if (!L) continue;
    const unplayedKeys = g.matches.filter((m) => !m.played).map((m) => `${m.home}-${m.away}`);
    const r1 = new Set(), r2 = new Set(), r3 = new Set();
    if (unplayedKeys.length === 0) {
      const st = computeGroupStanding(g);
      if (st[0]) r1.add(st[0].code);
      if (st[1]) r2.add(st[1].code);
      if (st[2]) r3.add(st[2].code);
      out[L] = { r1, r2, r3 };
      continue;
    }
    if (unplayedKeys.length > 2) {
      // scenarioGrid only enumerates 1-2 unplayed matches (it throws otherwise).
      // With 3+ still to play (early in the group) the field is wide open, so take
      // the SAFE SUPERSET — every team can still finish 1st/2nd/3rd. Over-wide,
      // never a false lock; exact enumeration resumes automatically once the group
      // narrows to <=2 unplayed. (Without this, the calendar tool crashed whenever
      // a group sat at 3 unplayed.)
      for (const t of g.teams) { r1.add(t.code); r2.add(t.code); r3.add(t.code); }
      out[L] = { r1, r2, r3 };
      continue;
    }
    const grid = scenarioGrid(g, unplayedKeys, 6);
    for (const t of g.teams) {
      const s = grid.teams[t.code];
      for (const rk of s.ranks) {
        if (rk === 1) r1.add(t.code);
        else if (rk === 2) r2.add(t.code);
        else if (rk === 3) r3.add(t.code);
      }
    }
    out[L] = { r1, r2, r3 };
  }
  return out;
}

// ----------------------------------------------------------------------------
// DETERMINISTIC R32 third-place slot candidate SET.
// A third slot ("3rd E/H/I/J/K") is filled by whichever candidate group's third
// qualifies AND is allocated here. Exact deterministic resolution across all
// completions is intractable (Annex C is cross-group), so we take the SAFE
// SUPERSET: the union of {teams that can finish 3rd} across the slot's candidate
// groups. The MC ordering trims noise for display; the deterministic set governs
// correctness (we never claim "locked" from this path).
// ----------------------------------------------------------------------------

function thirdSlotCandidates(slotFromLetters, rankSets) {
  const cands = new Set();
  for (const L of slotFromLetters || []) {
    const rs = rankSets[L];
    if (!rs) continue;
    for (const code of rs.r3) cands.add(code);
  }
  return cands;
}

/** Deterministic LOCK of every R32 third slot, only when the whole group stage is
 *  decided so the Annex C allocation AND each allocated group's third are fixed.
 *  Returns Map<matchNo, code>. (Correctness-first: never locks early.) */
function lockedThirdSlots(groups, bracket, resolveThirdPlaceSlots, rankThirdPlaceTeams) {
  const locked = new Map();
  const allDecided = groups.every((g) => g.matches.every((m) => m.played));
  if (!allDecided || typeof resolveThirdPlaceSlots !== 'function' || typeof rankThirdPlaceTeams !== 'function') {
    return locked;
  }
  try {
    const thirds = rankThirdPlaceTeams(groups);
    const qual = thirds.filter((t) => t.qualifies);
    const qualLetters = qual.map((t) => /Group\s+([A-L])/i.exec(t.group)[1].toUpperCase());
    if (qualLetters.length !== 8) return locked;
    const slots = resolveThirdPlaceSlots(qualLetters, bracket);
    const thirdByLetter = {};
    for (const t of qual) {
      const L = /Group\s+([A-L])/i.exec(t.group)[1].toUpperCase();
      thirdByLetter[L] = t.code;
    }
    for (const s of slots) locked.set(s.match, thirdByLetter[s.group]);
  } catch { /* allocation not resolvable yet */ }
  return locked;
}

// ----------------------------------------------------------------------------
// PURE side renderers (unit-testable in isolation). Both consume the per-slot
// occupancy array [{code, p}] — the SAME numbers the bracket page shows — so the
// calendar can never disagree with the site (single source of truth).
// ----------------------------------------------------------------------------

const pct = (p) => `${Math.round(p * 100)}%`;

/**
 * Render one R32 GROUP/THIRD slot from its per-slot occupancy. Tiers run on the
 * REALISTIC set (occupants >= R32_REALISTIC_FLOOR), David's rule:
 *   1 team  -> full name (locked)
 *   2 teams -> "FAV (NN%)/OTHER"          (favorite-first; only the favorite shows %)
 *   3+, top >= DOMINANT_THRESHOLD -> "slotCode (FAV NN%)"   e.g. "A2 (KOR 90%)"
 *   3+, none dominant             -> bare slotCode           e.g. "K2", "3rd E/H/I/J/K"
 * @param {Array<{code:string,p:number}>} occ per-slot occupancy for this side
 * @returns {{label:string}}
 */
export function renderR32Side(occ, slotCode, fullName, opts = {}) {
  const floor = opts.floor ?? R32_REALISTIC_FLOOR;
  const dom = opts.dominantThreshold ?? DOMINANT_THRESHOLD;
  const a = (occ || []).filter((c) => c.p >= floor).sort((x, y) => y.p - x.p);
  if (a.length <= 1) return { label: a.length ? fullName(a[0].code) : slotCode };
  if (a.length === 2) return { label: `${a[0].code} (${pct(a[0].p)})/${a[1].code}` };
  if (a[0].p >= dom) return { label: `${slotCode} (${a[0].code} ${pct(a[0].p)})` };
  return { label: slotCode };
}

/**
 * Render one KNOCKOUT slot to MIRROR THE BRACKET — the real contender pair, NOT a
 * highlighted-teams-only preview. Consumes the per-slot occupancy [{code,p}]:
 *   - occupant >= LOCKED_THRESHOLD            -> that team's full name (played/locked)
 *   - else the realistic contenders (p >= floor), favorite-first, "CODE NN%/CODE NN%",
 *     capped at `cap` (default 2, like the bracket) with a trailing "/…" if more
 *     real contenders exist. Always names at least the top 2, so an R16 slot fed by
 *     a DECIDED R32 reads as its two teams (e.g. "BRA 57%/JPN 43%").
 *   - genuinely no candidates (feeder unknowable) -> the structural feeder code.
 * Matches build-html's per-candidate rendering so the calendar can't disagree with
 * the site. (Old behavior named only HIGHLIGHTED teams + a reach %, else a bare
 * structural code — which diverged from the bracket once the R32 was set.)
 * @param {Array<{code:string,p:number}>} occ per-slot occupancy for this side
 * @returns {{label:string, structural:boolean}}
 */
export function renderKoSide(occ, structuralCode, fullName, opts = {}) {
  const mode = opts.mode ?? 'contenders';   // 'contenders' (bracket-mirror) | 'highlighted' (group-stage preview)
  const a = (occ || []).slice().sort((x, y) => y.p - x.p);
  if (!a.length) return { label: structuralCode, structural: true };          // genuinely unknown
  if (a[0].p >= LOCKED_THRESHOLD) return { label: fullName(a[0].code), structural: false }; // locked winner

  if (mode === 'highlighted') {
    // PRESERVED GROUP-STAGE PREVIEW (toggle): name ONLY highlighted/iconic teams,
    // each "CODE (NN%)" favorite-first, then "/…"; if none clears the floor the side
    // is structural (its feeder code). Useful EARLY, when a KO slot's field is wide —
    // it surfaces David's teams on the path rather than two arbitrary leaders. This is
    // the original behavior; opt in with computeMatchLabels({ koLabelMode:'highlighted' }).
    const highlighted = opts.highlighted || new Set(HIGHLIGHTED_TEAMS);
    const showFloor = opts.showFloor ?? KO_SHOW_FLOOR;
    const hi = a.filter((c) => highlighted.has(c.code) && c.p >= showFloor);
    if (!hi.length) return { label: structuralCode, structural: true };
    return { label: hi.map((c) => `${c.code} (${pct(c.p)})`).join('/') + '/…', structural: false };
  }

  // DEFAULT 'contenders' — MIRROR THE BRACKET: the realistic contenders favorite-first,
  // "CODE NN%/CODE NN%", top `cap` (default 2) + "/…" if more. Always names the top 2,
  // so an R16 slot fed by a DECIDED R32 reads as its two teams ("BRA 57%/JPN 43%").
  const floor = opts.floor ?? R32_REALISTIC_FLOOR;   // drop GD-swing longshots (~impossible)
  const cap = opts.cap ?? 2;
  const real = a.filter((c) => c.p >= floor);
  const list = real.length >= 2 ? real : a.slice(0, 2);
  const shown = list.slice(0, cap);
  let label = shown.map((c) => `${c.code} ${pct(c.p)}`).join('/');
  if (list.length > shown.length) label += '/…';
  return { label, structural: false };
}

/** Terse structural feeder code for a knockout side, e.g. "W82" / "L102". */
export function koStructuralCode(side) {
  if (side.type === 'winnerOf') return 'W' + side.match;
  if (side.type === 'loserOf') return 'L' + side.match;
  return '?';
}

/** Short code for a SINGLE feeder side: group slot (group-first "G1"/"B2"),
 *  a third ("?3"), or a deeper knockout feeder (terse "W82"/"L102"). */
function feederShortCode(side) {
  if (side.type === 'winner') return groupSlotCode(side.group, 1);
  if (side.type === 'runnerup') return groupSlotCode(side.group, 2);
  if (side.type === 'third') return '?3';
  return koStructuralCode(side);
}

/** Readable structural label for a knockout side (David prefers "G1/?3" over the
 *  terse "W82"): name the two things that can occupy it, taken from its feeder
 *  match's own two sides. One level deep — enough for R16 (fed by R32 group
 *  slots); deeper rounds almost always name a highlighted team instead, so they
 *  rarely fall through to this. Falls back to "Wxx"/"Lxx" if the feeder is absent. */
export function koStructuralLabel(side, matchByNo) {
  const feeder = matchByNo && matchByNo[side.match];
  if (!feeder) return koStructuralCode(side);
  return `${feederShortCode(feeder.home)}/${feederShortCode(feeder.away)}`;
}

// ----------------------------------------------------------------------------
// Recursive knockout candidate sets (deterministic).
// A knockout side references a feeder match by number. The set of teams that can
// occupy it = teams that can occupy EITHER side of that feeder match (winnerOf or
// loserOf both pull from the same two participants). Recurse to R32, where the
// base case is the group-slot alive set. An ACTUAL played feeder result collapses
// the set to the single winner/loser.
// ----------------------------------------------------------------------------

function buildKnockoutCandidateSets(bracket, r32AliveByMatch, koResults) {
  // matchNo -> { home:Set, away:Set } of deterministic candidate occupants.
  const sideSets = {};
  // R32 base: home/away alive sets straight from the group resolution.
  for (const m of bracket.rounds.R32) {
    sideSets[m.match] = {
      home: new Set(r32AliveByMatch[m.match].home),
      away: new Set(r32AliveByMatch[m.match].away),
    };
  }
  // All teams that can be IN a match (either side) = pool that can WIN or LOSE it.
  const poolOf = (matchNo) => {
    const r = koResults[matchNo];
    if (r) return { winner: new Set([r.winner]), loser: new Set([r.loser]), both: new Set([r.winner, r.loser]) };
    const s = sideSets[matchNo];
    const both = new Set([...(s ? s.home : []), ...(s ? s.away : [])]);
    return { winner: both, loser: both, both };
  };
  // Resolve later rounds in dependency order.
  for (const rd of ['R16', 'QF', 'SF', 'ThirdPlace', 'Final']) {
    for (const m of bracket.rounds[rd] || []) {
      const sideCandidates = (side) => {
        const pool = poolOf(side.match);
        return side.type === 'loserOf' ? pool.loser : pool.winner;
      };
      sideSets[m.match] = {
        home: new Set(sideCandidates(m.home)),
        away: new Set(sideCandidates(m.away)),
      };
    }
  }
  return sideSets;
}

// ----------------------------------------------------------------------------
// Public resolver
// ----------------------------------------------------------------------------

/**
 * Compute labels for every knockout match (R32 through the 3rd-place match AND the
 * Final) — all knockout rounds are treated identically (contender previews that
 * resolve as the feeders decide).
 *
 * @param {object} engineState
 *   engineState.groups   engine-schema groups (teams carry elo; matches carry played/goals)
 *   engineState.bracket  parsed bracket.json
 *   engineState.teams    [{code,name}] for full-name rendering
 *   engineState.koResults  optional { [matchNo]: {winner, loser} } for PLAYED KO matches
 *   engineState.resolveThirdPlaceSlots  Annex C resolver (injected; required for MC)
 *   engineState.rankThirdPlaceTeams     optional; enables deterministic 3rd-slot LOCK
 *   engineState.mc       optional precomputed monteCarlo() result (else built here)
 * @param {object} [opts]
 *   opts.watchedTeams  string[] FIFA codes for the over-cap breadcrumb (default [])
 *   opts.maxPreview    knockout candidate cap (default DEFAULT_MAX_PREVIEW)
 *   opts.mcN, opts.mcSeed, opts.koLambda, opts.hosts  MC overrides
 * @returns {Map<number, {home:string|null, away:string|null, full:string|null, round:string}>}
 */
export function computeMatchLabels(engineState, opts = {}) {
  const { groups, bracket, teams, resolveThirdPlaceSlots } = engineState;
  const koResults = engineState.koResults || {};
  const watchedSet = new Set(opts.watchedTeams || []);
  const maxPreview = opts.maxPreview ?? DEFAULT_MAX_PREVIEW;
  const dominantThreshold = opts.dominantThreshold ?? DOMINANT_THRESHOLD;
  // KO-slot label style: 'contenders' (default) mirrors the bracket — the real
  // contender pair with %. 'highlighted' restores the group-stage preview (iconic
  // teams + reach %, else structural). Toggle for next tournament's wide-open phase.
  const koLabelMode = opts.koLabelMode ?? 'contenders';

  const nameByCode = new Map((teams || []).map((t) => [t.code, t.name]));
  const fullName = (c) => nameByCode.get(c) || c;

  // Deterministic structures.
  const rankSets = groupRankSets(groups);
  const lockedThirds = lockedThirdSlots(
    groups, bracket, resolveThirdPlaceSlots, engineState.rankThirdPlaceTeams
  );

  // Monte-Carlo (ordering/dominance only).
  const mc = engineState.mc || monteCarlo(groups, bracket, {
    n: opts.mcN ?? DEFAULT_MC_N,
    seed: opts.mcSeed ?? DEFAULT_MC_SEED,
    hostCodes: new Set(opts.hosts || DEFAULT_HOSTS),
    koLambda: opts.koLambda ?? DEFAULT_KO_LAMBDA,
    topCandidates: 48,
    resolveThirdPlaceSlots,
  });
  const mcSlot = {}; // mNo -> { home:[{code,p}], away:[{code,p}] }
  for (const s of mc.perSlot) mcSlot[s.match] = { home: s.home || [], away: s.away || [] };
  const occOf = (mNo, sideName) => (mcSlot[mNo] && mcSlot[mNo][sideName]) || [];
  const highlightedSet = new Set(opts.highlighted || HIGHLIGHTED_TEAMS);
  const matchByNo = {};
  for (const rd of Object.values(bracket.rounds)) for (const mm of rd) matchByNo[mm.match] = mm;

  // R32 alive sets per match/side (for the recursive knockout candidate build).
  const r32AliveByMatch = {};
  const r32SideAlive = (side, matchNo) => {
    if (side.type === 'winner') return new Set(rankSets[side.group].r1);
    if (side.type === 'runnerup') return new Set(rankSets[side.group].r2);
    if (side.type === 'third') {
      if (lockedThirds.has(matchNo)) return new Set([lockedThirds.get(matchNo)]);
      return thirdSlotCandidates(side.from, rankSets);
    }
    return new Set();
  };
  for (const m of bracket.rounds.R32) {
    r32AliveByMatch[m.match] = {
      home: r32SideAlive(m.home, m.match),
      away: r32SideAlive(m.away, m.match),
    };
  }

  const koSideSets = buildKnockoutCandidateSets(bracket, r32AliveByMatch, koResults);

  // KNOCKOUT contender distribution — the SAME chained head-to-head the bracket page
  // renders (shared ko-slot-dist.mjs), so the calendar's KO %s are IDENTICAL to the
  // site's, not the Monte-Carlo occupancy (which differs by a few points). Leaves are
  // the LOCKED R32 occupants (deterministic, from r32AliveByMatch when a side is a
  // singleton); a played KO match collapses to its winner.
  const eloByCode = {};
  for (const t of (teams || [])) eloByCode[t.code] = t.elo;
  const koDist = makeKoSlotDist({
    bracket,
    eloByCode,
    koLambda: opts.koLambda ?? DEFAULT_KO_LAMBDA,
    hosts: new Set(opts.hosts || DEFAULT_HOSTS),
    koVenueCountry: engineState.koVenueCountry || {},
    r32Occupant: (matchNo, side) => {
      const al = r32AliveByMatch[matchNo];
      const s = al && al[side];
      return s && s.size === 1 ? [...s][0] : null;
    },
    koWinner: (matchNo) => (koResults[matchNo] ? koResults[matchNo].winner : null),
    koLoser: (matchNo) => (koResults[matchNo] ? koResults[matchNo].loser : null),
  });

  // Resolve every match.
  const out = new Map();
  const r32Matches = new Set(bracket.rounds.R32.map((m) => m.match));

  const resolveMatch = (m, round) => {
    let homeRes, awayRes, isKo = false;
    if (r32Matches.has(m.match)) {
      homeRes = renderR32Side(occOf(m.match, 'home'), r32SlotCode(m.home), fullName, { dominantThreshold });
      awayRes = renderR32Side(occOf(m.match, 'away'), r32SlotCode(m.away), fullName, { dominantThreshold });
    } else {
      isKo = true;
      homeRes = renderKoSide(koDist.slotDist(m.match, 'home'), koStructuralLabel(m.home, matchByNo), fullName, { mode: koLabelMode });
      awayRes = renderKoSide(koDist.slotDist(m.match, 'away'), koStructuralLabel(m.away, matchByNo), fullName, { mode: koLabelMode });
    }
    const home = homeRes.label;
    const away = awayRes.label;
    const suffix = ROUND_SUFFIX[round] ?? '';
    // 3rd-place (M103) and the Final (M104) are treated EXACTLY like any other
    // knockout match: previewed with their contender pairs as soon as the feeders
    // give anything, resolving to the two beaten SF teams (3rd) / SF winners (Final)
    // once the semifinals are played. (No special-casing — they auto-update on the
    // Sports calendar like every other KO game.)
    // A KNOCKOUT event stays "unchanged" only when NEITHER side names anything —
    // both are bare structural feeder codes. If even one side names a highlighted
    // team (or locks), emit the full label (the other side shows its feeder code).
    // R32 events always emit a label.
    const bothStructural = isKo && homeRes.structural && awayRes.structural;
    const full = bothStructural ? null : `${home} v ${away}${suffix}`;
    out.set(m.match, { home, away, full, round });
  };

  for (const m of bracket.rounds.R32) resolveMatch(m, 'R32');
  for (const m of bracket.rounds.R16 || []) resolveMatch(m, 'R16');
  for (const m of bracket.rounds.QF || []) resolveMatch(m, 'QF');
  for (const m of bracket.rounds.SF || []) resolveMatch(m, 'SF');
  for (const m of bracket.rounds.ThirdPlace || []) resolveMatch(m, 'ThirdPlace');
  for (const m of bracket.rounds.Final || []) resolveMatch(m, 'Final');

  return out;
}

/**
 * Resolve any PLAYED knockout matches from an openfootball-style raw feed into
 * { [matchNo]: {winner, loser, home, away, score, decider, pens} } records. Pure
 * (no fs). Unplayed KO matches (still slot placeholders) are skipped.
 *   score   = [home, away] after 90'/ET   decider = 'reg' | 'aet' | 'pens'
 *   pens    = [home, away] shootout (null unless decider==='pens')
 * (winner/loser kept for back-compat with existing callers.) The feed can't always
 * distinguish AET from regulation, so decider defaults 'reg' unless score.et is
 * present; the ESPN poller supplies the authoritative decider for the live path.
 */
export function knockoutResultsFromRaw(raw, teams) {
  const codeByName = new Map((teams || []).map((t) => [t.name, t.code]));
  const byMatch = {};
  for (const m of (raw && raw.matches) || []) {
    if (/^Group [A-L]$/.test(m.group || '')) continue;
    const num = m.num ?? m.match ?? null;
    if (num == null) continue;
    const ft = m.score && Array.isArray(m.score.ft) ? m.score.ft : null;
    if (!ft || ft.length !== 2) continue;
    const h = codeByName.get(m.team1);
    const a = codeByName.get(m.team2);
    if (!h || !a) continue; // still a placeholder, not real team names
    const p = m.score.p; // penalty shootout [home, away], if any
    const hasPens = Array.isArray(p) && p.length === 2 && p[0] !== p[1];
    let homeWins, decider, pens = null;
    if (ft[0] === ft[1]) {
      if (!hasPens) continue; // level with no shootout data yet -> not resolved
      homeWins = p[0] > p[1];
      decider = 'pens';
      pens = [p[0], p[1]];
    } else {
      homeWins = ft[0] > ft[1];
      decider = m.score.et ? 'aet' : 'reg';
    }
    byMatch[num] = {
      winner: homeWins ? h : a,
      loser: homeWins ? a : h,
      home: h, away: a,
      score: [ft[0], ft[1]],
      decider,
      pens,
    };
  }
  return byMatch;
}

/**
 * Normalize hand-/auto-entered knockout results (manual-ko-results.json) into the
 * shared KO-result shape, keyed by matchNo. Each input entry:
 *   { match, home, away, score:[h,a], decider?:'reg'|'aet'|'pens', pens?:[h,a] }
 * home/away are TEAM CODES; winner/loser are derived. A level score is only
 * resolved when a valid (unequal) shootout is supplied. Pure (no fs). Unlike the
 * feed, a manual entry CAN assert AET (`decider:'aet'`) — the ESPN poller and a
 * human both know when 90' didn't settle it, so the manual path is authoritative
 * on the decider until the (AET-blind) feed eventually supersedes it.
 */
export function knockoutResultsFromManual(entries = []) {
  const byMatch = {};
  for (const e of entries || []) {
    if (!e || e.match == null || !e.home || !e.away) continue;
    const ft = e.score;
    if (!Array.isArray(ft) || ft.length !== 2 || ft[0] == null || ft[1] == null) continue;
    const pens = Array.isArray(e.pens) && e.pens.length === 2 ? e.pens : null;
    let homeWins, decider;
    if (ft[0] === ft[1]) {
      if (!pens || pens[0] === pens[1]) continue; // level with no decisive shootout -> unresolved
      homeWins = pens[0] > pens[1];
      decider = 'pens';
    } else {
      homeWins = ft[0] > ft[1];
      decider = e.decider === 'aet' ? 'aet' : 'reg'; // a decided score can't be 'pens'
    }
    byMatch[e.match] = {
      winner: homeWins ? e.home : e.away,
      loser: homeWins ? e.away : e.home,
      home: e.home, away: e.away,
      score: [ft[0], ft[1]],
      decider,
      pens: decider === 'pens' ? [pens[0], pens[1]] : null,
    };
  }
  return byMatch;
}

/**
 * Merge knockout-result maps; LATER sources win per matchNo. Call order
 * mirrors the group-stage flow — manual/auto FIRST, the openfootball feed LAST —
 * so once the feed publishes a match it supersedes the near-real-time manual
 * entry (self-correcting a typo on the next refresh), exactly like the group path.
 */
export function mergeKnockoutResults(...sources) {
  const out = {};
  for (const src of sources) {
    for (const [k, v] of Object.entries(src || {})) out[k] = v;
  }
  return out;
}

/**
 * DETERMINISTIC knockout fixture resolution. Given the current groups + bracket +
 * any played knockout results, returns { [matchNo]: {home, away, round} } (team
 * CODES) for every knockout match whose BOTH sides are now FIXED. A match is
 * omitted while either side is still undetermined — so the result grows
 * monotonically as the tournament progresses.
 *
 *   - A group winner / runner-up is fixed only once that group is fully played.
 *   - A 3rd-place R32 slot is fixed only once ALL groups are fully played (the
 *     8-best set and the Annex C allocation are cross-group, so a single missing
 *     group result can flip who lands in any 3rd slot).
 *   - An R16+ side (winnerOf / loserOf) is fixed once its feeder match carries a
 *     result in `koResults`.
 *
 * Pure (no fs): caller injects resolveThirdPlaceSlots (Annex C), mirroring
 * computeMatchLabels. This is the inverse map the poller uses to turn an ESPN
 * KO event (a team pair) into one of our match numbers (73-104).
 */
export function resolveKnockoutFixtures(groups, bracket, koResults = {}, opts = {}) {
  const resolveThirds = opts.resolveThirdPlaceSlots;
  const letterOf = (name) => /Group\s+([A-L])/i.exec(name)?.[1]?.toUpperCase()
    ?? String(name).trim().slice(-1).toUpperCase();

  // 1) per-group winner / runner-up — only for COMPLETE groups
  const winnerOfGroup = {};
  const runnerUpOfGroup = {};
  let allGroupsComplete = (groups || []).length > 0;
  for (const g of groups || []) {
    const complete = g.matches.length > 0 && g.matches.every((m) => m.played);
    if (!complete) { allGroupsComplete = false; continue; }
    const standing = computeGroupStanding(g);
    const letter = letterOf(g.name);
    winnerOfGroup[letter] = standing[0]?.code;
    runnerUpOfGroup[letter] = standing[1]?.code;
  }

  // 2) 3rd-place R32 slots — only once EVERY group is complete (cross-group)
  const thirdCodeForMatch = {};
  if (allGroupsComplete && resolveThirds) {
    const thirdCodeByLetter = {};
    const qualifiedLetters = [];
    for (const t of rankThirdPlaceTeams(groups).filter((x) => x.qualifies)) {
      const letter = letterOf(t.group);
      thirdCodeByLetter[letter] = t.code;
      qualifiedLetters.push(letter);
    }
    for (const s of resolveThirds(qualifiedLetters, bracket)) {
      thirdCodeForMatch[s.match] = thirdCodeByLetter[s.group];
    }
  }

  const r32SlotCode = (side, matchNo) => {
    if (side.type === 'winner') return winnerOfGroup[side.group] || null;
    if (side.type === 'runnerup') return runnerUpOfGroup[side.group] || null;
    if (side.type === 'third') return thirdCodeForMatch[matchNo] || null;
    return null;
  };

  const r32Set = new Set(bracket.rounds.R32.map((m) => m.match));
  const sideCode = (side, matchNo, isR32) => {
    if (isR32) return r32SlotCode(side, matchNo);
    if (side.type === 'winnerOf') return koResults[side.match]?.winner || null;
    if (side.type === 'loserOf') return koResults[side.match]?.loser || null;
    return null;
  };

  // Round order so feeders resolve before the matches that depend on them.
  const out = {};
  const order = ['R32', 'R16', 'QF', 'SF', 'Final', 'ThirdPlace'];
  for (const round of order) {
    for (const m of bracket.rounds[round] || []) {
      const isR32 = r32Set.has(m.match);
      const home = sideCode(m.home, m.match, isR32);
      const away = sideCode(m.away, m.match, isR32);
      if (home && away) out[m.match] = { home, away, round };
    }
  }
  return out;
}
