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
// Monte-Carlo probability helpers (used only when opts.mcByCode is supplied)
// ---------------------------------------------------------------------------

/** Format a probability [0..1] as a compact whole-ish percent, matching the UI. */
function pctMC(p) {
  if (p == null) return '';
  if (p >= 0.995) return '99%';        // never print a bare 100% for a non-clinch
  if (p > 0 && p <= 0.005) return '<1%';
  const v = p * 100;
  return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + '%';
}

/** Current POINTS per team code, from PLAYED matches only (3/1/0). */
function currentPointsByCode(group) {
  const pts = {};
  for (const t of group.teams) pts[t.code] = 0;
  for (const m of group.matches) {
    if (!m.played) continue;
    if (!(m.home in pts) || !(m.away in pts)) continue;
    if (m.homeGoals > m.awayGoals) pts[m.home] += 3;
    else if (m.homeGoals < m.awayGoals) pts[m.away] += 3;
    else { pts[m.home] += 1; pts[m.away] += 1; }
  }
  return pts;
}

/** Current overall goal difference per team code, from PLAYED matches only. */
function currentGDByCode(group) {
  const gd = {};
  for (const t of group.teams) gd[t.code] = 0;
  for (const m of group.matches) {
    if (!m.played) continue;
    if (!(m.home in gd) || !(m.away in gd)) continue;
    gd[m.home] += m.homeGoals - m.awayGoals;
    gd[m.away] += m.awayGoals - m.homeGoals;
  }
  return gd;
}

/** P(reach R32 | team finishes on exactly `finalPts`), from advanceByPoints. */
function advGivenPoints(mc, finalPts) {
  if (!mc || !mc.advanceByPoints) return null;
  const b = mc.advanceByPoints[String(finalPts)];
  return b ? b.pAdvanceGiven : null;
}

/**
 * P(qualify | finish 3rd on exactly `finalPts`) and P(finish 3rd | finish on
 * `finalPts`), from qualifyIfThirdByPoints. This is the ONLY probability that may
 * be attached to a 3rd-place outcome — it is conditioned on actually finishing
 * 3rd, so it excludes the 4th-place (never-qualifies) mass entirely.
 * @returns {{p3rd:number, pQualIfThird:number}|null}
 */
function qualIfThirdGivenPoints(mc, finalPts) {
  if (!mc || !mc.qualifyIfThirdByPoints) return null;
  const b = mc.qualifyIfThirdByPoints[String(finalPts)];
  return b || null;
}

// ---------------------------------------------------------------------------
// DETERMINISTIC cross-group best-third clinch (mirrors group-situation.js).
// A 3rd-place team is mathematically locked into the top-8 thirds when its
// WORST possible 3rd-place points total can be matched-or-beaten by at most 7
// OTHER groups' third-place ceilings (groups are independent, so all hitting
// their ceiling at once is the achievable worst case). This is a guarantee, not
// a probability — used to upgrade a "99% to qualify" headline to "Clinched".
// Requires opts.allGroups; absent it, we leave the MC wording untouched.
// ---------------------------------------------------------------------------
const ssGroupLetter = (g) => {
  const m = /Group\s+([A-L])/i.exec(g.name || '');
  return m ? m[1].toUpperCase() : null;
};

function ssBasePoints(group) {
  const pts = new Map();
  for (const t of group.teams) pts.set(t.code, 0);
  for (const m of group.matches) {
    if (!m.played) continue;
    if (m.homeGoals > m.awayGoals) pts.set(m.home, pts.get(m.home) + 3);
    else if (m.homeGoals < m.awayGoals) pts.set(m.away, pts.get(m.away) + 3);
    else { pts.set(m.home, pts.get(m.home) + 1); pts.set(m.away, pts.get(m.away) + 1); }
  }
  return pts;
}

// Enumerate coarse W/D/L of a group's unplayed matches, yielding final-points Maps.
function* ssEnumerate(basePts, unplayed) {
  const k = unplayed.length;
  for (let n = 0; n < 3 ** k; n++) {
    const f = new Map(basePts);
    let x = n;
    for (let i = 0; i < k; i++) {
      const m = unplayed[i], o = x % 3; x = Math.floor(x / 3);
      if (o === 0) f.set(m.home, f.get(m.home) + 3);
      else if (o === 1) f.set(m.away, f.get(m.away) + 3);
      else { f.set(m.home, f.get(m.home) + 1); f.set(m.away, f.get(m.away) + 1); }
    }
    yield f;
  }
}

/** Max points a third-place team in this group can still finish on. */
function ssMaxThirdPoints(group) {
  const unplayed = group.matches.filter((m) => !m.played);
  let mx = -1;
  for (const f of ssEnumerate(ssBasePoints(group), unplayed)) {
    const s = [...f.values()].sort((a, b) => b - a);
    if (s[2] > mx) mx = s[2];
  }
  return mx;
}

/**
 * Is `code` deterministically locked into the R32 via a guaranteed top-8 third?
 * Returns { clinched:true, worstThirdPts } or null. Conservative (worst-case
 * rank loses all ties; "ceiling >= worst" counts as could-beat).
 */
function ssThirdClinch(group, code, allGroups) {
  if (!allGroups) return null;
  const unplayed = group.matches.filter((m) => !m.played);
  let everFourth = false, everThird = false, worst = Infinity;
  for (const f of ssEnumerate(ssBasePoints(group), unplayed)) {
    const mine = f.get(code);
    let above = 0, equal = 0;
    for (const [c, p] of f) { if (c === code) continue; if (p > mine) above++; else if (p === mine) equal++; }
    const worstRank = above + equal + 1;
    if (worstRank >= 4) everFourth = true;
    else if (worstRank === 3) { everThird = true; if (mine < worst) worst = mine; }
  }
  if (everFourth || !everThird) return null; // can be 4th, or never 3rd (top-2 path)
  const own = ssGroupLetter(group);
  let canBeat = 0;
  for (const g of allGroups) {
    const L = ssGroupLetter(g);
    if (!L || L === own) continue;
    if (ssMaxThirdPoints(g) >= worst) canBeat++;
  }
  return canBeat <= 7 ? { clinched: true, worstThirdPts: worst } : null;
}

/** Whole-number percent for an advance probability attached to a 3rd-place
 *  token. Never prints a bare 100% (a Monte-Carlo advance is never a certainty);
 *  caps at 99%. Tiny non-zero prints "<1%"; an exact 0 prints "0%". */
function pctWhole(p) {
  if (p == null) return '';
  if (p >= 0.995) return '99%';
  if (p > 0 && p < 0.005) return '<1%';
  return Math.round(p * 100) + '%';
}

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
 *
 * When `withOpp` is true, "avoid defeat" forms name the opponent for clarity
 * inside a subject-first dependency clause:
 *   {D,L} -> "Mexico avoid defeat against Czech Republic"
 */
