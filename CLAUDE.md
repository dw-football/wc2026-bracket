# WC2026 Bracket Projector

## RESUME
Next action: **UPDATE THE TEST SUITE** — `scenario-summary.test.js` and
`group-situation.test.js` are STALE/FAILING after this session's big scenario-text
rewrite (verbatim assertions still expect the old wording). Rewrite their assertions
for the new result-led renderer (see "SCENARIO TEXT (rewritten 2026-06-22)" below),
`node --test` to green, then commit + push. The live app is already deployed and
correct; only the tests lag.
Then read: SCENARIO TEXT (rewritten 2026-06-22), then HOW TO UPDATE RESULTS.

**"Find new scores and GO"** (or "GO" + a score) = update the live bracket. Run the
**HOW TO UPDATE RESULTS** routine below: `node build-html.mjs --refresh` (auto-pulls
any overnight results from the feed) → `cp dist/index.html docs/index.html` → commit →
push → GitHub Pages redeploys https://dw-football.github.io/wc2026-bracket/ (~1 min).
A score the feed hasn't published yet → add to `manual-results.json` first.
(Push note: the tokenized push from `.env` doesn't update the local `origin/main`
tracking ref, so `git log @{u}..` may show a commit as "unpushed" when it's actually
on GitHub — verify with the push output, not the tracking ref.)

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

## HOW TO UPDATE RESULTS  ("GO" flow) + DEPLOY
When a game finishes and David gives a score, run the full routine:
1. Add it to `manual-results.json` (entry: group, team1, team2 [exact openfootball
   names], ft:[h,a]). The feed silently supersedes a manual entry once openfootball
   publishes the same match (already-played matches are skipped).
2. `node build-html.mjs --refresh`   (re-pull feed + apply manual + re-bake 200k; ~1.5 min)
3. `cp dist/index.html docs/index.html`   (docs/ is what GitHub Pages serves)
4. `git add -A && git commit -m "Result: <...>"`
5. Push (token from gitignored .env, kept OUT of git config):
   `TOKEN=$(grep '^GITHUB_TOKEN=' .env|cut -d= -f2); git push "https://dw-football:${TOKEN}@github.com/dw-football/wc2026-bracket.git" main`
GitHub Pages auto-redeploys main:/docs in ~1 min. David + friends hard-refresh
the live URL. Everything (standings, sim, bracket, scenario odds) recomputes off
the one rebuild. (TODO nicety: have build-html.mjs also emit docs/index.html so
step 3 is automatic.)

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

## SCENARIO TEXT (rewritten 2026-06-22)
Per-group "what each result means" prose. TWO renderers by # unplayed in the group:
- **1–2 unplayed → `scenario-summary.js` `summarizeGroup` → `mcResultLedDetail`** (the
  rewrite). RESULT-LED: "Win → …; Draw → …; Loss → …", each own-result on its own line
  (the app splits the detail on "; "; see `build-html.mjs` `.descline`). Engine-derived
  & brute-force-correct (ranks from the full scoreline enumeration, so H2H-before-GD is
  applied for free). Key conventions David signed off on:
  - Opponent results read "Belgium win or draw" (NOT "avoid defeat").
  - When the dominant rank is uniform across branches, collapse to "2nd, but 3rd if X"
    (one "but"; multiple routes to a rank join as "but Nth if A or if B").
  - Goal-difference flips: the edge belongs to the team AHEAD on CURRENT GD; the team
    BEHIND "overturn"s it ("Belgium overturn Egypt's 2-goal goal-difference edge"), the
    leader "hold"s it ("Egypt hold their 2-goal goal-difference edge"). Teams LEVEL on
    GD → "win the tiebreak over X"; both-drew (GD pinned) → "win the goals-scored
    tiebreak"; a true dead heat (both win/lose, GD swingable) → JUMP BALL
    "1st or 2nd on goal difference if …" (no false default).
  - 3rd-place outcomes carry P(qualify | finish 3rd on those points); ~0% → "(out)".
  - "through" reserved for a guaranteed top-2; a virtually-certain (cross-group) advance
    is "v through".
