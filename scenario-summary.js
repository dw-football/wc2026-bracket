// scenario-summary.js
// "Scenario logic simplifier": turn the raw scenario truth-table for a group's
// remaining match(es) into ESPN-style plain-English clinch / elimination /
// qualification statements.
//
// Pure ES module, browser-safe (imports only from engine.js).
//
// Public API:
//   summarizeGroup(group, opts?) -> {
//     teams: [ { code, name, status, headline, detail, maxRank, minRank } ... ],
//     deadRubbers: [ matchKey, ... ]
//   }
//
// status is one of:
//   'won-group'   rank == 1 in every scenario
//   'qualified'   rank in {1,2} always, not always 1 (top-2 clinched)
//   'best-3rd'    max achievable rank == 3 (never 1 or 2, sometimes 3)
//   'eliminated'  rank == 4 in every scenario
//   'conditional' everything else (rank still spans across qualifying lines)
//
// HONESTY LOCK: within-group rank (1/2/3/4) is deterministic and stated as
// fact. Whether a 3rd-place finish QUALIFIES, and any knockout opponent, are
// CROSS-GROUP and are NEVER asserted here.
//
// ---------------------------------------------------------------------------
// CORE IDEA — per-OUTCOME Boolean minimization
// ---------------------------------------------------------------------------
// There are 1 or 2 unplayed matches. Treat each as a ternary variable over
// {W,D,L} (HOME team's perspective). For a team T and a within-group rank r,
// the set of outcome-cells (a subset of the 3- or 9-cell grid) that produce
// rank r is a Boolean function. We compute the EXACT minimal cover of that set
// as a union of "subcubes" (per match: a subset of {W,D,L}, or "any"=dropped),
// minimizing the number of subcubes and then preferring subcubes that DROP a
// match. A dropped match disappears from the prose clause — that is the fix for
// the old per-team-only variable elimination, which still enumerated coupled
// groups.

import { computeGroupStanding } from './engine.js';

const MAX_GOALS = 6;
const COARSE = ['W', 'D', 'L'];

const matchKey = (m) => `${m.home}-${m.away}`;
const ordinal = (n) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

/**
 * Enumerate every scoreline combination for the unplayed matches, holding
 * played matches fixed. For each scenario record, per team, its within-group
 * rank, plus the coarse W/D/L (home perspective) and signed home margin for
 * each unplayed match.
 *
 * @returns {{ unplayed: Array, scenarios: Array<{coarse, margins, rankByCode}> }}
 */
function enumerateScenarios(group, maxGoals = MAX_GOALS) {
  const played = group.matches.filter((m) => m.played);
  const unplayed = group.matches.filter((m) => !m.played);
  const scenarios = [];

  const acc = new Array(unplayed.length);
  const recurse = (idx) => {
    if (idx === unplayed.length) {
      const synthetic = played.concat(
        unplayed.map((m, k) => ({
          home: m.home,
          away: m.away,
          homeGoals: acc[k][0],
          awayGoals: acc[k][1],
          played: true,
        }))
      );
      const standing = computeGroupStanding({ ...group, matches: synthetic });
      const rankByCode = {};
      for (const t of standing) rankByCode[t.code] = t.rank;
      const coarse = acc.map(([h, a]) => (h > a ? 'W' : h < a ? 'L' : 'D'));
      const margins = acc.map(([h, a]) => h - a);
      scenarios.push({ coarse, margins, rankByCode });
      return;
    }
    for (let h = 0; h <= maxGoals; h++) {
      for (let a = 0; a <= maxGoals; a++) {
        acc[idx] = [h, a];
        recurse(idx + 1);
      }
    }
  };
  recurse(0);

  return { unplayed, scenarios };
}

// ---------------------------------------------------------------------------
// Variable elimination (per-team relevance — coarse first cut)
// ---------------------------------------------------------------------------

/**
 * Determine which unplayed matches actually affect this team's rank.
 *
 * A match j is RELEVANT to team T if, fixing every other match's full scoreline,
 * varying match j changes T's rank for some fixing. Tested exactly against the
 * enumerated scenarios.
 *
 * @returns {number[]} indices of relevant matches (sorted)
 */
function relevantMatchIndices(code, unplayed, scenarios) {
  const relevant = [];
  for (let j = 0; j < unplayed.length; j++) {
    const groups = new Map(); // key = margins of all matches != j -> Set<rank>
    for (const s of scenarios) {
      const otherKey = s.margins.filter((_, k) => k !== j).join(',');
      if (!groups.has(otherKey)) groups.set(otherKey, new Set());
      groups.get(otherKey).add(s.rankByCode[code]);
    }
    let affects = false;
    for (const set of groups.values()) {
      if (set.size > 1) {
        affects = true;
        break;
      }
    }
    if (affects) relevant.push(j);
  }
  return relevant;
}

// ---------------------------------------------------------------------------
// Coarse cell table for a team over its RELEVANT matches
// ---------------------------------------------------------------------------

/**
 * Build the coarse-outcome cell table for `code` over the `relevant` matches.
 * Each cell is keyed by the tuple of coarse home-outcomes and records:
 *   coarse: string[]  (one of 'W'|'D'|'L' per relevant match, home perspective)
 *   rankSet: Set<number>
 *   byMargin: Map<marginSignature, Set<rank>>   (subject-perspective margins)
 *
 * marginMatters is true iff some coarse cell spans >1 rank (a goal margin flips
 * the result within fixed W/D/L outcomes).
 */
