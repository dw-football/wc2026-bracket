// engine.js
// Deterministic core engine for a 2026 FIFA World Cup bracket projector.
//
// Pure ES module, browser-safe (no Node-only APIs in exported logic).
//
// Public API:
//   computeGroupStanding(group)            -> 4 teams ranked 1st..4th
//   rankThirdPlaceTeams(groups)            -> all 12 third-place teams ranked, top 8 qualify
//   scenarioGrid(group, upcomingMatchKeys, maxGoals=6)
//                                          -> collapsed scenario summary per team + describe()
//
// Data shapes
//   group   = { name, teams:[{code,name,fairPlay?}], matches:[match,...] }
//   match   = { home, away, homeGoals, awayGoals, played:bool }
//             home/away are team codes. A match "key" is `${home}-${away}`.
//
// Conventions
//   - Only PLAYED matches contribute to a standing.
//   - `fairPlay` is an optional per-team integer; LOWER is better; default 0.
//   - Where a tie can only be resolved by "drawing of lots", we deterministically
//     fall back to alphabetical-by-code ordering and flag the affected teams
//     `tiedByLots:true` so a UI can surface the coin-flip.

// ----------------------------------------------------------------------------
// Low-level stat aggregation
// ----------------------------------------------------------------------------

/**
 * Build a blank stat record for a team.
 * @param {{code:string,name:string,fairPlay?:number}} team
 */
function blankStats(team) {
  return {
    code: team.code,
    name: team.name,
    fairPlay: Number.isFinite(team.fairPlay) ? team.fairPlay : 0,
    elo: Number.isFinite(team.elo) ? team.elo : 0,
    worldRank: Number.isFinite(team.worldRank) ? team.worldRank : null,
    played: 0,
    won: 0,
    drawn: 0,
    lost: 0,
    gf: 0,
    ga: 0,
    gd: 0,
    points: 0,
  };
}

/**
 * Aggregate played matches into per-team stat records.
 * Only matches whose `played` flag is truthy AND whose home & away codes are
 * both in `teamCodes` count.
 *
 * @param {Array} teams   list of {code,name,fairPlay?}
 * @param {Array} matches list of match objects
 * @returns {Map<string,object>} code -> stats
 */
function aggregate(teams, matches) {
  const byCode = new Map();
  for (const t of teams) byCode.set(t.code, blankStats(t));

  for (const m of matches) {
    if (!m.played) continue;
    const home = byCode.get(m.home);
    const away = byCode.get(m.away);
    if (!home || !away) continue; // match references a team not in this subset

    const hg = m.homeGoals;
    const ag = m.awayGoals;

    home.played++; away.played++;
    home.gf += hg; home.ga += ag;
    away.gf += ag; away.ga += hg;

    if (hg > ag) {
      home.won++; away.lost++;
      home.points += 3;
    } else if (hg < ag) {
      away.won++; home.lost++;
      away.points += 3;
    } else {
      home.drawn++; away.drawn++;
      home.points += 1; away.points += 1;
    }
  }

  for (const s of byCode.values()) s.gd = s.gf - s.ga;
  return byCode;
}

// ----------------------------------------------------------------------------
// Tiebreaker comparators
// ----------------------------------------------------------------------------

/**
 * Compare two stat records on the OVERALL group criteria (a,b,c):
 *   points desc, goal-difference desc, goals-for desc.
 * Returns negative if `x` ranks ahead of `y`, positive if behind, 0 if level.
 */
function cmpOverall(x, y) {
  if (y.points !== x.points) return y.points - x.points;
  if (y.gd !== x.gd) return y.gd - x.gd;
  if (y.gf !== x.gf) return y.gf - x.gf;
  return 0;
}

/**
 * Compare two stat records on disciplinary (fair-play) points: LOWER is better.
 * Returns negative if `x` ahead, positive if behind, 0 if level.
 */
