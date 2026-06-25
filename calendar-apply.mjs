// calendar-apply.mjs
// ============================================================================
// Headless Google Calendar writer for the unattended auto-sync (#4).
//
// Reuses an EXISTING mcp-gsuite-style OAuth credential file (decision 4a): the
// cached refresh_token + client_id/secret already carries the
// https://www.googleapis.com/auth/calendar scope, so we mint a fresh access token
// and PATCH the calendar events directly via the Calendar v3 REST API. No service
// account, no in-session MCP, machine-independent.
//
// The path to that credential file is REQUIRED via the $GSUITE_OAUTH_FILE env var
// (see run-autosync.example.cmd) — nothing personal is baked into this file.
//
// Consumes calendar-sync-plan.json (written by sync-calendar.mjs): for each entry
// with unchanged:false and a non-null summary, set the event's summary +
// description. unchanged:true / summary:null  =>  leave the event exactly as-is.
//
//   node calendar-apply.mjs          # DRY-RUN: GET each event, show before -> after, write nothing
//   node calendar-apply.mjs --apply  # actually PATCH the events (live)
//
// SECURITY: never logs the token, client_secret, refresh_token, or full eventIds.
// ============================================================================

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const OAUTH_FILE = process.env.GSUITE_OAUTH_FILE;
const PLAN_FILE = join(__dirname, 'calendar-sync-plan.json');

/** Exchange the cached refresh_token for a fresh access token (read-only on the file). */
export async function mintAccessToken(fetchImpl = fetch) {
  if (!OAUTH_FILE) {
    throw new Error('Set the $GSUITE_OAUTH_FILE env var to the path of your OAuth credential JSON (see run-autosync.example.cmd).');
  }
  if (!existsSync(OAUTH_FILE)) {
    throw new Error(`OAuth credential not found at ${OAUTH_FILE} ($GSUITE_OAUTH_FILE).`);
  }
  const c = JSON.parse(await readFile(OAUTH_FILE, 'utf8'));
  if (!c.refresh_token) throw new Error('Cached credential has no refresh_token.');
  const body = new URLSearchParams({
    client_id: c.client_id,
    client_secret: c.client_secret,
    refresh_token: c.refresh_token,
    grant_type: 'refresh_token',
  });
  const res = await fetchImpl(c.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  const tok = await res.json();
  if (!tok.access_token) throw new Error('Token refresh returned no access_token.');
  return tok.access_token;
}

const evUrl = (calendarId, eventId) =>
  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;

async function getEvent(token, calendarId, eventId, fetchImpl) {
  const res = await fetchImpl(evUrl(calendarId, eventId) + '?fields=summary,description', {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) throw new Error(`GET ${res.status}: ${await res.text()}`);
  return res.json();
}

async function patchEvent(token, calendarId, eventId, patch, fetchImpl) {
  const res = await fetchImpl(evUrl(calendarId, eventId), {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`PATCH ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Apply (or dry-run) the calendar-sync-plan.
 * @returns {Promise<{applied:number, skipped:number, changes:Array, errors:Array}>}
 */
export async function applyPlan({ apply = false, fetchImpl = fetch } = {}) {
  if (!existsSync(PLAN_FILE)) {
    throw new Error('calendar-sync-plan.json not found — run `node sync-calendar.mjs` first.');
  }
  const plan = JSON.parse(await readFile(PLAN_FILE, 'utf8'));
  const token = await mintAccessToken(fetchImpl);

  const changes = [], errors = [];
  let applied = 0, skipped = 0;

  for (const p of plan) {
    if (p.unchanged || p.summary == null) { skipped++; continue; }
    try {
      const before = await getEvent(token, p.calendarId, p.eventId, fetchImpl);
      const needs = before.summary !== p.summary || before.description !== p.description;
      const row = {
        match: p.match,
        from: before.summary ?? '(none)',
        to: p.summary,
        descChanged: before.description !== p.description,
        noop: !needs,
      };
      if (!needs) { skipped++; changes.push(row); continue; }
      if (apply) {
        await patchEvent(token, p.calendarId, p.eventId, { summary: p.summary, description: p.description }, fetchImpl);
        applied++;
      }
      changes.push(row);
    } catch (e) {
      errors.push({ match: p.match, error: String(e.message || e) });
    }
  }
  return { applied, skipped, changes, errors, apply };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const apply = process.argv.includes('--apply');
  const { applied, skipped, changes, errors } = await applyPlan({ apply });

  console.log(`\n=== calendar-apply ${apply ? '(LIVE — writing)' : '(DRY-RUN — writing nothing)'} ===\n`);
  for (const c of changes) {
    if (c.noop) { console.log(`  M${c.match}: up to date — "${c.to}"`); continue; }
    console.log(`  M${c.match}: "${c.from}"  ->  "${c.to}"${c.descChanged ? '  (+desc)' : ''}`);
  }
  if (errors.length) {
    console.log(`\n!! ${errors.length} error(s):`);
    for (const e of errors) console.log(`  M${e.match}: ${e.error}`);
  }
  const wouldWord = apply ? 'wrote' : 'would write';
  const toWrite = changes.filter((c) => !c.noop).length;
  console.log(`\n${wouldWord} ${apply ? applied : toWrite} event(s); ${skipped} unchanged/up-to-date; ${errors.length} error(s).\n`);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });
