# SESSIONS.md — WC2026 Bracket Projector, per-session history log

Append-only history, oldest first. NOT auto-loaded into context (only CLAUDE.md is) — read on demand. Current state lives in CLAUDE.md (RESUME + Open Items).

---

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
- 2026-06-22 (night) — Decided cross-machine token handling: **`gh auth login`** (browser
  OAuth, creds in Credential Manager, no token to copy; retires the tokenized-URL push) —
  baked into the tomorrow task + pickup note + RESUME; PAT demoted to fallback. Ran the
  **model-vs-market** research (background agent): directional comparison built (`_market-vs-
  elo.html`, local only) — market side is one-way "to advance" prices (NOT de-vigged; clean
  two-way "to qualify" markets unavailable, oddschecker 403'd). Real disagreements: POR/BEL
  (market > Elo), SCO + longshots (Elo > market via best-third); ≥99% "Elo higher" rows are
  vig artifacts. Deployed **France 3-0 Iraq** (commit 14c8c9c) — France clinched live via the
  new best-third logic; Iraq to 0. All pushed (latest 84b1cb1).
- 2026-06-23 — Deployed **Algeria 2-1 Jordan** (Group J, ESPN-confirmed; commit e4dc1bd,
  Mark1, 44/104). Caught + recorded a workflow miss: misread "push out the new model with
  ALG's win" as deploy-Mark2 → halted by David → baked the "ASK before anything HUGE; GO =
  routine update on the CURRENT model, not a model swap" rule into the WORKFLOW RULE. Then a
  big **model-calibration session** (prototype branch `model-mark2-ko`, pushed, NOT deployed):
  (a) side-by-side Mark1 vs Mark2 on remaining group games + reach-round/title — Mark2 is
  Elo-faithful per game (fixes SEN-IRQ 58→71%) but its title OVERSHOOTS market (ARG 22→30 vs
  mkt 14); (b) added a KO-only variance knob **`koLambda`** (E'=0.5+λ(E−0.5), group stage
  untouched) — sweep shows λ≈0.5 lands ARG/ESP on market but can't invert the France>ARG
  ordering (that's Elo staleness); (c) David caught a real **underdog-win-floor bug** (draw cap
  zeroed the dog's win for Δ≳470 — ENG-GHA, ARG-JOR at 0.00%) → fixed with
  `UNDERDOG_WIN_FLOOR=0.45` (dog→~2.4%, E preserved, even games untouched). Market-blend
  approach CONFIRMED by David = force the Elo INPUT ("Elo\*", soft shrink k≈0.35), gated on a
  de-vigged 48-team winner board. David headed to work mid-convo → wrote full cross-machine
  handoff for **520 (NYWDWARREN2)**: branch pushed, token SCRUBBED from synced notes, deploy
  via `gh auth login` + plain `git push origin main`. Pickup: session-notes/2026-06-23-09.md.
- 2026-06-23 (pm, 520) — Resumed on 520; **Mark2 merged → main + deployed** (λ=0.6,
  UNDERDOG_WIN_FLOOR=0.45; POR 5-0 UZB, ENG 0-0 GHA). Main work was a deep **3rd-place
  qualifying analysis** (throwaway scripts `par_drill*.mjs`, `sco_*.mjs`, `third_dist.mjs` left
  in the repo, gitignored/untracked): Scotland conditional on finishing 3rd/3pts → **88.3%**
  qualifying overall. Decomposed by weak-thirds count — modal = 3 weak thirds (34.3% of sims)
  → 91% SCO qual; P(≥4 weak thirds) = 22.5% (Poisson-Binomial DP). **Dead-rubber adjustment**
  (MEX/GER rotated to ~1770 Elo): SCO drops to **83%** — Groups A and E then produce fewer
  cheap 1-pt thirds, taking lifeboat slots from Scotland. Rival-GD analysis: GD=0 rivals
  (IRN/URU/BEL/CPV/COD, ~50% of sims) always beat SCO on GD; cannon fodder (UZB/ALG/PAR avg
  −4 to −5) always beaten; SEN/SWE/AUS/AUT (avg −1.0 to −1.9) are the genuine H2H contests.
  (This note was uncommitted on 520 and kept the autosync hook from pulling; recovered + folded
  in on the 2026-06-24 bring-up.)
- 2026-06-23 (eve, laptop) — Deployed **Panama 0-1 Croatia** (Group L, ESPN-confirmed; commit
  449d288, 47/104). Then a NEW FEATURE (localhost-first → David approved → DEPLOYED commit
  a30e149): per-result **W/D/L probabilities** lead each own-result line in the final-round
  scenario text. Plumbed `outcomeProbs()` (Elo+host bonus) through a `matchProbs` map in
  build-html.mjs `renderGroup` → `summarizeGroup(opts.matchProbs)` → `mcResultLedDetail`'s
  `words()` formatter; merged results sum. Verified the baked group teams carry `.elo` so the
  browser path matches Node. Also **de-brittled `group-situation.test.js`**: its "Group L (real
  data)" test pinned exact scenario wording to one day's live standings, so it broke on every
  new result — rewrote it to assert ONLY data-independent structural + policy invariants
  (correctness wording stays locked on the frozen synthetic fixtures c/d + claims-validator,
  which run on any data). 55/55 green. Long teaching thread with David on git (fetch vs pull,
  ff-only, branch/merge/commit/push, the SessionStart `git-autosync` hook that silently pulled
  520's work), plugins/npm, fork-forward strategy for Euros 2028 / WC 2030, what the 55 tests
  actually are (deterministic rigged scenarios vs enumeration oracle vs Monte Carlo), and a
  qualify-% consistency check (per-branch "X% to qualify" is points-driven/conditional and
  immune to match odds; the blended headline number is what moves with the win prob).
- 2026-06-24 (big session) — Closed the 520 bring-up (was 6 commits behind; dirty tree blocked
  the autosync pull). Then a large run, all DEPLOYED: (1) **de-brittled the test suite** — split
  "does the prose make SENSE" property/oracle checks (stay LIVE) from "exact-string" golden tests
  (now pinned to a FROZEN snapshot in `test-fixtures/`, MC at 50k so wording matches the 200k
  build); fixed a real `bracket-labels.mjs` crash (scenarioGrid throws on ≠1-2 unplayed → safe
  superset). (2) **`3rd (<1%)`** — a 3rd-place outcome shows its sliver % until mathematically out
  (was collapsing <0.5% to "out"); routed 3 render paths through one `thirdIsOut`. (3) **Calendar
  auto-sync built + David's Sports calendar fully labeled** (R32 M73-88 + KO M89-103): new
  `bracket-labels.mjs` rules — R32 n-based tiers ("A2 (KOR 90%)", "SUI (60%)/CAN"), KO shows only
  highlighted teams w/ % ("FRA (28%)/GER (17%)/…"), readable structural ("G1/?3"), 3rd-place blank
  till SFs. **Single source of truth**: `build-html.mjs` writes `dist/baked-mc.json`; `sync-calendar.mjs`
  consumes it (no re-sim → calendar == page always). Fixed a koLambda drift David caught. (4) **UI
  overhaul**: tabs → Projected/Knockout bracket · Group by Group scenarios · Group stage tables
  (tab1 auto-flips when group stage done); **third-place RACE panel** (games-played, % to advance,
  prob-ordered, cut line, MATHEMATICAL green/red bands via group-situation `thirdOnPointsClinches`/
  `…Eliminated`); group-by-group shows completed fixtures w/ score·date·venue. (5) **Venue-aware
  host bonus** — a co-host gets +80 only IN ITS OWN country (Canada at SoFi/LA gets nothing); CAN/MEX
  title odds drop, USA flat. (6) **Real FIFA World Ranking** (11 Jun 2026) → `team.worldRank` for the
  step-7 tiebreaker. Group B updated on both site + calendar. Annex C research (agents): D1←B 99.7%,
  K↔L a 100% locked reciprocal pair, near-locked driven by no-rematch + fixed-bracket + rest (late
  groups barred from early R32 slots). Discussed **#4 unattended auto-sync** — plan delivered, awaiting
  David's 3 decisions (see RESUME). Commits e7fd003→0f5a2b3.
- 2026-06-25 (overnight + morning, 520) — **#4 auto-sync VALIDATED**: Group A auto-deployed unattended,
  flawlessly (ESPN→site→calendar, `b9d4257`, 54/104, 0 errors). Fixed the **worldRank adapter gap**
  (`toGroups` was dropping `worldRank` → step-7 tiebreaker silently used the Elo proxy despite the
  data+comparator being in place; FIXED + live `cdfeeea`, 74/74). **Parameterized + published the
  auto-sync** (`d6e83ea`): machine paths → gitignored `run-autosync.cmd` (`$GSUITE_OAUTH_FILE`),
  committed `run-autosync.example.cmd` — now backed-up + cross-machine portable. Long teaching thread
  on git/backup posture (code→GitHub, secrets→gitignored+Drive; no private repo needed). Big **demo
  iteration** on the KO rendering (branch `demo-mid-r32-backup` @ `5144b3b`, served :8008): two-ahead
  contender pairs, **exact chained-H2H reach distribution** for deep slots (eliminated teams carry 0),
  flag-color accents, greyed losers, no-parens — all reviewed + APPROVED by David. **Decided NOT to
  port the demo as-is**; build the real KO feature (ALL 4: KO result handling, rendering port, ESPN
  events pipeline + group backfill, failure notify), dual-path, on the **`ko-build` worktree**, merge
  before Sun Jun 28. Started #1 (enriched `knockoutResultsFromRaw` @ `6b98115`). Caught + corrected my
  own bad framing (I don't run between turns — "build proceeding heads-down" was false). Then `/wrap`
  to start the big build fresh with full context.
- 2026-06-25 (KO build session, 520) — **Built the ENTIRE knockout feature on the `ko-build` worktree
  — 11 commits, 99/99 tests green, pushed to GitHub, NOT yet merged to main.** #1 KO result handling:
  pure `resolveKnockoutFixtures` (deterministic matchNo→teams; M73=RSA v CAN), `knockoutResultsFromManual`
  + `mergeKnockoutResults` (feed supersedes manual) + committed `manual-ko-results.json`, ESPN poller
  extended off the group-only gate to detect KO FT incl AET/pens/winner (summary fallback for a level
  FT; level-no-shootout HELD winnerless), build bakes `koResults`, autosync `deployLiveKo`. #2 ported the
  approved demo rendering into live build-html wired to REAL koResults (fakes stripped) — verified via
  headless export (empty + injected M73 pens). #3 ESPN events pipeline: `espn-events.mjs` parser (scorer
  from text incl own-goals/stoppage; validated live on POR 5-0 UZB), `build-events.mjs` backfill (all 54
  played group games cached to `data/match-events.json`, now COMMITTED), build bakes koDetails+groupDetails,
  click-for-detail popovers on completed group fixtures + KO bracket (shared `matchDetailCard`). #4
  `notify.mjs` failure-only Gmail-REST send (reuses the gsuite token; spoiler-safe), wired into autosync.
  **Pre-merge hardening** (`86c9d9c`): committed the events cache (else the auto-sync rebuild drops the
  popovers), wrapped the KO poller in try/catch so a KO error can't crash the live GROUP auto-sync.
  Showed David two claude.ai artifacts (today's dormant state ⚽ + the mid-R32 feature demo 🏆). **DECISIONS:**
  push the `ko-build` branch NOW as backup (done), MERGE+go-live Sunday Jun 28 ~noon ET via a dated task +
  Sports-calendar event; let the **KO auto-deploy run UNATTENDED Sunday** (David watching M73); revert path
  captured in the task. Git-teaching thread on branch-push vs merge vs live (Pages serves `main:/docs`).
- 2026-06-27 — **Merged the KO build → main + LIVE, 2 days early** (`74c8246`, fast-forward; verified
  `renderCandSpans` on the production site). Then reworked the bracket slot rendering on David's call:
  per-candidate display — LOCKED slot → full team NAME (no %; the demo wrongly showed advance % on
  determined R32 matchups), 2 contenders → "GER 61% / PAR 39%", >2 → top-by-width + "…". The "…" is gated
  on REAL (≥0.5%) contenders, so COD's 0.26% K2 runner-up tail no longer triggers it while ECU 99% / SCO <1%
  still shows both. R32 keeps its structural chip (`K2`; per-team `3E/3F` for thirds); look-aheads stay clean.
  Fixed a LIVE popup bug David caught (12 D-I final-round games missing events; cache stale 54→66; `a57b213`)
  and made the auto-sync self-heal events on a TAPE-DELAYED decoupled pass (`264b3a3`) — scores immediate, NO
  ESPN in the score path, popups follow a tick later, non-fatal. Long MODEL thread (David VINDICATED on SCO):
  Elo has no dead-rubber / mutual-draw model nor cross-group info edge → over-prices cheap 3-pt thirds (KOR
  44%); throwaway experiment showed forcing the J/L mutual draws to 50% + COD-beats-UZB drops KOR 44%→20% —
  logged as a fork-forward design note (state-dependent scoring intensity), MOOT this tournament. Cleanup:
  removed the `wc2026-ko`/`wc2026-demo`/agent worktrees + deleted `ko-build`/`demo-mid-r32-backup` branches
  (backed up on origin); updated CLAUDE.md + marked the Sunday Obsidian task done + repointed the noon Sports
  calendar event. Sunday = WATCH M73 (RSA-CAN, 3pm EDT); KO auto-deploy runs unattended. 100/100 tests green.
- 2026-06-28/29 — **KO stage went live; calendar+bracket unified; auto-sync hardened.** (1) 3rd-place OUT badge made
  TIEBREAKER-AWARE: `thirdPlaceOutlook`'s elimination branch now uses `compareThirdPlace` (points→GD→GF) for done
  groups, not points-only — caught a real bug where a 3-pt third beaten only on goal difference (Scotland, vs IRN/
  KOR/SEN) read "<1%" instead of OUT; +regression test. (2) David flagged the calendar R16/KO labels diverged from
  the bracket ("A2/B2 v BRA (12%)/…") → rewrote `renderKoSide` to MIRROR the bracket (contender pairs, resolve known
  R32 teams, top-2 + "…") and added a `koLabelMode` toggle preserving the old group-stage highlighted-preview for
  next tournament. (3) Numbers still differed (calendar MC-occupancy vs bracket analytic chained-H2H) → extracted the
  chained-H2H into a SHARED `ko-slot-dist.mjs` that BOTH build-html (bracket) and bracket-labels (calendar) import —
  site == calendar by construction, no drift possible. (4) **M73 RSA 0-1 CAN auto-deployed flawlessly 6-28** (FT
  4:57 → live 5:02), validating the KO result path + tape-delayed events live. (5) 6-29: pulled David's laptop change
  (`96e4f3b`) folding events INLINE into the single score deploy (`fetchEventsInline`, 20s-timeboxed + non-fatal, ONE
  commit/game) — fixes the GitHub-Pages concurrency race my two-push tape-delay had caused (a "deploy failed" email
  per game); standalone catch-up demoted to a quiet-tick-only fallback. Reviewed + verified + on origin. (6)
  De-brittled the espn-poll KO-deployable test (no hardcoded M73; picks any pollable resolved KO match) → 106/106
  (`c7b3905`). (7) Throwaway scenario worktree (ENG/CRO what-if) used + removed — clean isolation (own port + own
  manual-results, never touches live). ⚠️ FIFA numbers matches by BRACKET POSITION, not kickoff order (M76 BRA-JPN
  1pm ET is today's first KO game, NOT M74 Germany 4:30pm).
- 2026-06-29 (pm) — **First real autosync failure on M76 BRA 2-1 JPN — post-mortem + two hardening fixes.** David
  got a GitHub "Run failed" email; calendar had updated but the site hadn't ("calendar knows, site doesn't"). TWO
  root causes, THREE symptoms: (#1) GitHub Pages *deploy* job flaked (build OK, deploy failed 23s) → site served
  yesterday's artifact while the calendar (separate REST sink) was correct; our autosync never knew (push returned
  0). (#2) the KO goal popover was FEED-GATED — `build-events.mjs` built its worklist from the ~day-late
  openfootball feed, so M76's scorers weren't even REQUESTED from ESPN (quiet ticks logged "73 played; 0 to
  fetch") — would've lagged a full day. Manually re-published the score (empty-commit re-trigger), then shipped
  both fixes (`0eeb240`): `verifyPagesPublished` self-heals a flaked Pages deploy by polling the live `builtAtISO`
  + re-triggering (escalates to the failure email on exhaustion); build-events KO worklist now drives off
  `koResults`. Backfilled + deployed M76 popover (Sano/Casemiro/Martinelli), verified live. Corrected my own bad
  diagnoses twice (ESPN-was-slow → actually never-asked; "live=goal-by-goal was wrong" → David's ESPN-builds-it
  model was right). Parked a future LIVE in-match popover idea (David: maybe later). 106/106 green throughout.
- 2026-06-29 (eve) — **M74 GER 1-1 PAR (PAR 4-3 pens) — first live shootout; alarming on the surface, benign at root.**
  David: "GER PAR went to extra time and STILL no score!!!" Diagnosis: (1) pens detection WORKED (committed `20c565e`
  locally) — not the bug; (2) a 2nd machine's push (`dd45d5d`) had moved origin, so 520's push was correctly rejected
  as non-fast-forward → result stranded LOCALLY, unpushed. Reconciled via stash→rebase→push (`38cbb74`); GER-PAR now
  on GitHub. (3) Couldn't VERIFY the live site because **DWP Cisco-Umbrella now 403-blocks github.io** from 520 (new
  tonight; `github.com`/push unaffected) — that block also broke the day's new verify-guard (403 read as "stale" →
  would spam re-triggers + a false failure email), so shipped `0b9cb97` making the guard degrade to "assume ok" on
  any unreachable/blocked/non-app response. **DECISIONS:** WORK ONLY ON 520 (kills the divergence class; chose process
  over auto-pull-rebase on the live job); David to complain to DWP IT re the github.io block; verify all deploys from
  phone/cellular until unblocked. Finished /wrap. ⏳ M75 NED-MAR (FT ~11pm) still to auto-deploy. 106/106 green.
- 2026-06-29 (late eve) — **GER-PAR shootout POPOVER fix + self-heal (continuation).** After the score went live,
  David caught the popover showing the 2 goals but NO penalty takers. Root cause: `parseSummaryEvents` read a
  `shootout:true` flag on `keyEvents`, but fifa.world puts the takers in a DEDICATED top-level `summary.shootout`
  block (keyEvents has only a "Start Shootout" marker) — so pens was always empty (GER-PAR = first shootout to expose
  it). Fixed the parser to flatten `summary.shootout` ordered by shot id, name→side (`ab01739`); re-fetched M74 → 12
  takers live (PAR 4-3). Added a regression test on the real shape (`ab0c375`). Then closed the lag gap (`0694a13`):
  build-events re-fetches a pens result with empty takers + `deployEventsCatchUp` gates on cache CONTENT (not key
  count), so a shootout whose takers lag FT now self-heals automatically. 107/107. All in sync on GitHub (`0694a13`),
  tree clean. M75 NED-MAR still in progress (1-1 → ET) at wrap.
- 2026-06-30 — **NOR-CIV strand → autosync hardened; github.io unblocked.** David: "NORWAY IVORY COAST SCORE DIDN'T
  SAVE!" Diagnosed from the log (correcting my own "mystery interruption" guess): the 3:01pm tick's `build-html.mjs
  --refresh` FAILED (transient feed re-pull) AFTER appending M78 to manual-ko but before commit → stranded +
  dedup-hidden. Recovered by hand (`197d048`), then shipped 3 fixes (`5981e56`): `bake()` (feed-refresh non-fatal,
  cached-feed fallback), `recoverInterruptedDeploy` (start-of-tick self-heal of an interrupted deploy), on top of the
  same-day `gitPushReconciled` (`b6b0aa6`, pull --rebase before push). Also Alfonso (DWP IT) whitelisted github.io →
  520 can verify the live site again; verified all 6-29/6-30 results + shootouts live. Task briefly disabled during
  repair, re-armed (Ready). 107/107.
- 2026-07-01 — **Reviewed + deployed the freshness-header fix (`3310c16`)** authored by a sibling session: the "Data
  through" header lagged the bracket for days because `computeFreshness` read the day-late feed, not `koResults`.
  Reviewed the diff (merge group+KO on a common UTC epoch via new `koEpoch`; feed KO rows excluded → no double-count;
  call moved after koResults built), verified (header now MEX 2-0 ECU 79/104, live confirmed) + 107/107, deployed on
  David's GO. Self-heals through the Final. David confirmed it working on his other computer (view-only, no push —
  single-machine push rule intact). Also: renamed his terminal tab via Windows Terminal right-click Rename Tab (no
  Claude Code setting exists to lock the auto-title; WT-side is the only lever).
- 2026-07-03 — **Popover parser bug + reconciliation gate (see SHIPPED 2026-07-03).** David: "see the Portugal win over
  Croatia last night and check the popover. What happened???" M83 POR-CRO showed a phantom Ronaldo red card + 1-1 vs
  the real 2-1. Root cause: `t.includes('red')` matched "Sco**red**" in ESPN's "Penalty - Scored" type → converted a
  penalty goal into a sending-off. Fixed the parser (trust `scoringPlay`; `\bred\b` for reds), added the goal-count-vs-
  score reconciliation gate David explicitly asked for, +regression tests (109/109). The gate caught 11 corrupted
  matches (all penalty-in-open-play games), healed all. Pushed `1e0a52e`. Then M88 AUS-EGY pens popover was empty —
  ESPN lag, not a bug; polled + backfilled takers when they landed (`aad75f5`). 86/104.
- 2026-07-04/05 — **Two LIVE bracket fixes David caught.** (1) "Who did you claim is first quarterfinalist?! OH NO!!"
  → the first-ever R16 result (M90 MAR 3-0 CAN) had put ELIMINATED Netherlands in the Boston QF, and M90 rendered
  as unplayed. Diagnosed (not emotion): three R32-ONLY assumptions in build-html's KO overlay (winner map, played-
  gate, stale-MC-modal preference) that never got exercised until an R16 game finished. Extracted the all-rounds
  winner/occupant resolution into a pure `ko-resolve.mjs` (unit-tested), generalized played-result decoration +
  koDist-sourced locked team + R16+ played rendering across every round. New `ko-resolve.test.js` (8 tests: exact
  NED-in-QF repro, full R32→Final play-through, "eliminated team appears in no later round"), 117/117. Verified
  headless PNG + live stamp. Shipped `a2de4ec`. (2) David then flagged a completed-bracket inconsistency (`NOR 2`
  in R32 vs `NOR Norway 2` in R16) → decided locked-in teams show full country NAME (bold), drop the code, keep the
  R32 chip, loser stays greyed. Built + compared on localhost side-by-side per his request, shipped `3118592`.
  Filed a fork-forward note (name-shorten on pens/AET overflow — moot this cup, Switzerland fits). Long-name+tag
  overflow confirmed impossible this tournament. Both fixes round-agnostic. Through M91 (91/104).
- 2026-07-05 (pm) — **Completed-vs-upcoming bracket legibility (`f33e3d6`, LIVE).** David: hard to tell a finished game
  from an upcoming one (both bold; completed still showed its future kickoff time). Built a 6-option local mockup,
  he picked B (shaded tile + FT header) and explicitly rejected the green-✓ combo as cluttered. Shipped: completed
  matches get a shaded tile; "FT" shows only in the round still in progress (`roundFullyPlayed` — a fully-done round
  drops FT + time, shows just venue·date, since the shading conveys done); upcoming games pop their whole schedule
  line (venue+date bold dark + kickoff time bold amber). Iterated live on localhost through two "pop it more" rounds
  (time, then location+date). Render-only. Mockup deleted, localhost killed. All three of the day's UI changes are
  round-agnostic and self-apply as the tournament advances.
- 2026-07-15 — **Final & 3rd-place now show Elo WIN odds on the locked, unplayed matchup (`803c45e`, LIVE).** David:
  "for the final and 3rd place game I see NO predicted elo odds of victory!" Both semis decided → M104 (ESP v ARG) &
  M103 (FRA v ENG) are determined but unplayed; the renderer showed bare NAMES because "who wins" normally lives on
  the fed slot one column right — but terminal matches feed nothing. Fix: `buildSlotInfo` terminal pass attaches
  `winP`/`winDist` = P(win this match) via shared `ko-slot-dist` `h2hAdvanceProb`; renderer shows "NAME pp%", popover
  shows the 2-team split. LIVE: Final ESP 50%/ARG 50%, 3rd FRA 52%/ENG 48%. Self-triggers on the 2nd-semi deploy
  (both feeders resolved); round-agnostic + Euro-safe. Also de-brittled 2 stale live-data tests the M101/M102
  auto-sync had left red (frozen pre-semi snapshot; pollReport `now`→Jul 25). 121/121. Verified headless (poster PNG
  clips M103 at bottom — export-only quirk, live page fine), pushed on David's standing GO. David then asked whether
  it'll self-switch next time — yes, confirmed (structural: fires when both terminal feeders resolve).

## SHIPPED status-block log (verbatim; preserved in original as-stacked order, newest first)

## SHIPPED 2026-07-15 — Final & 3rd-place show Elo WIN odds on the locked, unplayed matchup — LIVE (`803c45e`)
Both semis decided (M101 FRA 0-2 ESP, M102 ENG 1-2 ARG) → the Final (M104 = ESP v ARG) and 3rd-place (M103 =
FRA v ENG) became DETERMINED matchups but UNPLAYED. David: "for the final and 3rd place game I see NO predicted
elo odds of victory!" Root = the KO renderer showed a locked slot as just the team NAME (no %), on the 6-27 logic
that "who wins this game" appears one column to the right (the reach-% on the fed slot). But the Final and 3rd-place
are **TERMINAL** matches — they feed nothing — so their win odds were never shown ANYWHERE. **Fix:** a terminal-match
pass in `buildSlotInfo` (build-html) attaches each locked side's `winP`/`winDist` = P(win THIS match) via the shared
`ko-slot-dist` `h2hAdvanceProb` (analytic chained-H2H, same λ=0.6 squeeze + venue-aware host bonus as every reach %),
sums to 100 across the two sides; the `slotGroup` locked-branch renders "NAME pp%" (blue %, matching the played-score
hue) and the click popover shows the 2-team win-odds distribution ("Elo win odds") instead of a trivial "Locked"
label. A played result short-circuits it (score + greyed loser already decorate). Round-agnostic (keys off "no
look-ahead column"). LIVE: **Final ESP 50% / ARG 50%** (Elo 2129 vs 2128 — dead even), **3rd place FRA 52% / ENG
48%** (2084 vs 2055). Verified headlessly (tall screenshot — the POSTER PNG export clips M103 off the bottom at
window-height×2, a pre-existing export-only quirk; the live web page renders it fine at natural height). Also
de-brittled TWO stale live-data tests the M101/M102 auto-sync had left RED (pre-existing, unrelated): the
3rd-place-contenders test now runs on a FROZEN pre-semifinal snapshot (`MANUAL_KO.filter(match<101)` = its stated
intent), and the pollReport KO-deployable test advances `now` to Jul 25 (past the last scheduled KO game) so the
only resolved-but-unplayed KO match left is DUE. **121/121 green.** Pushed on David's standing GO ("if you get the
odds right, publish it fully"); Pages stamp `2026-07-15T22:43:58` confirmed live. 102/104.

## SHIPPED 2026-07-04 — KO winner propagation across ALL rounds (eliminated team in a QF) — LIVE (`a2de4ec`)
David caught the bracket showing **NED (out in the R32) sitting in the M97 Boston QF**, and **M90 CAN-MAR
rendering as UNPLAYED** — on the day of the FIRST-EVER R16 result (M90 MAR 3-0 CAN). NOT emotion, a real bug.
Root cause = **three R32-only assumptions** in build-html's KO overlay that never got exercised until an R16 game
finished: (1) the played-winner map `koWinnerOf` was built from `BRACKET.rounds.R32` ONLY → a decided R16/QF/SF
result never propagated into the round it feeds; (2) the "played → score + greyed loser" path was gated
`rd==='R32'` → M90 showed as an unplayed CAN/MAR matchup; (3) a locked look-ahead slot took its code as
`code||ncands[0].code`, preferring the **stale pre-tournament MC occupancy modal** (NED was ~61% to reach that
slot) over the authoritative eliminated-filtered `koDist` candidate. The DATA was always correct (MAR-beat-CAN
recorded; `ko-slot-dist` knew MAR; M101 look-ahead even read "MAR 40%") — purely a render-resolution fallback.
**Fix:** new pure module **`ko-resolve.mjs`** (`makeOccupantResolver`/`koWinnersByMatch`) = the all-rounds winner
map + concrete side-code resolver, inlined into the page (wrapModuleIIFE) and **unit-tested**. build-html now:
decorates played results + skips the walk for a played match in EVERY round (pinning the two ACTUAL teams from the
result, never the MC occupancy); sources a non-official look-ahead slot's code from `koDist` (never the stale
modal); and renders played R16+/QF/SF/Final games with score + greyed loser + AET/pens tag in the non-R32 renderer.
**Tests:** `ko-resolve.test.js` — 8 new, incl. the exact NED-in-QF reproduction, a full R32→Final play-through
("every fed slot = its feeder winner"), "a team eliminated in round R appears in NO later round", and koDist
zero-probability checks. **117/117 green.** Verified headlessly (PNG): M90 = CAN 0 / MAR 3, M97 = MAR (not NED);
live-published stamp confirmed (`builtAtISO 2026-07-04T20:45`). This fix is round-agnostic → self-applies to every
future R16/QF/SF/Final result. (David will need a hard-refresh — his browser had the old, buggy artifact cached.)

## SHIPPED 2026-07-05 — Locked-in teams show full country NAME (bold), 3-letter code dropped — LIVE (`3118592`)
David noticed the completed-portion inconsistency (R32 played rows showed `NOR 2` while R16+ showed `NOR
Norway 2`). Root = two renderers: `renderR32Inline` prepends the structural group/seed chip (`3E`, `K2`, `A2`)
and dropped the name for space; the R16+ else-branch had room and showed code+name. David's call: **once a team
is LOCKED IN, show the full country name in BOLD and drop the code** — applies to played games AND official/
clinched occupants; the R32 seed chip is RETAINED (`3E Ecuador 0`); a played LOSER stays greyed (winner-bold/
loser-muted preserved, David 100% confirmed). Still-CONTESTED look-ahead slots keep the compact code+% form
(`FRA 67% / MAR 33%`). Changed all locked-render sites in both renderers (R32 played/locked/fallback + R16+
played/locked/fallback); names width-budgeted per decider (reg/AET/pens) and truncate with `…` rather than
overflow. Render-only, no logic/data change. Verified localhost side-by-side + headless PNG, pushed on GO, Pages
publish confirmed. **Longest surviving name = Switzerland (11), fits even with a pens tag → the long-name+tag
overflow case is MOOT this cup**; filed as a fork-forward note (see OPEN/PARKED: shorten display name only when a
pens/AET R32 row would overflow, via a render-only display-name override leaving teams.json canonical).

## SHIPPED 2026-07-05 (pm) — Completed vs. upcoming legibility: shaded tiles + round-aware FT + popped schedule — LIVE (`f33e3d6`)
David: "it's still too difficult to see the difference between a completed game and a live game" (both rendered bold
dark; only a score distinguished them, and a completed game still showed its future kickoff time → read as upcoming).
Built a mockup (`_mockup-completed-vs-upcoming.html`, 6 treatments, opened locally — artifacts don't work for David)
→ he chose **B** (rejected the green-✓ combo E as too cluttered). Shipped in `matchGroup`/`matchHeader` (build-html):
(1) **completed match → shaded tile** (`#e9edf2` fill vs white `#ffffff` for upcoming; keyed on `info.home.result`);
(2) **round-aware FT** — `roundFullyPlayed(round)` gates it: `FT` shows ONLY on finished games in the round STILL IN
PROGRESS; a fully-played round drops FT + the time and shows just `venue · date` (shading already says done), so a
done round isn't cluttered with FT on every game (self-advances R16→QF→…); (3) **upcoming schedule line POPPED** —
`matchHeader` rebuilt with tspans: venue+date bold dark `#2f3a49` FS9 + kickoff time bold amber `#b45309` FS9.5, so
"where + when next" reads at a glance. `koLabel` removed (matchHeader reads KOSCHED directly). Render-only, no logic/
data change. Iterated live on localhost (David: pop the time → then pop location+date too). Mockup file deleted.

## SHIPPED 2026-07-14 — 3rd-place game (M103) contenders/%s fixed + Final & 3rd auto-sync to Sports calendar — LIVE
David caught the bracket's **3rd-place game showing ELIMINATED teams** as contenders (NED/USA/GER/COL/BRA/NOR at
~9-14%) with bogus %s. Root = **`loserOf` was unhandled everywhere**. The 3rd-place match (M103) is the ONLY slot fed
by `loserOf` (the two SF losers); `ko-slot-dist.mjs` and `ko-resolve.mjs` only understood `winnerOf`, so M103 fell
through to the raw Monte-Carlo per-slot occupancy — which is NOT conditioned on played KO results → it listed teams
knocked out rounds ago. **Fix:** added `loserDist(matchNo)` (the per-match COMPLEMENT of `winnerDist`) + a `loserOf`
branch to `slotDist`, and `koLosersByMatch`/`loserOf` to the occupant resolver; wired a new `koLoser` callback through
both callers (build-html + bracket-labels). Now M103 carries ONLY the four semifinalists at their P(reach-and-lose),
and — per David's own framing — **the 3rd-place probs are the exact INVERSE of the finalist probs** (P(final)+P(3rd)=1
per team). A played semi collapses each slot to the beaten team. Round-agnostic. Shared module → fixes bracket AND
calendar in one shot. Tests: `ko-resolve.test.js` +5 (inverse invariant, "no eliminated team in the 3rd-place box",
loserDist-collapses-when-played, 3rd-place-is-the-two-SF-losers; refined the too-strong "loser in no later round" to
allow the legitimate loserOf feed). 121/121 green.
**ALSO 2026-07-14 — killed two bogus "long-standing rules" David never asked for.** The calendar tooling had been
(a) NEVER touching the Final (it lived only on Family shared) and (b) refusing to preview the 3rd-place match until
both semis played. David: neither was ever his instruction. Removed both special-cases — **M103 and M104 now
auto-update on the Sports calendar exactly like every other KO game** (contender previews that resolve as feeders
decide): dropped the `match===104` skip in sync-calendar, dropped the ThirdPlace `sfDone` gate + added the Final to
the resolve loop in bracket-labels (new `Final: ' Final'` suffix). **Created a Sports Final event** (`ji0clj9i…`, Jul
19 3p MetLife) — none existed — and added `104` to `calendar-map.local.json`. Applied both labels live NOW: M103 =
"FRA 54%/ESP 46% v ENG 56%/ARG 44% 3rd place", M104 = "ESP 54%/FRA 46% v ARG 56%/ENG 44% Final". Copying to
Family/elsewhere stays David's MANUAL call (not the tool's job). Calendar-label tests updated (M103/M104 now carry
previews, loops extended to 104). Left the existing Family "World Cup Final [Fox]" event untouched.
**SFs DONE: M101 FRA 0-2 ESP (Dallas), M102 ENG 1-2 ARG (Atlanta) → ESP & ARG to the Final. 102/104.** Remaining:
M103 3rd place FRA v ENG (Jul 18), M104 Final ESP v ARG (Jul 19) — both auto-deploy + now carry Elo win odds (see
SHIPPED 2026-07-15).

## SHIPPED 2026-06-27 — KO build merged LIVE (early) + per-candidate slot rendering
Merged `ko-build` → `main` (FAST-FORWARD) and pushed LIVE 2 days ahead of the Sunday plan — David wanted
the R16 contender %s visible now. **Live + verified** (`renderCandSpans` confirmed on the production site).
100/100 tests green. Shipped the full KO feature (KO result handling, demo rendering port, ESPN events
pipeline + 54-game group backfill, failure-only Gmail notify) PLUS a rendering rework David asked for:
- **Per-candidate slot rendering, by candidate count** (replaces the demo's next-up special-case): LOCKED
  slot (1 team) → full team NAME, no % (the demo wrongly showed advance % on DETERMINED R32 matchups);
  2 contenders → "GER 61% / PAR 39%"; >2 → top-by-width + "…" (click-for-all).
- **"…" gated on REAL contenders (≥0.5%)**: a sub-0.5% tail (e.g. COD's 0.26% K2 runner-up path) no longer
  triggers it, but the genuine 2nd team still shows (ECU 99% / SCO <1%, no "…").
- **R32 keeps its structural chip** (K2 winner/runner-up; per-team 3E/3F for third-place slots); look-ahead
  rounds (R16→Final) stay clean (no chips).
Advance %s use analytic `h2hAdvanceProb` = `0.5+λ(E−0.5)` (λ=0.6, intentional favorite-squeeze) → differs
a few pts from the MC Poisson+shootout (GER 61 analytic vs 64 MC). David chose to LEAVE the analytic
squeeze (it chains cleanly into the SF/Final reach math). Reconciling to the MC = parked option.
**ALSO shipped 2026-06-27:** (a) fixed a live popup bug David caught — the events cache was stale at 54/66, so
the 12 final-round games of groups D-I had no match-detail popup; backfilled all 66 (`a57b213`). (b) Made the
auto-sync SELF-HEAL events on a TAPE-DELAYED, decoupled pass (`264b3a3`, `deployEventsCatchUp`): the score path
is unchanged (immediate, NO ESPN events call), and a separate post-deploy pass backfills events + rebuilds/pushes
a SEPARATE commit ONLY when a new match is cached (key-count gate), fully non-fatal — a game whose ESPN summary
isn't ready at FT is caught on a later tick. So new group + KO games self-populate popups going forward.

**MODEL NOTE — dead-rubber / mutual-draw blind spot (David vindicated on SCO).** The Elo→Poisson model has
NO representation of mutually-beneficial DRAWS / dead-rubber non-aggression, nor the cross-group info edge
of later-kicking-off groups → it under-prices draws in semi-dead final-round games and OVER-prices cheap
3-pt thirds. Empirics: JPN 1-1 SWE (model draw 24%, JPN a 54% fav), PAR 0-0 AUS (26%), CPV 0-0 KSA (26%) —
the mutual-interest games all drew (joint ~6% under the model). Throwaway experiment (harness deleted):
forcing ALG-AUT & CRO-GHA to 50% draw drops KOR's 3rd-place qualify 44%→31%; +COD beats UZB 60% → 20% (and
IRN 92→73 purely via cutoff inflation). KOR's 44% sits on the cutoff knife-edge; honest number ~20-30%. The
dynamic is STATE-DEPENDENT (level + late → both shift to preserve/no-risk; an early goal voids it), so it's
hard to model and MOOT this tournament (group stage ends 6-27). **Logged as a fork-forward design note**
(Euro 2028 / WC 2030): a state-dependent scoring intensity that decays on a mutually-sufficient late scoreline.

## SHIPPED 2026-06-26 — Deterministic 3rd-place QUALIFIED/OUT badge + clinch-math bug fix
Third-place RACE panel: once a group's 3rd has MATHEMATICALLY clinched a top-8 place it now drops the
% + bar and shows a green **QUALIFIED** badge (red **OUT** when eliminated); still-live rows keep the
model %. We deliberately do NOT fake the % to 100% — % is the Elo estimate (capped ">99%"), the badge
is the deterministic fact. **Bug fixed:** the old `thirdOnPointsClinches`/`thirdOnPointsEliminated`
were TIEBREAKER-BLIND (counted any group that could MATCH the points as a threat), so Sweden was held
short of clinching by Bosnia/Ecuador — level on 4 pts but ranked BELOW on GD/GF and unable to pass.
New `thirdPlaceOutlook(group, allGroups)` (group-situation.js) counts only groups that can STRICTLY
OUTRANK (done groups: exact FIFA cascade via new `compareThirdPlace` export in engine.js; live groups:
conservative `maxThirdPoints >= P`). Now SWE **and** ECU read QUALIFIED (only 6 live groups can field a
≥4-pt third — Grp I capped at 3 by FRA/NOR — so ≤7 can pass ECU); BIH correctly still live (8 can pass).
75/75 tests green (added a tiebreaker-aware regression test). Old points-only fns kept (still used by
advanceClinchInfo/scenario prose — same blind spot there is a conservative UNDER-report; follow-up to
route that through thirdPlaceOutlook too).

## SHIPPED 2026-06-25 — Reverse 3rd-place opponent view
On the Group Stage Tables → third-place race panel, each row now shows a sub-line
"if 3rd & through, R32 vs <winner code> %…": the conditional distribution of WHICH GROUP WINNER
that group's 3rd-place team would meet in the R32 (the inverse of the forward "who does ENG meet"
bracket view). Data: `perTeam[].thirdOpponents` in `model.js` (P(opponent | qualified as a 3rd);
opponent is always a group winner per Annex C, respects no-rematch — verified KOR/SCO vs from-lists).
Render in `build-html.mjs thirdsPanel` (`.titem` wrapper + `.topp` sub-line; gated to rows with
advance p≥5%). 74/74 tests green. NOTE: the live auto-sync rebuilt with this working-tree source and
deployed the feature inside score commit `c5652bc` BEFORE the source was committed — this commit just
makes git source-of-truth match the already-live artifacts (no rebuild needed; dist == HEAD == live).

## SHIPPED 2026-07-03 — Popover parser bug: in-play "Penalty - Scored" misread as a RED CARD (+ reconciliation gate)
David caught the M83 **POR 2-1 CRO** popover reading 1-1 with a phantom **Cristiano Ronaldo red card at 68'**. Root
cause = a substring collision in `espn-events.mjs parseSummaryEvents`: ESPN labels a converted in-play penalty
`type.text = "Penalty - Scored"`. The classifier did `if t.includes('goal') … else if t.includes('red')` — "penalty
- scored" has no "goal", but "sco**red**" contains "red" → the goal became a sending-off AND a goal was dropped. The
SCORE (2-1) was always right (different path), which is exactly why it shipped silently. **Fixes (`1e0a52e`, pushed):**
(1) goals now trust ESPN's own `scoringPlay===true` flag (covers Goal / Goal-Header / Own Goal / Penalty-Scored;
excludes a `scoringPlay:false` disallowed/VAR goal), text `'goal'` kept only as a fallback when the flag is absent;
reds match `/\bred\b/` (word boundary — matches "Red Card", NOT "Scored"). (2) **Reconciliation guardrail David asked
for** in `build-events.mjs`: the popover goal count MUST equal the actual score; any cached entry that disagrees is
force-re-fetched (so a parser fix self-heals the cache), and any surviving mismatch prints a loud `SCORE
RECONCILIATION` warning instead of baking silently. (3) regression tests (penalty-scored + disallowed-goal), 109/109.
**Blast radius was 11 matches, not 1** — every game with a penalty scored in open play: KO **M82 BEL-SEN** (Tielemans'
120'+5 AET winner; had shown 2-2 vs real 3-2) + M83, plus 8 group games (ENG-CRO, GER-CUW, AUT-JOR, JOR-ARG, COD-UZB,
SUI-BIH, QAT-SUI, CZE-RSA). The reconciliation gate caught + healed all 11. **Also 7-03:** M88 **AUS 1-1 EGY (2-4
pens)** popover had no takers — NOT a bug, just ESPN's `summary.shootout` block trailing FT (block was entirely
absent, not misparsed). Polled ESPN directly; takers landed ~5 min post-FT (EGY 4-2: Souttar✗/Irvine✓/Mabil✓/
Herrington✗ vs Saber✓/Rabia✓/Salah✓/Abdelmaguid✓), backfilled + pushed (`aad75f5`). The self-heal (`0694a13`) is the
standing backstop for this. 86/104.

