# WC2026 Bracket Projector

A self-contained, shareable web app that ingests live 2026 World Cup results,
computes group standings (full FIFA-2026 tiebreakers), ranks the 8 best
third-place teams, maps everything into the Round-of-32 via FIFA's Annex C
allocation, runs a Monte-Carlo projection, and renders an interactive knockout
bracket + a per-group scenario calculator. Built to share with friends.

Location: `C:\Users\dwarren\src\wc2026-bracket` (local + git). **Only on THIS
machine** until pushed to GitHub (see "Sharing" — not on Drive, not synced).

## HOW TO RUN (localhost)
```
python -m http.server 8000 --directory dist      # then open http://localhost:8000/
```
The app is one self-contained file (`dist/index.html`) — all code, data, and the
simulator inlined. localhost is preferred over double-clicking the file so the
My-Picks live worker runs cleanly.

## HOW TO UPDATE RESULTS  ("GO" flow)
When a game finishes and David gives a score:
1. Add it to `manual-results.json` (entry: group, team1, team2 [exact openfootball
   names], ft:[h,a]). The feed silently supersedes a manual entry once openfootball
   publishes the same match (already-played matches are skipped).
2. Rebuild: `node build-html.mjs --refresh`  (re-pulls openfootball + applies
   manual results + re-runs the 200k bake; ~1.5 min).
3. David (and friends) hard-refresh the browser.
Everything (standings, sim, bracket, scenario odds) recomputes off the one rebuild.

Already entered manually this tournament: Belgium 0-0 Iran (G), Uruguay 2-2 Cape
Verde (H).

## COMMANDS
- `node build-html.mjs`            — rebuild dist from cached feed + manual results (+200k bake)
- `node build-html.mjs --refresh`  — also re-pull the openfootball feed
- `node --test`                    — full suite (44 tests)
- `node verify-model.mjs`          — print title odds / group odds / modal R32
- `node verify-standings.mjs`      — current standings all 12 groups
- `node export-image.mjs`          — hi-res PNG + PDF of the bracket (uses installed Edge/Chrome)

## ARCHITECTURE
Pure client-side JS baked into one HTML file. Same engine .js runs in Node
(build + tests) and in the browser (live sim). The build inlines everything.
- `engine.js`         — standings, FIFA-2026 tiebreakers, 3rd-place ranking, scenarioGrid
- `model.js`          — Elo→Poisson supremacy model + Monte-Carlo (per-team, per-slot, advanceByPoints, qualifyIfThirdByPoints)
- `allocation.js` + `allocation.json` — Annex C 495-combination 3rd-place allocation
- `bracket.json`      — knockout structure (R32→Final)
- `scenario-summary.js` — final-round (1-2 unplayed) per-team result-based prose + qualify odds
- `group-situation.js`  — pre-final (3+ unplayed) status + magic numbers + next-round triggers
- `adapter.js`        — openfootball feed → engine schema; merges manual-results.json
- `teams.json`        — 48 teams: name, FIFA code, live Elo (scraped from eloratings.net via build-teams.mjs)
- `build-html.mjs`    — the build: fetch + bake + inline → dist/index.html
- `export-image.mjs`  — headless hi-res export
- `*.test.js`         — node:test suites

## ENGINE FACTS (get these right)
- **FIFA 2026 group tiebreakers (CHANGED for 2026):** points → H2H points → H2H GD
  → H2H GF → overall GD → overall GF → fair play → FIFA World Ranking.
  Head-to-head now OUTRANKS overall goal difference; drawing of lots ABOLISHED.
  ⚠️ Step 7 (World Ranking) is PROXIED with Elo (higher = better) — swap in real
  FIFA ranking via team.worldRank if desired (last-resort tiebreaker, rarely hit).
- **Bracket:** R32 + Annex C independently confirmed vs FIFA's official regs PDF +
  ESPN/CBS/Fox/openfootball. R16 match numbers 91-94 had a Wikipedia-parse
  transposition — FIXED. Don't reintroduce.
- USA won Group D, Mexico Group A, Germany Group E (all clinched 1st).

## MODEL / SIM
- Elo→Poisson "supremacy" model; host bonus +80 Elo for USA/MEX/CAN.
- Knockout ties → Elo-weighted shootout coin.
- **200k sims baked at build time** into the default Projected view (instant load,
  tight tails). A live 10k Web-Worker sim runs ONLY when My-Picks edits a result.
- Title odds land ~ARG/ESP 18-21%, FRA ~13%, ENG ~9% (matches the market-aligned
  cluster of the Towards-Data-Science 11-model piece).

## SHARING (see GitHub recommendation in chat)
- Now: localhost for David; send dist/index.html to friends (no auto-update).
- Recommended: push to GitHub + enable Pages (public URL, auto-updates on push).
  The claude.ai Artifact path was abandoned (kept failing for David).

## OPEN / PARKED
- [ ] Push to GitHub + GitHub Pages for a shareable friends URL (David deciding).
- [ ] (Parked, David's call) Market-odds overlay: de-vigged 1X2 as the engine +
      tournament-winner market as a "model vs market" sanity column.
- [ ] (Optional) Real FIFA World Ranking data for the step-7 tiebreaker (Elo proxy now).
- [ ] (Cosmetic) Visual-design polish pass; tighten the widest R32 3rd-place
      two-candidate lines; title/freshness-stamp crowding at top.

## DATA SOURCE
PRIMARY: openfootball/worldcup.json (public domain, no key):
https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json
— community/PR-maintained, ~daily lag → hence the manual-results.json stopgap.
API-Football key in .env (gitignored) is UNUSABLE on the free tier for 2026
(capped to seasons 2022-24). football-data.org is a possible fallback (free token).

State as of 2026-06-21. ~38/104 matches played; group stage in progress.
