// verify-bracket.mjs
// Loads bracket.json + allocation.json, prints the 16 R32 matchups, runs
// lookupAllocation on sample combinations, asserts the no-own-group invariant
// across ALL captured combinations, and prints the entry count.
//
// Run: node verify-bracket.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { lookupAllocation, resolveThirdPlaceSlots, canonicalKey } from "./allocation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bracket = JSON.parse(readFileSync(join(__dirname, "bracket.json"), "utf8"));
const allocation = JSON.parse(readFileSync(join(__dirname, "allocation.json"), "utf8"));

function slotStr(side) {
  switch (side.type) {
    case "winner": return `Winner ${side.group}`;
    case "runnerup": return `Runner-up ${side.group}`;
    case "third": return `3rd [${side.from.join("/")}]`;
    case "winnerOf": return `Winner of M${side.match}`;
    case "loserOf": return `Loser of M${side.match}`;
    default: return JSON.stringify(side);
  }
}

console.log("=".repeat(72));
console.log("ROUND OF 32 MATCHUPS (FIFA match 73-88)");
console.log("=".repeat(72));
for (const m of bracket.rounds.R32) {
  console.log(`  M${m.match}:  ${slotStr(m.home).padEnd(28)} vs  ${slotStr(m.away)}`);
}

// structural cross-checks on the bracket
console.log("\n" + "-".repeat(72));
console.log("BRACKET STRUCTURE CROSS-CHECKS");
console.log("-".repeat(72));
const winners = [], runners = [], thirdWinnerGroups = [];
for (const m of bracket.rounds.R32) {
  for (const side of [m.home, m.away]) {
    if (side.type === "winner") winners.push(side.group);
    if (side.type === "runnerup") runners.push(side.group);
  }
  // a match with a third slot: record the winner-group it opposes
  const w = [m.home, m.away].find((s) => s.type === "winner");
  const t = [m.home, m.away].find((s) => s.type === "third");
  if (t && w) thirdWinnerGroups.push(w.group);
}
const ALL = "ABCDEFGHIJKL".split("");
const sortedJoin = (a) => [...a].sort().join("");
function assert(cond, msg) {
  if (!cond) { console.error("  FAIL: " + msg); process.exitCode = 1; }
  else console.log("  OK:   " + msg);
}
assert(sortedJoin(winners) === sortedJoin(ALL), "each of 12 group winners appears exactly once");
assert(sortedJoin(runners) === sortedJoin(ALL), "each of 12 group runners-up appears exactly once");
assert(sortedJoin(thirdWinnerGroups) === "ABDEGIKL",
  "the 8 winners facing 3rd-place teams are exactly groups A,B,D,E,G,I,K,L");
const ruWinners = winners.filter((g, i, a) => {
  // winners that face a runner-up (matches with no third slot)
  return false;
});
// derive winners-facing-runnerup directly
const facingRU = [];
for (const m of bracket.rounds.R32) {
  const w = [m.home, m.away].find((s) => s.type === "winner");
  const r = [m.home, m.away].find((s) => s.type === "runnerup");
  if (w && r) facingRU.push(w.group);
}
assert(sortedJoin(facingRU) === "CFHJ",
  "winners of C,F,H,J face runners-up");

// ---- sample allocation lookups ----
console.log("\n" + "-".repeat(72));
console.log("SAMPLE ALLOCATION LOOKUPS (lookupAllocation + resolveThirdPlaceSlots)");
console.log("-".repeat(72));
const samples = [
  ["A", "B", "C", "D", "E", "F", "G", "H"],   // row 495 in the table
  ["E", "F", "G", "H", "I", "J", "K", "L"],   // row 1
  ["A", "C", "E", "G", "I", "K", "B", "D"],   // arbitrary, given unsorted
];
for (const s of samples) {
  const key = canonicalKey(s);
  console.log(`\n  combo ${key}:`);
  const map = lookupAllocation(s);
  console.log("    slot->group: " + Object.entries(map).map(([k, v]) => `${k}=3${v}`).join("  "));
  const resolved = resolveThirdPlaceSlots(s, bracket);
  for (const r of resolved) {
    console.log(`    M${r.match} slot ${r.slotLabel}: 3rd-place of group ${r.group}  (candidates ${r.candidates.join("/")})`);
  }
}

// ---- no-own-group invariant across ALL captured combinations ----
console.log("\n" + "-".repeat(72));
console.log("NO-OWN-GROUP INVARIANT (all captured combinations)");
console.log("-".repeat(72));
let checked = 0, violations = 0;
for (const [key, slotMap] of Object.entries(allocation)) {
  for (const [label, grp] of Object.entries(slotMap)) {
    if (label.slice(1) === grp) {
      console.error(`  VIOLATION ${key}: slot ${label} filled by own group ${grp}`);
      violations++;
    }
  }
  // also: fills must be a permutation of the qualified set
  if (sortedJoin(Object.values(slotMap)) !== key) {
    console.error(`  VIOLATION ${key}: slot fills not a permutation of qualified set`);
    violations++;
  }
  checked++;
}
assert(violations === 0, `no 3rd-place team faces its own group winner across ${checked} combinations`);

// ---- entry count ----
console.log("\n" + "=".repeat(72));
const count = Object.keys(allocation).length;
console.log(`ALLOCATION ENTRY COUNT: ${count}  (expected 495 = C(12,8))`);
assert(count === 495, "captured all 495 Annex C combinations");
console.log("=".repeat(72));
console.log(process.exitCode ? "RESULT: FAILURES PRESENT" : "RESULT: ALL CHECKS PASSED");
