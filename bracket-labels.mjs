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

import { computeGroupStanding, scenarioGrid } from './engine.js';
import { monteCarlo } from './model.js';
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
 * Render one KNOCKOUT slot: name ONLY highlighted teams (>= KO_SHOW_FLOOR), each
 * "CODE (NN%)" favorite-first, then "/…". A single occupant >= LOCKED_THRESHOLD is
 * the locked team (full name). If no highlighted team clears the floor, the side is
 * "structural" (its feeder code) and adds nothing new — a KO event with BOTH sides
 * structural stays unchanged.
 * @param {Array<{code:string,p:number}>} occ per-slot occupancy for this side
 * @returns {{label:string, structural:boolean}}
 */
export function renderKoSide(occ, structuralCode, fullName, opts = {}) {
  const highlighted = opts.highlighted || new Set(HIGHLIGHTED_TEAMS);
  const showFloor = opts.showFloor ?? KO_SHOW_FLOOR;
  const a = (occ || []).slice().sort((x, y) => y.p - x.p);
  if (a[0] && a[0].p >= LOCKED_THRESHOLD) return { label: fullName(a[0].code), structural: false };
  const hi = a.filter((c) => highlighted.has(c.code) && c.p >= showFloor);
  if (!hi.length) return { label: structuralCode, structural: true };
  return { label: hi.map((c) => `${c.code} (${pct(c.p)})`).join('/') + '/…', structural: false };
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
 * Compute labels for every knockout match (R32..3rd place; Final included in the
 * map but callers may ignore it).
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
      homeRes = renderKoSide(occOf(m.match, 'home'), koStructuralLabel(m.home, matchByNo), fullName, { highlighted: highlightedSet });
      awayRes = renderKoSide(occOf(m.match, 'away'), koStructuralLabel(m.away, matchByNo), fullName, { highlighted: highlightedSet });
    }
    const home = homeRes.label;
    const away = awayRes.label;
    const suffix = ROUND_SUFFIX[round] ?? '';
    // 3rd-place match: like the Final, NEVER previewed — fill only once BOTH
    // semifinals are played (then it shows the two SF losers). David's rule.
    if (round === 'ThirdPlace') {
      const sfDone = [m.home.match, m.away.match].every((fm) => koResults[fm]);
      out.set(m.match, { home, away, full: sfDone ? `${home} v ${away}${suffix}` : null, round });
      return;
    }
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

  return out;
}

/**
 * Resolve any PLAYED knockout matches from an openfootball-style raw feed into
 * { [matchNo]: {winner, loser} } team-code pairs. Helper for callers that have the
 * raw feed; pure (no fs). Unplayed KO matches (still slot placeholders) are skipped.
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
    if (ft[0] === ft[1]) {
      const p = m.score.p; // penalties
      if (Array.isArray(p) && p.length === 2 && p[0] !== p[1]) {
        const homeWins = p[0] > p[1];
        byMatch[num] = { winner: homeWins ? h : a, loser: homeWins ? a : h };
      }
      continue;
    }
    const homeWins = ft[0] > ft[1];
    byMatch[num] = { winner: homeWins ? h : a, loser: homeWins ? a : h };
  }
  return byMatch;
}
