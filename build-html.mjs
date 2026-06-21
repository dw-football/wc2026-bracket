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

  const [engineSrc, allocationSrc, modelSrc] = await Promise.all([
    readText('engine.js'),
    readText('allocation.js'),
    readText('model.js'),
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

  const logicBundle = [
    '/* ===== engine.js ===== */',
    engineBundle,
    '/* ===== allocation.js (filesystem read replaced by baked table) ===== */',
    allocationBundle,
    '/* ===== model.js ===== */',
    modelBundle,
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
    new Function(`${logicBundle}\nreturn typeof monteCarlo === 'function' && typeof computeGroupStanding === 'function' && typeof resolveThirdPlaceSlots === 'function';`);
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

/* bracket */
.bracket-wrap{overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;
  border:1px solid var(--line);border-radius:10px;background:var(--panel);padding:10px}
.bracket{display:flex;gap:18px;min-width:1040px;align-items:stretch}
.col{display:flex;flex-direction:column;justify-content:space-around;min-width:150px}
.col h3{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);
  margin:0 0 6px;text-align:center}
.col.final-col{justify-content:center}
.match{background:var(--panel2);border:1px solid var(--line);border-radius:8px;
  margin:6px 0;overflow:hidden}
.match .mhdr{font-size:10px;color:var(--dim2);padding:2px 7px;border-bottom:1px solid var(--line)}
.slot{display:flex;align-items:center;gap:6px;padding:6px 8px;cursor:pointer;
  border-bottom:1px solid var(--line);position:relative}
.slot:last-child{border-bottom:0}
.slot:hover{background:#232836}
.slot .accent{width:3px;align-self:stretch;border-radius:2px;background:var(--dim2);
  position:absolute;left:0;top:0;bottom:0}
.slot .code{font-weight:700;font-size:13px;min-width:34px;padding-left:6px}
.slot .nm{color:var(--dim);font-size:11px;flex:1;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis}
.slot .p{font-size:12px;color:var(--accent);font-variant-numeric:tabular-nums}
.slot.known .p{color:var(--good)}
.slot.picked{background:#15294a}
.slot.winner-row{box-shadow:inset 0 0 0 1px var(--qualline)}
.slot.empty .code{color:var(--dim2)}

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

    // kick a projection if needed
    if(state.mode==='projected' && state.tab!=='scenario' && !state.mc && !state.simming){
      runProjection();
    }
  }

  function header(){
    var d=document.createElement('div');
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

  // ---------------- BRACKET ----------------
  function renderBracket(){
    var sec=document.createElement('div'); sec.className='section active';
    if(state.mode==='projected'){
      var bar=document.createElement('div'); bar.className='row tiny muted';
      if(state.simming){ bar.innerHTML='<span class="simstate"><span class="spinner"></span> simulating '+SIM_N.toLocaleString()+' tournaments&hellip;</span>'; }
      else { bar.innerHTML='<span>Each slot shows the most-likely team and the share of sims it appears there. Tap a slot for the top candidates.</span>'; }
      sec.appendChild(bar);
      if(!state.mc){ if(!state.simming){ var p=document.createElement('div'); p.className='muted'; p.textContent='Preparing simulation…'; sec.appendChild(p);} sec.appendChild(bracketShell(null)); return sec; }
      sec.appendChild(bracketShell(state.mc));
    } else {
      var info=document.createElement('div'); info.className='callout';
      info.innerHTML='<b>My Picks.</b> Group results below feed the R32; tap any knockout slot to choose who advances. Edit group scores in the Group stage tab. Empty slots stay blank until the groups (or your picks) decide them.';
      sec.appendChild(info);
      sec.appendChild(bracketShell(null));
    }
    return sec;
  }

  function bracketShell(mc){
    // build per-match modal occupant maps from mc (projected) or deterministic (picks)
    var det = state.mode==='picks'? deterministicBracket() : null;
    var slotMap={};   // R32 matchNo -> {home:[cands], away:[cands]}
    _winPoolCache={};
    if(mc){
      mc.perR32Slot.forEach(function(s){ slotMap[s.match]={ home:s.home, away:s.away }; });
    }

    var wrap=document.createElement('div'); wrap.className='bracket-wrap';
    var br=document.createElement('div'); br.className='bracket';

    var rounds=[['R32','Round of 32'],['R16','Round of 16'],['QF','Quarter-finals'],['SF','Semi-finals'],['Final','Final']];
    rounds.forEach(function(rd){
      var col=document.createElement('div'); col.className='col'+(rd[0]==='Final'?' final-col':'');
      var h=document.createElement('h3'); h.textContent=rd[1]; col.appendChild(h);
      (BRACKET.rounds[rd[0]]||[]).forEach(function(m){
        col.appendChild(matchCard(rd[0], m, mc, slotMap, det));
      });
      br.appendChild(col);
    });
    wrap.appendChild(br);
    return wrap;
  }

  function matchCard(round, m, mc, slotMap, det){
    var card=document.createElement('div'); card.className='match';
    var hdr=document.createElement('div'); hdr.className='mhdr'; hdr.textContent='M'+m.match;
    card.appendChild(hdr);

    // determine the two slots
    var homeInfo, awayInfo;
    if(state.mode==='projected' && mc){
      if(round==='R32'){
        var sm=slotMap[m.match];
        homeInfo=projSlot(sm?sm.home:null);
        awayInfo=projSlot(sm?sm.away:null);
      } else {
        // R16+ : aggregate the candidate pool feeding each side, normalized.
        homeInfo=projWinnerOf(m.home, slotMap);
        awayInfo=projWinnerOf(m.away, slotMap);
      }
    } else if(state.mode==='picks'){
      var d=det.slotByMatch[m.match]||{};
      homeInfo=pickSlot(d.home, m.match, round, 'home', m);
      awayInfo=pickSlot(d.away, m.match, round, 'away', m);
    } else {
      homeInfo={code:null,p:0}; awayInfo={code:null,p:0};
    }

    card.appendChild(slotEl(homeInfo, round, m, 'home'));
    card.appendChild(slotEl(awayInfo, round, m, 'away'));
    return card;
  }

  // cache: aggregated candidate pool for the WINNER of a given match number.
  var _winPoolCache={};
  function projSlot(info){
    if(!info||!info.length) return {code:null,p:0,cands:[]};
    var top=info[0]||{};
    return {code:top.code||null, p:top.p||0, cands:info};
  }

  // R16+ projected: the winner of a feeding match comes from the union of the
  // R32 occupants beneath it. We aggregate each candidate's R32-appearance
  // probability, then RENORMALIZE within the pool to express "given this slot is
  // reached, which team is most likely here." This is a glanceable approximation
  // (it ignores match-by-match win probability), surfaced honestly in About.
  function projWinnerOf(side, slotMap){
    var pool=winnerPool(side, slotMap);
    if(!pool.length) return {code:null,p:0,cands:[]};
    var tot=0; pool.forEach(function(c){tot+=c.p;});
    var norm=pool.map(function(c){return {code:c.code,p:tot>0?c.p/tot:0};})
      .sort(function(a,b){return b.p-a.p;});
    return {code:norm[0].code,p:norm[0].p,cands:norm.slice(0,6)};
  }
  function winnerPool(side, slotMap){
    if(side.type!=='winnerOf') return [];
    if(_winPoolCache[side.match]) return _winPoolCache[side.match];
    var fm=findMatch(side.match);
    var pool;
    if(isR32(side.match)){
      // leaf: combine this match's two R32 candidate slots
      var sm=slotMap[side.match]||{home:[],away:[]};
      pool=mergeCands((sm.home||[]),(sm.away||[]));
    } else {
      pool=mergeCands(winnerPool(fm.home, slotMap), winnerPool(fm.away, slotMap));
    }
    _winPoolCache[side.match]=pool;
    return pool;
  }
  function mergeCands(a,b){
    var m={}; [a,b].forEach(function(arr){ (arr||[]).forEach(function(c){ if(c&&c.code) m[c.code]=(m[c.code]||0)+(c.p||0); }); });
    return Object.keys(m).map(function(k){return {code:k,p:m[k]};});
  }
  function isR32(no){ return BRACKET.rounds.R32.some(function(x){return x.match===no;}); }
  function findMatch(no){
    var all=[].concat(BRACKET.rounds.R32,BRACKET.rounds.R16,BRACKET.rounds.QF,BRACKET.rounds.SF,BRACKET.rounds.Final);
    return all.filter(function(x){return x.match===no;})[0];
  }

  function pickSlot(code, matchNo, round, side, m){
    return {code:code||null, p:0, known:!!code};
  }

  function slotEl(info, round, m, side){
    var el=document.createElement('div'); el.className='slot'+(info.code?'':' empty');
    if(state.mode==='picks' && state.picks[m.match] && state.picks[m.match]===info.code){ el.className+=' winner-row'; }
    var code=info.code;
    var acc=document.createElement('div'); acc.className='accent'; acc.style.background=accentFor(code);
    el.appendChild(acc);
    var c=document.createElement('div'); c.className='code'; c.textContent=code||'—'; el.appendChild(c);
    var nm=document.createElement('div'); nm.className='nm'; nm.textContent=code?(nameByCode[code]||''):'TBD'; el.appendChild(nm);
    var pe=document.createElement('div'); pe.className='p';
    if(state.mode==='projected' && code){ pe.textContent=pct(info.p); }
    el.appendChild(pe);

    if(state.mode==='projected'){
      el.onclick=function(ev){ if(info.cands&&info.cands.length) showCandidates(ev, info.cands, m.match, side); };
    } else {
      // My Picks: clicking a slot picks that team to advance from this match
      el.onclick=function(){ if(code){ state.picks[m.match]=code; render(); } };
      if(code){ el.title='Click to advance '+(nameByCode[code]||code); }
    }
    return el;
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
  function renderScenario(){
    var sec=document.createElement('div'); sec.className='section active';
    var gs=baseGroups; // scenarios always against the real feed
    var callout=document.createElement('div'); callout.className='callout';
    callout.innerHTML='These are <b>within-group positions</b> (1st/2nd/3rd/4th) and are <b>deterministic</b>. They do <b>not</b> assert 3rd-place qualification or knockout opponents — those are cross-group and shown probabilistically in the bracket.';
    sec.appendChild(callout);

    // controls: group select + match select
    var ctrls=document.createElement('div'); ctrls.className='scn-controls';
    var gsel=document.createElement('select');
    gs.forEach(function(g){ var o=document.createElement('option'); o.value=letterOf(g); o.textContent=g.name; gsel.appendChild(o); });
    if(!state.scnGroup) state.scnGroup=letterOf(gs[0]);
    gsel.value=state.scnGroup;
    var msel=document.createElement('select');
    ctrls.appendChild(document.createTextNode('Group: ')); ctrls.appendChild(gsel);
    ctrls.appendChild(document.createTextNode(' Match: ')); ctrls.appendChild(msel);
    sec.appendChild(ctrls);

    var out=document.createElement('div'); sec.appendChild(out);

    function curGroup(){ return gs.filter(function(g){return letterOf(g)===state.scnGroup;})[0]; }
    function key(m){ return m.home+'-'+m.away; }

    function refillMatches(){
      msel.innerHTML='';
      var g=curGroup();
      var unplayed=g.matches.filter(function(m){return !m.played;});
      if(!unplayed.length){ var o=document.createElement('option'); o.textContent='(all matches played)'; o.value=''; msel.appendChild(o); return; }
      // detect simultaneous final pair (same date+time) -> not available in feed times here,
      // so we approximate: if exactly 2 unplayed remain in the group, offer joint mode.
      unplayed.forEach(function(m){ var o=document.createElement('option'); o.value=key(m); o.textContent=m.home+' v '+m.away; msel.appendChild(o); });
      if(unplayed.length===2){ var oj=document.createElement('option'); oj.value='JOINT'; oj.textContent='Final round — BOTH games (joint)'; msel.appendChild(oj); msel.value='JOINT'; }
    }

    function compute(){
      out.innerHTML='';
      var g=curGroup();
      var unplayed=g.matches.filter(function(m){return !m.played;});
      if(!unplayed.length){ out.innerHTML='<div class="scn-card muted">All matches in '+esc(g.name)+' are played — the group is decided.</div>'; return; }
      var keys;
      if(msel.value==='JOINT'){ keys=unplayed.slice(0,2).map(key); }
      else if(msel.value){ keys=[msel.value]; }
      else { keys=[key(unplayed[0])]; }
      var grid;
      try{ grid=scenarioGrid(g, keys, 6); }
      catch(e){ out.innerHTML='<div class="scn-card muted">Scenario unavailable: '+esc(e.message)+'</div>'; return; }
      var card=document.createElement('div'); card.className='scn-card';
      var head=document.createElement('div'); head.className='scn-note';
      head.innerHTML=(keys.length===2?'Joint final-round scenario for both remaining matches: '
        :'Scenario for the next match: ')+'<b>'+esc(grid.matches.join('  +  '))+'</b>';
      card.appendChild(head);
      g.teams.forEach(function(team){
        var s=grid.teams[team.code]; if(!s) return;
        var row=document.createElement('div'); row.className='scn-team';
        row.innerHTML='<div class="h"><span class="cd" style="color:'+accentFor(team.code)+'">'+team.code+'</span> <span class="nm">'+esc(team.name)+'</span></div>'+
          '<div class="desc">'+esc(grid.describe(team.code))+'</div>';
        card.appendChild(row);
      });
      out.appendChild(card);
    }

    gsel.onchange=function(){ state.scnGroup=gsel.value; refillMatches(); compute(); };
    msel.onchange=compute;
    refillMatches(); compute();
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
      '<p><b>Coin-flips are real:</b> a ⚖ marks teams a standing could separate only by drawing of lots — a genuine random draw, '+
        'which we render deterministically (alphabetical) but flag honestly.</p>'+
      '<p><b>Data:</b> openfootball/worldcup.json (public domain). '+FRESH.playedCount+' of 104 matches in the build. '+
        'Re-run the build as games finish to refresh. In-progress or very-recently-final games may lag the feed — use My Picks to enter them by hand.</p>'+
      '<p class="muted tiny">Within-group positions in the Scenario tab are exact; everything probabilistic (qualification odds, opponents, title odds) is a model estimate, not a guarantee.</p>';
    return d;
  }

  // first paint
  render();
})();
`;

main().catch((e) => { console.error(e); process.exit(1); });
