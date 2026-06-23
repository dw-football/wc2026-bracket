# WC2026 Bracket Projector

## WORKFLOW RULE — localhost first, push only on command
**NEW FEATURES / code changes: build to `dist/` and let David verify on localhost
FIRST. Do NOT commit or push to GitHub until David explicitly says to.** Deploying =
pushing to GitHub Pages, which is live to friends — that's David's call, per change.
The ONE exception is the **"GO" score-update flow** below, where "GO" itself IS the
authorization to build + push (score refreshes are pre-approved). Everything else
(new UI, logic, layout, copy) stops at localhost until David approves the push.

## RESUME
Next action: **finish the model-vs-market "odds of advancing" comparison** (David's
ask, parked mid-flight). OUR side is done — Elo P(advance to R32) for all 48 from
`mc.perTeam[].pAdvance` (200k); snapshot below in "MARKET-VS-ELO". STILL NEEDED: live
market "to qualify from group" odds (de-vigged Yes/No) to sit beside ours, focused on
the contested teams (the ~30 between 5–95%). Market odds require a WEB source
(APISPORTS key in .env is useless for 2026; try oddschecker/oddsportal "to qualify"
pages or a WebSearch for a consolidated table). Build the 48-row table, highlight
where market and Elo disagree.
⚠️ **CROSS-MACHINE (David moved off the laptop NYLDWARREN3):** this repo is local+git
ONLY (not synced). On the new machine: `git clone
https://github.com/dw-football/wc2026-bracket.git` then **`gh auth login`** (as
dw-football, authenticate Git: Yes) — preferred, stores creds in Credential Manager,
no token in any file, and makes plain `git push origin main` work (retiring the
tokenized-URL push). PAT-in-`.env` is now a fallback only. Steps + Elo snapshot in
the synced pickup note `~/My Drive/Computing/Claude/session-notes/2026-06-22-17.md`.
Tests green 55/55; live app current. NEW feature/edit → WORKFLOW RULE (localhost first).
Then read: MARKET-VS-ELO (below), HOW TO UPDATE RESULTS, WORKFLOW RULE.

## MARKET-VS-ELO (parked — Elo side, snapshot 2026-06-22, 41/104 played)
Our Elo P(advance to R32), 200k sims. Regenerate any time: run monteCarlo (see
verify-model.mjs) and read `mc.perTeam[].pAdvance`. Through/near-locked (≥99%): MEX,
CAN, SUI, BRA, USA, GER, NED, JPN, ESP, ARG, MAR, EGY (all 100%), ENG 99.6, FRA 99.4,
COL 98.8, NOR 98.6. CONTESTED (the interesting ones): KOR 94, AUT 94, SWE 94, AUS 94,
CIV 93, SCO 88, BEL 85, PAR 85, POR 81, CRO 78, GHA 72, IRN 70, CPV 65, SEN 63, BIH 51,
COD 51, ALG 50, URU 46, UZB 38, KSA 36, ECU 31, QAT 24, PAN 21, JOR 21, RSA 19, CZE 18,
CUW 16, NZL 15, IRQ 12. Out (~0%): HAI, TUR, TUN. (Throwaway extractor not kept;
reconstruct from this note + verify-model.mjs.)

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
Verde (H), Argentina 2-0 Austria (J).

## COMMANDS
- `node build-html.mjs`            — rebuild dist from cached feed + manual results (+200k bake)
- `node build-html.mjs --refresh`  — also re-pull the openfootball feed
- `node --test`                    — full suite (55 tests, all green; incl. claims-validator.test.js)
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
- `knockout-schedule.json` — matchNo(73-104) → venue/date/time for the bracket headers.
  From openfootball; carries BOTH `venue` (metro, e.g. "Boston") and `ground`
  (stadium suburb, e.g. "Boston (Foxborough)") so the label is a one-line swap.
  `koLabel()` in build-html.mjs renders "venue · date · time EDT" beside each M-number.