## SHIPPED 2026-06-30 / 07-01 — NOR-CIV strand → 3 autosync hardening fixes; github.io unblocked; freshness header
**6-30 M78 CIV 1-2 NOR silently didn't post.** Root cause (from the log, NOT a mystery "interruption"): the deploy
tick ran `build-html.mjs --refresh`, the feed re-pull FAILED transiently, and deployLiveKo threw AFTER appending M78
to manual-ko-results.json but BEFORE commit → result stranded uncommitted, and the poller's dedup (M78 now "recorded")
hid it from every later tick. Recovered by hand (finished the build+push, `197d048`). Then shipped THREE fixes so a
deploy can't silently strand again (`5981e56`): (1) **`bake()`** — the deploy's `--refresh` is non-fatal; a feed-pull
blip falls back to a plain cached-feed bake (the manual result ships either way), only a real bake error throws;
(2) **`recoverInterruptedDeploy`** — start-of-tick, if a result file differs from HEAD (a prior deploy died before
commit), finish it (rebuild + reconciled push + calendar + verify) before polling → self-heals next tick;
(3) earlier same day, **`gitPushReconciled`** (`b6b0aa6`) — pull --rebase --autostash before every push (divergence
guard). Also: **github.io block RESOLVED** — Alfonso (DWP IT) whitelisted it; 520 can reach + verify the live site
again, so the verify-guard is fully functional (not just the blocked-network "assume ok" fallback). 6-30 R32 all
live (M77 FRA 3-0 SWE, M78 NOR, M79 MEX 2-0 ECU); M75 MAR pens auto-deployed unattended earlier.
**7-01 freshness header (`3310c16`):** `computeFreshness(raw, koResults, koSchedule)` merges group games (feed) + KO
games (koResults) on a common UTC epoch (new `koEpoch` parses knockout-schedule EDT labels), feed KO rows excluded so
no double-count → header tracks the real latest result (MEX 2-0 ECU 79/104), no longer lags the bracket; self-heals
through the Final. Fix authored in a sibling session, reviewed + verified + deployed here. 107/107 green throughout.