- **3+ unplayed → `group-situation.js` `groupSituation`** (magic-number view: statusLine
  + needLine). Honest "out of the top two" (a best-third berth is cross-group, never
  asserted as "eliminated"); non-monotone magic-number bug fixed (a higher points total
  can be LESS safe, so the guarantee requires the whole upper tail to be safe).
- ⚠️ TESTS LAG: both `*.test.js` still assert the OLD wording → failing. See RESUME.

## SHARING — LIVE
- **Live URL (share with friends): https://dw-football.github.io/wc2026-bracket/**
- GitHub repo: https://github.com/dw-football/wc2026-bracket (PUBLIC). Account: dw-football.
- GitHub Pages serves `main:/docs/index.html`; auto-redeploys on every push (~1 min).
- Push credential: classic PAT (`repo` scope, ~90-day) in gitignored `.env` as
  GITHUB_TOKEN. Used inline at push time (see GO flow); NOT stored in .git/config.
  If pushes start 401'ing, the token expired — David regenerates at
  github.com/settings/tokens and replaces GITHUB_TOKEN in .env.
- localhost still works for David: `python -m http.server 8000 --directory dist`.
- (The claude.ai Artifact path was abandoned — kept failing for David.)

## OPEN / PARKED
- [ ] **NEXT SESSION: update the test suite** to the rewritten scenario text (see RESUME).
- [ ] (Parked, revisit ~late June once more games played) Third-place points-distribution
      analysis — definitive bounds ("≥N groups WILL have a 3rd on ≥X pts", cutoff range)
      + Elo-MC probabilistic statements (cutoff = 3 pts ~85%, P(advance | 3rd on N pts),
      etc.). David found it not yet interesting enough to send out; wants to discuss as
      the field firms up. Throwaway analysis scripts were not kept; reconstruct from this note.
- [x] GitHub + Pages live: https://dw-football.github.io/wc2026-bracket/ (2026-06-21).
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

State as of 2026-06-22. 40/104 matches played (last: New Zealand 1-3 Egypt); group stage in progress.

## Session Notes
- 2026-06-21 — Built the full projector end-to-end: engine + FIFA-2026 tiebreakers
  (H2H before GD; lots abolished), double-sourced bracket (R16 transposition fixed),
  Elo-Poisson Monte Carlo (200k baked + 10k live for My-Picks), interactive knockout
  bracket (tree layout, click-to-pin per-slot popover, R32 seeds/clinch-pop/top-two,
  3rd-place declutter), scenario calculator (result-based prose + qualification odds,
  magic numbers + next-round triggers), live-score entry (manual-results.json:
  Belgium 0-0, Uruguay 2-2). Deployed live to GitHub Pages (dw-football/wc2026-bracket).
  44 tests green. "Find new scores and GO" defined in RESUME above (NOT in global CLAUDE.md).
- 2026-06-22 — Two distinct logic fixes in `group-situation.js` (false "two-draws
  guarantees top-2" from a non-monotone magic number; "out" → "out of the top two"),
  then a full REWRITE of the final-round scenario text into the result-led
  `mcResultLedDetail` (see SCENARIO TEXT section): "Win→/Draw→/Loss→" one per line,
  "win or draw", uniform-rank "but X", GD-edge ownership (ahead holds / behind
  overturns), level→"win the tiebreak", dead-heat jump ball "1st or 2nd on goal
  difference", 3rd-place qualify %s, "v through". Heavy back-and-forth with David on
  exact wording (Groups A/B/C/E/F/G/H all reviewed via a throwaway `_scenario-review.html`
  he opened in-browser — artifacts don't work for him, use a local HTML file + Start-Process).
  Refreshed data (NZ 1-3 EGY → 40/104) and pushed live (commit 1444970). Also explored a
  parked 3rd-place points-distribution analysis (definitive bounds + Elo MC) — David wants
  to revisit it in a few days once more games are played; NOT productionized. ⚠️ Test
  suite left STALE/failing — top priority next session (see RESUME).
