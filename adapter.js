// adapter.js — data layer feeding openfootball/worldcup.json into engine.js
//
// Exports:
//   fetchRaw()                  -> async; returns parsed openfootball object.
//                                  Reads cached data/raw/worldcup.json if present,
//                                  otherwise curls it and caches it.
//   toGroups(raw, teamsTable)   -> pure; 12 group objects in the ENGINE schema
//                                  (group-stage matches only).
//   nameToCode(teamsTable)      -> Map<openfootball name, FIFA code>.
//
// teamsTable is the parsed teams.json array: [{ name, code, elo }, ...].
//
// ENGINE schema produced:
//   group = { name, teams:[{code,name,elo}], matches:[{home,away,homeGoals,awayGoals,played}] }
//   home/away are TEAM CODES; played = (score.ft exists).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SOURCE_URL =
  'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';
const CACHE_PATH = 'data/raw/worldcup.json';
const MANUAL_PATH = 'manual-results.json';

/**
 * Fetch the openfootball World Cup object. Prefers the local cache so it works
 * offline; otherwise curls the source and writes the cache. In both cases any
 * locally-entered results in manual-results.json are merged on top (in memory).
 * @param {{ refresh?: boolean }} [opts] refresh:true forces a re-download.
 */
export async function fetchRaw(opts = {}) {
  let parsed;
  if (!opts.refresh && existsSync(CACHE_PATH)) {
    parsed = JSON.parse(await readFile(CACHE_PATH, 'utf8'));
  } else {
    const { stdout } = await execFileAsync('curl', ['-sL', SOURCE_URL], {
      maxBuffer: 32 * 1024 * 1024,
    });
    parsed = JSON.parse(stdout);
    await mkdir('data/raw', { recursive: true });
    await writeFile(CACHE_PATH, JSON.stringify(parsed, null, 2) + '\n');
  }
  return applyManualResults(parsed);
}

/**
 * Merge locally-entered final scores (manual-results.json) onto the feed, for
 * games that have finished but openfootball hasn't published yet. In-memory
 * only — never written to the cache. Once the feed publishes a match, the feed
 * value wins and the matching manual entry is ignored (we skip already-played
 * matches). Orientation is normalized: the manual entry's score is swapped if
 * the feed lists the two teams in the opposite order.
 */
async function applyManualResults(raw) {
  if (!existsSync(MANUAL_PATH)) return raw;
  let entries;
  try {
    entries = JSON.parse(await readFile(MANUAL_PATH, 'utf8'));
  } catch {
    return raw;
  }
  if (!Array.isArray(entries)) return raw;
  for (const e of entries) {
    const m = raw.matches.find(
      (mm) =>
        mm.group === e.group &&
        ((mm.team1 === e.team1 && mm.team2 === e.team2) ||
          (mm.team1 === e.team2 && mm.team2 === e.team1))
    );
    if (!m) continue;
    if (m.score && Array.isArray(m.score.ft)) continue; // feed already has it
    const reversed = m.team1 === e.team2;
    m.score = { ft: reversed ? [e.ft[1], e.ft[0]] : [e.ft[0], e.ft[1]], manual: true };
  }
  return raw;
}

/**
 * Build a Map from openfootball team name -> FIFA 3-letter code.
 * @param {Array<{name:string,code:string}>} teamsTable
 * @returns {Map<string,string>}
 */
export function nameToCode(teamsTable) {
  const map = new Map();
  for (const t of teamsTable) map.set(t.name, t.code);
  return map;
}

/** A match is a group-stage match iff it carries a "group" field. */
function isGroupMatch(m) {
  return typeof m.group === 'string' && /^Group [A-L]$/.test(m.group);
}

/** Played iff score.ft exists (a 2-element array). */
function isPlayed(m) {
  return !!(m.score && Array.isArray(m.score.ft) && m.score.ft.length === 2);
}

/**
 * Transform the raw openfootball object into the engine's array of group objects.
 * Group-stage matches only. Fails loudly on any unmapped team name.
 *
 * @param {object} raw           parsed openfootball worldcup.json
 * @param {Array<{name,code,elo}>} teamsTable  parsed teams.json
 * @returns {Array<object>}      12 group objects in engine schema
 */
export function toGroups(raw, teamsTable) {
  const codeOf = nameToCode(teamsTable);
  const eloOf = new Map(teamsTable.map((t) => [t.code, t.elo]));

  const resolve = (name) => {
    const code = codeOf.get(name);
    if (!code) throw new Error(`unmapped team name in raw data: "${name}"`);
    return code;
  };

  // group name -> { teams:Set<code>, matches:[] }
  const groups = new Map();
  const ensure = (name) => {
    if (!groups.has(name)) groups.set(name, { teamCodes: new Set(), matches: [] });
    return groups.get(name);
  };

  for (const m of raw.matches) {
    if (!isGroupMatch(m)) continue;
    const home = resolve(m.team1);
    const away = resolve(m.team2);
    const g = ensure(m.group);
    g.teamCodes.add(home);
    g.teamCodes.add(away);
    const played = isPlayed(m);
    g.matches.push({
      home,
      away,
      homeGoals: played ? m.score.ft[0] : null,
      awayGoals: played ? m.score.ft[1] : null,
      played,
      date: m.date ?? null,
      time: m.time ?? null,
      venue: m.ground ?? m.venue ?? null,
    });
  }

  const nameOf = new Map(teamsTable.map((t) => [t.code, t.name]));

  const result = [...groups.keys()].sort().map((name) => {
    const g = groups.get(name);
    const teams = [...g.teamCodes].sort().map((code) => ({
      code,
      name: nameOf.get(code),
      elo: eloOf.get(code),
    }));
    return { name, teams, matches: g.matches };
  });

  return result;
}
