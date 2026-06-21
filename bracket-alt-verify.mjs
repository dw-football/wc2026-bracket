// Independent invariant checks for bracket.alt.json (no npm deps).
// Run: node bracket-alt-verify.mjs
import { readFileSync } from "node:fs";

const b = JSON.parse(readFileSync(new URL("./bracket.alt.json", import.meta.url)));
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error("FAIL:", m); } else console.log("ok:", m); };

const GROUPS = "ABCDEFGHIJKL".split("");

// --- R32 invariants ---
const r32 = b.round32;
ok(r32.length === 16, "16 R32 matches");
ok(r32.every((m, i) => m.match === 73 + i), "R32 numbered 73..88 in order");

// winners + runners-up each appear exactly once
const winnerCount = {}, runnerCount = {}, thirdSlots = [];
for (const g of GROUPS) { winnerCount[g] = 0; runnerCount[g] = 0; }
for (const m of r32) for (const side of [m.home, m.away]) {
  if (side.type === "winner") winnerCount[side.group]++;
  else if (side.type === "runnerup") runnerCount[side.group]++;
  else if (side.type === "third") thirdSlots.push(side);
}
ok(GROUPS.every(g => winnerCount[g] === 1), "each group winner appears exactly once");
ok(GROUPS.every(g => runnerCount[g] === 1), "each group runner-up appears exactly once");
ok(thirdSlots.length === 8, "exactly 8 third-place slots");

// the 8 winners drawing a third are A,B,D,E,G,I,K,L
const winnersFacingThird = r32.filter(m => m.away.type === "third").map(m => m.home.group).sort();
ok(JSON.stringify(winnersFacingThird) === JSON.stringify(["A","B","D","E","G","I","K","L"]),
   "winners of A,B,D,E,G,I,K,L draw a third-place team");

// winners of C,F,H,J face a runner-up
const winnersFacingRU = r32.filter(m =>
  (m.home.type === "winner" && m.away.type === "runnerup") ||
  (m.away.type === "winner" && m.home.type === "runnerup"))
  .map(m => (m.home.type === "winner" ? m.home.group : m.away.group)).sort();
ok(JSON.stringify(winnersFacingRU) === JSON.stringify(["C","F","H","J"]),
   "winners of C,F,H,J face a runner-up");

// no third-place candidate set lets a team meet its own group winner
for (const m of r32.filter(x => x.away.type === "third")) {
  ok(!m.away.from.includes(m.home.group),
     `M${m.match}: winner ${m.home.group} not in its own third-candidate set [${m.away.from}]`);
}
// each candidate set has 5 groups
ok(thirdSlots.every(s => s.from.length === 5), "each third-place set lists 5 candidate groups");

// --- single-elimination tree integrity ---
const allRounds = { 16: b.round16, QF: b.quarterfinals, SF: b.semifinals, F: b.final };
const feeders = [];
for (const arr of [b.round16, b.quarterfinals, b.semifinals, b.thirdPlace, b.final])
  for (const m of arr) for (const s of [m.home, m.away]) feeders.push(s);

// every winnerOf reference points to a real, earlier match; each R32..SF winner consumed once
const consumed = {};
for (const s of feeders) if (s.type === "winnerOf") consumed[s.match] = (consumed[s.match] || 0) + 1;
const winnerProducers = [
  ...r32.map(m => m.match), ...b.round16.map(m => m.match),
  ...b.quarterfinals.map(m => m.match), ...b.semifinals.map(m => m.match),
];
ok(winnerProducers.every(n => consumed[n] === 1),
   "each match 73..102 winner feeds exactly one downstream slot");
ok(b.round16.length === 8 && b.quarterfinals.length === 4 &&
   b.semifinals.length === 2 && b.final.length === 1,
   "round sizes 8/4/2/1 (valid single-elimination tree)");

// third-place game consumes both SF losers
const tp = b.thirdPlace[0];
ok(tp.home.type === "loserOf" && tp.away.type === "loserOf" &&
   new Set([tp.home.match, tp.away.match]).size === 2 &&
   [tp.home.match, tp.away.match].every(n => [101,102].includes(n)),
   "third-place game = losers of the two semifinals");

console.log(fails === 0 ? "\nALL INVARIANTS PASS" : `\n${fails} INVARIANT(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
