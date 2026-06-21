// build-allocation.mjs
// Parses the Annex C third-place allocation table from the raw wikitext of
// Template:2026 FIFA World Cup third-place table (fetched via curl) into
// allocation.json. NOT hand-typed, NOT model-recalled.
//
// Usage: node build-allocation.mjs <path-to-tpl_raw.wikitext> <out allocation.json>
import { readFileSync, writeFileSync } from "node:fs";

const SLOT_LABELS = ["1A", "1B", "1D", "1E", "1G", "1I", "1K", "1L"];

const srcPath = process.argv[2];
const outPath = process.argv[3];
if (!srcPath || !outPath) {
  console.error("usage: node build-allocation.mjs <tpl.wikitext> <allocation.json>");
  process.exit(1);
}

const text = readFileSync(srcPath, "utf8");
const lines = text.split(/\r?\n/);

// Walk the file. Each table row begins with `! scope="row" | N`.
// The cells for that row are on the subsequent `|`-prefixed line(s), up to the
// next `|-` row separator (or the closing `|}`). One row (the first) also carries
// the `! rowspan="495" |` separator cell on its own line — we drop any `!` line.
const rows = [];
let i = 0;
while (i < lines.length) {
  const m = lines[i].match(/^!\s*scope="row"\s*\|\s*(\d+)\s*$/);
  if (!m) { i++; continue; }
  const rowNo = parseInt(m[1], 10);
  i++;
  // gather data cells until next `|-` or `|}` or next `! scope="row"`
  const cellChunks = [];
  while (i < lines.length) {
    const ln = lines[i];
    if (/^\|-/.test(ln) || /^\|\}/.test(ln) || /^!\s*scope="row"/.test(ln)) break;
    if (/^\|/.test(ln)) {
      // strip leading `| ` then split on `||`
      cellChunks.push(ln.replace(/^\|\s?/, ""));
    }
    // lines starting with `!` (the rowspan separator) are ignored
    i++;
  }
  const joined = cellChunks.join(" || ");
  const cells = joined.split("||").map((c) => c.trim());
  rows.push({ rowNo, cells });
}

if (rows.length !== 495) {
  console.error(`WARN: parsed ${rows.length} rows, expected 495`);
}

const allocation = {};
const meta = []; // for validation
for (const { rowNo, cells } of rows) {
  // Qualifying groups: cells that are a bold single letter '''X'''
  // Slot fills: cells that look like 3X
  const qualified = [];
  const slots = [];
  for (const cell of cells) {
    const bold = cell.match(/^'''([A-L])'''$/);
    if (bold) { qualified.push(bold[1]); continue; }
    const third = cell.match(/^3([A-L])$/);
    if (third) { slots.push(third[1]); continue; }
    // blank cells, empty, or stray markup -> ignore
  }
  if (qualified.length !== 8) {
    console.error(`row ${rowNo}: expected 8 qualified groups, got ${qualified.length}: ${qualified.join("")}`);
    continue;
  }
  if (slots.length !== 8) {
    console.error(`row ${rowNo}: expected 8 slot fills, got ${slots.length}: ${slots.join("")}`);
    continue;
  }
  const key = [...qualified].sort().join("");
  const slotMap = {};
  for (let s = 0; s < 8; s++) slotMap[SLOT_LABELS[s]] = slots[s];
  if (allocation[key]) {
    console.error(`row ${rowNo}: duplicate key ${key}`);
  }
  allocation[key] = slotMap;
  meta.push({ rowNo, key, slotMap, qualified });
}

writeFileSync(outPath, JSON.stringify(allocation, null, 0) + "\n");
console.log(`Wrote ${Object.keys(allocation).length} entries to ${outPath}`);

// ---- inline validation ----
let errors = 0;

// 1. Every key has 8 distinct letters
for (const key of Object.keys(allocation)) {
  if (key.length !== 8 || new Set(key).size !== 8) {
    console.error(`bad key ${key}`); errors++;
  }
}

// 2. No-own-group invariant. Slot "1X" opposes winner of group X; the 3rd-place
//    team placed there must NOT come from group X.
for (const { rowNo, slotMap } of meta) {
  for (const [label, grp] of Object.entries(slotMap)) {
    const winnerGroup = label.slice(1); // "1E" -> "E"
    if (grp === winnerGroup) {
      console.error(`row ${rowNo}: VIOLATION own-group: slot ${label} filled by group ${grp}`);
      errors++;
    }
  }
}

// 3. The 8 slot fills in a row are exactly the 8 qualified groups (a permutation)
for (const { rowNo, key, slotMap } of meta) {
  const fills = Object.values(slotMap).slice().sort().join("");
  if (fills !== key) {
    console.error(`row ${rowNo}: slot fills ${fills} != qualified set ${key}`);
    errors++;
  }
}

console.log(errors === 0 ? "VALIDATION OK (keys, no-own-group, permutation)" : `VALIDATION FAILED: ${errors} errors`);
