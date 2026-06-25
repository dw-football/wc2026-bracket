// notify.test.js — node:test
//
//   node --test notify.test.js
//
// Failure-only Gmail-REST notify. No network / no credential file: a mock fetch
// captures the request and we decode the base64url raw message to assert the
// recipient, subject, and body — proving the message is well-formed before it
// ever reaches Gmail.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRaw, sendFailureEmail } from './notify.mjs';

// Decode a base64url Gmail `raw` back to the RFC 822 text.
const decodeRaw = (raw) =>
  Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

test('buildRaw: produces a valid base64url RFC 822 message', () => {
  const raw = buildRaw('a@b.com', 'Subj', 'line one\nline two');
  assert.ok(!/[+/=]/.test(raw), 'base64url has no +, /, or = padding');
  const msg = decodeRaw(raw);
  assert.match(msg, /^To: a@b\.com\r\n/);
  assert.match(msg, /\r\nSubject: Subj\r\n/);
  assert.match(msg, /\r\n\r\nline one\nline two$/);
});

test('sendFailureEmail: POSTs the raw message to the Gmail send endpoint', async () => {
  let captured = null;
  const fetchImpl = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, json: async () => ({ id: 'sent123' }) };
  };
  const res = await sendFailureEmail('[WC2026] FAILURE', 'push failed for set X', {
    token: 'fake-token', to: 'dest@x.com', fetchImpl,
  });
  assert.equal(res.id, 'sent123');
  assert.match(captured.url, /gmail\.googleapis\.com.*messages\/send/);
  assert.equal(captured.opts.headers.Authorization, 'Bearer fake-token');
  const body = JSON.parse(captured.opts.body);
  const msg = decodeRaw(body.raw);
  assert.match(msg, /To: dest@x\.com/);
  assert.match(msg, /Subject: \[WC2026\] FAILURE/);
  assert.match(msg, /push failed for set X/);
});

test('sendFailureEmail: surfaces a Gmail API error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => 'insufficientPermissions' });
  await assert.rejects(
    () => sendFailureEmail('s', 'b', { token: 't', fetchImpl }),
    /Gmail send 403: insufficientPermissions/,
  );
});
