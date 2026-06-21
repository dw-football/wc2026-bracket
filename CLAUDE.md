# WC2026 Bracket Projector

Tool that ingests 2026 World Cup results, computes group standings (full FIFA
tiebreakers), ranks the 8 best third-place teams, maps them into the Round-of-32
bracket via FIFA's Annex C allocation table, and projects unplayed games to
visualize likely knockout matchups. Shareable with friends as a self-contained
HTML Artifact.

## Architecture (locked 2026-06-21)
- **Engine:** pure client-side JS, baked into ONE self-contained HTML file →
  published as a claude.ai Artifact (private link, shareable, renders on phones).
  All logic runs in the browser: standings, tiebreakers, third-place ranking,
  Annex C bracket mapping, Elo-Poisson Monte Carlo, interactive overrides.
- **Projection:** probabilistic by DEFAULT (Elo-driven Poisson scoreline model,
  Monte Carlo ~10k sims). Must simulate SCORELINES, not just W/D/L — group
  advancement turns on goal difference and goals scored. Friends can click any
  unplayed game to force a result; bracket + downstream odds recompute live.
- **Strength signal:** soccer Elo (eloratings.net), mapped rating diff →
  expected goal supremacy → per-side lambda.
- **Data refresh:** small build step pulls results + Elo, bakes them into the
  HTML's JSON block. Re-run as games finish, redeploy to the same Artifact URL.

## DATA SOURCE DECISION (2026-06-21)
- **PRIMARY = openfootball/worldcup.json** (public domain, NO key):
  https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json
  All 104 fixtures w/ dates, venues, goal scorers, score.ft [a,b], group label.
  Confirmed current (37 played as of 2026-06-21). Team names are full strings
  (e.g. "Mexico") — need a name→FIFA-3-letter-code + Elo-rating map for the 48.
- **API-Football (api-sports.io) free tier CANNOT serve 2026** (capped to
  seasons 2022–2024). Key IS stored in .env (works, just wrong season access).
  Only usable if upgraded to a paid plan — do NOT rely on it.
- **football-data.org** = optional fallback (free token, covers WC, 10/min) if
  openfootball lags during knockouts.

## Three tools, one engine
1. **Live bracket** — probabilistic default + interactive override. The viz.
2. **Scenario calculator** — before each match (and the two simultaneous
   final-round games per group), enumerate the scoreline grid, run each combo
   through the engine, collapse to minimal human-readable conditions per team.
   - Within-group position (1st/2nd/3rd/4th): DETERMINISTIC — state as fact.
   - 3rd-place qualification + knockout opponent: CROSS-GROUP dependent —
     state as probability ("qualifies in ~78% of live scenarios; 4 pts safe").
     Never blur the two.
3. **Python data-refresh step.**

## R32 structure (from FIFA, confirmed)
Group winners A,B,D,E,G,I,K,L draw a best-third-place team. C,F,H,J winners draw
a runner-up. A 3rd-place team never faces its own group winner.
- M74 = Winner D (Germany) vs Best-3rd of A/B/C/D/F
- M79 = Winner E (Mexico)  vs Best-3rd of C/E/F/H/I
- M81 = Winner I (USA)     vs Best-3rd of B/E/F/I/J
(USA/Mexico/Germany already group winners → their slots are trivial.)

## FIFA tiebreakers (group stage), in order
points → goal difference → goals scored → head-to-head (pts, GD, GF among tied)
→ fair-play (disciplinary) → drawing of lots.
Third-place ranking: points → GD → GF → disciplinary → lots.

## OPEN / NEXT
- [x] Data source resolved → openfootball (see above). No signup needed.
- [~] Build standings + tiebreaker engine + scenario calculator (JS) —
      RUNNING in background agent as of 2026-06-21; review on completion.
- [ ] Name→FIFA-code + Elo-rating map for the 48 teams.
- [ ] Data adapter: openfootball JSON → engine group/match schema
      ({name, teams:[{code,name}], matches:[{home,away,homeGoals,awayGoals,played}]}).
- [ ] Parse the 495-row Annex C allocation table from Wikipedia HTML
      programmatically (NOT via model summarization) → JSON.
- [ ] Elo-Poisson Monte Carlo.
- [ ] Bracket render + interactive overrides.
- [ ] Build/refresh script (fetch openfootball + Elo → bake into HTML).

## State as of 2026-06-21 (mid group stage)
WC started 2026-06-11. Mexico = Group E winner, USA = Group I winner, Germany =
Group D winner all confirmed qualified. Group stage final matches ~late June.