- `scenario-summary.js` — final-round (1-2 unplayed) per-team result-based prose + qualify odds;
  carries the deterministic best-third CLINCH (opts.allGroups) so "Clinched a Round-of-32
  place" never regresses to "99%" when a group drops to 1-2 unplayed.
- `group-situation.js`  — pre-final (3+ unplayed). needLine is an ADVANCEMENT reward LADDER
  (`safeRequirement` per target r32/top2/first): "X guarantees a Round-of-32 place; Y clinches
  a top-2 place; Z clinches top spot" — only tie-free, advancement-correct guarantees (folds in
  the best-third cushion; fixes the RPS false "(or better) guarantees top-2"). Also the
  deterministic best-third clinch ("advanced" status).
- `claims-validator.test.js` — INDEPENDENT cross-validation oracle: exhaustive within-group
  enumeration + Monte Carlo, fails the build on ANY false guarantee/clinch. Add new scenario
  wording? It must pass this. (Built after a hand-written test had itself enshrined a false
  "two draws (or better)" guarantee.)
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
- ✅ TESTS CURRENT (2026-06-22): `scenario-summary.test.js` rewritten to the result-led
  wording (~16 assertions); `group-situation.test.js` needed no change. 47/47 green.

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
- [x] Update the test suite to the rewritten scenario text — DONE 2026-06-22 (47/47 green).
- [x] Knockout match venue/date/time on bracket headers (EDT) — DONE/deployed 2026-06-22.
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

State as of 2026-06-22. 41/104 (feed 40 + manual ARG 2-0 AUT); group stage in progress.

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
- 2026-06-22 (pm) — Fixed the stale test suite (background agent): `scenario-summary.test.js`
  ~16 assertions rewritten to the result-led wording; `group-situation.test.js` was already
  green. Now 47/47. Then added knockout match **venue/date/time (EDT)** to every bracket
  match header (R32→Final + 3rd place) via new `knockout-schedule.json` + `koLabel()`:
  "M74 · Boston · Jun 29 · 4:30p EDT". Used metro labels (Boston, NY/NJ…), not stadium
  suburbs — both stored in the JSON for a one-line swap. First pass put a single "knockout
  times EDT" note on the freshness stamp; it collided with the centered round headers (same
  row) → moved EDT onto each match line and restored the short stamp. Established + recorded
  the **localhost-first / push-only-on-command** WORKFLOW RULE (top of file). Deployed
  (commits 4771071, c04de73).
- 2026-06-22 (eve) — Big session, all DEPLOYED (commit f581d52). (1) Full **light theme**
  (David disliked dark, hated it for print): :root swap + ~30 SVG color literals + print
  forced white + image exports. (2) **"Print this group"** button + active-tab printing
  (named @page portrait/landscape). (3) Group-stage **gold best-third highlight** (top-8
  thirds). (4) Bracket header collision fix (TITLE_H 46→62). (5) **ARG 2-0 AUT** manual.
  (6) The MAIN work — scenario correctness: deterministic **best-third clinch** in BOTH
  renderers ("Clinched a Round-of-32 place", never regresses to 99%); needLines reframed
  as an **advancement reward ladder** (R32 → top-2 → top spot), fixing the recurring
  **rock-paper-scissors false guarantee** ("two draws (or better) guarantees top-2" is FALSE
  when a win+loss = 6 can be a 3-way-tie 3rd — but 6 ADVANCES as a best third, so framed
  around advancement it's honest). Root cause it "didn't take" before: a hand-written test
  had ENSHRINED the false wording + the prior fix only guarded 'strictly out', not 'tie→3rd'.
  (7) Built **claims-validator.test.js** (David's idea: check prose vs the scenario runs) —
  independent enumeration + MC oracle; it immediately caught a 2nd false guarantee. 55/55.
  Wording David signed off: "guarantees a Round-of-32 place / clinches a top-2 place /
  clinches top spot", each clause capitalized, "to be safe"→advancement framing. Then David
  re-raised the **model-vs-market advance-odds** ask (Elo side computed — see MARKET-VS-ELO;
  market side still TODO) and switched machines off the laptop → see RESUME + synced pickup.