function buildRelevantCells(code, unplayed, scenarios, relevant) {
  const cells = new Map();
  for (const s of scenarios) {
    const coarse = relevant.map((j) => s.coarse[j]);
    const key = coarse.join('|');
    if (!cells.has(key)) cells.set(key, { coarse, rankSet: new Set(), byMargin: new Map() });
    const cell = cells.get(key);
    cell.rankSet.add(s.rankByCode[code]);
    const marg = relevant
      .map((j) => {
        const m = unplayed[j];
        const hm = s.margins[j];
        return m.away === code ? -hm : hm;
      })
      .join(',');
    if (!cell.byMargin.has(marg)) cell.byMargin.set(marg, new Set());
    cell.byMargin.get(marg).add(s.rankByCode[code]);
  }
  let marginMatters = false;
  for (const cell of cells.values()) if (cell.rankSet.size > 1) marginMatters = true;
  return { cells, marginMatters };
}

// ===========================================================================
// MINIMAL COVER  (the core fix)
// ===========================================================================
//
// A "subcube" over N (=1 or 2) ternary match variables is an array of N sets,
// each a non-empty subset of {W,D,L}. The subcube covers a coarse cell iff each
// of the cell's coarse outcomes is in the corresponding set. A subcube where a
// match's set is the full {W,D,L} effectively DROPS that match from the clause.
//
// minimalCover(targetCells, otherCells, numMatches):
//   targetCells : Array<string[]>  coarse tuples that MUST be covered
//   otherCells  : Set<string>      "off" cells that must NOT be covered
//                  (cells reachable but belonging to a different rank)
//   Returns the minimum-cardinality set of valid subcubes whose union is
//   exactly targetCells, with a tie-break preferring (a) more dropped matches,
//   then (b) larger 2-of-3 sets over singletons. Exact brute force (search
//   space is tiny: 7^numMatches candidate subcubes).
//
// Validity: a subcube is valid iff it covers no off-cell. We only ever pass
// off-cells that are reachable; unreachable grid cells (e.g. impossible
// combos — none here, every W/D/L combo is reachable) are treated as "don't
// care" by simply not appearing in either set.

/** All 7 non-empty subsets of {W,D,L}, as arrays, richest-to-leanest order. */
const SUBSETS = (() => {
  const out = [];
  for (let mask = 1; mask < 8; mask++) {
    const s = [];
    if (mask & 1) s.push('W');
    if (mask & 2) s.push('D');
    if (mask & 4) s.push('L');
    out.push(s);
  }
  // sort so the FULL set (size 3 = "any") comes first, then size 2, then size 1
  out.sort((a, b) => b.length - a.length);
  return out;
})();

/** Cartesian product of per-match subset choices -> all candidate subcubes. */
function allSubcubes(numMatches) {
  let acc = [[]];
  for (let i = 0; i < numMatches; i++) {
    const next = [];
    for (const partial of acc) for (const s of SUBSETS) next.push(partial.concat([s]));
    acc = next;
  }
  return acc;
}

/** Does subcube cover coarse cell (array of 'W'|'D'|'L')? */
function subcubeCovers(subcube, coarse) {
  for (let i = 0; i < subcube.length; i++) if (!subcube[i].includes(coarse[i])) return false;
  return true;
}

/** Cost tuple for a subcube: fewer dropped matches is WORSE in count terms but
 *  preferred at equal cover size. We score: primary = #non-dropped matches
 *  (lower better), secondary = total literals = sum of (3 - setSize) (lower
 *  better, i.e. larger sets preferred). */
function subcubeCost(subcube) {
  let nonDropped = 0;
  let literals = 0;
  for (const s of subcube) {
    if (s.length < 3) {
      nonDropped++;
      literals += 3 - s.length; // size2 -> 1, size1 -> 2
    }
  }
  return nonDropped * 10 + literals;
}

/**
 * Exact minimal cover. Returns Array<subcube>.
 */
function minimalCover(targetCells, otherCells, numMatches) {
  const targetKeys = new Set(targetCells.map((c) => c.join('|')));
  if (targetKeys.size === 0) return [];

  // Candidate VALID subcubes: cover >=1 target cell, no off cell.
  const candidates = [];
  for (const sub of allSubcubes(numMatches)) {
    // enumerate cells this subcube covers
    let coversOff = false;
    const covered = new Set();
    // build the cells of this subcube
    const dims = sub.map((s) => s);
    const stack = [[]];
    while (stack.length) {
      const partial = stack.pop();
      if (partial.length === numMatches) {
        const key = partial.join('|');
        if (otherCells.has(key)) {
          coversOff = true;
          break;
        }
        if (targetKeys.has(key)) covered.add(key);
        continue;
      }
      for (const v of dims[partial.length]) stack.push(partial.concat([v]));
    }
    if (coversOff) continue;
    if (covered.size === 0) continue;
    candidates.push({ sub, covered, cost: subcubeCost(sub) });
  }

  // Minimum set cover by exact search (branch & bound on # of subcubes), with
  // cost tie-break. Search space is tiny (<= a few dozen candidates).
  let best = null;
  const targetArr = [...targetKeys];

  const search = (remaining, chosen, totalCost) => {
    if (remaining.size === 0) {
      if (
        !best ||
        chosen.length < best.chosen.length ||
        (chosen.length === best.chosen.length && totalCost < best.totalCost)
      ) {
        best = { chosen: chosen.slice(), totalCost };
      }
      return;
    }
    if (best && chosen.length >= best.chosen.length) {
      // can't beat on count; allow equal-count only if it could improve cost.
      if (chosen.length > best.chosen.length) return;
      if (chosen.length === best.chosen.length) return; // adding more can't reduce count
    }
    // pick an uncovered cell with the fewest covering candidates (MRV)
    let pivot = null;
    let pivotCands = null;
    for (const cell of remaining) {
      const cands = candidates.filter((c) => c.covered.has(cell));
      if (pivotCands === null || cands.length < pivotCands.length) {
        pivot = cell;
        pivotCands = cands;
        if (cands.length <= 1) break;
      }
    }
    if (!pivotCands || pivotCands.length === 0) return; // uncoverable
    // try each candidate covering the pivot
    for (const cand of pivotCands) {
      const nextRemaining = new Set(remaining);
      for (const k of cand.covered) nextRemaining.delete(k);
      search(nextRemaining, chosen.concat([cand]), totalCost + cand.cost);
    }
  };
  search(new Set(targetArr), [], 0);

  return best ? best.chosen.map((c) => c.sub) : [];
}

