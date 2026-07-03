# WC2026 Bracket Projector

## WORKFLOW RULE — localhost first, push only on command
**NEW FEATURES / code changes: build to `dist/` and let David verify on localhost
FIRST. Do NOT commit or push to GitHub until David explicitly says to.** Deploying =
pushing to GitHub Pages, which is live to friends — that's David's call, per change.
The ONE exception is the **"GO" score-update flow** below, where "GO" itself IS the
authorization to build + push (score refreshes are pre-approved). Everything else
(new UI, logic, layout, copy) stops at localhost until David approves the push.
**ALWAYS ASK before anything HUGE — even inside an authorized flow.** "GO"/"push the
new model" authorizes the routine score update on the CURRENT model; it does NOT
authorize swapping models, big refactors, or anything structural. When a command is
ambiguous between "routine" and "huge" (e.g. "push the new model" = deploy today's
result vs. swap in Mark2), ASSUME ROUTINE and confirm before the huge thing.
(2026-06-23: misread "push out the new model with ALG's win" as deploy-Mark2; David
halted it. Mark2 stays parked on its `model-mark2` branch until explicit go-ahead.)

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

## RESUME
Next action: NOTHING PENDING — R32 auto-deploys unattended. **Through M88; 86/104** (R32 nearly complete — M86/M87
remain). If a new pens game's popover shows no takers, that's ESPN lag (their `summary.shootout` block trails FT by
~5 min); the self-heal + the poll pattern used 7-03 backfill it — do NOT treat empty pens as a bug.
Then read: SHIPPED 2026-07-03 (popover penalty-as-red-card fix + reconciliation gate), Session Notes.
**KO stage is LIVE and auto-deploying — NOTHING TO DO MANUALLY.** The `WC2026-autosync` task on 520 deploys each
R32/KO result UNATTENDED ~5 min after full time: score + winner slotted by name + calendar labels + goal-scorer
popover, in ONE clean commit/push per game. First KO (M73 **RSA 0-1 CAN**) deployed flawlessly 2026-06-28
(FT 4:57 → live 5:02). Group stage complete (72/72). **6-29 R32 status:** M76 **BRA 2-1 JPN** DONE (popover live,
after a Pages-flake + feed-gated-events recovery — see SHIPPED 6-29 pm). M74 **GER 1-1 PAR (PAR 4-3 pens)** DONE +
**shootout takers popover now live** (`ab01739`) — first live shootout; pens detection + popover both fixed; see
SHIPPED 6-29 eve for the divergence/Umbrella/parser saga.
M75 **NED 1-1 MAR (MAR 3-2 pens)** auto-deployed FULLY UNATTENDED (`d7479cd`), 2nd straight shootout, takers live.
**6-30 R32 done + live:** M77 **FRA 3-0 SWE**, M78 **CIV 1-2 NOR** (stranded then recovered — see SHIPPED 6-30),
M79 **MEX 2-0 ECU**. **Through M79; 79/104.** R32 continues (M80+); auto-deploys unattended.
**THREE autosync hardening fixes now in place (deploy can't silently strand a game):**
(1) `gitPushReconciled` (`b6b0aa6`) — every push does `git pull --rebase --autostash` first, so a stray remote push
can't cause a non-FF strand (the GER-PAR failure). (2) `bake()` (`5981e56`) — a transient `build-html --refresh`
feed-pull failure falls back to a cached-feed bake instead of aborting the deploy (the M78 NOR-CIV failure).
(3) `recoverInterruptedDeploy` (`5981e56`) — start-of-tick check finishes any result left uncommitted by an
aborted prior tick, so an interrupted deploy self-heals next tick instead of being dedup-hidden forever.
**Freshness header fixed 7-01 (`3310c16`):** `computeFreshness` now tracks `koResults` (not the day-late feed), so
the "Data through" header no longer lags the bracket — reads MEX 2-0 ECU 79/104; self-heals through the Final.
✅ **github.io block RESOLVED 6-30** — Alfonso (DWP IT) whitelisted github.io; 520 can reach + verify the live site
again (verified directly 6-30: all 3 KO results + both shootouts' takers live, live builtAtISO == HEAD). The
verify-and-self-heal guard is now FULLY functional again (real publish confirmation, not the blocked-network "assume
ok" fallback). ⚠️ **REMAINING OPS RULE: WORK ONLY ON 520** for autosync — though `gitPushReconciled` (`b6b0aa6`)
now reconciles a moved remote before pushing, so a stray cross-machine push can no longer strand a game either.
⚠️ FIFA numbers matches by bracket position, NOT kickoff order. Autosync OFF 4-11am ET; poll opens at KO+115.
520 must stay AWAKE + logged in during games.
**Auto-sync design (current, `96e4f3b` 6-29):** events folded INLINE into the single score deploy
(`fetchEventsInline`, 20s-timeboxed + non-fatal → a slow ESPN never blocks the score), so ONE push per game —
this killed the GitHub-Pages concurrency race that had fired a "deploy failed" email per game (my earlier
two-push tape-delay caused it). A standalone catch-up now runs ONLY on a QUIET tick (no new score) to backfill a
game whose ESPN summary wasn't ready at deploy time. **Two hardening fixes 6-29 pm (`0eeb240`, see SHIPPED above):**
(a) `verifyPagesPublished` — every score push now confirms the live site actually published (by `builtAtISO`)
and self-heals a flaked GitHub Pages deploy by re-triggering, else escalates to the failure email (closes the
"calendar updated, site silently stale" blind spot); (b) `build-events.mjs` KO worklist drives off `koResults`
(not the ~day-late feed) so KO goal-popovers backfill SAME-DAY, not a feed-day later.
**Site == calendar:** KO contender %s come from ONE shared module `ko-slot-dist.mjs` (analytic chained-H2H,
`0.5+λ(E−0.5)`); both build-html (bracket) and bracket-labels (calendar) import it → no drift. Calendar KO labels
mirror the bracket (contender pairs, e.g. `GER 61%/PAR 39%`); group-stage preview preserved behind
`koLabelMode:'highlighted'` for next tournament. 3rd-place OUT badge is tiebreaker-aware (GD), not points-only.
⚠️ **Revert path (FF merges → `git revert -m 1` does NOT apply):** restore prior artifacts → `git checkout
<good-sha> -- docs/index.html dist/index.html && git commit && git push`, and/or pause `WC2026-autosync` on 520.
Bad KO score → edit/remove the line in `manual-ko-results.json` + rebuild (feed self-corrects next day). 106/106 green.
Open code TODOs (Claude-autonomous, low risk): (1) guard `build-teams.mjs` so an Elo re-scrape preserves
`team.worldRank`; (2) the dead-rubber/mutual-draw model blind spot — fork-forward design note (see SHIPPED 2026-06-27).
Model follow-up (parked, future tournaments): the dead-rubber/mutual-draw blind spot — see SHIPPED 2026-06-27
MODEL NOTE.

**PARKED WIP — knockout-rendering UI (2026-06-24 night; reviewed+approved by David; NOT on main):** A throwaway demo built the new knockout bracket rendering. Lives on branch **`demo-mid-r32-backup` @ `5144b3b`** (on top of `f714df1`), worktree **`C:\Users\dwarren\src\wc2026-demo`**, served on **localhost:8008** (disk backup: scratchpad `RECOVERED/demo-latest.html`). **KEEPABLE rendering:** completed-KO **score + AET/`x–y pens` tag**; **greyed losers** in place (no strikethrough); **retired bold-as-confirmed**; **flag-color accent bars** (`FLAG_ACCENT` map + hash fallback); **head-to-head pairs** for next-up / one-ahead (R16) / two-ahead (QF) slots = P(reach this slot), sum 100, NO parens; **exact chained-H2H reach distribution** for deeper slots (SF/Final) — a played R32 collapses to its winner so eliminated teams carry 0 and never distort, sums to 100 (`slotDist`/`winnerDist` recursion); **match-detail popover** (goals/scorers/cards/pens) — currently **FAKE** data. **THROWAWAY (strip before any port):** 20 fake group results in `manual-results.json` + the hardcoded `koResults` object (12 fabricated R32 results + invented scorers). **DECISIONS:** no parens; deep-slot %s via chained H2H (NOT renormalized MC); flag colors; cosmetic changes (flag colors + un-bolded teams) GO LIVE as soon as we port (David's "yes on a"). **ESPN match-event pipeline = NOW IN SCOPE** (David reversed the defer — wants it wired "over the next day or so", PLUS **backfill all events to the completed GROUP-STAGE matches too**). Feasibility CONFIRMED 2026-06-24: `site.api.espn.com/.../fifa.world/summary?event={id}` returns full `keyEvents` (goals w/ scorer + exact minute incl `45'+7'`, cards, subs) + a dedicated `shootout` field; map ESPN `team.id`→FIFA code via the scoreboard competitors.
**PUBLISH PLAN (next 72h, before R32 on Jun 28) — the new rendering is backward-compatible (dormant w/ no KO results + incomplete groups → draws today's projected bracket), so port EARLY and it activates progressively. Two pieces must land, plus the events pipeline:**
- **Events pipeline (shared foundation):** scoreboard(by date)→ESPN eventIds→`summary` per match→parse goals/cards/subs/shootout→cache to a data file→bake. 
- **Increment 1 (early, independent quick win):** group-stage BACKFILL — run the pipeline over the ~52 played group games + add a click-for-detail popover on completed fixtures. Ships with the cosmetics.
- **Increment 2 (before Jun 28):** port the KO rendering into main's `build-html.mjs` (FAKE data removed) + **KO result handling** (score/AET/pens/winner into manual-results + adapter + the auto-sync poller; reuse `knockoutResultsFromRaw`); the SAME events pipeline feeds the KO match-detail popovers (real, not fabricated). Verify localhost @ real data + 74 tests, push on David's go; THEN kill :8008 + remove worktree + delete throwaway branches.
Sequence: tonight Group A auto-deploys → back up + PARAMETERIZE the auto-sync (move machine paths/`.oauth2` file location into a gitignored local config, mirroring `.env`/`calendar-map.local.json`, so the code can be committed+pushed = off-machine backup + cross-machine portable) + push the demo as a backup branch; tomorrow build events pipeline + backfill + start KO port/result-handling.

**BUILD STATUS — 2026-06-25 ~6:45am EDT:**
- Group A auto-deployed overnight unattended, flawlessly (commit `b9d4257`, 54/104, site+calendar, 0 errors) — #4 unattended auto-sync VALIDATED on its first live run.
- Auto-sync PARAMETERIZED + PUBLISHED (commit `d6e83ea`, on GitHub). `calendar-apply.mjs` now reads `$GSUITE_OAUTH_FILE` (no hardcoded path); David's real launcher is gitignored `run-autosync.cmd` (carries `set GSUITE_OAUTH_FILE=…` + `AUTOSYNC_LIVE=1` + `--arm`); committed template = `run-autosync.example.cmd`. Task re-armed (Ready). So auto-sync is now backed-up + cross-machine portable. (2026-06-26: the Task Scheduler task was renamed from the stale `WC2026-autosync-dryrun` to **`WC2026-autosync`** — it's been LIVE for days despite the old name; config unchanged: logged-on/InteractiveToken, 5-min repeat, runs `run-autosync.cmd`. Only runs while David is logged into 520, machine awake, on AC.)
- **KO BUILD ACTIVE — David approved ALL FOUR pieces, dual-path (auto ESPN poller + manual GO backstop), current demo design as-is ("can change later").** Building on **isolated worktree `C:\Users\dwarren\src\wc2026-ko`** (branch `ko-build` off `main` @ d6e83ea) so the live group-stage auto-sync on `main` is untouched; **merge to main + push before Sun Jun 28 3pm EDT** (M73 R32, South Africa v Canada, LA — David's hometown). The demo rendering to port lives on `demo-mid-r32-backup` @ `5144b3b`.
- **#1 IN PROGRESS:** enriched `knockoutResultsFromRaw` (bracket-labels.mjs) → now returns `{winner,loser,home,away,score,decider,pens}` (the shared KO-result shape; `decider`='reg'|'aet'|'pens'; feed can't always tell AET, ESPN poller will), 74/74 green. **NEXT in #1:** extend ESPN poller off the group-only gate (espn-poll.mjs:147) to detect KO FT incl AET/pens/winner (ESPN `summary`/scoreboard has `shootoutScore`/`winner`/period); a KO-results data file merging manual+auto+feed; bake into `koResults`; autosync `deployLive` KO append. **Then** #2 port rendering (fakes stripped, wired to real koResults), #3 ESPN events pipeline + group backfill, #4 failure-only Gmail notify. Verify (74 tests + throwaway KO result + live group path intact) → merge+push before Sun.

Remaining open (parked): **market blend** (Elo\* soft shrink k≈0.35) — confirmed by David, GATED on a de-vigged 48-team winner board; David said NOT now. **Visual-design polish** (#6b): widest R32 3rd-place lines, title/stamp crowding — cosmetic, parked.

⚠️ **CROSS-MACHINE / TOKEN-FREE DEPLOY:** repo is local+GitHub only (not Drive-synced). On any machine: `git clone https://github.com/dw-football/wc2026-bracket.git` → `gh auth login` (GitHub.com/HTTPS/"Authenticate Git: Yes", log in as **dw-football**) → plain **`git push origin main`**. No `.env` token needed.
NEW feature/edit → WORKFLOW RULE (localhost first, push on "go"). Routine scores → "Find new scores and GO" (now also auto-updates the calendar).

## OPEN — #4: UNATTENDED AUTO-SYNC (full plan; awaiting David's 3 decisions, 2026-06-24)
Goal: a timer job that, with NO human in the loop, detects a finished score → updates the live site AND David's Sports calendar → notifies him. TODAY both need an interactive Claude session (calendar writes go through the gcal MCP authed in-session; that's the gap).

**The 4-step loop** (every ~20 min during match windows): (1) poll ESPN `fifa.world` scoreboard (open JSON, no key, near-real-time) for a new FT result; (2) append to `manual-results.json` → `node build-html.mjs --refresh` → `cp dist/index.html docs/index.html` → `git push` (site — git creds already work headless via Windows Credential Manager); (3) `node sync-calendar.mjs` → apply the diff to the Sports calendar; (4) notify David. Steps 1/2/4 need NO new setup.

**The ONE blocker = headless calendar-write auth.** The MCP is tied to the interactive session and is typically ABSENT in a cron/headless run. Need a NON-interactive Google credential:
 - **(a) PREFERRED** — reuse the existing gsuite/gmail-MCP OAuth refresh token for david@warren1.net (Calendar scope); location/setup is in `~/My Drive/Computing/Claude/integrations.md`. If reusable, a small **`calendar-apply.mjs`** hits the Calendar REST API directly → basically immediate AND machine-independent.
 - **(b)** a Google **service account**, share the Sports calendar with it — cleaner long-term, a few minutes of setup.

**Buildable immediately (no auth needed):** the score-poller, `calendar-apply.mjs` (REST writer that reads `calendar-sync-plan.json` + the token), the orchestrator chaining build→push→calendar→notify, PLUS a **dry-run mode** (logs what it WOULD do, writes nothing) so David can watch it for a day before arming.

**Runner:** local **Windows Task Scheduler** on an always-on machine (simplest; that machine must be awake during match windows) OR a Claude Code **cloud routine** (`/schedule` skill; machine-independent — works with approach (a) because it's token-based, sidestepping the headless-MCP caveat).

**Judgment / trust (David's call, not technical):** unattended = no human sanity-check on scores (ESPN becomes the trusted FT source) + auto-push to the LIVE site + auto-write the LIVE calendar with no review → a STANDING exception to the "push only on GO" rule. Blast radius bounded (routine score refreshes on the current model only; the feed self-corrects a bad manual entry next day). David is already OK with auto-CALENDAR; auto-SITE-push unattended is the bigger trust step → hence decision (c).

**DECISIONS NEEDED FROM DAVID:** (a) reuse existing Google token vs service account; (b) local Task Scheduler vs cloud routine; (c) auto-push-to-live-site unattended OK, or calendar-only auto + keep site pushes on "go". **Claude's rec:** confirm token reuse (a) → build the dry-run orchestrator + scripts → run as a local Task Scheduler job on 520 first (watchable/killable) → graduate to a cloud routine later.

## CALENDAR AUTO-SYNC (NEW 2026-06-24 — built; dry-run awaiting David's GO, NOT yet applied)
> ⚠️ **SUPERSEDED 2026-06-24 (pm) — see Session Notes + RESUME.** This is now LIVE and APPLIED: David's Sports calendar is fully labeled (R32 M73-88 + KO M89-103) and auto-updates on each score. The LABEL RULES below are OUTDATED — the deployed `bracket-labels.mjs` now uses: R32 n-based tiers ("A2 (KOR 90%)", "SUI (60%)/CAN", bare code), KO = HIGHLIGHTED teams only with % ("FRA (28%)/GER (17%)/…"), readable structural ("G1/?3" not "Wxx"), 3rd-place blank till SFs. Labels read the SINGLE baked sim (`dist/baked-mc.json`), NOT a re-sim. The PENDING DECISIONS below were RESOLVED (kept David's two-horse guesses; USA-path uses %-breadcrumbs). Open now = #4 unattended auto-sync (RESUME). Kept below for history only.

Tooling to auto-update the Sports-calendar knockout events as results come in, so we stop hand-editing labels. Does NOT write to any calendar — emits a plan; a human/Claude applies it via the gcal MCP after David approves.
- **`bracket-labels.mjs`** — PURE, shareable resolver, ZERO calendar/personal data. `computeMatchLabels(engineState, { watchedTeams, maxPreview=4 })` → label per match 73–103. Rules: R32 group slots (73–88) = 4-tier (locked / exactly-two→favorite-first / ≥75% dominant→`NAME/code` / structural `K2`,`3rd E/H/I/J/K`); knockout (89–103) = ≤4 candidate list favorite-first, else `WATCHED?/…` breadcrumb if a watched team is in the pool, else keep current label. `DOMINANT_THRESHOLD=0.75`. **Group slot codes are GROUP-FIRST per David's preference — `A2`/`F1`/`K2`, NOT FIFA `2A`/`1F`** (a forker may flip it; it's a one-liner). Locked/alive is DETERMINISTIC (scenarioGrid for groups; recursive feeder-tree union for KO); Monte-Carlo used ONLY for favorite ordering + the ≥75% test.
- **`sync-calendar.mjs`** — thin glue: loads gitignored `calendar-map.local.json` (real eventIds + `watchedTeams:["USA"]`), runs the resolver, prints the dry-run table, writes `calendar-sync-plan.json` (gitignored). NO network/apply mode. Final (104) skipped (it's on the Family calendar).
- **`calendar-map.example.json`** — COMMITTED template (placeholder ids) so the code can be shared/forked without exposing David's calendar. Mirrors `.env`/`.env.example`.
- **Private map is gitignored** so it won't reach GitHub; a synced copy lives at `G:\Computing\Projects\wc2026-calendar-map.local.json` (copy into the repo on another machine before running sync).
- Tests: `bracket-labels.test.js` 17/17 green (pure logic). Full suite 70/72 — the 2 fails are the pre-existing live-data brittleness in `scenario-summary.test.js` (Group A/B verbatim wording), unrelated to this code.
- **GO-flow addition:** after `node build-html.mjs --refresh`, run `node sync-calendar.mjs` → review `calendar-sync-plan.json` → apply each non-`unchanged` entry (set summary + stadium description) to the Sports calendar; `unchanged:true`/`summary:null` = leave as-is. R32 fills as groups decide; R16+ reveal only as feeders resolve, plus a `USA?/…` breadcrumb down USA's path.
- **PENDING DECISION (full writeup: vault note `Personal/soccer/World Cup 2026 calendar project.md`):** dry-run today = 20 edits. (a) It reverts match 83 `POR/COL→K2` and 73 `SUI/CAN→B2` (those runner-up slots aren't mathematically two-horse yet) — keep David's guesses or accept the codes? (b) The 4 USA-path KO events render the non-USA side as `Wxx/Lxx` codes (less readable than `G1/?3`,`W QF(Fox)`) — likely wants a friendlier structural label first. Awaiting **go / go R32 only / fix …**.

## MARKET-VS-ELO (done directionally — 2026-06-22)
Our Elo P(advance to R32), 200k sims (regenerate via verify-model.mjs →
`mc.perTeam[].pAdvance`). Market side: one-way "to advance" American prices (FOX/
DraftKings board, cross-checked ESPN), **NOT de-vigged** — two-way "to qualify"
markets weren't findable (oddschecker 403'd); comparison is DIRECTIONAL. Got real
market odds for ~32/48. Report: `_market-vs-elo.html` (local).
Genuine disagreements (survive the vig): **POR** market ~98% vs Elo 81%, **BEL** ~96%
vs 85% (market backs pedigree over current points); the other way **SCO** 88% vs ~75%
and longshots (NZL/ECU/CUW) — our model leans harder on the 8-best-third lifeboat.
Vig artifacts (NOT real gaps): the ≥99% teams showing "Elo higher" (JPN/EGY/NED/MAR/
SWE/CIV) — a heavy favorite's one-way price caps ~87-93% on juice; de-vigged they agree.
Optional next step: group-constrained de-vig (2 advance per group + est. best-third
share) to back out the vig without the "No" price.

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
0. **DOUBLE-SOURCE the score against ESPN (fast, do it every time)** — catches a
   mistyped/transposed score before it goes live. ESPN's `fifa.world` scoreboard is
   near-real-time (the openfootball feed lags ~a day, so it can't confirm same-day):
   `curl -s "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=YYYYMMDD"`
   → check the match is `status.type.completed` (FT) and the score+home/away match what
   David said. If it's still "in" (in progress) or mismatches, STOP and flag it — don't
   enter. (All 4 manual entries to date verified clean vs ESPN + feed.)
1. Add it to `manual-results.json` (entry: group, team1, team2 [exact openfootball
   names], ft:[h,a]). The feed silently supersedes a manual entry once openfootball
   publishes the same match (already-played matches are skipped) — so a manual typo also
   self-corrects on the next `--refresh` once the feed catches up (next-day backstop).
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
Verde (H), Argentina 2-0 Austria (J), France 3-0 Iraq (I), Norway 3-2 Senegal (I,
ESPN-confirmed), Algeria 2-1 Jordan (J, ESPN fifa.world-confirmed). Group I now decided: FRA & NOR both through (play off for 1st/2nd
on Jun 26); SEN & IRQ reduced to a 3rd-place-only longshot via their head-to-head.

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
- [ ] (PARKED, David's call — "maybe in the future", 2026-06-29) LIVE in-match goal-by-goal
      popover build-up: poll ESPN's in-progress `summary` (keyEvents populate mid-match) and
      deploy goals incrementally as scored, instead of the current single post-full-time pull.
      Decided NOT needed now — would mean frequent in-match pushes + give up the spoiler-safe
      "silent until FT" posture. (NOTE: today's events are already auto + same-day-at-FT; this
      is purely about populating DURING the match.)

## DATA SOURCE
PRIMARY: openfootball/worldcup.json (public domain, no key):
https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json
— community/PR-maintained, ~daily lag → hence the manual-results.json stopgap.
API-Football key in .env (gitignored) is UNUSABLE on the free tier for 2026
(capped to seasons 2022-24). football-data.org is a possible fallback (free token).

State as of 2026-06-24. **50/104** (added COL 1-0 COD, SUI 2-1 CAN, BIH 3-1 QAT — Group B complete: SUI 1st, CAN 2nd, BIH 3rd, QAT out). Live model = **Mark2** (λ=0.6, **now venue-aware host bonus** + real FIFA worldRank). Group stage finishing (A/C due 6-24).

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