function cmpFairPlay(x, y) {
  return x.fairPlay - y.fairPlay;
}

/** Points-only comparator (more points first) — FIFA's first ranking criterion. */
function cmpPoints(x, y) {
  return y.points - x.points;
}

/**
 * FIFA World Ranking tiebreaker (criterion 7 for 2026; drawing of lots was
 * abolished). We do not yet carry the official FIFA ranking, so we PROXY it
 * with Elo (higher Elo = better rank). Swap in real ranks via team.worldRank.
 */
function cmpWorldRank(x, y) {
  if (x.worldRank != null && y.worldRank != null) return x.worldRank - y.worldRank;
  return (y.elo || 0) - (x.elo || 0);
}

// ----------------------------------------------------------------------------
// Head-to-head resolution
// ----------------------------------------------------------------------------

/**
 * Given a set of tied teams (stat records) and the full match list, compute the
 * head-to-head mini-table among ONLY those teams (matches where both sides are
 * in the tied set), and split them by h2h criteria:
 *   (d) h2h points, (e) h2h goal-difference, (f) h2h goals-for.
 *
 * Returns an array of "buckets": each bucket is an array of stat records that
 * remain tied after applying h2h. Buckets are ordered best->worst. A bucket of
 * length > 1 means h2h did not separate those teams and the caller must go on
 * to fair-play / lots.
 *
 * @param {Array<object>} tied  stat records (>=2) currently tied on (a,b,c)
 * @param {Array} allMatches    the group's full match list
 */
function headToHeadSplit(tied, allMatches) {
  const codes = new Set(tied.map((t) => t.code));
  const teamsSubset = tied.map((t) => ({ code: t.code, name: t.name, fairPlay: t.fairPlay }));
  const subMatches = allMatches.filter(
    (m) => m.played && codes.has(m.home) && codes.has(m.away)
  );
  const h2h = aggregate(teamsSubset, subMatches); // code -> h2h stats

  // Sort the tied teams by their h2h overall criteria.
  const ordered = [...tied].sort((a, b) => cmpOverall(h2h.get(a.code), h2h.get(b.code)));

  // Group consecutive teams that are still level on h2h (a,b,c).
  const buckets = [];
  let cur = [ordered[0]];
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const team = ordered[i];
    if (cmpOverall(h2h.get(prev.code), h2h.get(team.code)) === 0) {
      cur.push(team);
    } else {
      buckets.push(cur);
      cur = [team];
    }
  }
  buckets.push(cur);
  return buckets;
}

/**
 * Fully resolve an ordering of a set of tied stat records, applying the FIFA
 * sequence FROM the head-to-head step onward:
 *   (d-f) head-to-head, (g) fair-play, (h) drawing of lots (alpha fallback).
 *
 * The h2h step is recursive in spirit: if h2h splits the set into smaller tied
 * groups, each of those is re-resolved from h2h again on its own subset — but
 * because a smaller tied subset's h2h is computed only among its members, a set
 * that h2h could not split will not split on a re-run, so we proceed to
 * fair-play then lots for any bucket length > 1.
 *
 * @returns {Array<object>} ordered stat records (best first); each record may
 *          gain `tiedByLots:true`.
 */
function resolveTiedGroup(tied, allMatches) {
  if (tied.length === 1) return [tied[0]];

  // (d-f) head-to-head among exactly these tied teams.
  const buckets = headToHeadSplit(tied, allMatches);

  // If h2h fully kept them together (a single bucket of the same size), h2h has
  // failed to separate -> go to fair-play / lots for the whole set.
  if (buckets.length === 1 && buckets[0].length === tied.length) {
    return resolveByOverallThenDiscipline(tied);
  }

  // h2h produced >=2 buckets (a partial or full split). Resolve each bucket:
  //  - length 1: settled
  //  - length >1: these are tied on h2h too; recompute their OWN h2h subgroup
  //               first (FIFA: re-apply criteria to the still-tied subset), and
  //               if that still doesn't split, fair-play then lots.
  const result = [];
  for (const bucket of buckets) {
    if (bucket.length === 1) {
      result.push(bucket[0]);
    } else {
      result.push(...resolveStillTiedSubset(bucket, allMatches));
    }
  }
  return result;
}