// ---------------------------------------------------------------------------
// Phrasing helpers
// ---------------------------------------------------------------------------

/** Convert a coarse home-outcome to the subject team's perspective. */
function fromSubjectPerspective(coarse, match, code) {
  if (match.home === code) return coarse;
  if (match.away === code) return coarse === 'W' ? 'L' : coarse === 'L' ? 'W' : 'D';
  return coarse;
}

/**
 * Render the SUBJECT team's own match (a subset of {W,D,L} in subject
 * perspective) into a verb phrase naming the opponent.
 *   {W}    -> "a win over Paraguay"
 *   {D}    -> "a draw with Paraguay"
 *   {L}    -> "a loss to Paraguay"
 *   {W,D}  -> "a win or draw vs Paraguay"   (avoid defeat)
 *   {D,L}  -> "a draw or loss vs Paraguay"  (fail to win)
 *   {W,L}  -> "a win or loss vs Paraguay"   (rare)
 *   full   -> "" (dropped; caller omits)
 */
function ownMatchPhrase(set, opp) {
  const has = (x) => set.has(x);
  if (set.size === 3) return '';
  if (set.size === 1) {
    if (has('W')) return `a win over ${opp}`;
    if (has('D')) return `a draw with ${opp}`;
    return `a loss to ${opp}`;
  }
  if (has('W') && has('D')) return `a win or draw vs ${opp}`;
  if (has('D') && has('L')) return `a draw or loss vs ${opp}`;
  return `a win or loss vs ${opp}`;
}

/**
 * Render an OTHER match (subject not playing) as an EVENT phrase, given a subset
 * of coarse home-outcomes.
 *   {W}        -> "Czech Republic beat Mexico"
 *   {L}        -> "Mexico beat Czech Republic"
 *   {D}        -> "Czech Republic and Mexico draw"
 *   {W,D} (!L) -> "Czech Republic avoid defeat"      (home not beaten)
 *   {D,L} (!W) -> "Mexico avoid defeat"               (away not beaten)
 *   {W,L} (!D) -> "Czech Republic or Mexico win"      (no draw)
 *   full       -> "" (dropped)
 */
function otherMatchPhrase(set, match, nameOf) {
  const home = nameOf(match.home);
  const away = nameOf(match.away);
  if (set.size === 3) return '';
  if (set.size === 1) {
    const c = [...set][0];
    if (c === 'W') return `${home} beat ${away}`;
    if (c === 'L') return `${away} beat ${home}`;
    return `${home} and ${away} draw`;
  }
  // size 2 -> express as the natural negation of the excluded outcome.
  if (!set.has('L')) return `${home} avoid defeat`; // {W,D}
  if (!set.has('W')) return `${away} avoid defeat`; // {D,L}
  return `${home} or ${away} win`; // {W,L}, no draw
}

/**
 * Render ONE subcube (over the relevant matches) into a condition phrase from
 * the subject team's point of view. Matches set to "any" are dropped. Multiple
 * surviving conditions are joined with "and". Returns '' if the subcube drops
 * every match (i.e. the rank is unconditional given the branch).
 */
function renderSubcube(subcube, code, unplayed, relevant, nameOf) {
  const parts = [];
  for (let i = 0; i < relevant.length; i++) {
    const m = unplayed[relevant[i]];
    const homeSet = new Set(subcube[i]);
    if (homeSet.size === 3) continue; // dropped
    const subjectPlays = m.home === code || m.away === code;
    if (subjectPlays) {
      const subjSet = new Set([...homeSet].map((c) => fromSubjectPerspective(c, m, code)));
      const opp = nameOf(m.home === code ? m.away : m.home);
      parts.push(ownMatchPhrase(subjSet, opp));
    } else {
      parts.push(otherMatchPhrase(homeSet, m, nameOf));
    }
  }
  return parts.filter(Boolean).join(' and ');
}

/** Join the subcube clauses for a single rank with "or". When more than one
 *  clause survives and any clause itself contains "and", parenthesize the
 *  multi-condition clauses so the top-level "or" can't be misread. */
