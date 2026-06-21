// build-html.mjs
// Build a SELF-CONTAINED single-file 2026 World Cup bracket web app.
//
// Reads engine.js / allocation.js / model.js, strips ES import/export syntax,
// concatenates them into ONE classic-script bundle in a shared scope, bakes in
// the live data (teams / bracket / allocation / current groups via the adapter),
// computes a freshness object, injects the UI, and writes dist/index.html.
//
// Re-runnable: a data refresh = re-run this build -> redeploy the same Artifact.
//
//   node build-html.mjs            # uses cached data/raw/worldcup.json
//   node build-html.mjs --refresh  # forces a fresh openfootball download
//
// NO external resources end up in the output: all CSS/JS inline, all data baked.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { toGroups, fetchRaw } from './adapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readText = (f) => readFile(join(__dirname, f), 'utf8');
const loadJSON = async (f) => JSON.parse(await readText(f));

// ----------------------------------------------------------------------------
// ES module syntax stripping
// ----------------------------------------------------------------------------
// engine.js + allocation.js + model.js are pure ES modules. We want one classic
// <script> where all their functions live in the same scope and call each other.
//
//   - Drop every `import ... from '...'` line (engine has none; model imports
//     from engine; allocation imports node:fs/url/path which we replace).
//   - Turn `export function`/`export const` into plain declarations.
//   - allocation.js reads allocation.json off disk via fs; in the browser we
//     instead read a baked-in global. We replace its file-reading getAllocation
//     body with a return of the embedded table.

function stripModuleSyntax(src) {
  let s = src;
  // Remove static import statements (single or multi-line up to the terminating ;).
  // Matches: import X from 'y';  /  import { a, b } from "y";  / import 'y';
  s = s.replace(/^\s*import\s+[^;]*?;\s*$/gm, '');
  s = s.replace(/^\s*import\s*\{[\s\S]*?\}\s*from\s*[^;]*;\s*$/gm, '');
  // Remove bare import of side-effects across lines too.
  s = s.replace(/^\s*import\s+[\s\S]*?from\s*['"][^'"]*['"];\s*$/gm, '');
  // Strip leading `export ` from declarations (function/const/let/var/class).
  s = s.replace(/^\s*export\s+(function|const|let|var|class|async)\b/gm, '$1');
  // Strip any standalone `export { ... };` re-export blocks.
  s = s.replace(/^\s*export\s*\{[\s\S]*?\};\s*$/gm, '');
  return s;
}

// Wrap a self-contained ES module in an IIFE so its top-level declarations stay
// PRIVATE (avoids collisions like `COARSE`/`matchKey` shared across modules),
// while EXPORTING the named symbols out to the shared bundle scope. Any free
// references the module makes (e.g. computeGroupStanding) resolve up the scope
// chain to the already-inlined engine — IIFEs are closures, so that still works.
//
//   exportNames: array of identifiers the module's `export` declared.
// Produces:
//   var __m = (function(){
//     <module body with import/export stripped>
//     return { name1: name1, name2: name2 };
//   })();
//   var name1 = __m.name1, name2 = __m.name2;
// The IIFE return reads the INNER (private) declarations; the outer vars expose
// only the chosen exports. No inner top-level name leaks to the shared scope, so
// collisions like COARSE/matchKey across modules are impossible.
function wrapModuleIIFE(src, exportNames, holder) {
  const body = stripModuleSyntax(src);
  const ret = exportNames.map((n) => `${n}: ${n}`).join(', ');
  const outer = exportNames.map((n) => `${n} = ${holder}.${n}`).join(', ');
  return `var ${holder} = (function(){\n${body}\nreturn { ${ret} };\n})();\nvar ${outer};`;
}

// Replace allocation.js's filesystem-backed getAllocation with the baked table.
function patchAllocation(src) {
  let s = stripModuleSyntax(src);
  // Remove the now-orphaned __dirname line referencing fileURLToPath/import.meta.
  s = s.replace(/^\s*const\s+__dirname\s*=.*$/gm, '');
  // Replace the getAllocation function body to read from the embedded global.
  // Original body parses a file; we swap in the baked-in object.
  s = s.replace(
    /function getAllocation\(\)\s*\{[\s\S]*?\n\}/,
    'function getAllocation() {\n  return __ALLOCATION__;\n}'
  );
  return s;
}

// ----------------------------------------------------------------------------
// Freshness derivation
// ----------------------------------------------------------------------------
// Sort all PLAYED matches (group + knockout) chronologically by date + time
// (time carries a UTC offset like "19:00 UTC-4") and read off the latest.
function matchEpoch(m) {
  const mm = /(\d{1,2}):(\d{2})\s*UTC\s*([+-]\d+)?/.exec(m.time || '');
  let hh = 0;
  let mi = 0;
  let off = 0;
  if (mm) {
    hh = +mm[1];
    mi = +mm[2];
    off = mm[3] ? +mm[3] : 0;
  }
  const [Y, Mo, D] = (m.date || '1970-01-01').split('-').map(Number);
  // Local clock at offset `off` -> UTC epoch.
  return Date.UTC(Y, (Mo || 1) - 1, D || 1, hh - off, mi);
}

function isPlayed(m) {
  return !!(m.score && Array.isArray(m.score.ft) && m.score.ft.length === 2);
}

function computeFreshness(raw) {
  const played = raw.matches.filter(isPlayed).slice().sort((a, b) => matchEpoch(a) - matchEpoch(b));
  const last = played[played.length - 1];
  const dataThrough = last
    ? `${last.team1} ${last.score.ft[0]}-${last.score.ft[1]} ${last.team2}`
    : '(no matches played yet)';
  return {
    dataThrough,
    lastDate: last ? last.date : null,
    playedCount: played.length,
    totalCount: 104,
    builtAtISO: new Date().toISOString(),
  };
}

// ----------------------------------------------------------------------------
// Build
// ----------------------------------------------------------------------------
async function main() {
  const refresh = process.argv.includes('--refresh');

  const [engineSrc, allocationSrc, modelSrc, scenarioSummarySrc, groupSituationSrc] = await Promise.all([
    readText('engine.js'),
    readText('allocation.js'),
    readText('model.js'),
    readText('scenario-summary.js'),
    readText('group-situation.js'),
  ]);

  const [teams, bracket, allocation] = await Promise.all([
    loadJSON('teams.json'),
    loadJSON('bracket.json'),
    loadJSON('allocation.json'),
  ]);

  const raw = await fetchRaw({ refresh });
  const groups = toGroups(raw, teams);
  const freshness = computeFreshness(raw);

  // Build the bundle: engine first (no deps), then allocation (patched), then
  // model (depends on engine functions, now in-scope).
  const engineBundle = stripModuleSyntax(engineSrc);
  const allocationBundle = patchAllocation(allocationSrc);
  const modelBundle = stripModuleSyntax(modelSrc);
  // These two analyzers are wrapped in IIFEs so their private top-level consts
  // (COARSE, matchKey, ordinal, MAX_GOALS, …) don't collide with each other or
  // with engine/model; only their public exports are hoisted to the bundle scope.
  const scenarioSummaryBundle = wrapModuleIIFE(scenarioSummarySrc, ['summarizeGroup', '__test'], '__scnSummaryMod');
  const groupSituationBundle = wrapModuleIIFE(groupSituationSrc, ['groupSituation'], '__grpSituationMod');

  const logicBundle = [
    '/* ===== engine.js ===== */',
    engineBundle,
    '/* ===== allocation.js (filesystem read replaced by baked table) ===== */',
    allocationBundle,
    '/* ===== model.js ===== */',
    modelBundle,
    '/* ===== scenario-summary.js (summarizeGroup; final-round analyzer) ===== */',
    scenarioSummaryBundle,
    '/* ===== group-situation.js (groupSituation; pre-final analyzer) ===== */',
    groupSituationBundle,
  ].join('\n\n');

  // Sanity: no leftover module tokens in the bundled LOGIC.
  // (We deliberately scope this check to the engine bundle, not the whole HTML,
  //  because the embedded JSON / UI text may legitimately contain those words.)
  const leftover = [];
  if (/^\s*import\s/m.test(logicBundle)) leftover.push('import');
  if (/^\s*export\s/m.test(logicBundle)) leftover.push('export');
  if (leftover.length) {
    throw new Error(`module syntax not fully stripped: ${leftover.join(', ')}`);
  }
  // Verify it parses as a function body (classic script scope).
  try {
    // eslint-disable-next-line no-new-func
    new Function(`${logicBundle}\nreturn typeof monteCarlo === 'function' && typeof computeGroupStanding === 'function' && typeof resolveThirdPlaceSlots === 'function' && typeof summarizeGroup === 'function' && typeof groupSituation === 'function';`);
  } catch (e) {
    throw new Error(`bundled logic failed to parse: ${e.message}`);
  }

  const data = { teams, bracket, allocation, groups, freshness };

  const html = renderHTML(logicBundle, data);

  await mkdir(join(__dirname, 'dist'), { recursive: true });
  const outPath = join(__dirname, 'dist', 'index.html');
  await writeFile(outPath, html);

  // -------- report --------
  const bytes = Buffer.byteLength(html, 'utf8');
  console.log(`Wrote dist/index.html  (${(bytes / 1024).toFixed(1)} KiB)`);
  console.log(`Data through: ${freshness.dataThrough}`);
  console.log(`Played: ${freshness.playedCount}/${freshness.totalCount}   built ${freshness.builtAtISO}`);
  console.log(`Logic bundle: ${(Buffer.byteLength(logicBundle, 'utf8') / 1024).toFixed(1)} KiB`);

  // Self-check: no http(s) resource refs, has embedded JSON, plausible size.
  const httpRefs = (html.match(/\bhttps?:\/\//g) || []).length;
  console.log(`http(s):// occurrences in output: ${httpRefs} (expect 0)`);
  console.log(`embeds __APP_DATA__: ${html.includes('__APP_DATA__')}`);
}

// ----------------------------------------------------------------------------
// HTML template + UI (inline CSS + inline app JS)
// ----------------------------------------------------------------------------
function renderHTML(logicBundle, data) {
  // Safe JSON embedding: escape </script and U+2028/2029.
  const embed = (obj) =>
    JSON.stringify(obj)
      .replace(/</g, '\u003c')
      .replace(/>/g, '\u003e')
      .replace(new RegExp(String.fromCharCode(0x2028),'g'), '\u2028')
      .replace(new RegExp(String.fromCharCode(0x2029),'g'), '\u2029');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>2026 World Cup Bracket Projector</title>
<style>
${CSS}
</style>
</head>
<body>
<div id="app"></div>

<script>
"use strict";
/* ============================================================================
   BAKED DATA
   ========================================================================== */
var __ALLOCATION__ = ${embed(data.allocation)};
var __APP_DATA__ = {
  teams: ${embed(data.teams)},
  bracket: ${embed(data.bracket)},
  groups: ${embed(data.groups)},
  freshness: ${embed(data.freshness)}
};

/* ============================================================================
   DETERMINISTIC ENGINE + ALLOCATION + MONTE-CARLO MODEL
   (engine.js, allocation.js, model.js inlined into one shared scope)
   ========================================================================== */
${logicBundle}

/* ============================================================================
   WORKER SOURCE (built from a Blob) — runs monteCarlo off the main thread.
   We stringify the same logic bundle + a tiny message handler.
   ========================================================================== */
var __WORKER_SRC__ = ${'`'}
${logicBundle.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}

self.onmessage = function (e) {
  var d = e.data;
  var groups = d.groups;
  // rebuild hostCodes Set (Sets don't survive structured clone of our payload shape)
  var hostCodes = new Set(d.hostCodes || []);
  var opts = {
    n: d.n, seed: d.seed,
    hostCodes: hostCodes,
    topCandidates: d.topCandidates || 6,
    resolveThirdPlaceSlots: function (letters, bracket) {
      return resolveThirdPlaceSlots(letters, bracket);
    }
  };
  try {
    var mc = monteCarlo(groups, d.bracket, opts);
    self.postMessage({ ok: true, mc: mc });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err && err.stack || err) });
  }
};
${'`'};

