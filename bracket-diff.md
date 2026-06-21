# Bracket cross-validation: independent sources vs Wikipedia (`bracket.json`)

**Date:** 2026-06-21
**My (independent) bracket:** `bracket.alt.json`
**Wikipedia-derived bracket:** `bracket.json`

## Independent sources used (NOT Wikipedia)
1. **openfootball/worldcup.json** (public domain) — the repo's own `data/raw/worldcup.json`
   carries the full numbered knockout bracket (matches 73-104) with explicit slot
   placeholders (`1A`, `2B`, `3C/E/F/H/I`, `W74`, `L101`, ...). Primary structural source.
2. **CBS Sports** — full match-numbered R32 table (cbssports.com `.../2026-world-cup-schedule-time-location-groups-bracket-usmnt`).
3. **Fox Sports** — R32 bracket by date+venue (foxsports.com `.../world-cup-bracket-scenarios-standings`).
4. **ESPN / CBS / Fox aggregate** — R16 match numbering with venues (matches 91-94).

openfootball, CBS, and Fox **agree on all 16 R32 matches**. (ESPN's *prose* article, when
summarized, produced internally inconsistent match numbers and third-place candidate sets —
that is an artifact of summarizing prose, not a real source disagreement, so ESPN prose was
not used as a structural authority. ESPN's *schedule* data agreed.)

## Result summary

| Round | Verdict |
|-------|---------|
| **R32 (73-88)** | **IDENTICAL** — byte-for-byte same slots, groups, and third-place candidate sets. |
| **R16 pairings (which R32 winners meet)** | **IDENTICAL** as unordered pairs. |
| **R16 match *numbers* 91-94** | **DIFFERENT** — Wikipedia transposes the labels. See below. |
| **QF matchups (which R16 winners meet)** | **IDENTICAL** (same four QF pairings). |
| **QF -> SF wiring (which half of the draw)** | **DIFFERENT** as a consequence of the R16 number swap. |
| **SF / 3rd place / Final feeds** | Same shape; affected by the same R16 numbering issue. |

## R32 — IDENTICAL (all 16 matches)
Every match 73-88 matches exactly. Both have:
- Winners of **A, B, D, E, G, I, K, L** drawing a best third-place team.
- Winners of **C, F, H, J** facing a runner-up.
- Identical third-place candidate sets, e.g. M79 (Winner A) vs 3rd of C/E/F/H/I; M82
  (Winner G) vs 3rd of A/E/H/I/J; M87 (Winner K) vs 3rd of D/E/I/J/L.
- No winner appears in its own third-place candidate set.

## The one real discrepancy — R16 match numbering 91-94

Both sources agree the **pairings** are the same set, but assign different match
**numbers** to the four lower-bracket R16 games:

| R16 feeders (R32 winners) | openfootball / ESPN / CBS / Fox | `bracket.json` (Wikipedia) |
|---|---|---|
| W76 vs W78 (NY/NJ) | **M91** | M93 |
| W79 vs W80 (Mexico City) | **M92** | M94 |
| W83 vs W84 (Dallas) | **M93** | M91 |
| W81 vs W82 (Seattle) | **M94** | M92 |

The independent numbering is confirmed by **venue**: ESPN/CBS/Fox put M91 at New
York/New Jersey (W76 v W78), M92 at Mexico City (W79 v W80), M93 at Dallas (W83 v W84),
M94 at Seattle (W81 v W82) — matching openfootball exactly. `bracket.json` has the upper
and lower R16 pairs swapped.

### Why this matters (it is not cosmetic)
Both files define the QFs identically as **M98 = W93 vs W94** and **M99 = W91 vs W92**.
Because `bracket.json` swapped which pairings carry numbers 91-94, the *same QF
definitions* pull a **different half of the bracket** into each semifinal:

- **Independent (correct):** SF101 reaches R32 feeders {73,74,75,77, 81,82,83,84};
  SF102 reaches {76,78,79,80, 85,86,87,88}.
- **Wikipedia `bracket.json`:** SF101 reaches {73,74,75,76,77,78,79,80};
  SF102 reaches {81,82,83,84,85,86,87,88}.

So `bracket.json` routes the wrong R16 winners into the wrong semifinal side. This is a
**genuine error in `bracket.json`'s R16 numbering**, confirmed by three independent
broadcasters plus openfootball, all anchored to FIFA venue assignments.

## Recommendation
Fix `bracket.json` R16 so that:
- M91 = W76 vs W78
- M92 = W79 vs W80
- M93 = W83 vs W84
- M94 = W81 vs W82

(R32, QF, SF, 3rd-place, and Final definitions are otherwise correct and need no change;
the QF feed lines `M98=W93/W94`, `M99=W91/W92` then resolve to the correct halves.)

## Verification
`bracket-alt-verify.mjs` asserts all structural invariants on `bracket.alt.json`
(16 R32 matches; each winner/runner-up once; 8 thirds = winners of A,B,D,E,G,I,K,L;
C/F/H/J face runners-up; no own-group third; valid single-elimination tree). All pass.
