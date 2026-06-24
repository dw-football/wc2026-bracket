# test-fixtures — FROZEN golden inputs

These are **deliberately stale** snapshots, captured 2026-06-24 at **48/104** played.

- `feed-snapshot.json` — the merged openfootball board (feed + manual-results.json),
  i.e. the exact output of `adapter.fetchRaw()` at capture time.
- `teams-snapshot.json` — `teams.json` (codes, names, live Elo) at capture time, so the
  Monte Carlo (seed 12345) is 100% reproducible regardless of future Elo re-scrapes.

## Why they exist

Scenario prose like `"Win → 2nd; Loss → 3rd (84% to qualify) ..."` is only ever correct
for **one day's standings**. Tests that assert that *exact* string against the LIVE feed
work for a day and then break on the next result — the recurring brittleness this fixes.

So the split (see the header of `scenario-summary.test.js`):

- **"Does the prose match this EXACT string?"** golden tests load these FROZEN files →
  immune to tournament progression.
- **"Does the live prose make SENSE?"** property sweeps + the `claims-validator` oracle +
  `group-situation` invariants keep reading the LIVE feed (`fetchRaw()`) — they hold on
  ANY valid board, so they break only on a genuine wording bug, never on a new result.

## Regenerating (only when the wording LOGIC changes on purpose)

A new score must NOT touch these. Regenerate ONLY when you intentionally change scenario
wording/model logic, then re-read and re-sign-off the exact strings the golden tests pin:

```sh
node -e 'import("./adapter.js").then(async({fetchRaw})=>{
  const fs=await import("fs/promises");
  await fs.writeFile("test-fixtures/feed-snapshot.json", JSON.stringify(await fetchRaw(),null,2)+"\n");
  await fs.writeFile("test-fixtures/teams-snapshot.json", (await fs.readFile("teams.json")));
})'
```