## SHIPPED 2026-06-29 (eve) — M74 GER-PAR (first live shootout): divergence saga + Umbrella block + guard fix
M74 GER 1-1 PAR went to PENALTIES (PAR 4-3) — the autosync's NEVER-RUN-LIVE pens path. THREE findings:
- **Pens detection WORKED PERFECTLY.** Log: `DEPLOYING KO: M74 GER 1-1 PAR (3-4 pens) -> PAR`, events fetched,
  committed `20c565e`. The scary first-live-shootout passed. NOT the bug.
- **Root cause = git DIVERGENCE blocked the push.** A 2nd machine had pushed a doc commit (`dd45d5d`) to origin, so
  520's commit became a non-fast-forward → `git push` correctly REJECTED it (`! [rejected] (fetch first)`; did NOT
  clobber the other commit). The PAR result sat committed LOCALLY on 520, unpushed → site showed nothing. Fix:
  `git stash` (uncommitted wrap edits) → `git rebase origin/main` (clean, zero overlap: dd45d5d=CLAUDE.md only,
  20c565e=data/docs/dist/manual-ko) → push (`38cbb74`) → stash pop. **DECISION (David): WORK ONLY ON 520** — the
  autosync has no pull-before-push, and single-machine eliminates the divergence class entirely (chose process over
  a riskier auto-pull-rebase on the live job).