/* ============================================================================
   APP UI
   ========================================================================== */
${APP_JS}
</script>
</body>
</html>
`;
}

// ---- inline CSS ------------------------------------------------------------
const CSS = String.raw`
:root{
  --bg:#0f1115; --panel:#171a21; --panel2:#1d212b; --line:#2a2f3a;
  --txt:#e7eaf0; --dim:#9aa3b2; --dim2:#6b7280;
  --accent:#4ea1ff; --good:#34d27b; --warn:#f0b429; --bad:#ef5e5e;
  --qual:#13351f; --qualline:#1f6b3a;
  --chip:#222733;
  --r32:#3a6ea5; --r16:#5a7d3a; --qf:#8a5a2a; --sf:#7a3a6a; --fin:#a04040;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--txt);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  font-size:15px;line-height:1.4;overflow-x:hidden;-webkit-text-size-adjust:100%}
a{color:var(--accent)}
#app{max-width:1280px;margin:0 auto;padding:12px 14px 80px}
h1{font-size:20px;margin:0 0 2px}
h2{font-size:16px;margin:18px 0 8px;font-weight:650}
.muted{color:var(--dim)}
.tiny{font-size:12px}
.fresh{background:var(--panel);border:1px solid var(--line);border-radius:10px;
  padding:10px 12px;margin:8px 0 12px;font-size:13px}
.fresh b{color:var(--txt)}
.fresh .note{color:var(--warn);margin-top:4px;font-size:12px}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.spacer{flex:1}

/* tabs + toggles */
.tabbar{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 4px}
.tab{background:var(--panel);border:1px solid var(--line);color:var(--dim);
  padding:7px 12px;border-radius:8px;cursor:pointer;font-size:13px}
.tab.active{background:var(--panel2);color:var(--txt);border-color:var(--accent)}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.seg button{background:var(--panel);color:var(--dim);border:0;padding:7px 14px;
  cursor:pointer;font-size:13px}
.seg button.on{background:var(--accent);color:#06203f;font-weight:650}
.btn{background:var(--panel2);border:1px solid var(--line);color:var(--txt);
  padding:6px 12px;border-radius:8px;cursor:pointer;font-size:13px}
.btn:hover{border-color:var(--accent)}
.btn.warn{border-color:var(--warn)}

.section{display:none}
.section.active{display:block}

/* bracket — now rendered as inline SVG (single source of truth on-screen) */
.bracket-wrap{overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;
  border:1px solid var(--line);border-radius:10px;background:var(--panel);padding:10px}
.bracket-wrap svg.bracket-svg{display:block}
/* SVG slot interactivity (geometry/colors are inline attrs so it serializes standalone) */
.bracket-svg .slot-hit{cursor:pointer}
.bracket-svg .slot-hit:hover .slot-bg{fill:#232836}

/* export controls */
.export-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0 4px}
.export-bar .lbl{color:var(--dim);font-size:12px;margin-right:2px}

/* candidate popover */
.pop{position:fixed;z-index:50;background:var(--panel2);border:1px solid var(--accent);
  border-radius:10px;padding:8px;min-width:200px;max-width:80vw;
  box-shadow:0 10px 40px rgba(0,0,0,.6)}
.pop h4{margin:0 0 6px;font-size:12px;color:var(--dim)}
.pop .cand{display:flex;gap:8px;align-items:center;padding:5px 6px;border-radius:6px;cursor:pointer}
.pop .cand:hover{background:#2a3242}
.pop .cand .code{font-weight:700;min-width:38px}
.pop .cand .nm{flex:1;color:var(--dim);font-size:12px}
.pop .cand .p{color:var(--accent);font-variant-numeric:tabular-nums}
.pop .x{position:absolute;top:4px;right:8px;color:var(--dim);cursor:pointer;font-size:16px}

/* group tables */
.groups-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:12px}
.gcard{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 10px}
.gcard h3{margin:2px 0 6px;font-size:14px}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{padding:4px 5px;text-align:right}
th:nth-child(2),td:nth-child(2){text-align:left}
th{color:var(--dim);font-weight:600;border-bottom:1px solid var(--line)}
td{border-bottom:1px solid #20242e}
tr.q1 td,tr.q2 td{background:var(--qual)}
tr.q1 td:first-child,tr.q2 td:first-child{box-shadow:inset 3px 0 0 var(--qualline)}
.lots{color:var(--warn);cursor:help}
.thirds{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin-top:8px}
.thirds .cut{border-top:2px dashed var(--warn);margin:4px 0;position:relative}
.thirds .cut span{position:absolute;right:0;top:-9px;background:var(--panel);
  color:var(--warn);font-size:10px;padding:0 4px}
.thirds .trow{display:flex;gap:8px;padding:3px 4px;font-size:12.5px;border-bottom:1px solid #20242e}
.thirds .trow.qual{color:var(--good)}
.thirds .trow .g{min-width:62px;color:var(--dim)}
.thirds .trow .cd{font-weight:700;min-width:40px}
.thirds .trow .st{flex:1;text-align:right;color:var(--dim);font-variant-numeric:tabular-nums}

/* score editor */
.editor{display:flex;align-items:center;gap:4px;font-size:12px;margin:3px 0;
  padding:3px 5px;background:var(--panel2);border-radius:6px}
.editor .vs{color:var(--dim)}
.editor .stepper{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:6px}
.editor .stepper button{background:var(--panel);border:0;color:var(--txt);width:22px;height:24px;cursor:pointer;font-size:14px}
.editor .stepper input{width:26px;height:24px;background:#0c0e12;border:0;color:var(--txt);text-align:center;font-size:13px}
.editor .lbl{min-width:34px;font-weight:700}
.editor.played{opacity:.85}
.editor .tag{font-size:10px;color:var(--dim2)}
.manual-add{margin-top:6px}
.manual-add input.team{width:70px}

/* scenario */
.scn-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
select,input[type=number],input[type=text]{background:#0c0e12;color:var(--txt);
  border:1px solid var(--line);border-radius:6px;padding:6px 8px;font-size:13px}
.scn-card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.scn-team{padding:8px 6px;border-bottom:1px solid #20242e}
.scn-team:last-child{border-bottom:0}
.scn-team .h{display:flex;gap:8px;align-items:baseline}
.scn-team .h .cd{font-weight:700}
.scn-team .h .nm{color:var(--dim);font-size:12px}
.scn-team .desc{color:var(--txt);font-size:13px;margin-top:3px}
.scn-note{color:var(--warn);font-size:12px;margin:8px 0}
.scn-stage{font-size:14px;margin:2px 0 8px;color:var(--txt)}
.scn-stage b{color:var(--txt)}
.scn-chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 12px}
.gchip{background:var(--panel);border:1px solid var(--line);color:var(--dim);
  width:34px;height:34px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:700}
.gchip.on{background:var(--panel2);color:var(--txt);border-color:var(--accent)}
.scn-headline{font-weight:650;font-size:13px;color:var(--txt);margin-top:3px}
.scn-elo{margin-top:5px;font-size:11px;color:var(--dim)}
.scn-elo .lbl{display:inline-block;color:var(--dim2);text-transform:uppercase;letter-spacing:.5px;font-size:10px;margin-right:6px}
.scn-bar{display:inline-flex;width:160px;max-width:60%;height:8px;border-radius:4px;overflow:hidden;vertical-align:middle;background:#0c0e12;border:1px solid var(--line)}
.scn-bar .seg{display:block;height:100%}
.scn-legend{margin-top:3px;color:var(--dim);font-size:10.5px}
.scn-legend .lg{white-space:nowrap}
.scn-legend .lg i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:3px;vertical-align:baseline}
.scn-next{margin-top:10px;border-top:1px solid #20242e;padding-top:8px}
.scn-triggers{margin:4px 0 0;padding-left:18px;font-size:13px;color:var(--txt)}
.scn-triggers li{margin:3px 0}
.callout{background:#11151c;border-left:3px solid var(--accent);padding:8px 10px;border-radius:0 8px 8px 0;font-size:13px;color:var(--dim);margin:6px 0}

details.about{margin-top:18px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 12px}
details.about summary{cursor:pointer;color:var(--dim);font-size:13px}
details.about p{font-size:12.5px;color:var(--dim);margin:8px 0}

.simstate{display:inline-flex;align-items:center;gap:8px;color:var(--dim);font-size:13px}
.spinner{width:14px;height:14px;border:2px solid var(--line);border-top-color:var(--accent);
  border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

@media(max-width:680px){
  #app{padding:10px 10px 80px}
  .groups-grid{grid-template-columns:1fr}
  h1{font-size:18px}
}

/* ---- print / Save-as-PDF: lay the full bracket out un-scrolled, landscape ---- */
@media print{
  @page{ size:landscape; margin:8mm; }
  html,body{ background:#0f1115 !important; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  #app{ max-width:none; padding:0; }
  /* hide everything that isn't the bracket export region (SVG carries its own title) */
  .export-bar, .tabbar, .seg, .row, details.about, .callout, .simstate, .app-header{ display:none !important; }
  /* show only the bracket section; let the SVG scale to the page width */
  .section{ display:none !important; }
  .section.print-bracket{ display:block !important; }
  .bracket-wrap{ overflow:visible !important; border:0 !important; padding:0 !important; }
  .bracket-svg{ width:100% !important; height:auto !important; }
}

/* ---- poster mode (?poster=1): full natural width, no scroll clip, for hi-res capture ---- */
body.poster{ overflow:visible; }
body.poster #app{ max-width:none; padding:18px 20px; width:max-content; }
body.poster .export-bar, body.poster .tabbar, body.poster .seg, body.poster .row,
body.poster details.about, body.poster .callout, body.poster .simstate,
body.poster .app-header{ display:none !important; }
body.poster .bracket-wrap{ overflow:visible !important; border:0; background:transparent; padding:0; }
`;

// ---- inline app JS ---------------------------------------------------------
// This is the browser-side controller. It assumes the engine/model functions
// (computeGroupStanding, rankThirdPlaceTeams, scenarioGrid, monteCarlo,
// resolveThirdPlaceSlots) are already in scope from the inlined bundle.
const APP_JS = String.raw`
(function(){
  var DATA = __APP_DATA__;
  var TEAMS = DATA.teams;
  var BRACKET = DATA.bracket;
  var FRESH = DATA.freshness;
  var HOSTS = ['USA','MEX','CAN'];
  var SIM_N = 10000;
  var SIM_SEED = 12345;

  // team lookups
  var nameByCode = {}, eloByCode = {};
  TEAMS.forEach(function(t){ nameByCode[t.code]=t.name; eloByCode[t.code]=t.elo; });

  // code -> group letter (A..L), from the embedded groups data (each group's
  // teams[].code). Used by R32 seed labels to highlight which group a projected
  // third-place occupant comes from.
  var groupLetterByCode = {};
  DATA.groups.forEach(function(g){
    var mm=/Group\s+([A-L])/i.exec(g.name); var L=mm?mm[1].toUpperCase():g.name.slice(-1);
    (g.teams||[]).forEach(function(t){ groupLetterByCode[t.code]=L; });
  });

  // deterministic-ish color accent per team code (subtle, no flags)
  function accentFor(code){
    if(!code) return '#6b7280';
    var h=0; for(var i=0;i<code.length;i++) h=(h*31+code.charCodeAt(i))>>>0;
    var hue=h%360; return 'hsl('+hue+',45%,52%)';
  }

  // ---- working state ----
  // groups: deep clone we may mutate in My Picks mode (manual scores).
  function cloneGroups(gs){
    return gs.map(function(g){
      return { name:g.name, teams:g.teams.map(function(t){return {code:t.code,name:t.name,elo:t.elo};}),
        matches:g.matches.map(function(m){return {home:m.home,away:m.away,homeGoals:m.homeGoals,awayGoals:m.awayGoals,played:m.played, manual:m.manual||false};}) };
    });
  }
  var baseGroups = DATA.groups;            // pristine (feed)
  var workGroups = cloneGroups(baseGroups);// editable in My Picks

  // ?poster=1 → hi-res capture layout: full natural width, no scroll clip,
  // bracket-only, projected mode. Honored by export-image.mjs.
  var POSTER = /[?&]poster=1\b/.test(location.search);
  if(POSTER){ document.body.classList.add('poster'); }

  var state = {
    mode:'projected',          // 'projected' | 'picks'
    tab:'bracket',             // bracket | groups | scenario
    mc:null,                   // last monteCarlo result (projected)
    simming:false,
    picks:{}                   // matchNo -> winning code (knockout picks)
  };

  // ---------- formatting ----------
  function pct(p){ if(p>=0.995) return '99%'; if(p<=0.005&&p>0) return '<1%'; var v=p*100; return (v>=10? Math.round(v): (Math.round(v*10)/10))+'%'; }
  function pct1(p){ return (Math.round(p*1000)/10).toFixed(1)+'%'; }
  function esc(s){ return String(s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); }
  function localBuilt(iso){ try{ var d=new Date(iso); return d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}); }catch(e){ return iso; } }

  // ---------- group helpers ----------
  function letterOf(g){ var m=/Group\s+([A-L])/i.exec(g.name); return m?m[1].toUpperCase():g.name.slice(-1); }
  function groupsForCompute(){ return state.mode==='picks'? workGroups : baseGroups; }

  // ====================================================================
  // MONTE CARLO (Projected mode) — Web Worker w/ synchronous fallback
  // ====================================================================
  var worker=null, workerBroken=false;
  function buildWorker(){
    if(worker||workerBroken) return worker;
    try{
      var blob=new Blob([__WORKER_SRC__],{type:'text/javascript'});
      worker=new Worker(URL.createObjectURL(blob));
    }catch(e){ workerBroken=true; worker=null; }
    return worker;
  }

  function runProjection(){
    state.simming=true; render();
    var groups=groupsForCompute();
    var payload={ groups:groups, bracket:BRACKET, n:SIM_N, seed:SIM_SEED,
      hostCodes:HOSTS, topCandidates:6 };
    var w=buildWorker();
    if(w){
      w.onmessage=function(ev){
        if(ev.data&&ev.data.ok){ state.mc=ev.data.mc; }
        else { /* worker failed -> fall back */ workerBroken=true; try{w.terminate();}catch(_){} worker=null; state.mc=syncMonte(groups); }
        state.simming=false; render();
      };
      w.onerror=function(){ workerBroken=true; try{w.terminate();}catch(_){} worker=null;
        state.mc=syncMonte(groups); state.simming=false; render(); };
      w.postMessage(payload);
    } else {
      // synchronous fallback (briefly blocks UI)
      setTimeout(function(){ state.mc=syncMonte(groups); state.simming=false; render(); }, 20);
    }
  }
  function syncMonte(groups){
    return monteCarlo(groups, BRACKET, { n:SIM_N, seed:SIM_SEED,
      hostCodes:new Set(HOSTS), topCandidates:6, resolveThirdPlaceSlots:resolveThirdPlaceSlots });
  }

  // ====================================================================
  // MY PICKS — deterministic resolution of the bracket given current
  // standings + user-forced knockout winners; unknown remainder via the
  // modal team from a quick sim (so empty slots still show a likely team).
  // ====================================================================
  function deterministicBracket(){
    // 1. standings from current (possibly edited) groups
    var groups=groupsForCompute();
    var winners={}, runners={};
    groups.forEach(function(g){
      var L=letterOf(g); var st=computeGroupStanding(g);
      st.forEach(function(s){ if(s.rank===1) winners[L]=s.code; else if(s.rank===2) runners[L]=s.code; });
    });
    // 2. third-place qualification + Annex C (only if all 12 groups complete enough
    //    to rank thirds; engine handles partials but allocation needs 8 letters)
    var thirdByLetter={}, thirdSlots=null, allocOK=false;
    try{
      var thirds=rankThirdPlaceTeams(groups);
      var qualLetters=[];
      thirds.filter(function(t){return t.qualifies;}).forEach(function(t){
        var L=/Group\s+([A-L])/i.exec(t.group)[1].toUpperCase();
        thirdByLetter[L]=t.code; qualLetters.push(L);
      });
      if(qualLetters.length===8){
        thirdSlots=resolveThirdPlaceSlots(qualLetters, BRACKET); allocOK=true;
      }
    }catch(e){ allocOK=false; }
    var thirdForMatch={};
    if(allocOK&&thirdSlots){ thirdSlots.forEach(function(s){ thirdForMatch[s.match]=thirdByLetter[s.group]; }); }

    // group-stage completeness: every group match played?
    var allGroupDone = groups.every(function(g){ return g.matches.every(function(m){return m.played;}); });

    function slotCode(side, matchNo){
      if(side.type==='winner') return winners[side.group]||null;
      if(side.type==='runnerup') return runners[side.group]||null;
      if(side.type==='third') return thirdForMatch[matchNo]||null;
      return null;
    }

    // R32 fixtures (known where group complete)
    var slotByMatch={}; // matchNo -> {home,away}
    BRACKET.rounds.R32.forEach(function(m){
      slotByMatch[m.match]={ home:slotCode(m.home,m.match), away:slotCode(m.away,m.match) };
    });

    // winner of each match: user pick overrides; else null (unknown)
    var winnerOf={};
    function resolveWinner(matchNo){
      if(state.picks[matchNo]) return state.picks[matchNo];
      return null;
    }
    // propagate through rounds
    var order=['R32','R16','QF','SF','Final'];
    order.forEach(function(rd){
      (BRACKET.rounds[rd]||[]).forEach(function(m){
        if(rd!=='R32'){
          var h=m.home.type==='winnerOf'? winnerOf[m.home.match] : null;
          var a=m.away.type==='winnerOf'? winnerOf[m.away.match] : null;
          slotByMatch[m.match]={ home:h, away:a };
        }
        winnerOf[m.match]=resolveWinner(m.match);
      });
    });

    return { slotByMatch:slotByMatch, winnerOf:winnerOf, allGroupDone:allGroupDone, allocOK:allocOK };
  }

  // ====================================================================
  // RENDER
  // ====================================================================
  var root=document.getElementById('app');

  function render(){
    root.innerHTML='';
    root.appendChild(header());
    root.appendChild(controls());
    var s;
    if(state.tab==='bracket') s=renderBracket();
    else if(state.tab==='groups') s=renderGroups();
    else s=renderScenario();
    root.appendChild(s);
    root.appendChild(about());

    // kick a projection if needed (poster mode computes synchronously up front,
    // so we never schedule the async worker there — capture must see a full bracket).
    // The scenario tab also wants mc (for the per-team Elo P1-4 distribution), so
    // it no longer opts out — it renders the deterministic content immediately and
    // backfills the Elo line when the sim returns.
    if(!POSTER && state.mode==='projected' && !state.mc && !state.simming){
      runProjection();
    }
  }

  function header(){
    var d=document.createElement('div'); d.className='app-header';
    var note = 'Very-recently-finished or in-progress games may not yet be in the feed — switch to My Picks to enter a just-final result by hand.';
    d.innerHTML =
      '<h1>2026 World Cup &mdash; Bracket Projector</h1>'+
      '<div class="muted tiny">Elo&ndash;Poisson supremacy model &middot; '+SIM_N.toLocaleString()+' Monte-Carlo sims &middot; data via openfootball</div>'+
      '<div class="fresh"><div><b>Data through:</b> '+esc(FRESH.dataThrough)+
        ' &middot; '+FRESH.playedCount+'/'+FRESH.totalCount+' matches played &middot; built '+esc(localBuilt(FRESH.builtAtISO))+'</div>'+
        '<div class="note">'+note+'</div></div>';
    return d;
  }

  function controls(){
    var wrap=document.createElement('div');
    // mode toggle
    var seg=document.createElement('div'); seg.className='row';
    seg.innerHTML='<span class="seg">'+
      '<button data-m="projected" class="'+(state.mode==='projected'?'on':'')+'">Projected</button>'+
      '<button data-m="picks" class="'+(state.mode==='picks'?'on':'')+'">My Picks</button></span>'+
      '<span class="spacer"></span>';
    if(state.mode==='picks'){
      var rb=document.createElement('button'); rb.className='btn warn'; rb.textContent='Reset picks';
      rb.onclick=function(){ state.picks={}; workGroups=cloneGroups(baseGroups); state.mc=null; render(); };
      seg.appendChild(rb);
    }
    Array.prototype.forEach.call(seg.querySelectorAll('button[data-m]'),function(b){
      b.onclick=function(){ state.mode=b.getAttribute('data-m'); if(state.mode==='projected'){ state.mc=null; } render(); };
    });
    wrap.appendChild(seg);

    // tabs
    var tabs=document.createElement('div'); tabs.className='tabbar';
    [['bracket','Knockout bracket'],['groups','Group stage'],['scenario','Scenario calculator']].forEach(function(t){
      var b=document.createElement('button'); b.className='tab'+(state.tab===t[0]?' active':'');
      b.textContent=t[1]; b.onclick=function(){ state.tab=t[0]; render(); };
      tabs.appendChild(b);
    });
    wrap.appendChild(tabs);
    return wrap;
  }

  // ---------------- BRACKET (inline SVG) ----------------
  function renderBracket(){
    var sec=document.createElement('div'); sec.className='section active print-bracket';
    if(state.mode==='projected'){
      var bar=document.createElement('div'); bar.className='row tiny muted';
      if(state.simming){ bar.innerHTML='<span class="simstate"><span class="spinner"></span> simulating '+SIM_N.toLocaleString()+' tournaments&hellip;</span>'; }
      else { bar.innerHTML='<span>Each slot shows the most-likely team and the true share of sims in which that team reaches and occupies that exact slot. Tap a slot for the top candidates.</span>'; }
      sec.appendChild(bar);
      sec.appendChild(exportBar());
      if(!state.mc){ if(!state.simming){ var p=document.createElement('div'); p.className='muted'; p.textContent='Preparing simulation…'; sec.appendChild(p);} sec.appendChild(bracketShell(null)); return sec; }
      sec.appendChild(bracketShell(state.mc));
    } else {
      var info=document.createElement('div'); info.className='callout';
      info.innerHTML='<b>My Picks.</b> Group results below feed the R32; tap any knockout slot to choose who advances. Edit group scores in the Group stage tab. Empty slots stay blank until the groups (or your picks) decide them.';
      sec.appendChild(info);
      sec.appendChild(exportBar());
      sec.appendChild(bracketShell(null));
    }
    return sec;
  }

  // Resolve, for every knockout match + side, the {code,p,cands} to display, in
  // BOTH modes. Projected: true Monte-Carlo per-slot frequencies (mc.perSlot).
  // Picks: deterministic occupant (p=0, no candidates), user override aware.
  function buildSlotInfo(mc, det){
    var info={}; // matchNo -> {home:{code,p,cands,known,picked}, away:{...}}
    // include ThirdPlace (M103) so the 3rd-place playoff box resolves too;
    // model.perSlot carries it in projected mode, picks mode leaves it TBD.
    var rounds=['R32','R16','QF','SF','ThirdPlace','Final'];
    if(state.mode==='projected' && mc){
      var byMatch={}; mc.perSlot.forEach(function(s){ byMatch[s.match]=s; });
      rounds.forEach(function(rd){
        (BRACKET.rounds[rd]||[]).forEach(function(m){
          var s=byMatch[m.match]||{home:[],away:[]};
          info[m.match]={
            home:{ code:(s.home[0]||{}).code||null, p:(s.home[0]||{}).p||0, cands:s.home },
            away:{ code:(s.away[0]||{}).code||null, p:(s.away[0]||{}).p||0, cands:s.away }
          };
        });
      });
    } else {
      rounds.forEach(function(rd){
        (BRACKET.rounds[rd]||[]).forEach(function(m){
          var d=(det&&det.slotByMatch[m.match])||{};
          var picked=det? det.winnerOf[m.match] : null;
          info[m.match]={
            home:{ code:d.home||null, p:0, cands:[], known:!!d.home, picked:picked===d.home && !!d.home },
            away:{ code:d.away||null, p:0, cands:[], known:!!d.away, picked:picked===d.away && !!d.away }
          };
        });
      });
    }
    return info;
  }

  function bracketShell(mc){
    var det = state.mode==='picks'? deterministicBracket() : null;
    var slotInfo = buildSlotInfo(mc, det);
    var wrap=document.createElement('div'); wrap.className='bracket-wrap';
    wrap.appendChild(bracketSVG(slotInfo));
    // stash the latest slotInfo for the export functions (current view state)
    _lastSlotInfo=slotInfo;
    return wrap;
  }

  // ---- SVG geometry ----
  // Poster mode scales the whole drawing up so the natural SVG is ~2600px wide
  // (a generous, un-clipped poster master); on-screen uses the base scale.
  // Built from parts so no literal resource-ref substring lands in the output
  // file (this is an XML namespace identifier, never fetched).
  var SVG_NS=['http','://www.w3.org/2000/svg'].join('');
  var _PS = POSTER ? 2.45 : 1;   // poster scale
  var SLOT_H=Math.round(22*_PS), MATCH_GAP=Math.round(10*_PS), MATCH_H=2*SLOT_H, HDR_H=Math.round(13*_PS);
  var COL_W=Math.round(176*_PS), COL_GAP=Math.round(34*_PS), PAD_X=Math.round(14*_PS), PAD_Y=Math.round(14*_PS), TITLE_H=Math.round(46*_PS);
  var FS=function(px){ return Math.round(px*_PS); }; // scaled font size helper
  var FONT='-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif';
  var ROUNDS=[['R32','Round of 32'],['R16','Round of 16'],['QF','Quarter-finals'],['SF','Semi-finals'],['Final','Final']];

  function svgEl(name, attrs){
    var e=document.createElementNS(SVG_NS,name);
    if(attrs) for(var k in attrs){ e.setAttribute(k, attrs[k]); }
    return e;
  }
  function svgText(x,y,str,attrs){
    var t=svgEl('text',attrs||{}); t.setAttribute('x',x); t.setAttribute('y',y);
    t.textContent=str==null?'':String(str); return t;
  }

  // Compute the vertical center of each match.
  //
  // The bracket must read as a proper single-elimination TREE, traceable
  // left->right. FIFA match NUMBERS do not run down the tree, so we cannot stack
  // R32 in 73..88 order — that misaligns every later column with the matches
  // that feed it. Instead we derive the leaf order from the tree itself:
  //
  //   - Build a match lookup across all rounds.
  //   - From the Final (the root) walk down each winnerOf reference, taking the
  //     HOME subtree before the AWAY subtree (in-order DFS). The R32 matches are
  //     the leaves; the order they're visited IS their top->bottom order.
  //   - Stack the 16 R32 leaves evenly in that order; every internal match then
  //     centers on the midpoint of its two children (recursively).
  //
  // This is fully data-driven: if bracket.json changes, the layout follows.
  function buildMatchIndex(){
    var idx={};
    Object.keys(BRACKET.rounds).forEach(function(rd){
      (BRACKET.rounds[rd]||[]).forEach(function(m){ idx[m.match]=m; });
    });
    return idx;
  }

  // In-order DFS from a root match, home subtree before away, collecting the
  // R32 leaf match numbers in top->bottom order.
  function r32LeafOrder(idx, rootMatch){
    var r32set={};
    BRACKET.rounds.R32.forEach(function(m){ r32set[m.match]=true; });
    var order=[];
    function walk(matchNo){
      if(r32set[matchNo]){ order.push(matchNo); return; }
      var m=idx[matchNo]; if(!m) return;
      [m.home, m.away].forEach(function(side){
        if(side && side.type==='winnerOf') walk(side.match);
      });
    }
    walk(rootMatch);
    return order;
  }

  function computeLayout(){
    var cy={}; // matchNo -> center y (within drawing area, before TITLE offset)
    var unit=MATCH_H+MATCH_GAP;
    var idx=buildMatchIndex();
    var r32=BRACKET.rounds.R32;

    // Tree-position order of the R32 leaves (root = the Final).
    var rootMatch=(BRACKET.rounds.Final[0]||{}).match;
    var leafOrder=r32LeafOrder(idx, rootMatch);
    // Fallback: if traversal didn't cover all leaves (malformed data), append the
    // rest in array order so nothing vanishes.
    if(leafOrder.length<r32.length){
      var seen={}; leafOrder.forEach(function(n){ seen[n]=true; });
      r32.forEach(function(m){ if(!seen[m.match]) leafOrder.push(m.match); });
    }
    leafOrder.forEach(function(matchNo,i){ cy[matchNo]=PAD_Y + i*unit + MATCH_H/2; });

    function feeders(side){ return side&&side.type==='winnerOf'? side.match : null; }
    ['R16','QF','SF','Final'].forEach(function(rd){
      (BRACKET.rounds[rd]||[]).forEach(function(m){
        var a=feeders(m.home), b=feeders(m.away);
        var ya=cy[a], yb=cy[b];
        if(ya!=null && yb!=null) cy[m.match]=(ya+yb)/2;
        else cy[m.match]=PAD_Y + MATCH_H/2;
      });
    });
    var totalH=PAD_Y + r32.length*unit - MATCH_GAP + PAD_Y;
    return { cy:cy, totalH:totalH, leafOrder:leafOrder };
  }

  function colX(ci){ return PAD_X + ci*(COL_W+COL_GAP); }

  function bracketSVG(slotInfo){
    var lay=computeLayout();
    var width=PAD_X*2 + ROUNDS.length*COL_W + (ROUNDS.length-1)*COL_GAP;
    var height=TITLE_H + lay.totalH;
    var svg=svgEl('svg',{ 'class':'bracket-svg',
      viewBox:'0 0 '+width+' '+height,
      width:String(width), height:String(height),
      preserveAspectRatio:'xMinYMin meet',
      xmlns:SVG_NS, 'font-family':FONT });

    // solid background (so PNG/SVG render standalone, no transparency surprise)
    svg.appendChild(svgEl('rect',{ x:0,y:0,width:width,height:height,fill:'#0f1115' }));

    // title + freshness stamp (baked into the exported image)
    var t1=svgText(PAD_X, Math.round(22*_PS), '2026 World Cup — '+(state.mode==='picks'?'My-Picks bracket':'projected bracket'),
      { fill:'#e7eaf0','font-size':String(FS(17)),'font-weight':'700' });
    svg.appendChild(t1);
    var stamp='data through '+FRESH.dataThrough+' · '+FRESH.playedCount+'/'+FRESH.totalCount+' played · built '+localBuilt(FRESH.builtAtISO);
    svg.appendChild(svgText(PAD_X, Math.round(39*_PS), stamp, { fill:'#9aa3b2','font-size':String(FS(11)) }));

    // round headers
    ROUNDS.forEach(function(rd,ci){
      svg.appendChild(svgText(colX(ci)+COL_W/2, TITLE_H-Math.round(4*_PS), rd[1].toUpperCase(),
        { fill:'#9aa3b2','font-size':String(FS(10)),'letter-spacing':'1','text-anchor':'middle' }));
    });

    // connectors first (under boxes): from each feeder's right edge to child's left edge
    ROUNDS.forEach(function(rd,ci){
      if(rd[0]==='R32') return;
      (BRACKET.rounds[rd[0]]||[]).forEach(function(m){
        [m.home,m.away].forEach(function(side){
          if(side.type!=='winnerOf') return;
          var fy=lay.cy[side.match]; var ty=lay.cy[m.match];
          if(fy==null||ty==null) return;
          var x1=colX(ci-1)+COL_W, x2=colX(ci), xm=(x1+x2)/2;
          var y1=TITLE_H+fy, y2=TITLE_H+ty;
          var p=svgEl('path',{ d:'M'+x1+','+y1+' H'+xm+' V'+y2+' H'+x2,
            fill:'none', stroke:'#2a2f3a', 'stroke-width':'1.5' });
          svg.appendChild(p);
        });
      });
    });

    // match boxes
    ROUNDS.forEach(function(rd,ci){
      (BRACKET.rounds[rd[0]]||[]).forEach(function(m){
        var cyv=lay.cy[m.match]; if(cyv==null) return;
        var x=colX(ci), top=TITLE_H+cyv-MATCH_H/2;
        svg.appendChild(matchGroup(rd[0], m, x, top, slotInfo[m.match]||{}));
      });
    });

    // 3rd-place playoff (M103 = losers of the two semis): drawn small and
    // unobtrusively below the Final column so it never distorts the main tree.
    var tp=(BRACKET.rounds.ThirdPlace||[])[0];
    if(tp){
      var finalCi=ROUNDS.length-1;
      var tx=colX(finalCi);
      var ty=TITLE_H + lay.totalH - PAD_Y - MATCH_H; // just above the bottom pad
      svg.appendChild(svgText(tx+Math.round(4*_PS), ty-Math.round(15*_PS), '3rd place',
        { fill:'#9aa3b2','font-size':String(FS(10)),'font-weight':'700' }));
      svg.appendChild(thirdPlaceGroup(tp, tx, ty, slotInfo[tp.match]||{}));
    }

    return svg;
  }

  function matchGroup(round, m, x, top, info){
    var g=svgEl('g',{});
    // header (match number) above the box
    g.appendChild(svgText(x+Math.round(4*_PS), top-Math.round(3*_PS), 'M'+m.match, { fill:'#6b7280','font-size':String(FS(9)) }));
    // outer box
    g.appendChild(svgEl('rect',{ x:x, y:top, width:COL_W, height:MATCH_H, rx:Math.round(6*_PS),
      fill:'#1d212b', stroke:'#2a2f3a','stroke-width':String(_PS) }));
    // divider between the two slots
    g.appendChild(svgEl('line',{ x1:x, y1:top+SLOT_H, x2:x+COL_W, y2:top+SLOT_H,
      stroke:'#2a2f3a','stroke-width':'1' }));
    g.appendChild(slotGroup(round, m, 'home', info.home||{code:null,p:0}, x, top));
    g.appendChild(slotGroup(round, m, 'away', info.away||{code:null,p:0}, x, top+SLOT_H));
    return g;
  }

  // 3rd-place playoff box — same structure as a regular match box but visually
  // muted (dashed border) so it reads as an aside, not part of the main tree.
  function thirdPlaceGroup(m, x, top, info){
    var g=svgEl('g',{});
    g.appendChild(svgText(x+Math.round(4*_PS), top-Math.round(3*_PS), 'M'+m.match, { fill:'#6b7280','font-size':String(FS(9)) }));
    g.appendChild(svgEl('rect',{ x:x, y:top, width:COL_W, height:MATCH_H, rx:Math.round(6*_PS),
      fill:'#15181f', stroke:'#2a2f3a','stroke-width':String(_PS),'stroke-dasharray':Math.round(4*_PS)+' '+Math.round(3*_PS) }));
    g.appendChild(svgEl('line',{ x1:x, y1:top+SLOT_H, x2:x+COL_W, y2:top+SLOT_H,
      stroke:'#2a2f3a','stroke-width':'1' }));
    g.appendChild(slotGroup('ThirdPlace', m, 'home', info.home||{code:null,p:0}, x, top));
    g.appendChild(slotGroup('ThirdPlace', m, 'away', info.away||{code:null,p:0}, x, top+SLOT_H));
    return g;
  }

  // R32-ONLY seed/group designation built from the bracket.json slot definition.
  // winner G -> "G1"; runnerup G -> "G2"; third [list] -> "3rd a/b/e/f/i" with the
  // single candidate letter the projected occupant comes from highlighted.
  // Returns 0 for non-R32 rounds or unrecognized slot types.
  // Renders into g starting at chipX; returns the x-offset (px) the code/name
  // text should start at (so a third-place label can push them further right).
  function renderSeedLabel(g, round, slotDef, occupantCode, chipX, midY){
    if(round!=='R32' || !slotDef) return 0;
    var fs=FS(9.5);
    if(slotDef.type==='winner' || slotDef.type==='runnerup'){
      var lab=(slotDef.group||'?')+(slotDef.type==='winner'?'1':'2');
      g.appendChild(svgText(chipX, midY, lab,
        { fill:'#6b7280','font-size':String(fs),'font-weight':'700' }));
      // fixed-width reservation for a 2-char chip
      return Math.round(20*_PS);
    }
    if(slotDef.type==='third' && Array.isArray(slotDef.from)){
      var occLetter = occupantCode ? (groupLetterByCode[occupantCode]||null) : null;
      var t=svgEl('text',{ x:chipX, y:midY, 'font-size':String(fs) });
      // "3rd " prefix
      var pre=svgEl('tspan',{ fill:'#6b7280' }); pre.textContent='3rd '; t.appendChild(pre);
      slotDef.from.forEach(function(L,i){
        if(i>0){ var sep=svgEl('tspan',{ fill:'#3a3f4a' }); sep.textContent='/'; t.appendChild(sep); }
        var hot = occLetter && L.toUpperCase()===occLetter;
        var ts=svgEl('tspan',{ fill: hot?'#4ea1ff':'#6b7280', 'font-weight': hot?'700':'400' });
        ts.textContent=L.toLowerCase(); t.appendChild(ts);
      });
      g.appendChild(t);
      // "3rd " + N letters + (N-1) separators, ~ per-char width
      var chars = 4 + slotDef.from.length + (slotDef.from.length-1);
      return Math.round((chars*5.3+6)*_PS);
    }
    return 0;
  }

  function slotGroup(round, m, side, si, x, sy){
    var g=svgEl('g',{ 'class':'slot-hit' });
    var code=si.code;
    var midY=sy+SLOT_H/2+Math.round(4*_PS);
    var pad=Math.round(7*_PS);
    // transparent hit/hover bg
    g.appendChild(svgEl('rect',{ 'class':'slot-bg', x:x, y:sy, width:COL_W, height:SLOT_H,
      fill:'transparent' }));
    // pick highlight (My Picks: this side is the chosen winner)
    if(state.mode==='picks' && si.picked){
      g.appendChild(svgEl('rect',{ x:x+1, y:sy+1, width:COL_W-2, height:SLOT_H-2, rx:Math.round(4*_PS),
        fill:'none', stroke:'#1f6b3a','stroke-width':String(1.5*_PS) }));
    }
    // accent bar
    g.appendChild(svgEl('rect',{ x:x+Math.round(3*_PS), y:sy+Math.round(4*_PS), width:Math.round(3*_PS), height:SLOT_H-Math.round(8*_PS), rx:1.5*_PS,
      fill: code? accentFor(code) : '#6b7280' }));

    // R32-ONLY: seed/group designation chip BEFORE the team code.
    var seedW=renderSeedLabel(g, round, (round==='R32'? m[side] : null), code, x+Math.round(11*_PS), midY);
    var codeX=x+Math.round(13*_PS)+seedW, nameX=x+Math.round(44*_PS)+seedW;

    // CLINCHED (projected, p≈100%): pop the team (bold + accent + glow) and DROP %.
    var clinched = state.mode==='projected' && code && si.p>=0.9995;

    // code
    if(clinched){
      var glow=svgText(codeX, midY, code,
        { fill:'#4ea1ff','font-size':String(FS(12.5)),'font-weight':'800',
          stroke:'#4ea1ff','stroke-width':String(0.6*_PS),'opacity':'0.35' });
      g.appendChild(glow);
      g.appendChild(svgText(codeX, midY, code,
        { fill:'#7fc0ff','font-size':String(FS(12.5)),'font-weight':'800' }));
    } else {
      g.appendChild(svgText(codeX, midY, code||'—',
        { fill: code? '#e7eaf0':'#6b7280', 'font-size':String(FS(12)),'font-weight':'700' }));
    }
    // name (clipped via truncation)
    var nm=code?(nameByCode[code]||''):'TBD';
    var nameMaxW=COL_W-(nameX-x)-(clinched?Math.round(10*_PS):Math.round(40*_PS));
    g.appendChild(svgText(nameX, midY, truncName(nm, nameMaxW),
      { fill: clinched?'#cfe6ff':'#9aa3b2','font-size':String(FS(10)),'font-weight': clinched?'600':'400' }));
    // probability (projected) at right — clinched slots show no %.
    if(state.mode==='projected' && code && !clinched){
      g.appendChild(svgText(x+COL_W-pad, midY, pct(si.p),
        { fill:'#4ea1ff','font-size':String(FS(11)),'text-anchor':'end' }));
    }
    // interaction
    if(state.mode==='projected'){
      g.addEventListener('click', function(ev){
        if(si.cands && si.cands.length) showCandidates(ev, si.cands, m.match, side);
      });
    } else {
      g.addEventListener('click', function(){ if(code){ state.picks[m.match]=code; render(); } });
      if(code){ var ttl=svgEl('title',{}); ttl.textContent='Click to advance '+(nameByCode[code]||code); g.appendChild(ttl); }
    }
    return g;
  }

  // crude SVG text truncation by estimated glyph width (~5.6px @ 10px font)
  function truncName(s, maxW){
    if(!s) return '';
    var per=5.6*_PS, max=Math.max(2, Math.floor(maxW/per));
    if(s.length<=max) return s;
    return s.slice(0, Math.max(1,max-1))+'…';
  }

  // ================= EXPORT =================
  // The live bracket <svg> is the single source of truth, so all three exports
  // serialize/rasterize/print exactly the current on-screen view (mode + picks).
  var _lastSlotInfo=null;

  function liveSVG(){ return document.querySelector('.bracket-svg'); }

  // Serialize the live SVG into a standalone document string. Geometry + colors
  // are inline attributes already; we only need to ensure width/height + font.
  function serializeSVG(){
    var src=liveSVG(); if(!src) return null;
    var clone=src.cloneNode(true);
    clone.setAttribute('xmlns', SVG_NS);
    clone.setAttribute('font-family', FONT);
    // make sure explicit pixel width/height are present for standalone renderers
    var vb=(src.getAttribute('viewBox')||'').split(/\s+/);
    if(vb.length===4){ clone.setAttribute('width', vb[2]); clone.setAttribute('height', vb[3]); }
    var xml=new XMLSerializer().serializeToString(clone);
    return '<?xml version="1.0" encoding="UTF-8"?>\n'+xml;
  }

  function downloadBlob(blob, filename){
    var url=URL.createObjectURL(blob);
    var a=document.createElement('a'); a.href=url; a.download=filename;
    document.body.appendChild(a); a.click();
    setTimeout(function(){ document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }

  function exportSVG(){
    var xml=serializeSVG(); if(!xml){ alert('Bracket not ready yet.'); return; }
    downloadBlob(new Blob([xml],{type:'image/svg+xml;charset=utf-8'}), 'wc2026-bracket.svg');
  }

  function exportPNG(){
    var src=liveSVG(); if(!src){ alert('Bracket not ready yet.'); return; }
    var vb=(src.getAttribute('viewBox')||'').split(/\s+/);
    var w=+vb[2]||src.clientWidth, h=+vb[3]||src.clientHeight;
    var scale=2; // device scale -> crisp raster
    var xml=serializeSVG();
    var img=new Image();
    var svgBlob=new Blob([xml],{type:'image/svg+xml;charset=utf-8'});
    var url=URL.createObjectURL(svgBlob);
    img.onload=function(){
      var canvas=document.createElement('canvas');
      canvas.width=Math.round(w*scale); canvas.height=Math.round(h*scale);
      var ctx=canvas.getContext('2d');
      ctx.fillStyle='#0f1115'; ctx.fillRect(0,0,canvas.width,canvas.height); // solid bg
      ctx.setTransform(scale,0,0,scale,0,0);
      ctx.drawImage(img,0,0,w,h);
      URL.revokeObjectURL(url);
      canvas.toBlob(function(blob){ if(blob) downloadBlob(blob,'wc2026-bracket.png'); }, 'image/png');
    };
    img.onerror=function(){ URL.revokeObjectURL(url); alert('PNG export failed to rasterize the SVG.'); };
    img.src=url;
  }

  function exportPDF(){
    // The print stylesheet (@media print) lays the bracket out un-scrolled in
    // landscape; the browser's print dialog offers "Save as PDF".
    window.print();
  }

  function exportBar(){
    var bar=document.createElement('div'); bar.className='export-bar';
    var lbl=document.createElement('span'); lbl.className='lbl'; lbl.textContent='Export:';
    bar.appendChild(lbl);
    [['Download SVG',exportSVG],['Download PNG',exportPNG],['Save as PDF',exportPDF]].forEach(function(b){
      var btn=document.createElement('button'); btn.className='btn'; btn.textContent=b[0];
      btn.onclick=b[1]; bar.appendChild(btn);
    });
    return bar;
  }

  function showCandidates(ev, cands, matchNo, side){
    closePop();
    var pop=document.createElement('div'); pop.className='pop';
    pop.innerHTML='<span class="x">&times;</span><h4>M'+matchNo+' &middot; '+side+' slot &mdash; top candidates</h4>';
    cands.slice(0,5).forEach(function(c){
      if(!c||!c.code) return;
      var row=document.createElement('div'); row.className='cand';
      row.innerHTML='<span class="code" style="color:'+accentFor(c.code)+'">'+c.code+'</span>'+
        '<span class="nm">'+esc(nameByCode[c.code]||'')+'</span>'+
        '<span class="p">'+pct1(c.p)+'</span>';
      pop.appendChild(row);
    });
    pop.querySelector('.x').onclick=closePop;
    document.body.appendChild(pop);
    var x=Math.min(ev.clientX, window.innerWidth-pop.offsetWidth-10);
    var y=Math.min(ev.clientY+8, window.innerHeight-pop.offsetHeight-10);
    pop.style.left=Math.max(8,x)+'px'; pop.style.top=Math.max(8,y)+'px';
    setTimeout(function(){ document.addEventListener('click', outsidePop, {once:true}); },0);
  }
  function outsidePop(e){ var p=document.querySelector('.pop'); if(p&&!p.contains(e.target)) closePop(); }
  function closePop(){ var p=document.querySelector('.pop'); if(p) p.remove(); }

  // ---------------- GROUP STAGE ----------------
  function renderGroups(){
    var sec=document.createElement('div'); sec.className='section active';
    if(state.mode==='picks'){
      var note=document.createElement('div'); note.className='callout';
      note.innerHTML='Edit any <b>unplayed</b> match score below (steppers) to recompute standings, the 3rd-place table, the Annex&nbsp;C allocation, and the bracket live. You can also <b>add a not-yet-in-feed result</b> by hand at the bottom of a group.';
      sec.appendChild(note);
    }
    var grid=document.createElement('div'); grid.className='groups-grid';
    var gs=groupsForCompute();
    gs.forEach(function(g){ grid.appendChild(groupCard(g)); });
    sec.appendChild(grid);
    sec.appendChild(thirdsPanel(gs));
    return sec;
  }

  function groupCard(g){
    var card=document.createElement('div'); card.className='gcard';
    var st=computeGroupStanding(g);
    var h=document.createElement('h3'); h.textContent=g.name; card.appendChild(h);
    var t=document.createElement('table');
    t.innerHTML='<thead><tr><th>#</th><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>GD</th><th>Pts</th></tr></thead>';
    var tb=document.createElement('tbody');
    st.forEach(function(s){
      var tr=document.createElement('tr'); if(s.rank<=2) tr.className='q'+s.rank;
      var lots=s.tiedByLots?' <span class="lots" title="Level on all criteria incl. fair-play — separated only by drawing of lots (a real coin-flip)">⚖</span>':'';
      tr.innerHTML='<td>'+s.rank+'</td>'+
        '<td><span style="color:'+accentFor(s.code)+';font-weight:700">'+s.code+'</span> <span class="muted tiny">'+esc(s.name)+'</span>'+lots+'</td>'+
        '<td>'+s.played+'</td><td>'+s.won+'</td><td>'+s.drawn+'</td><td>'+s.lost+'</td>'+
        '<td>'+s.gf+'</td><td>'+s.ga+'</td><td>'+(s.gd>0?'+':'')+s.gd+'</td><td><b>'+s.points+'</b></td>';
      tb.appendChild(tr);
    });
    t.appendChild(tb); card.appendChild(t);

    if(state.mode==='picks'){
      // editors for each match
      g.matches.forEach(function(m){ card.appendChild(matchEditor(g,m)); });
      card.appendChild(manualAdd(g));
    }
    return card;
  }

  function matchEditor(g,m){
    var row=document.createElement('div'); row.className='editor'+(m.played?' played':'');
    var hg=(m.homeGoals==null?0:m.homeGoals), ag=(m.awayGoals==null?0:m.awayGoals);
    function stepper(val, onCh){
      var s=document.createElement('span'); s.className='stepper';
      var dec=document.createElement('button'); dec.textContent='−';
      var inp=document.createElement('input'); inp.type='number'; inp.min='0'; inp.value=val;
      var inc=document.createElement('button'); inc.textContent='+';
      dec.onclick=function(){ var v=Math.max(0,(+inp.value||0)-1); inp.value=v; onCh(v); };
      inc.onclick=function(){ var v=Math.max(0,(+inp.value||0)+1); inp.value=v; onCh(v); };
      inp.onchange=function(){ var v=Math.max(0,Math.floor(+inp.value||0)); inp.value=v; onCh(v); };
      s.appendChild(dec); s.appendChild(inp); s.appendChild(inc); return s;
    }
    var lblH=document.createElement('span'); lblH.className='lbl'; lblH.style.color=accentFor(m.home); lblH.textContent=m.home;
    var lblA=document.createElement('span'); lblA.className='lbl'; lblA.style.color=accentFor(m.away); lblA.textContent=m.away;
    var newH=hg, newA=ag;
    function commit(){ m.homeGoals=newH; m.awayGoals=newA; m.played=true; state.mc=null; render(); }
    row.appendChild(lblH);
    row.appendChild(stepper(hg,function(v){newH=v;commit();}));
    var vs=document.createElement('span'); vs.className='vs'; vs.textContent=':'; row.appendChild(vs);
    row.appendChild(stepper(ag,function(v){newA=v;commit();}));
    row.appendChild(lblA);
    var tag=document.createElement('span'); tag.className='tag';
    tag.textContent = m.played? (m.manual?'manual':'played') : 'projected→edit';
    row.appendChild(tag);
    if(m.played){
      var clr=document.createElement('button'); clr.className='btn tiny'; clr.style.padding='2px 6px'; clr.textContent='clear';
      clr.onclick=function(){ m.played=false; m.homeGoals=null; m.awayGoals=null; m.manual=false; state.mc=null; render(); };
      row.appendChild(clr);
    }
    return row;
  }

  function manualAdd(g){
    // Allow entering a just-finished real result that isn't in the feed yet,
    // for any pairing in the group that doesn't already have a match row.
    var wrap=document.createElement('div'); wrap.className='manual-add tiny muted';
    wrap.textContent='All '+g.teams.length+' teams’ fixtures are listed above. Use a row’s steppers to enter a final score the feed hasn’t picked up yet (it will be tagged “manual”).';
    return wrap;
  }

  function thirdsPanel(gs){
    var panel=document.createElement('div'); panel.className='thirds';
    var h=document.createElement('h3'); h.style.margin='2px 0 6px'; h.style.fontSize='14px';
    h.textContent='Third-place ranking (top 8 advance)'; panel.appendChild(h);
    var ranked;
    try{ ranked=rankThirdPlaceTeams(gs); }
    catch(e){ var er=document.createElement('div'); er.className='muted tiny'; er.textContent='Third-place ranking unavailable: '+e.message; panel.appendChild(er); return panel; }
    ranked.forEach(function(t,i){
      if(i===8){ var cut=document.createElement('div'); cut.className='cut'; cut.innerHTML='<span>cut line</span>'; panel.appendChild(cut); }
      var row=document.createElement('div'); row.className='trow'+(t.qualifies?' qual':'');
      var lots=t.tiedByLots?' ⚖':'';
      row.innerHTML='<span class="g">'+esc(t.group)+'</span>'+
        '<span class="cd" style="color:'+accentFor(t.code)+'">'+t.code+lots+'</span>'+
        '<span class="st">'+t.points+' pts &middot; GD '+(t.gd>0?'+':'')+t.gd+' &middot; GF '+t.gf+'</span>';
      panel.appendChild(row);
    });
    return panel;
  }

  // ---------------- SCENARIO CALCULATOR ----------------
  // Stage-aware, group-at-a-time view. One selector (the group). Everything for
  // that group renders automatically based on how many matches are still unplayed:
  //   0 unplayed         -> "Group complete" + final standings table.
  //   1-2 unplayed (final round) -> summarizeGroup(): per-team headline + detail,
  //                          plus any dead-rubber note.
  //   3+ unplayed (pre-final)    -> groupSituation(): per-team statusLine + needLine,
  //                          plus a "Next round" trigger block.
  // EVERY stage also shows each team's Elo-model finish distribution P(1st..4th),
  // sourced from the Monte-Carlo mc.perTeam (backfilled when the sim returns).

  // Reflect group overrides in My-Picks mode (so edited scores change the
  // scenario); in Projected mode it reflects the real feed.
  function scenarioGroups(){ return groupsForCompute(); }

  // Map code -> mc.perTeam entry (Elo finish distribution), or null if no sim yet.
  function eloDistByCode(){
    if(!state.mc || !state.mc.perTeam) return null;
    var m={}; state.mc.perTeam.forEach(function(e){ m[e.code]=e; }); return m;
  }

  // Render one compact "Elo model: 1st x% · 2nd y% · 3rd z% · 4th w%" line for a
  // team, or a placeholder while the sim is still running.
  function eloLine(code, dist){
    var d=document.createElement('div'); d.className='scn-elo';
    if(!dist){ d.innerHTML='<span class="lbl">Elo model</span> <span class="muted tiny">computing finish distribution…</span>'; return d; }
    var e=dist[code];
    if(!e){ d.innerHTML='<span class="lbl">Elo model</span> <span class="muted tiny">n/a</span>'; return d; }
    var r=function(p){ return Math.round((p||0)*100); };
    var p1=r(e.pGroup1),p2=r(e.pGroup2),p3=r(e.pGroup3),p4=r(e.pGroup4);
    // 4-segment stacked bar + a compact numeric legend underneath.
    var segs=[['#34d27b',p1,'1st'],['#4ea1ff',p2,'2nd'],['#f0b429',p3,'3rd'],['#ef5e5e',p4,'4th']];
    var bar='<span class="scn-bar">'+segs.map(function(s){
      return s[1]>0?'<span class="seg" style="width:'+s[1]+'%;background:'+s[0]+'" title="'+s[2]+' '+s[1]+'%"></span>':''; }).join('')+'</span>';
    var legend=segs.map(function(s){
      return '<span class="lg"><i style="background:'+s[0]+'"></i>'+s[2]+' '+s[1]+'%</span>'; }).join(' · ');
    d.innerHTML='<span class="lbl">Elo model</span>'+bar+'<div class="scn-legend">'+legend+'</div>';
    return d;
  }

  function teamHeader(code, name){
    var h=document.createElement('div'); h.className='h';
    h.innerHTML='<span class="cd" style="color:'+accentFor(code)+'">'+code+'</span> <span class="nm">'+esc(name)+'</span>';
    return h;
  }

  function renderScenario(){
    var sec=document.createElement('div'); sec.className='section active';
    var gs=scenarioGroups();

    var callout=document.createElement('div'); callout.className='callout';
    callout.innerHTML='Within-group positions (1st/2nd/3rd/4th) shown as <b>clinch / eliminate / needs</b> lines are <b>deterministic facts</b>. The <b>Elo model</b> row is this projector’s <i>probabilistic</i> view of where each team finishes — a model estimate, not a guarantee. Finishing 3rd is stated as fact; whether a 3rd-place team <b>advances</b> is cross-group and is never asserted here.';
    sec.appendChild(callout);

    // ---- group selector: a row of A–L chips ----
    if(!state.scnGroup){
      // default to the first final-round group (1-2 unplayed), else group A.
      var def=null;
      gs.forEach(function(g){
        var u=g.matches.filter(function(m){return !m.played;}).length;
        if(def===null && u>=1 && u<=2) def=letterOf(g);
      });
      state.scnGroup=def||letterOf(gs[0]);
    }
    var chips=document.createElement('div'); chips.className='scn-chips';
    gs.forEach(function(g){
      var L=letterOf(g);
      var b=document.createElement('button'); b.className='gchip'+(state.scnGroup===L?' on':'');
      b.textContent=L;
      b.onclick=function(){ state.scnGroup=L; render(); };
      chips.appendChild(b);
    });
    sec.appendChild(chips);

    var g=gs.filter(function(x){return letterOf(x)===state.scnGroup;})[0];
    if(!g){ return sec; }

    var dist=eloDistByCode();
    // Standing order for the whole group (deterministic, drives team ordering).
    var standing=computeGroupStanding(g);
    var orderIdx={}; standing.forEach(function(s,i){ orderIdx[s.code]=i; });
    var orderedTeams=g.teams.slice().sort(function(a,b){
      return (orderIdx[a.code]==null?99:orderIdx[a.code])-(orderIdx[b.code]==null?99:orderIdx[b.code]);
    });

    var unplayed=g.matches.filter(function(m){return !m.played;});
    var card=document.createElement('div'); card.className='scn-card';

    var head=document.createElement('div'); head.className='scn-stage';
    var nUn=unplayed.length;
    head.innerHTML='<b>'+esc(g.name)+'</b> · '+
      (nUn===0?'group complete':nUn+' match'+(nUn===1?'':'es')+' to play'+
        (nUn<=2?' — final round':''));
    card.appendChild(head);

    if(nUn===0){
      // ---- STAGE: complete -> final standings table ----
      var note=document.createElement('div'); note.className='scn-note';
      note.textContent='Group complete — final standings:';
      card.appendChild(note);
      var t=document.createElement('table'); t.style.marginBottom='6px';
      t.innerHTML='<thead><tr><th>#</th><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>GD</th><th>Pts</th></tr></thead>';
      var tb=document.createElement('tbody');
      standing.forEach(function(s){
        var tr=document.createElement('tr'); if(s.rank<=2) tr.className='q'+s.rank;
        tr.innerHTML='<td>'+s.rank+'</td>'+
          '<td><span style="color:'+accentFor(s.code)+';font-weight:700">'+s.code+'</span> <span class="muted tiny">'+esc(s.name)+'</span></td>'+
          '<td>'+s.played+'</td><td>'+s.won+'</td><td>'+s.drawn+'</td><td>'+s.lost+'</td>'+
          '<td>'+s.gf+'</td><td>'+s.ga+'</td><td>'+(s.gd>0?'+':'')+s.gd+'</td><td><b>'+s.points+'</b></td>';
        tb.appendChild(tr);
      });
      t.appendChild(tb); card.appendChild(t);
      // Elo finish row per team (in standing order).
      orderedTeams.forEach(function(team){
        var row=document.createElement('div'); row.className='scn-team';
        row.appendChild(teamHeader(team.code, team.name));
        row.appendChild(eloLine(team.code, dist));
        card.appendChild(row);
      });

    } else if(nUn<=2){
      // ---- STAGE: final round (1-2 unplayed) -> summarizeGroup ----
      var sum;
      try{ sum=summarizeGroup(g); }
      catch(e){ var er=document.createElement('div'); er.className='muted tiny'; er.textContent='Final-round summary unavailable: '+esc(e.message); card.appendChild(er); sec.appendChild(card); return sec; }
      var byCode={}; sum.teams.forEach(function(t){ byCode[t.code]=t; });
      orderedTeams.forEach(function(team){
        var s=byCode[team.code]; if(!s) return;
        var row=document.createElement('div'); row.className='scn-team';
        row.appendChild(teamHeader(team.code, team.name));
        var hl=document.createElement('div'); hl.className='scn-headline'; hl.textContent=s.headline; row.appendChild(hl);
        if(s.detail){ var dt=document.createElement('div'); dt.className='desc'; dt.textContent=s.detail; row.appendChild(dt); }
        row.appendChild(eloLine(team.code, dist));
        card.appendChild(row);
      });
      if(sum.deadRubbers && sum.deadRubbers.length){
        var dr=document.createElement('div'); dr.className='scn-note';
        dr.innerHTML=sum.deadRubbers.map(function(k){
          var p=k.split('-'); return 'Dead rubber: '+esc(p[0])+' v '+esc(p[1])+' — result can’t change any position.';
        }).join('<br>');
        card.appendChild(dr);
      }

    } else {
      // ---- STAGE: pre-final (3+ unplayed) -> groupSituation ----
      var sit;
      try{ sit=groupSituation(g); }
      catch(e){ var er2=document.createElement('div'); er2.className='muted tiny'; er2.textContent='Group situation unavailable: '+esc(e.message); card.appendChild(er2); sec.appendChild(card); return sec; }
      var byC={}; sit.teams.forEach(function(t){ byC[t.code]=t; });
      orderedTeams.forEach(function(team){
        var s=byC[team.code]; if(!s) return;
        var row=document.createElement('div'); row.className='scn-team';
        row.appendChild(teamHeader(team.code, team.name));
        var hl=document.createElement('div'); hl.className='scn-headline';
        hl.textContent=s.statusLine+' · '+s.points+' pts ('+s.played+' played)';
        row.appendChild(hl);
        var nl=document.createElement('div'); nl.className='desc'; nl.textContent=s.needLine; row.appendChild(nl);
        row.appendChild(eloLine(team.code, dist));
        card.appendChild(row);
      });
      // Next round block.
      var nr=sit.nextRound;
      if(nr && nr.triggers && nr.triggers.length){
        var nb=document.createElement('div'); nb.className='scn-next';
        var nh=document.createElement('div'); nh.className='scn-note';
        nh.innerHTML='<b>Next round'+(nr.date?' ('+esc(nr.date)+')':'')+'</b>'+(sit.decided?' — group already decided on points':'')+':';
        nb.appendChild(nh);
        var ul=document.createElement('ul'); ul.className='scn-triggers';
        nr.triggers.forEach(function(tr){ var li=document.createElement('li'); li.textContent=tr; ul.appendChild(li); });
        nb.appendChild(ul);
        card.appendChild(nb);
      } else if(sit.decided){
        var nd=document.createElement('div'); nd.className='scn-note'; nd.textContent='Group already decided on points.'; card.appendChild(nd);
      }
    }

    sec.appendChild(card);
    return sec;
  }

  // ---------------- ABOUT ----------------
  function about(){
    var d=document.createElement('details'); d.className='about';
    d.innerHTML='<summary>About this model &amp; method</summary>'+
      '<p><b>Strength signal:</b> soccer Elo ratings (eloratings.net-style). A rating gap maps to expected goal <i>supremacy</i> ('+
        '~0.0036 goals per Elo point), split into a Poisson mean for each side around a '+
        'base of 2.6 total goals. Co-host bonus (+80 Elo) for USA/Mexico/Canada.</p>'+
      '<p><b>Projection:</b> '+SIM_N.toLocaleString()+' Monte-Carlo tournaments. Each unplayed group game is a Poisson scoreline draw; '+
        'standings use the full FIFA tiebreaker cascade (points → GD → GF → head-to-head → fair-play → drawing of lots). '+
        'The best 8 third-place teams are mapped into the Round of 32 by FIFA’s Annex C table. '+
        'Knockout ties go to an Elo-weighted shootout coin.</p>'+
      '<p><b>Per-round percentages are TRUE Monte-Carlo frequencies.</b> Every knockout slot — Round of 32 through the Final — '+
        'shows the most-likely team and the exact share of simulated tournaments in which that team <i>reaches and occupies that exact slot</i> '+
        '(an unconditional probability, tallied directly from the sims; deeper rounds are not renormalized approximations). Tap a slot to see the top candidates with their true probabilities.</p>'+
      '<p><b>Coin-flips are real:</b> a ⚖ marks teams a standing could separate only by drawing of lots — a genuine random draw, '+
        'which we render deterministically (alphabetical) but flag honestly.</p>'+
      '<p><b>Data:</b> openfootball/worldcup.json (public domain). '+FRESH.playedCount+' of 104 matches in the build. '+
        'Re-run the build as games finish to refresh. In-progress or very-recently-final games may lag the feed — use My Picks to enter them by hand.</p>'+
      '<p class="muted tiny">Within-group positions in the Scenario tab are exact; everything probabilistic (qualification odds, opponents, title odds) is a model estimate, not a guarantee.</p>';
    return d;
  }

  // first paint
  if(POSTER){
    // hi-res capture path: run the sim synchronously so the bracket is fully
    // populated on the very first paint (no async worker for the screenshotter).
    try{ state.mc=syncMonte(groupsForCompute()); }catch(e){ /* leave bracket empty */ }
    state.simming=false;
  }
  render();
})();
`;

main().catch((e) => { console.error(e); process.exit(1); });