/**
 * A subset that was tied within a larger h2h table. FIFA restarts the criteria
 * for the reduced subgroup. We recompute h2h among ONLY this subset; if that
 * splits them further we recurse, otherwise fair-play then lots.
 */
function resolveStillTiedSubset(subset, allMatches) {
  const buckets = headToHeadSplit(subset, allMatches);
  if (buckets.length === 1 && buckets[0].length === subset.length) {
    return resolveByOverallThenDiscipline(subset);
  }
  const result = [];
  for (const bucket of buckets) {
    if (bucket.length === 1) result.push(bucket[0]);
    else result.push(...resolveStillTiedSubset(bucket, allMatches));
  }
  return result;
}

/**
 * Resolve a set that head-to-head (criteria 1-3) could NOT separate, using the
 * FIFA 2026 fallback criteria in order:
 *   (4) overall goal difference, (5) overall goals scored,
 *   (6) fair-play/disciplinary points, (7) FIFA World Ranking.
 * Drawing of lots was abolished for 2026, and World Ranking is unique per team,
 * so this always produces a strict order.
 */
function resolveByOverallThenDiscipline(tied) {
  return [...tied].sort((a, b) => {
    const ov = cmpOverall(a, b); // points are equal here, so this is GD then GF
    if (ov !== 0) return ov;
    const fp = cmpFairPlay(a, b);
    if (fp !== 0) return fp;
    return cmpWorldRank(a, b);
  });
}

// ----------------------------------------------------------------------------
// Group standing
// ----------------------------------------------------------------------------

/**
 * Compute the full ranked standing of a group.
 *
 * @param {{name:string,teams:Array,matches:Array}} group
 * @returns {Array<object>} 4 (or N) stat records ordered 1st..last, each with a
 *          1-based `rank`, and possibly `tiedByLots:true`.
 */
export function computeGroupStanding(group) {
  const stats = aggregate(group.teams, group.matches);
  const all = [...stats.values()];

  // FIFA 2026: teams are first ordered by POINTS. Any set level on points is
  // resolved by the head-to-head cascade (criteria 1-3) and, only if that cannot
  // separate them, by overall GD -> overall GF -> fair-play -> FIFA World Ranking.
  // (For 2026, head-to-head OUTRANKS overall goal difference, and lots are gone.)
  all.sort(cmpPoints);

  const ranked = [];
  let i = 0;
  while (i < all.length) {
    let j = i + 1;
    while (j < all.length && all[j].points === all[i].points) j++;
    const tiedSlice = all.slice(i, j);
    if (tiedSlice.length === 1) {
      ranked.push(tiedSlice[0]);
    } else {
      ranked.push(...resolveTiedGroup(tiedSlice, group.matches));
    }
    i = j;
  }

  return ranked.map((s, idx) => ({
    code: s.code,
    name: s.name,
    played: s.played,
    won: s.won,
    drawn: s.drawn,
    lost: s.lost,
    gf: s.gf,
    ga: s.ga,
    gd: s.gd,
    points: s.points,
    fairPlay: s.fairPlay,
    elo: s.elo,
    rank: idx + 1,
  }));
}

// ----------------------------------------------------------------------------
// Third-place ranking across groups
// ----------------------------------------------------------------------------

/**
 * Rank the 3rd-place teams of all groups against each other.
 * Criteria: points -> GD -> goals-for -> disciplinary -> lots(alpha).
 *
 * @param {Array} groups  array of group objects (any count; WC2026 has 12)
 * @returns {Array<object>} all 3rd-place teams ranked best->worst, each with
 *          `group` (group name), `rank` (1-based), `qualifies` (true for top 8),
 *          and possibly `tiedByLots:true`.
 */
