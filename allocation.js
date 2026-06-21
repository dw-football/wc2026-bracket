// allocation.js
// FIFA 2026 World Cup "Annex C" third-place allocation: maps which eight
// third-placed groups qualify to which round-of-32 third-place slot they fill.
//
// allocation.json is keyed by the canonical combination key: the 8 qualifying
// group letters, sorted alphabetically and concatenated (e.g. "ABCDEFGH").
// Each value maps a slot label ("1A","1B","1D","1E","1G","1I","1K","1L") to the
// GROUP LETTER whose third-placed team fills that slot.
//
// ES module. No dependencies beyond node: builtins.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

let _allocation = null;
function getAllocation() {
  if (_allocation === null) {
    _allocation = JSON.parse(readFileSync(join(__dirname, "allocation.json"), "utf8"));
  }
  return _allocation;
}

/**
 * Normalize an array/Set/string of group letters to the canonical key:
 * uppercased, de-duplicated implicitly by validation, sorted, concatenated.
 * @param {Iterable<string>|string} groups
 * @returns {string} canonical 8-letter key
 */
export function canonicalKey(groups) {
  let arr;
  if (typeof groups === "string") {
    arr = groups.split(/[^A-Za-z]+/).filter(Boolean);
    if (arr.length <= 1) arr = groups.replace(/[^A-Za-z]/g, "").split(""); // "ABCDEFGH"
  } else {
    arr = [...groups];
  }
  const letters = arr.map((g) => String(g).trim().toUpperCase());
  for (const l of letters) {
    if (!/^[A-L]$/.test(l)) throw new Error(`invalid group letter: ${JSON.stringify(l)}`);
  }
  const uniq = [...new Set(letters)];
  if (uniq.length !== 8) {
    throw new Error(`expected 8 distinct group letters, got ${uniq.length}: ${uniq.join("")}`);
  }
  return uniq.sort().join("");
}

/**
 * Look up the Annex C slot->group mapping for a given set of qualifying
 * third-place groups.
 * @param {Iterable<string>|string} qualifiedGroupLetters - the 8 group letters
 *   whose third-placed teams qualified.
 * @returns {Record<string,string>} mapping slot label -> group letter
 */
export function lookupAllocation(qualifiedGroupLetters) {
  const key = canonicalKey(qualifiedGroupLetters);
  const table = getAllocation();
  const entry = table[key];
  if (!entry) {
    throw new Error(`combination ${key} not found in Annex C allocation table`);
  }
  return { ...entry };
}

/**
 * Combine the allocation with the bracket to resolve, for each R32 match that
 * has a "third" slot, which group's third-placed team is assigned there.
 *
 * The bracket's R32 third slots are conventionally labelled by the group
 * WINNER they oppose: a match whose other side is { type:"winner", group:X }
 * has third slot label "1X". We use that to index the allocation.
 *
 * @param {Iterable<string>|string} qualifiedGroupLetters
 * @param {object} bracket - parsed bracket.json
 * @returns {Array<{match:number, slotLabel:string, group:string, candidates:string[]}>}
 */
export function resolveThirdPlaceSlots(qualifiedGroupLetters, bracket) {
  const alloc = lookupAllocation(qualifiedGroupLetters);
  const out = [];
  const r32 = (bracket && bracket.rounds && bracket.rounds.R32) || [];
  for (const m of r32) {
    let thirdSide = null;
    let winnerSide = null;
    for (const side of [m.home, m.away]) {
      if (side && side.type === "third") thirdSide = side;
      if (side && side.type === "winner") winnerSide = side;
    }
    if (!thirdSide) continue;
    if (!winnerSide) {
      throw new Error(`match ${m.match} has a third slot but no winner side to label it`);
    }
    const slotLabel = "1" + winnerSide.group;
    const group = alloc[slotLabel];
    if (!group) {
      throw new Error(`no allocation for slot ${slotLabel} (match ${m.match})`);
    }
    // sanity: the assigned group must be one of FIFA's listed candidates
    if (Array.isArray(thirdSide.from) && !thirdSide.from.includes(group)) {
      throw new Error(
        `match ${m.match} slot ${slotLabel}: allocated group ${group} not in candidate list ${thirdSide.from.join("/")}`
      );
    }
    out.push({ match: m.match, slotLabel, group, candidates: thirdSide.from || null });
  }
  return out;
}
