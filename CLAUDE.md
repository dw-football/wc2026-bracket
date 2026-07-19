# WC2026 Bracket Projector

> **FORK-FORWARD (Euro 2028 / WC 2030):** the full rebuild playbook — structural deltas (24 teams / 6 groups /
> 4-of-6 thirds / no 3rd-place / UEFA tiebreakers), the file-by-file change map, and the two landmines (ESPN slug
> `fifa.world`→`uefa.euro`; the 4-11am-ET dead window breaks for a UK-hosted tournament) — lives in David's vault at
> `Personal/soccer/Before Euro 2028 - rebuild the bracket projector.md`. A dated task (⏳ 2028-04-03) + a Jul-20-2026
> task to disable the `WC2026-autosync` scheduler both live in `Personal/tech/Claude setup.md`.

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

## RESUME
Next action: NOTHING PENDING — KO auto-deploys unattended; tree clean, all pushed (latest UI `803c45e`), Pages
verified live (stamp `2026-07-15T22:43:58`). **Both semis done: M101 FRA 0-2 ESP, M102 ENG 1-2 ARG → 102/104.**
Only two games left, both auto-deploy: **M103 3rd place FRA v ENG (Jul 18, 5p, Miami)** and **M104 Final ESP v ARG
(Jul 19, 3p, NY/NJ)**. **Latest fix (2026-07-15 `803c45e`) — the Final & 3rd-place now show Elo WIN odds** (ESP 50%/
ARG 50%; FRA 52%/ENG 48%) on the locked-but-unplayed matchup; before this a terminal match showed bare NAMES (its
"who wins" number had nowhere to live — no look-ahead column). Self-triggers on the deploy of the 2nd semi (both
feeders resolved → win-% replaces reach-%); round-agnostic, carries to future Finals; Euro-safe (no 3rd-place there).
See SHIPPED 2026-07-15. Recent round-agnostic UI/logic fixes still live: (1) 2026-07-04 `a2de4ec` — KO winner
propagation across ALL rounds; (2) 2026-07-05 `3118592` — locked teams show full NAME; (3) 2026-07-05 `f33e3d6` —
completed-vs-upcoming legibility; (4) 2026-07-14 — 3rd-place loserOf contenders/%s + Final/3rd calendar auto-sync.
If a new pens game's popover shows no takers, that's ESPN lag (their `summary.shootout` block trails FT by ~5 min);
the self-heal + the poll pattern used 7-03 backfill it — do NOT treat empty pens as a bug.
Then read: SESSIONS.md (SHIPPED status-block logs + Session Notes) for history.
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
- [ ] (FORK-FORWARD, next tournament — David 2026-07-05) Long-name + decider-tag overflow in the compact
      R32 column. Locked-in teams now render the full country NAME (bold, code dropped); the tightest layout
      is a long name in a PENS/AET R32 row ("3B Bosnia & Herzegovina 2  3–4 pens"). Current field fits (it
      truncates with "…" rather than breaking), so no action this cup. PLAN: when a team wins on penalties/AET
      such that name + score + tag would overflow, shorten the DISPLAY name (e.g. "Bosnia & Herzegovina" →
      "Bosnia") — a render-only display-name override keyed off the width-would-overflow condition, leaving
      teams.json canonical (so standings/scenario/calendar are unaffected). Only the R32 pens/AET rows need it.
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

*Per-session history → SESSIONS.md.*
