// build-teams.mjs — generate teams.json from openfootball participants + eloratings.net
//
// Run:  node build-teams.mjs            (uses cached data/raw/worldcup.json + curls elo)
//
// Produces teams.json: [{ name, code, elo }, ...] for the 48 group-stage teams.
// Elo is scraped live from https://www.eloratings.net/2026.tsv (column 3 = elo code,
// column 4 = current rating). We map each openfootball team name -> FIFA 3-letter code
// and -> eloratings 2-letter code.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// name (exact openfootball string) -> { fifa: 3-letter FIFA code, elo2: eloratings 2-letter code }
const TEAM_MAP = {
  'Mexico':               { fifa: 'MEX', elo2: 'MX' },
  'South Africa':         { fifa: 'RSA', elo2: 'ZA' },
  'South Korea':          { fifa: 'KOR', elo2: 'KR' },
  'Czech Republic':       { fifa: 'CZE', elo2: 'CZ' },
  'Canada':               { fifa: 'CAN', elo2: 'CA' },
  'Bosnia & Herzegovina': { fifa: 'BIH', elo2: 'BA' },
  'Qatar':                { fifa: 'QAT', elo2: 'QA' },
  'Switzerland':          { fifa: 'SUI', elo2: 'CH' },
  'Brazil':               { fifa: 'BRA', elo2: 'BR' },
  'Morocco':              { fifa: 'MAR', elo2: 'MA' },
  'Haiti':                { fifa: 'HAI', elo2: 'HT' },
  'Scotland':             { fifa: 'SCO', elo2: 'SQ' },
  'USA':                  { fifa: 'USA', elo2: 'US' },
  'Paraguay':             { fifa: 'PAR', elo2: 'PY' },
  'Australia':            { fifa: 'AUS', elo2: 'AU' },
  'Turkey':               { fifa: 'TUR', elo2: 'TR' },
  'Germany':              { fifa: 'GER', elo2: 'DE' },
  'Curaçao':              { fifa: 'CUW', elo2: 'CW' },
  'Ivory Coast':          { fifa: 'CIV', elo2: 'CI' },
  'Ecuador':              { fifa: 'ECU', elo2: 'EC' },
  'Netherlands':          { fifa: 'NED', elo2: 'NL' },
  'Japan':                { fifa: 'JPN', elo2: 'JP' },
  'Sweden':               { fifa: 'SWE', elo2: 'SE' },
  'Tunisia':              { fifa: 'TUN', elo2: 'TN' },
  'Belgium':              { fifa: 'BEL', elo2: 'BE' },
  'Egypt':                { fifa: 'EGY', elo2: 'EG' },
  'Iran':                 { fifa: 'IRN', elo2: 'IR' },
  'New Zealand':          { fifa: 'NZL', elo2: 'NZ' },
  'Spain':                { fifa: 'ESP', elo2: 'ES' },
  'Cape Verde':           { fifa: 'CPV', elo2: 'CV' },
  'Saudi Arabia':         { fifa: 'KSA', elo2: 'SA' },
  'Uruguay':              { fifa: 'URU', elo2: 'UY' },
  'France':               { fifa: 'FRA', elo2: 'FR' },
  'Senegal':              { fifa: 'SEN', elo2: 'SN' },
  'Iraq':                 { fifa: 'IRQ', elo2: 'IQ' },
  'Norway':               { fifa: 'NOR', elo2: 'NO' },
  'Argentina':            { fifa: 'ARG', elo2: 'AR' },
  'Algeria':              { fifa: 'ALG', elo2: 'DZ' },
  'Austria':             { fifa: 'AUT', elo2: 'AT' },
  'Jordan':               { fifa: 'JOR', elo2: 'JO' },
  'Portugal':             { fifa: 'POR', elo2: 'PT' },
  'DR Congo':             { fifa: 'COD', elo2: 'CD' },
  'Uzbekistan':           { fifa: 'UZB', elo2: 'UZ' },
  'Colombia':             { fifa: 'COL', elo2: 'CO' },
  'England':              { fifa: 'ENG', elo2: 'EN' },
  'Croatia':              { fifa: 'CRO', elo2: 'HR' },
  'Ghana':                { fifa: 'GHA', elo2: 'GH' },
  'Panama':               { fifa: 'PAN', elo2: 'PA' },
};

const RAW_PATH = 'data/raw/worldcup.json';
const ELO_URL = 'https://www.eloratings.net/2026.tsv';

function loadRaw() {
  if (!existsSync(RAW_PATH)) {
    throw new Error(`missing ${RAW_PATH} — run the curl download first`);
  }
  return JSON.parse(readFileSync(RAW_PATH, 'utf8'));
}

function participants(raw) {
  const set = new Set();
  for (const m of raw.matches) {
    if (m.group) { set.add(m.team1); set.add(m.team2); }
  }
  return [...set];
}

function fetchEloTable() {
  // eloratings.net 2026.tsv: tab-separated, col index 2 = 2-letter code, col 3 = elo
  let tsv;
  try {
    tsv = execFileSync('curl', ['-sL', ELO_URL], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  } catch (e) {
    throw new Error('failed to curl eloratings.net: ' + e.message);
  }
  const map = new Map(); // 2-letter -> elo number
  for (const line of tsv.split('\n')) {
    const cols = line.split('\t');
    if (cols.length < 4) continue;
    const code = cols[2];
    const elo = Number(cols[3]);
    if (code && Number.isFinite(elo)) map.set(code, elo);
  }
  if (map.size < 50) throw new Error('elo table looks too small: ' + map.size);
  return map;
}

function main() {
  const raw = loadRaw();
  const names = participants(raw);
  if (names.length !== 48) throw new Error(`expected 48 participants, got ${names.length}`);

  const eloTable = fetchEloTable();
  const teams = [];
  const problems = [];
  for (const name of names) {
    const m = TEAM_MAP[name];
    if (!m) { problems.push(`no mapping for "${name}"`); continue; }
    const elo = eloTable.get(m.elo2);
    if (elo == null) { problems.push(`no elo for "${name}" (elo2=${m.elo2})`); continue; }
    teams.push({ name, code: m.fifa, elo });
  }
  if (problems.length) throw new Error('mapping problems:\n' + problems.join('\n'));

  // validate unique codes
  const codes = new Set(teams.map((t) => t.code));
  if (codes.size !== 48) throw new Error(`duplicate FIFA codes: ${codes.size} unique of ${teams.length}`);

  teams.sort((a, b) => b.elo - a.elo);
  writeFileSync('teams.json', JSON.stringify(teams, null, 2) + '\n');
  console.log(`wrote teams.json: ${teams.length} teams, elo range ${teams[teams.length-1].elo}..${teams[0].elo}`);
}

main();