- **DWP Cisco-Umbrella started 403-blocking `github.io`** (was reachable earlier today). So 520 — and any tool
  egressing through it, incl. WebFetch — gets a block page, NOT the site. Can't verify live from 520; `github.com`
  (push) unaffected. This also DEFEATED the new `verifyPagesPublished` guard: a 403 read as "stale" → would fire
  bogus empty-commit re-triggers + a FALSE failure email per deploy. **FIX (`0b9cb97`):** `liveHasStamp` returns
  null (can't tell → assume ok, no re-trigger) for any non-200 / non-app-body / network throw; only a real 200 of
  OUR page missing the stamp is a genuine "stale". `awaitPublish` bails early on a sustained-unreachable streak.
  Strictly more conservative — can never cause a bad deploy. (Verify all deploys from phone until IT unblocks
  github.io.)
- **Shootout POPOVER was empty (parser looked in the wrong place).** The GER-PAR popover showed the 2 goals but no
  takers. `parseSummaryEvents` only read a `shootout:true` flag on `keyEvents` — but fifa.world puts NO taker events
  there (just a "Start Shootout" marker); the real list is a DEDICATED top-level `summary.shootout`
  (`[{team:"Germany", shots:[{player, shotNumber, didScore, id}]}]`). **FIX (`ab01739`):** flatten both teams, order
  by shot `id` (ESPN's firing order), map team-NAME→side; keyEvents flag kept as fallback. Re-fetched M74 → 12 takers
  baked + live (PAR 4-3: GER Havertz✗/Kimmich✓/Musiala✓/Woltemade✗/Amiri✓/Tah✗). Renderer (`matchDetailCard pensHtml`)
  was already correct. Regression test on the real shape (`ab0c375`).
- **Shootout SELF-HEAL (`0694a13`).** ESPN's `summary.shootout` can lag FT, so the FT fetch caches a pens result with
  empty takers — and the incremental skip never refilled it (needed the manual re-fetch above). Now build-events
  re-fetches a KO pens result whose cached `pens[]` is empty (bounded — stops when takers land), and
  `deployEventsCatchUp` gates the quiet-tick redeploy on cache CONTENT change (not key count) so a same-key pens-fill
  actually deploys. So a future lagged shootout backfills + deploys automatically. **107/107 green throughout.**
  ⏳ STILL PENDING (as of ~11pm 6-29): **M75 NED-MAR 1-1 → extra time** in progress; auto-deploys when final
  (inherits ALL tonight's hardening: pens detect, single-machine no-divergence, Umbrella-safe guard, shootout self-heal).

## SHIPPED 2026-06-29 (pm) — Two autosync edge-bug fixes (M76 BRA 2-1 JPN post-mortem)
First R32 game watched in real time exposed TWO narrow edge bugs (core pipeline — detection/model/calendar —
worked perfectly; the score commit `a1eced2` + calendar were correct). THREE symptoms, TWO root causes:
- **#1 GitHub Pages deploy FLAKED (external, transient).** Push succeeded, GitHub's *build* job succeeded, its
  *deploy* job failed (23s) → Pages kept serving the PRIOR artifact. Calendar (a separate REST sink) updated fine
  → the "calendar knows, site doesn't" weirdness. David got GitHub's OWN "Run failed" email — our autosync never
  knew (git push returned 0). **FIX (`verifyPagesPublished` in autosync.mjs):** after each score push, poll the
  live site for the artifact's unique `builtAtISO` stamp; if Pages flaked, re-trigger with an empty commit
  (bounded, 2 attempts, ~108s window each); on exhaustion surface via the failure-only email. Never throws / never
  re-runs the deploy (can't double-append a result); a network blip → "assume ok" (no empty-commit spam).
- **#2 KO goal-popover was FEED-GATED (our latent bug since the KO build).** `build-events.mjs` built its
  worklist of "played matches" from `raw.matches` (the openfootball feed, ~a day late) → a just-deployed KO
  score's goal-by-goal popover lagged a full feed-day. The quiet-tick catch-up ran every 5 min but reported
  "73 played; 0 to fetch" because the feed hadn't listed M76 yet. **FIX:** KO worklist now drives off `koResults`
  (manual + feed merged) keyed by matchNo, date from `knockout-schedule.json` → events backfill same-day once
  ESPN's timeline is ready. Also fixed a latent `ReferenceError` (out-of-scope `ymd`) in the no-event warning.
Both live + verified (`0eeb240`; M76 popover live: Sano 29' / Casemiro 56' / Martinelli 90'+5'). 106/106 green.
NOTE: because the cache was already populated by hand-running build-events, the catch-up's key-count gate won't
re-push it — the M76 popover was baked + deployed manually in `0eeb240`. Going forward both fixes are automatic.
**KNOWN GAP (parked, David's "no need" 6-29) — event popovers do NOT self-heal overnight corrections.** SCORES
self-heal (the openfootball feed supersedes `manual-results.json` on `--refresh`), but the goal-scorer POPOVERS do
NOT: `build-events.mjs` is incremental (skips any key already in `data/match-events.json`), so an overnight FIFA/ESPN
own-goal or VAR reclassification is NEVER re-fetched without `--all`. (David caught me overstating "events self-heal
next day" — true for scores, false for popovers.) Parked fix if ever wanted: a **freshness-window** re-fetch (events
for matches played within the last ~2-3 days each run) to catch corrections, while still skipping the settled backlog.
