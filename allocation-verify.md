# Annex C allocation table — independent verification

**Date:** 2026-06-21
**Target:** `allocation.json` (495-combination third-place allocation table, Wikipedia-derived)
**Independent source found:** YES — FIFA official regulations PDF (NOT Wikipedia).

## Source
**FIFA "Regulations for the FIFA World Cup 26" (May 2026 edition), Annexe C —
"Combinations for eight best third-placed teams."**
URL: https://digitalhub.fifa.com/m/636f5c9c6f29771f/original/FWC2026_regulations_EN.pdf

This is FIFA's own competition regulations document — the primary authority, fully
independent of Wikipedia. Annexe C contains the complete table of all 495 combinations.
The PDF text was extracted with `pdftotext -layout` and parsed programmatically (no model
summarization of the numbers).

## What Annexe C contains
- Header row: the eight group-winner slots, in order **1A 1B 1D 1E 1G 1I 1K 1L** — exactly
  the eight winners (groups A,B,D,E,G,I,K,L) that draw a best third-placed team. This matches
  `bracket.json.thirdPlaceSlotLabels` and the R32 structure.
- 495 numbered option rows. Each row's eight `3X` entries are the third-placed groups that
  qualified (the combination), and each entry's column position says which winner that
  third-placed team is allocated against.

## Cross-check method
For every one of the 495 FIFA rows:
1. The set of the eight `3X` groups = the qualifying combination -> sorted to the same
   8-letter key scheme `allocation.json` uses.
2. For each winner slot (1A..1L), compare FIFA's assigned third-place group against
   `allocation.json[combo][slot]`.

## Result — FULL TABLE CONFIRMED (not a spot-check)

| Check | Result |
|---|---|
| FIFA rows parsed | **495 / 495** |
| FIFA combos found as keys in `allocation.json` | **495 / 495** (0 missing) |
| Slot-level assignments compared | **3,960** (495 x 8) |
| **Mismatches vs `allocation.json`** | **0** |
| Own-group violations in FIFA table (winner faces 3 of own group) | **0** |
| Own-group violations in `allocation.json` | **0** |
| `allocation.json` combos where assigned thirds != the combo set | **0** |

**Every single one of the 3,960 third-place allocations in `allocation.json` matches FIFA's
official Annexe C exactly.** The no-team-faces-its-own-group-winner invariant holds in both
the FIFA table and `allocation.json`.

## Verdict
**CONFIRMED.** `allocation.json` is an exact reproduction of FIFA's official Annexe C
allocation table, independently verified against the FIFA regulations PDF (a non-Wikipedia
primary source). No discrepancies. No manual FIFA-PDF re-check by the user is required for
the allocation table.

(Reproduce: extract the PDF with `pdftotext -layout`, grab all `3[A-L]` tokens after the
"Option 1A 1B 1D ..." header, chunk into rows of 8, and diff against `allocation.json`.)