function renderRankCover(subcubes, code, unplayed, relevant, nameOf) {
  const phrases = subcubes
    .map((sc) => renderSubcube(sc, code, unplayed, relevant, nameOf))
    .filter((p) => p !== '');
  // De-dup.
  const seen = new Set();
  const uniq = [];
  for (const p of phrases) {
    if (!seen.has(p)) {
      seen.add(p);
      uniq.push(p);
    }
  }
  if (uniq.length <= 1) return uniq.join(' or ');
  return uniq.map((p) => (p.includes(' and ') ? `(${p})` : p)).join(' or ');
}

// ---------------------------------------------------------------------------
// Per-rank cover construction (coarse, margin-free)
// ---------------------------------------------------------------------------

/**
 * For a team whose rank is decided purely by coarse outcomes (no margin flips),
 * compute the minimal subcube cover for EACH achievable rank.
 *
 * @returns Map<rank, subcube[]>
 */
function coverByRank(cells, ranks, numMatches) {
  // rank -> array of coarse tuples
  const cellsByRank = new Map();
  const allKeys = new Set();
  for (const cell of cells.values()) {
    const r = [...cell.rankSet][0]; // margin-free => singleton
    allKeys.add(cell.coarse.join('|'));
    if (!cellsByRank.has(r)) cellsByRank.set(r, []);
    cellsByRank.get(r).push(cell.coarse);
  }
  const result = new Map();
  for (const r of ranks) {
    const target = cellsByRank.get(r) || [];
    if (target.length === 0) continue;
    const off = new Set([...allKeys].filter((k) => !target.some((t) => t.join('|') === k)));
    result.set(r, minimalCover(target, off, numMatches));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Detail builder — REFRAMED prose (best outcome first, then downside)
// ---------------------------------------------------------------------------

/**
 * Build a plain-English detail string for a conditional / best-3rd team whose
 * rank depends on `relevant` matches. Leads with the best reachable rank and
 * its simplest controllable condition, then states the downside; appends the
 * deeper fall only when an extra match-result triggers it.
 *
 * Aim: one, at most two sentences. Falls back to a compact margin note rather
 * than a long enumeration if minimization can't shorten things.
 */
function describeConditional(code, name, unplayed, scenarios, relevant, nameOf) {
  const ranks = [...new Set(scenarios.map((s) => s.rankByCode[code]))].sort((a, b) => a - b);
  const { cells, marginMatters } = buildRelevantCells(code, unplayed, scenarios, relevant);
  const numMatches = relevant.length;

  const ownIdx = relevant.findIndex(
    (j) => unplayed[j].home === code || unplayed[j].away === code
  );

  // Margin-free and the subject plays one of the relevant matches: organize the
  // statement around the subject's OWN (controllable) result. This is where the
  // per-outcome minimization pays off — the OTHER match is dropped from any
  // own-result slice in which it doesn't change the rank.
  if (!marginMatters && ownIdx >= 0) {
    return describeByOwnResult(code, ranks, cells, unplayed, relevant, ownIdx, nameOf);
  }

  // Margin-free, subject doesn't play (rank driven entirely by other matches):
  // per-rank minimal cover, best rank first.
  if (!marginMatters) {
    const covers = coverByRank(cells, ranks, numMatches);
    return describeByRankCover(code, ranks, covers, unplayed, relevant, nameOf);
  }

  // Margin matters. Single match the subject plays -> concrete thresholds.
  if (numMatches === 1) {
    return describeSingleWithMargin(code, unplayed[relevant[0]], cells, ranks, nameOf);
  }
  return describeWithMarginFallback(code, ranks, cells, unplayed, relevant, nameOf);
}

// ---------------------------------------------------------------------------
// Own-result-centric renderer (margin-free, subject plays a relevant match)
// ---------------------------------------------------------------------------

/**
 * Subject-perspective verb noun phrase for a coarse outcome set, capitalized for
 * sentence-initial use when `cap` is true.
 *   {W} -> "a win" / "A win"; {W,D} -> "a win or draw"; etc.
 */
function ownResultWord(subjSet, capitalize = false) {
  let w;
  if (subjSet.size === 1) {
    const c = [...subjSet][0];
    w = c === 'W' ? 'a win' : c === 'D' ? 'a draw' : 'a loss';
  } else if (subjSet.has('W') && subjSet.has('D')) w = 'a win or draw';
  else if (subjSet.has('D') && subjSet.has('L')) w = 'a draw or loss';
  else if (subjSet.has('W') && subjSet.has('L')) w = 'a win or loss';
  else w = 'any result';
  return capitalize ? w.charAt(0).toUpperCase() + w.slice(1) : w;
}

/**
 * Build the per-own-result slices. For each subject result present (W/D/L), the
 * "other" matches partition the slice into ranks. We collapse each slice to:
 *   { subjSet, primaryRank, exceptions: [{rank, otherPhrases}] }
 * where primaryRank is the slice's DOMINANT rank (no condition needed) and
 * exceptions are the minority ranks gated by an other-match condition. Slices
 * that share an identical (primaryRank, no-exception) shape and the same subjSet
 * neighbourhood are merged by the caller via subjSet union.
 */
function sliceByOwnResult(code, cells, unplayed, relevant, ownIdx, nameOf) {
  const otherIdx = relevant.map((_, i) => i).filter((i) => i !== ownIdx);
  const ownMatch = unplayed[relevant[ownIdx]];

  // own coarse (home perspective) -> { other coarse tuple -> rank }
  const byOwn = new Map();
  for (const cell of cells.values()) {
    const ownC = cell.coarse[ownIdx];
    if (!byOwn.has(ownC)) byOwn.set(ownC, []);
    byOwn.get(ownC).push({ other: otherIdx.map((i) => cell.coarse[i]), rank: [...cell.rankSet][0] });
  }

  const slices = [];
  for (const [ownC, entries] of byOwn) {
    const subjC = fromSubjectPerspective(ownC, ownMatch, code);
    const rankCount = new Map();
    for (const e of entries) rankCount.set(e.rank, (rankCount.get(e.rank) || 0) + 1);
    const ranksHere = [...rankCount.keys()].sort((a, b) => a - b);

    if (ranksHere.length === 1) {
      slices.push({ subjC, primaryRank: ranksHere[0], exceptions: [] });
      continue;
    }
    // dominant rank = most cells (ties -> the better/lower rank, which is more
    // newsworthy as the default). Minorities become conditioned exceptions.
    let dominant = ranksHere[0];
    let dom = -1;
    for (const r of ranksHere) {
      const c = rankCount.get(r);
      if (c > dom || (c === dom && r < dominant)) {
        dom = c;
        dominant = r;
      }
    }
    const exceptions = [];
    for (const r of ranksHere) {
      if (r === dominant) continue;
      // minimal cover of this minority rank within the slice (other matches only)
      const target = entries.filter((e) => e.rank === r).map((e) => e.other);
      const off = new Set(
        entries.filter((e) => e.rank !== r).map((e) => e.other.join('|'))
      );
      const cover = minimalCover(target, off, otherIdx.length);
      const phrases = cover
        .map((sc) =>
          otherIdx
            .map((i, k) => otherMatchPhrase(new Set(sc[k]), unplayed[relevant[i]], nameOf))
            .filter(Boolean)
            .join(' and ')
        )
        .filter((p) => p !== '');
      exceptions.push({ rank: r, otherPhrases: phrases });
    }
    slices.push({ subjC, primaryRank: dominant, exceptions });
  }
  return { slices, ownMatch };
}

/**
 * Render the own-result slices into one or two sentences, leading with the best
 * reachable rank and ending with the worst.
 */
function describeByOwnResult(code, ranks, cells, unplayed, relevant, ownIdx, nameOf) {
  const { slices, ownMatch } = sliceByOwnResult(code, cells, unplayed, relevant, ownIdx, nameOf);
  const opp = nameOf(ownMatch.home === code ? ownMatch.away : ownMatch.home);

  // Merge slices that have the SAME primaryRank and NO exceptions — their own
  // results combine ("a win or draw" instead of two clauses).
  const merged = [];
  const plain = new Map(); // primaryRank -> Set of subjC (only for exception-free slices)
  for (const sl of slices) {
    if (sl.exceptions.length === 0) {
      if (!plain.has(sl.primaryRank)) plain.set(sl.primaryRank, new Set());
      plain.get(sl.primaryRank).add(sl.subjC);
    } else {
      merged.push(sl);
    }
  }
  for (const [rank, subjCs] of plain) {
    merged.push({ subjSet: subjCs, primaryRank: rank, exceptions: [] });
  }

  // Build a clause per slice; sort best-rank-first by the slice's BEST attainable
  // rank (primary or any exception).
  const sliceBest = (sl) =>
    Math.min(sl.primaryRank, ...sl.exceptions.map((e) => e.rank));
  const sliceWorst = (sl) =>
    Math.max(sl.primaryRank, ...sl.exceptions.map((e) => e.rank));
  merged.sort((a, b) => sliceBest(a) - sliceBest(b) || sliceWorst(a) - sliceWorst(b));

  const subjSetOf = (sl) => sl.subjSet || new Set([sl.subjC]);

  const clauses = merged.map((sl, idx) => {
    const subjSet = subjSetOf(sl);
    const word = ownResultWord(subjSet, idx > 0); // capitalize follow-on clauses
    if (sl.exceptions.length === 0) {
      // "2nd with a win or draw vs South Africa" / for a downside: phrased as the
      // own result leading.
      if (idx === 0) return `${ordinal(sl.primaryRank)} with ${ownResultWordPhrase(subjSet, opp)}`;
      // follow-on: "A loss drops them to 3rd"
      return `${word} drops them to ${ordinal(sl.primaryRank)}`;
    }
    // primary + exceptions:
    //   lead:      "1st with a win over Brazil — or 2nd if Morocco beat Haiti"
    //   follow-on: "a loss is 3rd — or 4th if Czech Republic beat Mexico"
    let s;
    if (idx === 0) {
      s = `${ordinal(sl.primaryRank)} with ${ownResultWordPhrase(subjSet, opp)}`;
    } else {
      s = `${word} drops them to ${ordinal(sl.primaryRank)}`;
    }
    for (const ex of sl.exceptions) {
      const cond = ex.otherPhrases.join(' or ');
      s += ` — or ${ordinal(ex.rank)} if ${cond}`;
    }
    return s;
  });

  return clauses.join('; ') + '.';
}

/** "a win or draw vs South Africa" — own result set with opponent attached. */
function ownResultWordPhrase(subjSet, opp) {
  return ownMatchPhrase(subjSet, opp) || 'any result';
}

/**
 * Subject does NOT play any relevant match — rank is driven entirely by other
 * teams' matches. Render best rank first via the per-rank minimal cover.
 */
function describeByRankCover(code, ranks, covers, unplayed, relevant, nameOf) {
  const parts = [];
  for (const r of ranks) {
    const p = renderRankCover(covers.get(r) || [], code, unplayed, relevant, nameOf);
    parts.push(p === '' ? `${ordinal(r)} otherwise` : `${ordinal(r)} if ${p}`);
  }
  return parts.join('; ') + '.';
}

// ---------------------------------------------------------------------------
// Margin-threshold rendering (single match the subject plays)
// ---------------------------------------------------------------------------

/**
 * Single relevant match where goal margin changes the rank. Express coarse
 * outcomes first, then add margin thresholds inside the cell that needs them.
 * Concrete thresholds ("if they win by 2+") replace any vague language.
 */
function describeSingleWithMargin(code, match, cells, ranks, nameOf) {
  const subjectPlays = match.home === code || match.away === code;
  const opp = nameOf(match.home === code ? match.away : match.home);
  const order = { W: 0, D: 1, L: 2 };
  const sorted = [...cells.values()].sort((a, b) => order[a.coarse[0]] - order[b.coarse[0]]);
  const clauses = [];
  for (const cell of sorted) {
    const homeCoarse = cell.coarse[0];
    const subjCoarse = subjectPlays ? fromSubjectPerspective(homeCoarse, match, code) : homeCoarse;
    if (cell.rankSet.size === 1) {
      const r = [...cell.rankSet][0];
      if (subjectPlays) {
        clauses.push(`${ordinal(r)} with ${ownMatchPhrase(new Set([subjCoarse]), opp)}`);
      } else {
        clauses.push(`${ordinal(r)} if ${otherMatchPhrase(new Set([homeCoarse]), match, nameOf)}`);
      }
      continue;
    }
    // margin splits this coarse cell -> describe by margin band (subject persp.)
    const byMargin = [...cell.byMargin.entries()]
      .map(([mk, set]) => ({ margin: Number(mk), rank: [...set][0] }))
      .sort((a, b) => a.margin - b.margin);
    const bands = [];
    for (const e of byMargin) {
      const last = bands[bands.length - 1];
      if (last && last.rank === e.rank && e.margin === last.hi + 1) last.hi = e.margin;
      else bands.push({ lo: e.margin, hi: e.margin, rank: e.rank });
    }
    const verb = subjectPlays
      ? subjCoarse === 'W'
        ? 'win'
        : subjCoarse === 'L'
          ? 'lose'
          : 'draw'
      : homeCoarse === 'W'
        ? 'win'
        : 'lose';
    for (const b of bands) {
      const loMag = Math.abs(b.lo);
      const hiMag = Math.abs(b.hi);
      const lo = Math.min(loMag, hiMag);
      const hi = Math.max(loMag, hiMag);
      let cond;
      if (lo === hi) cond = `${verb} by ${lo}`;
      else if (hi >= MAX_GOALS) cond = `${verb} by ${lo}+`;
      else cond = `${verb} by ${lo}-${hi}`;
      const subj = subjectPlays ? 'they' : nameOf(match.home);
      clauses.push(`${ordinal(b.rank)} if ${subj} ${cond}`);
    }
  }
  return clauses.join('; ') + '.';
}

/**
 * Two relevant matches where a goal margin flips the rank inside some coarse
 * cell — the genuinely hard case. Full enumeration is unreadable, so we state
 * the best CLEANLY-GUARANTEED outcome tightly, then collapse the rest into a
 * single compact "...otherwise Nth/Mth on goal difference" tail. Honest and
 * short; never an over-claim and never a 2-D margin grid.
 */
function describeWithMarginFallback(code, ranks, cells, unplayed, relevant, nameOf) {
  const numMatches = relevant.length;

  // Cells where each rank is the SOLE (coarse-guaranteed) outcome.
  const cleanByRank = new Map();
  for (const cell of cells.values()) {
    if (cell.rankSet.size === 1) {
      const r = [...cell.rankSet][0];
      if (!cleanByRank.has(r)) cleanByRank.set(r, []);
      cleanByRank.get(r).push(cell.coarse);
    }
  }

  // Tight cover of a rank's guaranteed cells: every other cell is off.
  const renderGuaranteed = (tuples) => {
    if (!tuples || tuples.length === 0) return '';
    const keep = new Set(tuples.map((t) => t.join('|')));
    const off = new Set();
    for (const cell of cells.values()) {
      const k = cell.coarse.join('|');
      if (!keep.has(k)) off.add(k);
    }
    return renderRankCover(minimalCover(tuples, off, numMatches), code, unplayed, relevant, nameOf);
  };

  // Render each rank in rank order (best first): a tight clean clause where the
  // rank is guaranteed, or a compact goal-difference note where it is only ever
  // margin-decided.
  const clauses = [];
  const marginOnly = [];
  for (const r of ranks) {
    const g = renderGuaranteed(cleanByRank.get(r));
    if (g !== '') clauses.push({ rank: r, text: `${ordinal(r)} with ${g}` });
    else marginOnly.push(r);
  }

  if (clauses.length === 0) {
    // Nothing cleanly guaranteed -> entirely a goal-difference matter.
    return `${ranks.map(ordinal).join('/')} depending on goal difference.`;
  }

  // Insert margin-only ranks at their rank position with a GD note.
  for (const r of marginOnly) {
    clauses.push({ rank: r, text: `${ordinal(r)} on goal difference` });
  }
  clauses.sort((a, b) => a.rank - b.rank);
  return clauses.map((c) => c.text).join('; ') + '.';
}

// ---------------------------------------------------------------------------
// "Wins the group" detail (1st still reachable for a clinched top-2 team)
// ---------------------------------------------------------------------------

/**
 * Build the detail line for a team that has clinched top-2 but can still win the
 * group: lead with the path to 1st, then note the simplest way 1st slips to 2nd.
 */
function detailForTop(code, name, unplayed, scenarios, relevant, nameOf) {
  const { cells, marginMatters } = buildRelevantCells(code, unplayed, scenarios, relevant);
  const ranks = [...new Set(scenarios.map((s) => s.rankByCode[code]))].sort((a, b) => a - b);
  const numMatches = relevant.length;

  if (!ranks.includes(1)) return null;

  if (!marginMatters) {
    const covers = coverByRank(cells, ranks, numMatches);
    const firstPhrase = renderRankCover(covers.get(1) || [], code, unplayed, relevant, nameOf);
    let lead = firstPhrase === '' ? 'Wins the group' : `Wins the group with ${firstPhrase}`;

    // If 2nd is the only other rank, phrase the slip succinctly.
    if (ranks.length === 1) return lead + '.';

    const ownIdx = relevant.findIndex(
      (j) => unplayed[j].home === code || unplayed[j].away === code
    );
    // The path to 2nd.
    const secondSubs = covers.get(2) || [];
    const secondPhrase = renderRankCover(secondSubs, code, unplayed, relevant, nameOf);

    if (ownIdx >= 0) {
      // Try clean own-result framing for the slip to 2nd.
      const ownMatch = unplayed[relevant[ownIdx]];
      const opp = nameOf(ownMatch.home === code ? ownMatch.away : ownMatch.home);
      // own subset & other condition for rank 2
      const ownHomeSet = new Set();
      const otherPhrases = new Set();
      let clean = secondSubs.length > 0;
      for (const sc of secondSubs) {
        for (const v of sc[ownIdx]) ownHomeSet.add(v);
        if (new Set(sc[ownIdx]).size === 3) clean = false;
        for (let i = 0; i < relevant.length; i++) {
          if (i === ownIdx) continue;
          const ph = otherMatchPhrase(new Set(sc[i]), unplayed[relevant[i]], nameOf);
          if (ph) otherPhrases.add(ph);
        }
      }
      if (clean) {
        const subjSet = new Set(
          [...ownHomeSet].map((c) => fromSubjectPerspective(c, ownMatch, code))
        );
        const ownP = ownMatchPhrase(subjSet, opp);
        if (otherPhrases.size === 0) {
          return `${lead}; ${cap(ownP)} sees them finish 2nd.`;
        }
        if (otherPhrases.size === 1) {
          // e.g. "a draw still tops the group unless Sweden beat Japan"
          return `${lead}; otherwise 2nd if ${[...otherPhrases][0]}.`;
        }
      }
    }
    // Generic.
    return `${lead}; 2nd${secondPhrase ? ` if ${secondPhrase}` : ' otherwise'}.`;
  }

  // Margin case: fall back to single-match margin renderer's 1st clause, or a
  // compact statement.
  if (numMatches === 1 && (unplayed[relevant[0]].home === code || unplayed[relevant[0]].away === code)) {
    return describeSingleWithMargin(code, unplayed[relevant[0]], cells, ranks, nameOf);
  }
  return `Wins the group if results elsewhere fall their way (and on goal difference).`;
}

/** Capitalize the first letter of a phrase. */
function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// ---------------------------------------------------------------------------
// Dead-rubber detection
// ---------------------------------------------------------------------------

/**
 * A match is a dead rubber if its result cannot change ANY team's within-group
 * rank. Match j is dead iff it is irrelevant to every team.
 */
function deadRubbers(group, unplayed, scenarios) {
  const dead = [];
  for (let j = 0; j < unplayed.length; j++) {
    let mattersToSomeone = false;
    for (const team of group.teams) {
      const rel = relevantMatchIndices(team.code, unplayed, scenarios);
      if (rel.includes(j)) {
        mattersToSomeone = true;
        break;
      }
    }
    if (!mattersToSomeone) dead.push(matchKey(unplayed[j]));
  }
  return dead;
}

// ---------------------------------------------------------------------------
// Headline accuracy
// ---------------------------------------------------------------------------

/**
 * "Fate in its own hands" / "controls its own destiny" is only warranted when
 * the team's OWN result alone determines whether it finishes top-2: there is an
 * own-result that GUARANTEES top-2 regardless of the other match(es). Otherwise
 * use a neutral headline.
 */
function controlsTop2(code, unplayed, scenarios, relevant) {
  const ownIdx = relevant.find(
    (j) => unplayed[j].home === code || unplayed[j].away === code
  );
  if (ownIdx === undefined) return false;
  const ownMatch = unplayed[ownIdx];
  // Group scenarios by the subject's own coarse result; check if some own result
  // yields top-2 (rank<=2) in EVERY scenario with that result.
  const byOwn = new Map(); // 'W'|'D'|'L' -> Set<rank>
  for (const s of scenarios) {
    const own = fromSubjectPerspective(s.coarse[ownIdx], ownMatch, code);
    if (!byOwn.has(own)) byOwn.set(own, new Set());
    byOwn.get(own).add(s.rankByCode[code]);
  }
  for (const set of byOwn.values()) {
    let allTop2 = true;
    for (const r of set) if (r > 2) allTop2 = false;
    if (allTop2) return true;
  }
  return false;
}

function conditionalHeadline(code, allRanks, unplayed, scenarios, relevant) {
  const hi = Math.max(...allRanks);
  const controls = controlsTop2(code, unplayed, scenarios, relevant);
  if (allRanks.has(1)) {
    return controls
      ? `Still alive for 1st (could finish as low as ${ordinal(hi)}) — controls its own destiny`
      : `Still alive for 1st (could finish as low as ${ordinal(hi)})`;
  }
  if (allRanks.has(2)) {
    return controls
      ? `Can finish as high as 2nd (as low as ${ordinal(hi)}) — fate in its own hands`
      : `Can still finish 2nd; could fall to ${ordinal(hi)}`;
  }
  return `Position still open (${ordinal(Math.min(...allRanks))}–${ordinal(hi)})`;
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

/**
 * Summarize a group's remaining-match scenarios into per-team plain-English
 * clinch / qualification / elimination statements.
 *
 * @param {{name,teams,matches}} group
 * @param {{maxGoals?:number}} [opts]
 * @returns {{ teams: Array, deadRubbers: string[] }}
 */
export function summarizeGroup(group, opts = {}) {
  const maxGoals = opts.maxGoals ?? MAX_GOALS;
  const nameOf = (code) => {
    const t = group.teams.find((x) => x.code === code);
    return t ? t.name : code;
  };

  const unplayed = group.matches.filter((m) => !m.played);

  // Fully-played group: every team has a fixed rank.
  if (unplayed.length === 0) {
    const standing = computeGroupStanding(group);
    const teams = standing.map((s) => ({
      code: s.code,
      name: s.name,
      status:
        s.rank === 1 ? 'won-group' : s.rank === 4 ? 'eliminated' : s.rank === 3 ? 'best-3rd' : 'qualified',
      headline:
        s.rank === 1
          ? 'Clinched 1st — group winner'
          : s.rank === 4
            ? 'Eliminated'
            : s.rank === 3
              ? 'Finished 3rd — advancing then depends on other groups'
              : 'Qualified — finished 2nd',
      detail: null,
      maxRank: s.rank,
      minRank: s.rank,
    }));
    return { teams, deadRubbers: [] };
  }

  const { scenarios } = enumerateScenarios(group, maxGoals);

  const teams = group.teams.map((team) => {
    const code = team.code;
    const ranks = scenarios.map((s) => s.rankByCode[code]);
    const minRank = Math.min(...ranks); // best
    const maxRank = Math.max(...ranks); // worst
    const allRanks = new Set(ranks);

    // rank == 1 in ALL scenarios -> clinched 1st.
    if (minRank === 1 && maxRank === 1) {
      return mk(code, team.name, 'won-group', 'Clinched 1st — group winner', null, maxRank, minRank);
    }

    // rank == 4 in ALL -> eliminated.
    if (minRank === 4 && maxRank === 4) {
      return mk(code, team.name, 'eliminated', 'Eliminated', null, maxRank, minRank);
    }

    // rank in {1,2} in all scenarios but not always 1 -> clinched top-2.
    if (maxRank <= 2) {
      const firstReachable = allRanks.has(1);
      let detail = null;
      if (firstReachable) {
        const relevant = relevantMatchIndices(code, unplayed, scenarios);
        detail = detailForTop(code, team.name, unplayed, scenarios, relevant, nameOf);
      }
      return mk(
        code,
        team.name,
        'qualified',
        'Qualified — clinched a top-2 place',
        detail,
        maxRank,
        minRank
      );
    }

    // best achievable POSITION is 3rd.
    if (minRank === 3) {
      let detail = null;
      if (maxRank > 3) {
        const relevant = relevantMatchIndices(code, unplayed, scenarios);
        detail = describeConditional(code, team.name, unplayed, scenarios, relevant, nameOf);
      }
      return mk(
        code,
        team.name,
        'best-3rd',
        'Can finish no higher than 3rd — advancing then depends on other groups',
        detail,
        maxRank,
        minRank
      );
    }

    // ---- conditional ----
    const relevant = relevantMatchIndices(code, unplayed, scenarios);
    const detail = describeConditional(code, team.name, unplayed, scenarios, relevant, nameOf);
    const headline = conditionalHeadline(code, allRanks, unplayed, scenarios, relevant);
    return mk(code, team.name, 'conditional', headline, detail, maxRank, minRank);
  });

  return { teams, deadRubbers: deadRubbers(group, unplayed, scenarios) };
}

function mk(code, name, status, headline, detail, maxRank, minRank) {
  return { code, name, status, headline, detail, maxRank, minRank };
}

// ---------------------------------------------------------------------------
// Test-only exports (minimal-cover unit testing).
// ---------------------------------------------------------------------------
export const __test = {
  minimalCover,
  renderSubcube,
  buildRelevantCells,
  relevantMatchIndices,
  enumerateScenarios,
  coverByRank,
};