function otherMatchPhrase(set, match, nameOf, withOpp = false) {
  const home = nameOf(match.home);
  const away = nameOf(match.away);
  if (set.size === 3) return '';
  if (set.size === 1) {
    const c = [...set][0];
    if (c === 'W') return `${home} beat ${away}`;
    if (c === 'L') return `${away} beat ${home}`;
    return `${home} and ${away} draw`;
  }
  // size 2 -> name the two outcomes for the relevant team ("win or draw"),
  // which reads more directly than "avoid defeat".
  if (!set.has('L')) return `${home} win or draw${withOpp ? ` vs ${away}` : ''}`; // {W,D}
  if (!set.has('W')) return `${away} win or draw${withOpp ? ` vs ${home}` : ''}`; // {D,L}
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
  // Two relevant matches, subject plays one of them, and a goal margin flips the
  // rank inside some coarse cell. Organize the statement around the subject's OWN
  // result (subject-first), append the other-match dependency, and surface any
  // margin-only path with an explicit concrete result + a goal-difference caveat
  // (never a bare "on goal difference").
  if (ownIdx >= 0) {
    return describeByOwnResultMargin(code, ranks, scenarios, unplayed, relevant, ownIdx, nameOf);
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
// Own-result-centric renderer for the MARGIN case (subject plays one of two
// relevant matches; a goal margin flips the rank inside some coarse cell).
// ---------------------------------------------------------------------------

/**
 * Build, per subject own-result (W/D/L, subject perspective), the map
 *   otherCoarse ('W'|'D'|'L', other-match HOME perspective) -> Set<rank>.
 * A set of size > 1 means that (own, other) coarse cell is decided on goal
 * difference (margin split).
 */
function sliceOwnVsOther(code, scenarios, unplayed, relevant, ownIdx) {
  const ownU = relevant[ownIdx];
  const otherI = relevant.find((_, i) => i !== ownIdx);
  const ownMatch = unplayed[ownU];
  const otherMatch = unplayed[otherI];
  const byOwn = new Map(); // subjOwn -> Map(otherCoarse -> Set<rank>)
  for (const s of scenarios) {
    const subjOwn = fromSubjectPerspective(s.coarse[ownU], ownMatch, code);
    const oth = s.coarse[otherI];
    if (!byOwn.has(subjOwn)) byOwn.set(subjOwn, new Map());
    const m = byOwn.get(subjOwn);
    if (!m.has(oth)) m.set(oth, new Set());
    m.get(oth).add(s.rankByCode[code]);
  }
  return { byOwn, ownMatch, otherMatch };
}

/**
 * Render the subject's own result (a single coarse 'W'|'D'|'L', subject persp.)
 * as a noun phrase naming the opponent, e.g. "a win over South Korea",
 * "a draw against South Korea", "a loss".
 */
function ownSinglePhrase(subjC, opp) {
  if (subjC === 'W') return `a win over ${opp}`;
  if (subjC === 'D') return `a draw against ${opp}`;
  return `a loss`;
}

/**
 * Margin case, subject plays one of two relevant matches. Produce one clause per
 * achievable rank (best -> worst), each SUBJECT-FIRST: it leads with the rank and
 * the subject's own result, then appends the other-match dependency with a
 * natural connector. Any path that exists only on a goal-difference tiebreak is
 * stated with its concrete results and an explicit "(... and even then on goal
 * difference)" caveat — never a bare "on goal difference".
 */
function describeByOwnResultMargin(code, ranks, scenarios, unplayed, relevant, ownIdx, nameOf) {
  const { byOwn, ownMatch, otherMatch } = sliceOwnVsOther(code, scenarios, unplayed, relevant, ownIdx);
  const opp = nameOf(ownMatch.home === code ? ownMatch.away : ownMatch.home);
  const COARSE_ORDER = { W: 0, D: 1, L: 2 };
  const sortCoarse = (a, b) => COARSE_ORDER[a] - COARSE_ORDER[b];

  // Per rank, gather the own-results that reach it, separating CLEAN cells
  // (rankSet === {r}) from GD-only cells (r is the BETTER member of a split cell,
  // i.e. reachable only on a favourable goal difference).
  const perRank = new Map(); // r -> { clean: Map<own,Set<other>>, gd: Map<own,Set<other>> }
  for (const r of ranks) perRank.set(r, { clean: new Map(), gd: new Map() });
  for (const [subjOwn, otherMap] of byOwn) {
    for (const [oth, rankSet] of otherMap) {
      const sorted = [...rankSet].sort((a, b) => a - b);
      const best = sorted[0];
      for (const r of sorted) {
        const slot = perRank.get(r);
        if (!slot) continue;
        const bucket = rankSet.size === 1 ? slot.clean : r === best ? slot.gd : null;
        if (!bucket) continue; // worse member of a split: owned by the better rank
        if (!bucket.has(subjOwn)) bucket.set(subjOwn, new Set());
        bucket.get(subjOwn).add(oth);
      }
    }
  }

  // Render one rank's clean own-results into a subject-first clause body, with
  // the chosen dependency connector ("provided" for the lead clause, "if"
  // otherwise). Returns { body, groups } where groups counts distinct
  // own-result/condition segments (used to decide the "otherwise" tail).
  const cleanBody = (slot, connector) => {
    // Merge own-results that share an IDENTICAL other-condition.
    const byCond = new Map(); // condKey -> { owns: [coarse], otherSet }
    for (const [own, otherSet] of slot.clean) {
      const key = [...otherSet].sort().join('');
      if (!byCond.has(key)) byCond.set(key, { owns: [], otherSet });
      byCond.get(key).owns.push(own);
    }
    const segs = [];
    for (const { owns, otherSet } of byCond.values()) {
      owns.sort(sortCoarse);
      const ownP = ownMergedPhrase(owns, opp);
      const cond = otherCondition(otherSet, otherMatch, nameOf);
      // "provided" reads with a comma; "if"/"unless" read without one.
      const sep = connector === 'provided' ? ', provided' : ` ${connector}`;
      segs.push(cond ? `${ownP}${sep} ${cond}` : ownP);
    }
    return { body: segs.join(', or '), groups: byCond.size };
  };

  // The worst clean rank becomes a bare "otherwise Nth" tail only when its body
  // is MULTI-CONDITION (messy) — a single decisive own-result is stated concretely.
  const cleanRanks = ranks.filter((r) => perRank.get(r).clean.size > 0);
  const worstClean = cleanRanks.length ? Math.max(...cleanRanks) : null;
  let tailRank = null;
  if (worstClean !== null && cleanRanks.length >= 2) {
    const { groups } = cleanBody(perRank.get(worstClean), 'if');
    if (groups >= 2) tailRank = worstClean;
  }

  // Order: clean ranks best -> worst, then GD-only ranks (low-probability) after,
  // then the "otherwise" tail. Track clause index for connector choice.
  const cleanList = cleanRanks.filter((r) => r !== tailRank);
  const gdRanks = ranks.filter((r) => perRank.get(r).clean.size === 0 && perRank.get(r).gd.size > 0);

  const clauses = [];
  let idx = 0;
  for (const r of cleanList) {
    const connector = idx === 0 ? 'provided' : 'if';
    const { body } = cleanBody(perRank.get(r), connector);
    clauses.push(`${ordinal(r)} with ${body}`);
    idx++;
  }
  for (const r of gdRanks) {
    const slot = perRank.get(r);
    const [own, otherSet] = [...slot.gd.entries()].sort((a, b) => sortCoarse(a[0], b[0]))[0];
    const cond = otherCondition(otherSet, otherMatch, nameOf);
    const path = cond ? `${ownGerundPhrase(own, opp)} while ${cond}` : ownGerundPhrase(own, opp);
    clauses.push(`${ordinal(r)} only by ${path} (and even then on goal difference)`);
  }
  let out = clauses.join('; ');
  if (tailRank !== null) out += `; otherwise ${ordinal(tailRank)}`;
  return out + '.';
}

/** Merge own-result coarse values into one phrase: {W}->"a win over X",
 *  {W,D}->"a win or draw against X", {D,L}->"a draw or loss against X", etc. */
function ownMergedPhrase(owns, opp) {
  const set = new Set(owns);
  if (set.size === 1) return ownSinglePhrase([...set][0], opp);
  const order = ['W', 'D', 'L'];
  const words = order.filter((c) => set.has(c)).map((c) => (c === 'W' ? 'win' : c === 'D' ? 'draw' : 'loss'));
  return `a ${words.join(' or ')} against ${opp}`;
}

/** Gerund form of the subject's own result for a "only by ..." path:
 *  W -> "beating South Korea", D -> "drawing with South Korea", L -> "losing". */
function ownGerundPhrase(subjC, opp) {
  if (subjC === 'W') return `beating ${opp}`;
  if (subjC === 'D') return `drawing with ${opp}`;
  return `losing`;
}

/** Render an other-match condition from a set of its HOME-perspective coarse
 *  outcomes, naming the opponent in "avoid defeat" forms. Returns '' if the set
 *  spans all three outcomes (unconditional). */
function otherCondition(otherCoarseSet, otherMatch, nameOf) {
  if (otherCoarseSet.size >= 3) return '';
  return otherMatchPhrase(new Set(otherCoarseSet), otherMatch, nameOf, true);
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

// ===========================================================================
// MONTE-CARLO-DRIVEN headlines + result-based detail (final round)
// ===========================================================================

/**
 * Result-based headline for a NON-clinched, NON-eliminated team, driven by the
 * Monte-Carlo per-team entry. Never claims a realistically-impossible outcome.
 *
 * @param {object} mc   perTeam entry (pAdvance, pGroup1, pGroup2, ...)
 * @returns {string}
 */
function mcContentionHeadline(mc, minRank = 1) {
  const pAdv = mc.pAdvance ?? 0;
  const pTop2 = (mc.pGroup1 ?? 0) + (mc.pGroup2 ?? 0);
  if (pAdv >= 0.99) return `Virtually through — ${pctMC(pAdv)} to qualify`;
  // MC top-2 probability rounds to 0% (< 0.5%): the team is, for all practical
  // purposes, out of the top 2. State it DEFINITIVELY and agree with the bars
  // (which show 0% top-2) — never a vague "fighting for 3rd" that implies a live
  // 2nd-place shot. The detail carries the <0.1% tail caveat (added by the
  // caller) only when 2nd is deterministically reachable (minRank <= 2).
  if (pTop2 < 0.005) {
    const p3 = pctMC(mc.pGroup3);
    const p4 = pctMC(mc.pGroup4);
    if (minRank >= 3) {
      // 2nd is mathematically impossible — flat statement, no caveat. Lead with the
      // overall advance odds (consistent with the pre-final groupSituation view),
      // then the 3rd/4th finish breakdown.
      return `Can finish only 3rd or 4th — ${pctMC(pAdv)} to qualify (3rd ${p3} / 4th ${p4})`;
    }
    return `Out of the top 2 — ${pctMC(pAdv)} to qualify (3rd ${p3} / 4th ${p4})`;
  }
  if (pAdv >= 0.85) return `In good shape — ${pctMC(pAdv)} to qualify`;
  return `In contention — ${pctMC(pAdv)} to qualify`;
}

/** Whether the infinitesimal-2nd caveat applies: MC top-2 rounds to 0% yet a
 *  2nd-place finish is deterministically reachable (minRank <= 2). */
function isInfinitesimalSecond(mc, minRank) {
  const pTop2 = (mc.pGroup1 ?? 0) + (mc.pGroup2 ?? 0);
  return pTop2 < 0.005 && minRank <= 2;
}

/** The tail caveat appended to a detail when 2nd is alive-but-infinitesimal. */
const INFINITESIMAL_SECOND_CAVEAT =
  'a 2nd-place finish is mathematically alive but <0.1% (needs an extreme goal swing).';

/**
 * For a clinched top-2 team that can still win the group, the headline append.
 * "Qualified for the Round of 32 — {pWinGroup%} to win the group" when 1st is
 * still reachable; plain otherwise.
 */
function mcQualifiedHeadline(mc, firstReachable) {
  const base = 'Qualified for the Round of 32';
  if (firstReachable && mc && (mc.pWinGroup ?? 0) > 0.005) {
    return `${base} — ${pctMC(mc.pWinGroup)} to win the group`;
  }
  return base;
}

/** A 3rd-place advance probability that COLLAPSES to "out": it rounds to <=2%
 *  (covers an exact 0, a "<1%" tail, 1%, and 2%). pctWhole prints "0%"/"<1%"/
 *  "1%"/"2%" for these; we never show that noisy near-zero — we say "out".
 *  GENERAL rule (Fix 1). */
function thirdIsOut(p) {
  return p == null || p < 0.005; // only a truly negligible (<0.5%) 3rd is "out"
}

/** Monte-Carlo probability the team finishes in `pos` (1..4), or null. */
function mcPosProb(mc, pos) {
  if (!mc) return null;
  return pos === 1 ? mc.pGroup1 ?? null
    : pos === 2 ? mc.pGroup2 ?? null
    : pos === 3 ? mc.pGroup3 ?? null
    : pos === 4 ? mc.pGroup4 ?? null
    : null;
}

/** A position whose Monte-Carlo probability for THIS team rounds to 0% (<0.5%)
 *  is dropped from per-result phrasing — it is below the noise floor and would
 *  contradict the headline (e.g. an "Out of the top 2" team must not show a 2nd
 *  in any clause). GENERAL rule (Fix 3). When mc is absent, nothing is dropped. */
function posBelowFloor(mc, pos) {
  const p = mcPosProb(mc, pos);
  return p != null && p < 0.005;
}

/**
 * Render the outcome token(s) for ONE remaining result `x` (a {res, slot, best,
 * worst, finalPts} record), honoring the CORE RULE and the four wording fixes:
 *   - a % may appear ONLY on a 3rd-place token, and it is pQualIfThird (the
 *     probability of advancing GIVEN a 3rd-place finish on that points total);
 *   - 4th is always bare "(out)" — never a %; a top-2 portion is "through";
 *   - (Fix 1) a 3rd whose advance% rounds to <=2% renders as "out", never
 *     "3rd (0% to advance)"; if the result was only that 3rd + 4th(out), the
 *     whole result is "out";
 *   - (Fix 2) a % is NEVER attached to a phrase containing "2nd": a {2nd,3rd}
 *     result is "through" when the team advances on it regardless (3rd branch
 *     itself ~certain to advance, or team virtually through), else
 *     "2nd, or 3rd (X%)" with the % on the 3rd token only;
 *   - (Fix 3) any position whose Monte-Carlo probability for this team rounds
 *     to 0% (<0.5%) is dropped from the phrasing — keeps detail consistent with
 *     an "Out of the top 2" headline.
 * Reachable positions come from the deterministic rank set (slot.ranks).
 * If mc is absent, falls back to position-only phrasing (no %).
 */
/**
 * Condition-aware rendering of ONE own-result branch: when the other (single)
 * remaining match splits this result between two outcomes, state the split with
 * its trigger, e.g. "3rd (82% to advance), but 4th (out) if Czech Republic beat
 * Mexico" or "2nd if South Africa beat South Korea, otherwise 3rd (99% to
 * advance)". Returns null (defer to the set-based renderer) when the split is
 * not a clean two-way single-condition one.
 *
 * Honors the CORE RULE: a % attaches ONLY to a 3rd-place token (pQualIfThird);
 * 4th and a near-zero 3rd are bare "out"; a top-2 position below the MC noise
 * floor is never asserted (we defer so the caller's infinitesimal handling runs).
 */
/**
 * Positional token for the rank SET a single other-match outcome yields, used
 * inside a conditional branch. Honors the CORE RULE (% only on a 3rd token):
 *   {2}     -> "2nd"            {3} live -> "3rd (X% to advance)"
 *   {2,3}   -> "2nd, or 3rd (X% to advance)"   (a goal-difference tie)
 *   {3,4}   -> "3rd (X% to advance) or 4th (out)"
 *   {4} / a negligible 3rd / {3,4}-dead-3rd -> "out"
 * A 3rd whose advance odds are negligible (<0.5%) folds into "out".
 */
function posToken(rankSet, pThird) {
  const top2 = [...rankSet].filter((r) => r <= 2);
  const has4 = rankSet.has(4);
  const live3 = rankSet.has(3) && !(pThird == null || pThird < 0.005);
  // "out-ish" = a genuine 4th, or a 3rd whose advance odds are negligible.
  const outish = has4 || (rankSet.has(3) && !live3);
  const parts = [];
  if (top2.length && live3) {
    // % must never read as glued to "2nd": separate with a comma.
    parts.push(`${ordinal(Math.min(...top2))}, or 3rd (${pctWhole(pThird)} to advance)`);
  } else if (top2.length) {
    parts.push(ordinal(Math.min(...top2)));
  } else if (live3) {
    parts.push(`3rd (${pctWhole(pThird)} to advance)`);
  }
  if (outish) {
    // A real 4th names itself ("4th (out)") so a conditional split reads as a
    // clear position contrast; a merely-negligible 3rd (no 4th) is just "out".
    const outTok = has4 ? '4th (out)' : 'out';
    if (parts.length === 0) return outTok;
    parts.push(outTok);
  }
  return parts.join(' or ');
}

/**
 * Condition-aware rendering: when the single other remaining match splits this
 * own-result across distinct outcomes, state EACH outcome with its trigger,
 * best first, e.g. "3rd (82% to advance) if Mexico avoid defeat, 4th (out) if
 * Czech Republic beat Mexico". Goal-difference ties surface honestly as
 * "2nd, or 3rd (X% to advance)". Returns null (defer to the set renderer) when
 * the result is unconditional (one outcome), too busy (>3 outcomes), or an
 * infinitesimal-2nd case (handled by the caller's caveat path).
 */
function conditionedOutcome(x, mc, ctx) {
  const { byOther, otherMatch, nameOf } = ctx;
  if (!byOther || byOther.size === 0 || !otherMatch) return null;

  // Infinitesimal-2nd guard: a reachable-but-<0.5% top-2 rank is dropped by the
  // set renderer (+ caveat), so defer rather than assert a 2nd here.
  for (const set of byOther.values()) {
    for (const r of set) if (r <= 2 && posBelowFloor(mc, r)) return null;
  }

  const pThird = qualIfThirdGivenPoints(mc, x.finalPts)?.pQualIfThird ?? null;

  // One positional token per other-match outcome; group outcomes sharing a
  // token. ALL out-ish outcomes (bare "out" and "4th (out)") collapse into a
  // single OUT class — splitting "out if X, 4th (out) if Y" is noise when the
  // team misses out either way.
  const byKey = new Map(); // key -> { token, minRank, maxRank, others:Set, has4:bool }
  for (const [oc, set] of byOther) {
    const tok = posToken(set, pThird);
    const isOut = tok === 'out' || tok === '4th (out)';
    const key = isOut ? 'OUT' : tok;
    const mn = Math.min(...set);
    const mx = Math.max(...set);
    if (!byKey.has(key)) byKey.set(key, { token: tok, minRank: mn, maxRank: mx, others: new Set(), has4: false });
    const e = byKey.get(key);
    e.minRank = Math.min(e.minRank, mn);
    e.maxRank = Math.max(e.maxRank, mx);
    e.others.add(oc);
    if (set.has(4)) e.has4 = true;
  }

  // 1 class -> unconditional (set renderer emits it); >3 -> too busy to condition.
  if (byKey.size < 2 || byKey.size > 3) return null;

  // The OUT class names a genuine 4th as "4th (out)", else bare "out".
  const out = byKey.get('OUT');
  if (out) out.token = out.has4 ? '4th (out)' : 'out';

  // Safest outcome first: lower worst-case rank, then lower best-case.
  const entries = [...byKey.values()].sort((a, b) => a.maxRank - b.maxRank || a.minRank - b.minRank);

  const clauses = entries.map((e) => {
    const cond = otherMatchPhrase(new Set(e.others), otherMatch, nameOf);
    return cond ? `${e.token} if ${cond}` : e.token;
  });
  return clauses.join(', ');
}

function outcomeForResult(x, mc, ctx) {
  // The set-based phrasing (collapses the rank SET into a single token like
  // "through", "v through", "2nd, or 3rd (X%)", "out", ...).
  const base = outcomeSet(x, mc);
  // Prefer a condition-aware rendering that names WHICH other-match result
  // splits this outcome — but never break a clean "(v) through" into a noisy
  // conditional, and let the set renderer keep unconditional / infinitesimal
  // cases.
  if (mc && ctx && ctx.hasOther && base !== 'through' && base !== 'v through') {
    const conditioned = conditionedOutcome(x, mc, ctx);
    if (conditioned != null) return conditioned;
  }
  return base;
}

function outcomeSet(x, mc) {
  const ranks = x.slot.ranks;
  // Fix 3: drop any position that is below the Monte-Carlo noise floor (<0.5%)
  // for this team, so the per-result detail never contradicts the headline.
  let canTop2 = [...ranks].some((r) => r <= 2);
  let can3rd = ranks.has(3);
  let can4th = ranks.has(4);
  if (canTop2 && [...ranks].filter((r) => r <= 2).every((r) => posBelowFloor(mc, r))) {
    canTop2 = false;
  }
  if (can3rd && posBelowFloor(mc, 3)) can3rd = false;
  if (can4th && posBelowFloor(mc, 4)) can4th = false;

  // 3rd-place advance probability (the ONLY % allowed anywhere here).
  const q = ranks.has(3) ? qualIfThirdGivenPoints(mc, x.finalPts) : null;
  const pThird = q ? q.pQualIfThird : null;

  // Fix 1: a near-zero 3rd collapses to "out" (it is, effectively, out).
  if (can3rd && mc && thirdIsOut(pThird)) {
    can3rd = false;
    can4th = true; // fold the (negligibly-advancing) 3rd into the "out" branch
  }

  const third = () =>
    pThird != null ? `3rd (${pctWhole(pThird)} to advance)` : '3rd';

  // Top-2 portion: the highest reachable top-2 rank, stated as a bare position.
  const top2Word = () => {
    const best = Math.min(...ranks);
    return ordinal(Math.min(best, 2));
  };

  // Result spans top-2 AND 3rd (deterministically). The % must never sit on a
  // phrase containing "2nd" (Fix 2).
  if (canTop2 && ranks.has(3)) {
    // 3rd is mathematically REACHABLE on this result, so the team is NOT a
    // guaranteed qualifier — a 3rd-place berth is cross-group-dependent and a
    // 200k-sim "100%" is evidence, not proof. We therefore never print a bare
    // "through" here. When advancement is essentially certain (the team is
    // virtually through overall, or its sole 3rd risk is below the noise floor)
    // we say "v through" (virtually); otherwise we show the split with the 3rd's
    // explicit advance % so the residual risk is visible.
    const top2Through = mc && (mc.pAdvance ?? 0) >= 0.985;
    if (!can3rd) {
      // 3rd is below the MC floor (<0.5% to finish 3rd): virtually through.
      return mc ? 'v through' : top2Word();
    }
    if (top2Through) return mc ? 'v through' : top2Word();
    // Otherwise split, % ONLY on the 3rd token: "2nd, or 3rd (X%)".
    return `${top2Word()}, or ${third()}`;
  }

  // Top-2 LOCKED (3rd mathematically unreachable) -> a genuine, proven "through".
  if (!can3rd && !can4th) return mc ? 'through' : top2Word();
  if (!can3rd && can4th) return 'out';                         // 4th only (incl. collapsed 3rd)

  // 3rd is in play, no top-2 portion. Assemble [3rd(%)] [4th(out)].
  const parts = [];
  parts.push(third());
  if (can4th) parts.push('4th (out)');
  return parts.join(' or ');
}

/**
 * RESULT-LED final-round detail, engine-derived and MC-aware. Organized around
 * the subject's own (controllable) result — "Win → …; Draw → …; Loss → …" — with
 * the placement that follows from the OTHER match stated per branch, and any rare
 * goal-difference flip folded inline ("2nd if X (or 3rd if Y overturn the N-goal
 * edge)"). 3rd-place outcomes carry the advance % (P(qualify | finish 3rd on
 * those points)); a position that finishes 3rd-or-4th with ~0% qualify reads
 * "(out)". Correct by construction: every rank comes from computeGroupStanding
 * over the full scoreline enumeration (so H2H-before-GD is applied for us).
 *
 * Returns null when the subject plays no relevant match (caller falls back).
 */
function mcResultLedDetail(code, group, unplayed, scenarios, mc, nameOf, matchProbs) {
  const relevant = relevantMatchIndices(code, unplayed, scenarios);
  if (relevant.length === 0) return null;
  const { cells } = buildRelevantCells(code, unplayed, scenarios, relevant);
  const curPts = currentPointsByCode(group)[code] ?? 0;
  const curGD = currentGDByCode(group);

  const ownRel = relevant.findIndex((j) => unplayed[j].home === code || unplayed[j].away === code);
  if (ownRel < 0) return null; // rank driven purely by others -> let describeConditional handle it
  const ownMatch = unplayed[relevant[ownRel]];
  const otherRel = relevant.findIndex((_, i) => i !== ownRel); // -1 if none (single remaining match)

  // W/D/L probabilities for the subject team's own remaining match
  let pByResult = null;
  if (matchProbs) {
    const key = `${ownMatch.home}_${ownMatch.away}`;
    const mp = matchProbs.get ? matchProbs.get(key) : matchProbs[key];
    if (mp) {
      pByResult = ownMatch.home === code
        ? { W: mp.pWin, D: mp.pDraw, L: mp.pLoss }
        : { W: mp.pLoss, D: mp.pDraw, L: mp.pWin };
    }
  }
  const otherMatch = otherRel >= 0 ? unplayed[relevant[otherRel]] : null;
  const ownSubj = (coarse) => fromSubjectPerspective(coarse[ownRel], ownMatch, code);
  const keyOf = (c) => c.coarse.join('|');
  const allCells = [...cells.values()];

  // Majority rank per cell (the "normal" finish). Counted over actual scenarios
  // (scorelines), NOT goal margin — a draw is always margin-0 regardless of
  // score, so a cell decided on GOALS SCORED (level-GD pairs) would otherwise be
  // mis-ranked. Scenario counts capture which rank is genuinely the common one.
  const cellMaj = new Map();
  {
    const cnt = new Map(); // key -> Map<rank, count>
    for (const s of scenarios) {
      const k = relevant.map((j) => s.coarse[j]).join('|');
      if (!cnt.has(k)) cnt.set(k, new Map());
      const m = cnt.get(k);
      const r = s.rankByCode[code];
      m.set(r, (m.get(r) || 0) + 1);
    }
    for (const [k, m] of cnt) {
      let maj = 99, mx = -1;
      for (const [r, c] of m) if (c > mx || (c === mx && r < maj)) { mx = c; maj = r; }
      cellMaj.set(k, maj);
    }
  }

  // Position token for a finishing rank at a given points total.
  const qOf = (pts) => qualIfThirdGivenPoints(mc, pts)?.pQualIfThird ?? null;
  const liveThird = (pts) => { const q = qOf(pts); return q != null && q >= 0.005; };
  const posTok = (rank, pts) => {
    if (rank <= 2) return ordinal(rank);
    if (rank === 4) return '4th (out)';
    const q = qOf(pts);
    return q != null && q >= 0.005 ? `3rd (${pctWhole(q)} to qualify)` : '3rd (out)';
  };

  // Find the rival the subject swaps with in a GD-split cell (the team at the
  // majority rank when the subject takes the edge rank).
  const findRival = (coarseKey, edgeRank, majRank) => {
    for (const s of scenarios) {
      if (relevant.map((j) => s.coarse[j]).join('|') !== coarseKey) continue;
      if (s.rankByCode[code] !== edgeRank) continue;
      for (const [c2, rk] of Object.entries(s.rankByCode)) if (c2 !== code && rk === majRank) return c2;
    }
    return null;
  };
  // A goal-difference flip between the subject and one rival LEVEL on points.
  // The GD edge belongs to whoever is higher on CURRENT goal difference (ahead);
  // the team behind can only take the better rank by OVERTURNING that edge.
  const gapInfo = (rival) => {
    if (!rival) return null;
    const diff = curGD[code] - curGD[rival];
    return { rival, ahead: diff >= 0 ? code : rival, behind: diff >= 0 ? rival : code, gap: Math.abs(diff) };
  };
  // Phrase the GD decider for the subject's EDGE outcome. edgeIsBetter = the
  // subject's edge rank is higher (better) than its majority finish.
  //  - level (gap 0): whoever wins the tiebreak takes the better rank (goals
  //    scored when the GD is pinned, e.g. both drew).
  //  - otherwise: an OVERTURN (the team behind on GD out-scores the edge) or a
  //    HOLD (the team ahead keeps its edge), per which side the subject lands on.
  const gapText = (gi, edgeIsBetter, gdPinned = false) => {
    if (gi == null) return 'the goal difference is overturned';
    if (gi.gap === 0) {
      const winner = edgeIsBetter ? code : gi.rival;
      const loser = edgeIsBetter ? gi.rival : code;
      return gdPinned ? `${nameOf(winner)} win the goals-scored tiebreak` : `${nameOf(winner)} win the tiebreak over ${nameOf(loser)}`;
    }
    const overturn = (gi.ahead === code) ? !edgeIsBetter : edgeIsBetter;
    return overturn
      ? `${nameOf(gi.behind)} overturn ${nameOf(gi.ahead)}'s ${gi.gap}-goal goal-difference edge`
      : `${nameOf(gi.ahead)} hold their ${gi.gap}-goal goal-difference edge`;
  };
  // Whether the subject's edge is the team BEHIND overturning the GD (vs a hold).
  const isOverturn = (gi, edgeIsBetter) =>
    gi != null && gi.gap > 0 && ((gi.ahead === code) ? !edgeIsBetter : edgeIsBetter);
  // "...and also overturn X's N-goal edge" — only when the branch-named team is
  // the one doing the overturning (the team behind on GD).
  const alsoOverturn = (gi, gdPinned = false) =>
    gi == null ? 'also overturn the goal difference'
    : gi.gap === 0
      ? (gdPinned ? 'also win the goals-scored tiebreak' : `also win the tiebreak over ${nameOf(gi.rival)}`)
    : `also overturn ${nameOf(gi.ahead)}'s ${gi.gap}-goal goal-difference edge`;
  // Condition phrase for the OTHER match given a set of its home-coarse outcomes.
  const otherCond = (ocSet) =>
    otherRel < 0 || ocSet.size >= 3 ? '' : otherMatchPhrase(ocSet, otherMatch, nameOf);
  // The team whose result the branch condition names (for "and also overturn").
  const branchActor = (ocSet) => {
    if (otherRel < 0) return null;
    const arr = [...ocSet];
    if (arr.length === 1) return arr[0] === 'W' ? otherMatch.home : arr[0] === 'L' ? otherMatch.away : null;
    if (arr.length === 2) return !ocSet.has('L') ? otherMatch.home : !ocSet.has('W') ? otherMatch.away : null;
    return null;
  };

  const RWORD = { W: 'win', D: 'draw', L: 'loss' };
  const ORDER = ['W', 'D', 'L'];

  // Build the placement description for each own result present.
  const descByOwn = new Map();
  for (const R of ORDER) {
    const mine = allCells.filter((c) => ownSubj(c.coarse) === R);
    if (mine.length === 0) continue;
    const pts = curPts + (R === 'W' ? 3 : R === 'D' ? 1 : 0);

    // When the DOMINANT (majority) rank is the SAME across every branch, the
    // other match doesn't change the normal finish — so state that one rank and
    // tack on only the rare goal-difference exception(s): "2nd, but 3rd if Bosnia
    // beat Qatar and overturn Canada's 9-goal edge". Much shorter than listing
    // every branch.
    const majSet = new Set(mine.map((c) => cellMaj.get(keyOf(c))));
    if (majSet.size === 1) {
      const M = [...majSet][0];
      // Key by (edge rank, rival): two cells reaching the same rank via DIFFERENT
      // rivals (different GD edges) must NOT be merged — their conditions differ.
      const exByEdge = new Map(); // `${edge}|${rival}` -> { edge, ocs:Set, rival }
      for (const c of mine) {
        if (c.rankSet.size <= 1) continue;
        const edge = [...c.rankSet].filter((r) => r !== M).sort((a, b) => a - b)[0];
        const rival = findRival(keyOf(c), edge, M);
        const k = `${edge}|${rival}`;
        if (!exByEdge.has(k)) exByEdge.set(k, { edge, ocs: new Set(), rival });
        if (otherRel >= 0) exByEdge.get(k).ocs.add(c.coarse[otherRel]);
      }
      const liveBase = M <= 2 || liveThird(pts);
      if (exByEdge.size === 0) { descByOwn.set(R, liveBase ? posTok(M, pts) : 'out'); continue; }
      const base = liveBase ? posTok(M, pts) : 'out';
      const parts = [base];
      // Build each exception's condition, then group by edge RANK so multiple
      // routes to the same rank read as one "but Nth if A or if B" (not two buts).
      const condsByRank = new Map(); // edge rank -> [condition strings]
      for (const e of [...exByEdge.values()].sort((a, b) => a.edge - b.edge)) {
        const edge = e.edge;
        const edgeLive = edge <= 2 || (edge === 3 && liveThird(pts));
        if (!liveBase && !edgeLive) continue; // "out, but still out" -> nothing to add
        const branch = otherCond(e.ocs);
        const gi = gapInfo(e.rival);
        const edgeIsBetter = edge < M;
        const gdPinned = R === 'D' && [...e.ocs].every((o) => o === 'D');
        // If the branch-named team is the one overturning the GD, merge with
        // "and also overturn …" instead of repeating the team name.
        const cond = branch && gi && isOverturn(gi, edgeIsBetter) && branchActor(e.ocs) === gi.behind
          ? `${branch} and ${alsoOverturn(gi, gdPinned)}`
          : [branch, gapText(gi, edgeIsBetter, gdPinned)].filter(Boolean).join(' and ');
        if (!condsByRank.has(edge)) condsByRank.set(edge, []);
        condsByRank.get(edge).push(cond);
      }
      for (const [edge, conds] of [...condsByRank].sort((a, b) => a[0] - b[0])) {
        parts.push(`but ${posTok(edge, pts)} if ${conds.join(' or if ')}`);
      }
      descByOwn.set(R, parts.join(', '));
      continue;
    }

    // Dominant rank varies by branch -> state each branch, folding any GD flip
    // inline ("2nd if X (or 3rd if Y overturn the edge), 3rd if Z").
    const segs = []; // { best, worst, text, live }
    const cleanByTok = new Map(); // tok -> { rank, ocs:Set }
    for (const c of mine) {
      if (c.rankSet.size !== 1) continue;
      const maj = cellMaj.get(keyOf(c));
      const tok = posTok(maj, pts);
      if (!cleanByTok.has(tok)) cleanByTok.set(tok, { rank: maj, ocs: new Set() });
      if (otherRel >= 0) cleanByTok.get(tok).ocs.add(c.coarse[otherRel]);
    }
    for (const [tok, e] of cleanByTok) {
      const cond = otherCond(e.ocs);
      segs.push({ best: e.rank, worst: e.rank, live: e.rank <= 2 || liveThird(pts), text: cond ? `${tok} if ${cond}` : tok });
    }
    for (const c of mine) {
      if (c.rankSet.size <= 1) continue;
      const maj = cellMaj.get(keyOf(c));
      const edge = [...c.rankSet].filter((r) => r !== maj).sort((a, b) => a - b)[0];
      const rival = findRival(keyOf(c), edge, maj);
      const branch = otherRel >= 0 ? otherCond(new Set([c.coarse[otherRel]])) : '';
      const gi = gapInfo(rival);
      const edgeIsBetter = edge < maj;
      const gdPinned = R === 'D' && otherRel >= 0 && c.coarse[otherRel] === 'D';
      const lo = Math.min(maj, edge), hi = Math.max(maj, edge);
      let text;
      if (gi && gi.gap === 0 && !gdPinned) {
        // Dead heat: level on points AND goal difference, and this result can
        // still swing the GD (both teams won/lost) -> a true jump ball between
        // the two positions, decided on goal difference. Don't pick a false default.
        const pair = `${posTok(lo, pts)} or ${posTok(hi, pts)} on goal difference`;
        text = branch ? `${pair} if ${branch}` : pair;
      } else {
        // Downgrade reads "unless … "; an upgrade reads "or {better} if … ".
        const inner = edge > maj
          ? `unless ${gapText(gi, edgeIsBetter, gdPinned)}`
          : `or ${posTok(edge, pts)} if ${gapText(gi, edgeIsBetter, gdPinned)}`;
        const head = branch ? `${posTok(maj, pts)} if ${branch}` : posTok(maj, pts);
        text = `${head} (${inner})`;
      }
      segs.push({ best: lo, worst: hi, live: maj <= 2 || edge <= 2 || liveThird(pts), text });
    }

    if (!segs.some((s) => s.live)) { descByOwn.set(R, 'out'); continue; }
    segs.sort((a, b) => a.best - b.best || a.worst - b.worst);
    descByOwn.set(R, segs.map((s) => s.text).join(', '));
  }

  if (descByOwn.size === 0) return null;

  // Merge consecutive own-results (W,D,L order) sharing an identical description.
  const order = ORDER.filter((R) => descByOwn.has(R));
  const groupsOut = [];
  for (const R of order) {
    const d = descByOwn.get(R);
    const last = groupsOut[groupsOut.length - 1];
    if (last && last.desc === d) last.rs.push(R);
    else groupsOut.push({ rs: [R], desc: d });
  }
  const words = (rs) => {
    const w = rs.map((r) => RWORD[r]).join(' or ');
    const label = w.charAt(0).toUpperCase() + w.slice(1);
    if (pByResult) {
      const p = rs.reduce((sum, r) => sum + (pByResult[r] || 0), 0);
      return `${label} (${Math.round(p * 100)}%)`;
    }
    return label;
  };
  return groupsOut.map((g) => `${words(g.rs)} → ${g.desc}`).join('; ') + '.';
}

/**
 * RESULT-BASED final-round detail (team plays exactly ONE remaining match).
 * Leads with the best result, attaches advance odds to any result that leaves
 * the team 3rd-or-out. Results that guarantee top-2 read "through" (no odds).
 *
 * Returns null if the team has no single own-game mapping (caller falls back to
 * the deterministic renderer).
 */
function mcFinalRoundDetail(code, group, unplayed, scenarios, mc) {
  const ownIdx = unplayed.findIndex((m) => m.home === code || m.away === code);
  if (ownIdx === -1) return null;
  const ownMatch = unplayed[ownIdx];
  const opp = nameInGroup(group, ownMatch.home === code ? ownMatch.away : ownMatch.home);
  const curPts = currentPointsByCode(group)[code] ?? 0;
  const nameOf = (c) => nameInGroup(group, c);
  const otherIdx = unplayed.map((_, i) => i).filter((i) => i !== ownIdx);
  const hasOther = otherIdx.length === 1; // final round: 0 or 1 other match

  // Per own coarse result (subject perspective): rank set + per-other-outcome
  // rank SET (a set of size>1 for an other-outcome means goal difference splits
  // it — that result is left to the set-based renderer, not conditioned).
  const byOwn = new Map(); // 'W'|'D'|'L' -> { ranks:Set, byOther: Map<otherCoarse,Set<rank>> }
  for (const s of scenarios) {
    const own = fromSubjectPerspective(s.coarse[ownIdx], ownMatch, code);
    if (!byOwn.has(own)) byOwn.set(own, { ranks: new Set(), byOther: new Map() });
    const slot = byOwn.get(own);
    slot.ranks.add(s.rankByCode[code]);
    if (hasOther) {
      const oc = s.coarse[otherIdx[0]];
      if (!slot.byOther.has(oc)) slot.byOther.set(oc, new Set());
      slot.byOther.get(oc).add(s.rankByCode[code]);
    }
  }

  const finalPtsOf = { W: curPts + 3, D: curPts + 1, L: curPts + 0 };
  const resultPhrase = { W: 'win', D: 'draw', L: 'loss' };
  const ownNoun = { W: `a win over ${opp}`, D: `a draw with ${opp}`, L: `a loss to ${opp}` };
  const order = ['W', 'D', 'L'].filter((r) => byOwn.has(r));
  const info = order.map((res) => {
    const slot = byOwn.get(res);
    const worst = Math.max(...slot.ranks);
    const best = Math.min(...slot.ranks);
    return { res, slot, best, worst, top2: worst <= 2, finalPts: finalPtsOf[res] };
  });

  // Merge the LEADING run of top-2-safe results into one "win or draw" lead.
  const safeLead = [];
  let k = 0;
  while (k < info.length && info[k].top2) { safeLead.push(info[k]); k++; }

  const segs = [];

  if (safeLead.length > 0) {
    const worstAcrossLead = Math.max(...safeLead.map((x) => x.worst));
    const bestAcrossLead = Math.min(...safeLead.map((x) => x.best));
    // Combined own-result noun ("a win", "a win or draw").
    const words = safeLead.map((x) => resultPhrase[x.res]);
    let ownText;
    if (words.length === 1) ownText = ownNoun[safeLead[0].res];
    else ownText = `a ${words.join(' or ')} vs ${opp}`;
    // "2nd with ..." when the safe lead pins a single position; "At least 2nd
    // with ..." only when it spans (e.g. could be 1st or 2nd).
    const posWord = worstAcrossLead === bestAcrossLead
      ? ordinal(worstAcrossLead)
      : `At least ${ordinal(worstAcrossLead)}`;
    let lead = `${posWord} with ${ownText}`;
    // If 1st is reachable within the safe lead, note the (cross-match) condition.
    const oneReachable = safeLead.some((x) => x.best === 1);
    if (oneReachable && hasOther) {
      // Find, within a safe result that can be 1st, the other-match outcomes giving 1st.
      const x = safeLead.find((y) => y.best === 1);
      const firstOutcomes = new Set();
      // byOther maps each other-match coarse outcome -> the Set of ranks it
      // yields for this own-result. An outcome cleanly gives 1st when that set
      // is exactly {1}. (An empty firstOutcomes must NOT reach otherMatchPhrase,
      // which would misread it as an "avoid defeat" condition.)
      for (const [oc, rkSet] of x.slot.byOther) {
        if (rkSet.size === 1 && rkSet.has(1)) firstOutcomes.add(oc);
      }
      const cond = firstOutcomes.size > 0
        ? otherMatchPhrase(firstOutcomes, unplayed[otherIdx[0]], nameOf)
        : '';
      if (cond) lead += ` (1st if ${cond})`;
    }
    segs.push(lead);
  }

  // Remaining results (can leave the team 3rd-or-out): render the reachable
  // position(s). CORE RULE: a qualification % may attach ONLY to a 3rd-place
  // token, using pQualIfThird (P(advance | finish 3rd on this total)). 4th is
  // NEVER given a % — it is always bare "(out)". Top-2 portions read "through".
  const otherMatch = hasOther ? unplayed[otherIdx[0]] : null;
  for (let i = k; i < info.length; i++) {
    const x = info[i];
    const ctx = { byOther: x.slot.byOther, otherMatch, nameOf, hasOther };
    segs.push(`a ${resultPhrase[x.res]} → ${outcomeForResult(x, mc, ctx)}`);
  }

  if (segs.length === 0) return null;
  // Fix 4: capitalize the first word of the whole detail string ("A win → …").
  const out = segs.length === 1 ? segs[0] + '.' : segs[0] + '; ' + segs.slice(1).join('; ') + '.';
  return cap(out);
}

/** Team name lookup within a group. */
function nameInGroup(group, code) {
  const t = group.teams.find((x) => x.code === code);
  return t ? t.name : code;
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
  const mcByCode = opts.mcByCode || null; // code -> perTeam entry, or null
  const mcOf = (code) => (mcByCode ? mcByCode[code] || null : null);
  const nameOf = (code) => {
    const t = group.teams.find((x) => x.code === code);
    return t ? t.name : code;
  };

  const unplayed = group.matches.filter((m) => !m.played);

  // Fully-played group: every team has a fixed rank.
  if (unplayed.length === 0) {
    const standing = computeGroupStanding(group);
    const teams = standing.map((s) => {
      const mc = mcOf(s.code);
      let headline;
      if (s.rank === 1) headline = mc ? 'Won the group' : 'Clinched 1st — group winner';
      else if (s.rank === 4) headline = 'Eliminated';
      else if (s.rank === 2) headline = mc ? 'Qualified for the Round of 32' : 'Qualified — finished 2nd';
      else headline = 'Finished 3rd — advancing then depends on other groups';
      // For a finished 3rd-place team, surface its qualification odds (cross-group).
      let detail = null;
      if (s.rank === 3 && mc && mc.pAdvance != null) {
        detail = `${pctMC(mc.pAdvance)} to advance as one of the best third-placed teams.`;
      }
      return {
        code: s.code,
        name: s.name,
        status:
          s.rank === 1 ? 'won-group' : s.rank === 4 ? 'eliminated' : s.rank === 3 ? 'best-3rd' : 'qualified',
        headline,
        detail,
        maxRank: s.rank,
        minRank: s.rank,
      };
    });
    return { teams, deadRubbers: [] };
  }

  const { scenarios } = enumerateScenarios(group, maxGoals);

  const teams = group.teams.map((team) => {
    const code = team.code;
    const mc = mcOf(code);
    const ranks = scenarios.map((s) => s.rankByCode[code]);
    const minRank = Math.min(...ranks); // best
    const maxRank = Math.max(...ranks); // worst
    const allRanks = new Set(ranks);

    // rank == 1 in ALL scenarios -> clinched 1st (won the group).
    if (minRank === 1 && maxRank === 1) {
      const hl = mc ? 'Won the group' : 'Clinched 1st — group winner';
      return mk(code, team.name, 'won-group', hl, null, maxRank, minRank);
    }

    // rank == 4 in ALL -> eliminated.
    if (minRank === 4 && maxRank === 4) {
      return mk(code, team.name, 'eliminated', 'Eliminated', null, maxRank, minRank);
    }

    // rank in {1,2} in all scenarios but not always 1 -> clinched top-2.
    if (maxRank <= 2) {
      const firstReachable = allRanks.has(1);
      const relevant = relevantMatchIndices(code, unplayed, scenarios);
      let detail = null;
      if (firstReachable) {
        detail = detailForTop(code, team.name, unplayed, scenarios, relevant, nameOf);
      }
      const headline = mc
        ? mcQualifiedHeadline(mc, firstReachable)
        : 'Qualified — clinched a top-2 place';
      return mk(code, team.name, 'qualified', headline, detail, maxRank, minRank);
    }

    const relevant = relevantMatchIndices(code, unplayed, scenarios);

    // best achievable POSITION is 3rd.
    if (minRank === 3) {
      let detail = null;
      if (mc) detail = mcResultLedDetail(code, group, unplayed, scenarios, mc, nameOf, opts.matchProbs);
      if (detail == null && maxRank > 3) {
        detail = describeConditional(code, team.name, unplayed, scenarios, relevant, nameOf);
      }
      const headline = mc
        ? mcContentionHeadline(mc, minRank)
        : 'Can finish no higher than 3rd — advancing then depends on other groups';
      return mk(code, team.name, 'best-3rd', headline, detail, maxRank, minRank);
    }

    // ---- conditional ----
    let detail = null;
    if (mc) detail = mcResultLedDetail(code, group, unplayed, scenarios, mc, nameOf, opts.matchProbs);
    if (detail == null) {
      detail = describeConditional(code, team.name, unplayed, scenarios, relevant, nameOf);
    }
    const headline = mc
      ? mcContentionHeadline(mc, minRank)
      : conditionalHeadline(code, allRanks, unplayed, scenarios, relevant);
    // Infinitesimal-2nd: when MC says top-2 ≈ 0% but 2nd is still mathematically
    // reachable, explain the vanishing tail — but ONLY if the rank-led detail
    // hasn't already surfaced that 2nd inline (it now states it as the rare
    // goal-difference flip, so the extra caveat would just be redundant).
    if (mc && detail != null && isInfinitesimalSecond(mc, minRank) && !/2nd/.test(detail)) {
      detail = detail.replace(/\.?\s*$/, '') + '; ' + INFINITESIMAL_SECOND_CAVEAT;
    }
    return mk(code, team.name, 'conditional', headline, detail, maxRank, minRank);
  });

  // DETERMINISTIC best-third clinch (cross-group): upgrade any team that can
  // still finish 3rd but is mathematically locked into the top-8 thirds. Without
  // this, dropping a group to 1-2 unplayed would flip a "Clinched" team (shown by
  // groupSituation) back to "99% to qualify" here — reading as an un-clinch.
  const allGroups = opts.allGroups || null;
  const finalTeams = allGroups
    ? teams.map((t) => {
        // Only upgrade the "can still be 3rd" cases; a guaranteed top-2 / won /
        // eliminated headline already says the right thing.
        if (t.status === 'won-group' || t.status === 'qualified' || t.status === 'eliminated') return t;
        const v = ssThirdClinch(group, t.code, allGroups);
        if (!v) return t;
        const mc = mcOf(t.code);
        const headline = mc && (mc.pGroup1 ?? 0) > 0.005
          ? `Clinched a Round-of-32 place — ${pctMC(mc.pGroup1)} to win the group`
          : 'Clinched a Round-of-32 place';
        // Every reachable 3rd for a clinched team is a guaranteed qualify, so the
        // per-branch "3rd (NN% to advance/qualify)" tokens become "3rd (clinched)".
        const detail = t.detail
          ? t.detail.replace(/3rd \([^)]*\bto (?:advance|qualify)\)/g, '3rd (clinched)')
          : t.detail;
        return { ...t, status: 'advanced', headline, detail };
      })
    : teams;

  return { teams: finalTeams, deadRubbers: deadRubbers(group, unplayed, scenarios) };
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