/**
 * Cross-group THIRD-PLACE comparator (negative => `a` ranks ABOVE `b`).
 * Third-place teams come from different groups and never met, so there is NO
 * head-to-head step. FIFA 2026 order: points -> overall GD -> overall GF ->
 * fair play -> FIFA World Ranking (drawing of lots abolished). Operates on
 * computeGroupStanding entries (which carry points/gd/gf/fairPlay/worldRank/elo).
 */
export function compareThirdPlace(a, b) {
  const o = cmpOverall(a, b); // points -> GD -> GF
  if (o !== 0) return o;
  const fp = cmpFairPlay(a, b);
  if (fp !== 0) return fp;
  return cmpWorldRank(a, b);
}

export function rankThirdPlaceTeams(groups) {
  const thirds = groups.map((g) => {
    const standing = computeGroupStanding(g);
    const third = standing.find((t) => t.rank === 3);
    return { ...third, group: g.name };
  });

  // Sort with the full cascade (see compareThirdPlace).
  thirds.sort(compareThirdPlace);

  return thirds.map((t, idx) => ({
    ...t,
    rank: idx + 1,
    qualifies: idx < 8,
  }));
}

// ----------------------------------------------------------------------------
// Scenario grid
// ----------------------------------------------------------------------------

const matchKey = (m) => `${m.home}-${m.away}`;

/** All scorelines 0-0 .. maxGoals-maxGoals, inclusive. */
function* scorelines(maxGoals) {
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      yield [h, a];
    }
  }
}

/**
 * Classify a scoreline for the team identified by `code` in a given match.
 * @returns {{result:'win'|'draw'|'loss', margin:number}} margin is the signed
 *          goal margin from the team's perspective (positive = ahead).
 */
function outcomeFor(code, match, hg, ag) {
  if (match.home === code) {
    const margin = hg - ag;
    return { result: margin > 0 ? 'win' : margin < 0 ? 'loss' : 'draw', margin };
  }
  // team is the away side
  const margin = ag - hg;
  return { result: margin > 0 ? 'win' : margin < 0 ? 'loss' : 'draw', margin };
}

/**
 * scenarioGrid — enumerate every scoreline combination for the unplayed
 * match(es) named by `upcomingMatchKeys`, holding played matches fixed, and
 * collapse the resulting WITHIN-GROUP ranks into a per-team summary.
 *
 * IMPORTANT: This asserts ONLY within-group rank (1/2/3/4). It says nothing
 * about 3rd-place qualification or knockout opponents (cross-group concerns).
 *
 * @param {object} group
 * @param {string[]} upcomingMatchKeys  1 or 2 keys `${home}-${away}` of unplayed matches
 * @param {number} [maxGoals=6]
 * @returns {object} {
 *   teams: { [code]: teamSummary },
 *   matches: [matchKey,...],          // the enumerated matches, in order
 *   describe(code): string,           // English digest for a team
 * }
 *
 * teamSummary shape:
 *   {
 *     code, name,
 *     ranks: number[],                // distinct ranks achievable (sorted)
 *     // single-match case:
 *     byOutcome: { win:{ranks,marginRules}, draw:{rank|ranks}, loss:{ranks,marginRules} }
 *     // two-match case:
 *     joint: [ { outcomes:[{key,result,margin?}...], rank } ... ]  // raw-ish, collapsed by rank
 *     needs: { rankN: <condition tree> }   // "what they need" digest per achievable rank
 *   }
 */
