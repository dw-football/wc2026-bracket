// notify.mjs
// ============================================================================
// Failure-only push notification for the unattended auto-sync (#4).
//
// Reuses the SAME headless OAuth credential the calendar writer uses
// ($GSUITE_OAUTH_FILE) — the cached mcp-gsuite refresh_token carries the Gmail
// send scope — and POSTs a plain-text message to the Gmail v1 REST API. No
// in-session MCP, machine-independent.
//
// Spoiler-safe by construction: autosync calls this ONLY on a failure/alert, never
// on a successful score deploy, so a finished score is never emailed ahead of the
// replay David watches in the morning. The message carries the PROBLEM, not scores.
//
// SECURITY: never logs the token / refresh_token / client_secret.
// ============================================================================

import { mintAccessToken } from './calendar-apply.mjs';

// Where the failure ping goes. Defaults to David's personal address (the gsuite
// credential's own mailbox); override via env without touching code.
const NOTIFY_TO = process.env.AUTOSYNC_NOTIFY_TO || 'david@warren1.net';

const GMAIL_SEND = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

/** Build a base64url-encoded RFC 822 message for the Gmail `raw` field. */
export function buildRaw(to, subject, text) {
  const msg = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    '',
    text,
  ].join('\r\n');
  return Buffer.from(msg, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Send a failure notification. The access token is minted from $GSUITE_OAUTH_FILE
 * unless one is injected (opts.token) — injection keeps the function unit-testable
 * with a mock fetch and no credential file.
 * @returns {Promise<object>} the Gmail send response
 */
export async function sendFailureEmail(subject, body, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const to = opts.to || NOTIFY_TO;
  const token = opts.token || await mintAccessToken(fetchImpl);
  const raw = buildRaw(to, subject, body);
  const res = await fetchImpl(GMAIL_SEND, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new Error(`Gmail send ${res.status}: ${await res.text()}`);
  return res.json();
}