export function scenarioGrid(group, upcomingMatchKeys, maxGoals = 6) {
  if (!Array.isArray(upcomingMatchKeys) || upcomingMatchKeys.length < 1 || upcomingMatchKeys.length > 2) {
    throw new Error('upcomingMatchKeys must contain 1 or 2 match keys');
  }

  // Resolve the upcoming match objects (must exist and be unplayed).
  const upcoming = upcomingMatchKeys.map((key) => {
    const m = group.matches.find((mm) => matchKey(mm) === key);
    if (!m) throw new Error(`upcoming match not found: ${key}`);
    return m;
  });

  const playedMatches = group.matches.filter((m) => m.played);
  const teams = group.teams;

  // Enumerate. For each combination we build a synthetic match list = played +
  // the upcoming matches with assigned scores, compute the standing, and read
  // off each team's rank.
  //
  // We record, per combination, the full scoreline tuple and the resulting rank
  // for every team.
  const combos = []; // { scores:[[hg,ag],...], rankByCode:{code:rank} }

  const enumerate = (idx, acc) => {
    if (idx === upcoming.length) {
      const synthetic = playedMatches.concat(
        upcoming.map((m, k) => ({
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
      combos.push({ scores: acc.map((s) => s.slice()), rankByCode });
      return;
    }
    for (const sl of scorelines(maxGoals)) {
      acc.push(sl);
      enumerate(idx + 1, acc);
      acc.pop();
    }
  };
  enumerate(0, []);

  // Build per-team summaries.
  const teamSummaries = {};
  for (const team of teams) {
    teamSummaries[team.code] =
      upcoming.length === 1
        ? summarizeSingle(team, upcoming[0], combos, maxGoals)
        : summarizeDouble(team, upcoming, combos);
  }

  return {
    matches: upcoming.map(matchKey),
    teams: teamSummaries,
    describe(code) {
      const s = teamSummaries[code];
      if (!s) throw new Error(`unknown team: ${code}`);
      return s.description;
    },
  };
}

// --- single upcoming match -------------------------------------------------

/**
 * Collapse the grid for the SINGLE-match case for one team.
 *
 * For a team PLAYING in the match, outcome is win/draw/loss and within each
 * outcome rank can vary only by margin -> we collapse to margin thresholds.
 * For a team NOT playing, its rank can still vary with the scoreline (it affects
 * GD/GF of the two participants), so we map the participants' margin -> rank.
 */
function summarizeSingle(team, match, combos, maxGoals) {
  const code = team.code;
  const isPlaying = match.home === code || match.away === code;

  if (isPlaying) {
    // Group combos by outcome, then within outcome by team-margin -> rank.
    const buckets = { win: new Map(), draw: new Map(), loss: new Map() };
    for (const c of combos) {
      const [hg, ag] = c.scores[0];
      const { result, margin } = outcomeFor(code, match, hg, ag);
      const m = buckets[result];
      const rank = c.rankByCode[code];
      if (!m.has(margin)) m.set(margin, new Set());
      m.get(margin).add(rank);
    }

    const byOutcome = {};
    for (const result of ['win', 'draw', 'loss']) {
      byOutcome[result] = collapseMarginMap(buckets[result], result);
    }

    const ranks = collectRanks(combos, code);
    const description = describeSinglePlaying(byOutcome, maxGoals);
    return { code, name: team.name, isPlaying: true, ranks, byOutcome, description };
  }

  // Non-playing team: rank depends on the participants' result/margin.
  // Map (participantMargin from home perspective) -> set of ranks.
  const map = new Map();
  for (const c of combos) {
    const [hg, ag] = c.scores[0];
    const homeMargin = hg - ag; // signed, home perspective
    const rank = c.rankByCode[code];
    const keyM = homeMargin;
    if (!map.has(keyM)) map.set(keyM, new Set());
    map.get(keyM).add(rank);
  }
  const ranks = collectRanks(combos, code);
  // Collapse contiguous home-margins sharing the same rank-set into bands.
  const sortedM = [...map.entries()].sort((a, b) => a[0] - b[0]);
  const sig = (set) => [...set].sort((a, b) => a - b).join(',');
  const byMargin = [];
  let bStart = sortedM[0][0];
  let bSig = sig(sortedM[0][1]);
  let bRanks = [...sortedM[0][1]].sort((a, b) => a - b);
  let bPrev = sortedM[0][0];
  const flushBand = (end) => byMargin.push({ homeMarginLo: bStart, homeMarginHi: end, ranks: bRanks });
  for (let i = 1; i < sortedM.length; i++) {
    const [m, set] = sortedM[i];
    if (sig(set) === bSig && m === bPrev + 1) {
      bPrev = m;
    } else {
      flushBand(bPrev);
      bStart = m; bSig = sig(set); bRanks = [...set].sort((a, b) => a - b); bPrev = m;
    }
  }
  flushBand(bPrev);
  const description = describeNonPlaying(team, match, ranks, byMargin, maxGoals);
  return { code, name: team.name, isPlaying: false, ranks, byMargin, description };
}

/**
 * Given a Map<margin,Set<rank>> for a single outcome, collapse to clean rules.
 * In the common deterministic case each margin yields exactly one rank, so we
 * collapse contiguous margins that share a rank into threshold "runs".
 *
 * Margins are signed from the team's perspective: wins are positive (+1..+max),
 * losses negative (-1..-max), a draw is exactly 0. Each rule records `marginLo`
 * <= `marginHi` (the contiguous signed-margin span) and either a single `rank`
 * (deterministic run) or a `ranks` array (margin alone didn't decide — rare,
 * happens only when other-table lots intrude).
 */
function collapseMarginMap(marginMap, result) {
  if (marginMap.size === 0) return { possible: false, rules: [], ranks: [] };

  const entries = [...marginMap.entries()].sort((a, b) => a[0] - b[0]);
  const allRanks = new Set();
  for (const [, set] of entries) for (const r of set) allRanks.add(r);

  // Merge contiguous margins that share the SAME rank-set (singleton or tied)
  // into one threshold rule. A rule with one rank also exposes `.rank` for
  // convenience; a tied rule exposes only `.ranks`.
  const sig = (set) => [...set].sort((a, b) => a - b).join(',');
  const rules = [];
  let runStart = entries[0][0];
  let runSig = sig(entries[0][1]);
  let runRanks = [...entries[0][1]].sort((a, b) => a - b);
  let prevMargin = entries[0][0];
  const flush = (endMargin) => {
    const rule = { marginLo: runStart, marginHi: endMargin, ranks: runRanks };
    if (runRanks.length === 1) rule.rank = runRanks[0];
    rules.push(rule);
  };
  for (let i = 1; i < entries.length; i++) {
    const [m, set] = entries[i];
    if (sig(set) === runSig && m === prevMargin + 1) {
      prevMargin = m;
    } else {
      flush(prevMargin);
      runStart = m;
      runSig = sig(set);
      runRanks = [...set].sort((a, b) => a - b);
      prevMargin = m;
    }
  }
  flush(prevMargin);

  return {
    possible: true,
    ranks: [...allRanks].sort((a, b) => a - b),
    rules,
  };
}

function collectRanks(combos, code) {
  const s = new Set();
  for (const c of combos) s.add(c.rankByCode[code]);
  return [...s].sort((a, b) => a - b);
}

const ordinal = (n) =>
  n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;

const rankWord = (rank) => ordinal(rank);

/**
 * English digest for a team playing in a single decisive match, e.g.
 * "1st with any win; 2nd on a draw; 3rd if they lose by 1; 4th if they lose by 2+".
 */
function describeSinglePlaying(byOutcome, maxGoals) {
  const parts = [];
  if (byOutcome.win.possible) parts.push(...phrasesForOutcome(byOutcome.win, 'win', maxGoals));
  if (byOutcome.draw.possible) parts.push(...phrasesForOutcome(byOutcome.draw, 'draw', maxGoals));
  if (byOutcome.loss.possible) parts.push(...phrasesForOutcome(byOutcome.loss, 'loss', maxGoals));
  return parts.join('; ');
}

/**
 * Turn a collapsed outcome (win/draw/loss) into English phrases.
 *  - draw: a single margin (0); usually one rank, multiple only under lots.
 *  - win/loss: margin-threshold rules, ordered best-rank-first, with the rule
 *    that reaches the enumeration edge (|margin| === maxGoals) rendered as "N+".
 */
function phrasesForOutcome(outcome, result, maxGoals) {
  if (result === 'draw') {
    const ranks = outcome.ranks;
    if (ranks.length === 1) return [`${rankWord(ranks[0])} on a draw`];
    return [`${ranks.map(rankWord).join(' or ')} on a draw (depends on the other result)`];
  }

  const rules = outcome.rules;

  // Constant rank across the whole outcome -> "Nth with any win/loss".
  const allDeterministic = rules.every((r) => r.rank != null);
  const uniqueRanks = new Set(rules.flatMap((r) => (r.rank != null ? [r.rank] : r.ranks)));
  if (allDeterministic && uniqueRanks.size === 1) {
    const rank = [...uniqueRanks][0];
    return [`${rankWord(rank)} with any ${result}`];
  }

  // Order rules by goal-margin magnitude ascending (smallest margin first); this
  // reads naturally as the result gets more lopsided.
  const ordered = [...rules].sort((a, b) => Math.abs(a.marginLo) - Math.abs(b.marginLo));
  const verb = result === 'win' ? 'win' : 'lose';

  return ordered.map((r) => {
    const loMag = Math.abs(r.marginLo);
    const hiMag = Math.abs(r.marginHi);
    const lo = Math.min(loMag, hiMag);
    const hi = Math.max(loMag, hiMag);
    const reachesEdge = hi === maxGoals;
    let cond;
    if (lo === hi) cond = `if they ${verb} by ${lo}`;
    else if (reachesEdge) cond = `if they ${verb} by ${lo}+`;
    else cond = `if they ${verb} by ${lo}–${hi}`;
    const label = r.rank != null ? rankWord(r.rank) : r.ranks.map(rankWord).join('/');
    return `${label} ${cond}`;
  });
}

function describeNonPlaying(team, match, ranks, byMargin, maxGoals) {
  if (ranks.length === 1) {
    return `${rankWord(ranks[0])} regardless of ${match.home} v ${match.away}`;
  }
  // Summarize by participant (home-perspective) margin bands.
  const sideCond = (lo, hi) => {
    // lo<=hi signed home margins within the band.
    const band = (mLo, mHi, who, edge) => {
      const a = Math.abs(mLo), b = Math.abs(mHi);
      const x = Math.min(a, b), y = Math.max(a, b);
      if (x === y) return `${who} win by ${x}`;
      if (y === maxGoals && edge) return `${who} win by ${x}+`;
      return `${who} win by ${x}–${y}`;
    };
    if (lo === 0 && hi === 0) return 'a draw';
    if (lo > 0) return band(lo, hi, match.home, true);   // home wins
    if (hi < 0) return band(lo, hi, match.away, true);   // away wins
    // Band straddles 0: it covers a draw plus wins on one (or both) sides.
    const segs = [];
    if (lo < 0) segs.push(band(lo, -1, match.away, lo === -maxGoals)); // away-win part
    if (lo <= 0 && hi >= 0) segs.push('a draw');
    if (hi > 0) segs.push(band(1, hi, match.home, hi === maxGoals));   // home-win part
    return segs.join(' or ');
  };
  const parts = byMargin.map((b) =>
    `${b.ranks.map(rankWord).join('/')} on ${sideCond(b.homeMarginLo, b.homeMarginHi)}`
  );
  return parts.join('; ');
}

// --- two simultaneous upcoming matches -------------------------------------

/**
 * Collapse the grid for the TWO-match (final round) case for one team.
 *
 * We produce:
 *   joint: array of { outcomes, rank } where outcomes describes each match by
 *          result (and, where rank depends on it, margin) — collapsed so that
 *          all scorelines yielding the same rank for this team share an entry.
 *   needs: per achievable rank, a compact description of sufficient conditions.
 *
 * For readability we first reduce each match to (result, margin) from the
 * perspective of its HOME team, then group combos by (resultA, resultB) and,
 * within that, report the rank(s) and whether margin matters.
 */
function summarizeDouble(team, upcoming, combos) {
  const code = team.code;
  const [mA, mB] = upcoming;

  // Group by (homeResultA, homeResultB) coarse outcome; collect rank sets and
  // whether margins within that coarse cell affect the rank.
  const cells = new Map(); // key "rA|rB" -> { rA,rB, rankSet:Set, marginVaries:bool, detail:Map }
  for (const c of combos) {
    const [aHg, aAg] = c.scores[0];
    const [bHg, bAg] = c.scores[1];
    const rA = aHg > aAg ? 'win' : aHg < aAg ? 'loss' : 'draw'; // home A perspective
    const rB = bHg > bAg ? 'win' : bHg < bAg ? 'loss' : 'draw';
    const key = `${rA}|${rB}`;
    if (!cells.has(key)) cells.set(key, { rA, rB, rankSet: new Set(), detail: new Map() });
    const cell = cells.get(key);
    const rank = c.rankByCode[code];
    cell.rankSet.add(rank);
    // detail keyed by (marginA, marginB) for margin-sensitivity analysis
    const dk = `${aHg - aAg},${bHg - bAg}`;
    cell.detail.set(dk, rank);
  }

  const joint = [];
  for (const cell of cells.values()) {
    const ranks = [...cell.rankSet].sort((a, b) => a - b);
    const marginVaries = ranks.length > 1;
    joint.push({
      outcomes: [
        { key: matchKey(mA), home: mA.home, away: mA.away, result: cell.rA },
        { key: matchKey(mB), home: mB.home, away: mB.away, result: cell.rB },
      ],
      ranks,
      marginVaries,
    });
  }

  // "What they need": for each achievable rank, list the coarse outcome cells
  // where that rank is GUARANTEED (rank set === [rank]) vs merely possible.
  const ranks = collectRanks(combos, code);
  const needs = {};
  for (const rank of ranks) {
    const guaranteed = [];
    const possible = [];
    for (const j of joint) {
      if (j.ranks.length === 1 && j.ranks[0] === rank) guaranteed.push(j.outcomes);
      else if (j.ranks.includes(rank)) possible.push(j.outcomes);
    }
    needs[rank] = { guaranteed, possible };
  }

  const description = describeDouble(team, upcoming, ranks, joint);
  return { code, name: team.name, ranks, joint, needs, description };
}

function describeDouble(team, upcoming, ranks, joint) {
  const [mA, mB] = upcoming;
  const resultPhrase = (o) => {
    if (o.result === 'win') return `${o.home} beat ${o.away}`;
    if (o.result === 'loss') return `${o.away} beat ${o.home}`;
    return `${o.home}-${o.away} draw`;
  };
  // Build "rank: when ..." clauses, listing guaranteed coarse cells.
  const clauses = [];
  for (const rank of ranks) {
    const guaranteedCells = joint.filter((j) => j.ranks.length === 1 && j.ranks[0] === rank);
    if (guaranteedCells.length === 0) {
      clauses.push(`${rankWord(rank)} possible (margin-dependent)`);
      continue;
    }
    const cellPhrases = guaranteedCells.map((j) => j.outcomes.map(resultPhrase).join(' & '));
    clauses.push(`${rankWord(rank)} if: ${cellPhrases.join('  OR  ')}`);
  }
  return clauses.join(' | ');
}
