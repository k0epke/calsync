// URL handling: webcal rewrite, file:// rejection, TLS->HTTP fallback rules,
// and the login rate limiter.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeFeedUrl, hasCredentials, isTlsError, shouldFallbackToHttp, fetchFeed, FeedFetchError } from '../lib/fetchfeed.js';
import { createRateLimiter, verifyCredentials } from '../lib/auth.js';

test('webcal:// is rewritten to https:// (case-insensitive)', () => {
  assert.equal(String(normalizeFeedUrl('webcal://example.com/cal.ics')), 'https://example.com/cal.ics');
  assert.equal(String(normalizeFeedUrl('WEBCAL://Example.COM/Cal')), 'https://example.com/Cal');
  assert.equal(String(normalizeFeedUrl('https://example.com/cal.ics')), 'https://example.com/cal.ics');
  assert.equal(String(normalizeFeedUrl('http://example.com/cal.ics')), 'http://example.com/cal.ics');
});

test('unsupported protocols are rejected, including file://', () => {
  assert.throws(() => normalizeFeedUrl('file:///etc/passwd'), FeedFetchError);
  assert.throws(() => normalizeFeedUrl('ftp://example.com/x'), FeedFetchError);
  assert.throws(() => normalizeFeedUrl('javascript:alert(1)'), FeedFetchError);
  assert.throws(() => normalizeFeedUrl('   '), FeedFetchError);
});

test('credential detection', () => {
  assert.equal(hasCredentials(normalizeFeedUrl('https://user:pass@example.com/c.ics')), true);
  assert.equal(hasCredentials(normalizeFeedUrl('https://user@example.com/c.ics')), true);
  assert.equal(hasCredentials(normalizeFeedUrl('https://example.com/c.ics')), false);
});

test('TLS error classification', () => {
  assert.equal(isTlsError(new Error('x', { cause: { code: 'CERT_HAS_EXPIRED' } })), true);
  assert.equal(isTlsError(new Error('x', { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } })), true);
  assert.equal(isTlsError(new Error('x', { cause: { code: 'ECONNREFUSED' } })), false);
  assert.equal(isTlsError(new FeedFetchError('http 404', { status: 404 })), false);
});

test('http fallback only for TLS failures without credentials', () => {
  const url = normalizeFeedUrl('webcal://example.com/c.ics');
  assert.equal(shouldFallbackToHttp(url, new Error('x', { cause: { code: 'CERT_HAS_EXPIRED' } })), true);
  assert.equal(shouldFallbackToHttp(url, new Error('x', { cause: { code: 'ECONNREFUSED' } })), false);
  const credUrl = normalizeFeedUrl('https://bob:secret@example.com/c.ics');
  assert.equal(shouldFallbackToHttp(credUrl, new Error('x', { cause: { code: 'CERT_HAS_EXPIRED' } })), false);
});

function fakeResponse(text, headers = {}) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  };
}

test('fetchFeed: https success path parses text', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(String(url)); return fakeResponse('BEGIN:VCALENDAR'); };
  const res = await fetchFeed('https://example.com/cal.ics', { fetchImpl, timeoutMs: 5000, maxBytes: 1000 });
  assert.deepEqual(calls, ['https://example.com/cal.ics']);
  assert.equal(res.text, 'BEGIN:VCALENDAR');
  assert.equal(res.finalUrl, 'https://example.com/cal.ics');
});

test('fetchFeed: TLS failure falls back to http when allowed', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) throw new Error('request failed', { cause: { code: 'CERT_HAS_EXPIRED' } });
    return fakeResponse('ok-http');
  };
  const res = await fetchFeed('webcal://example.com/cal.ics', { fetchImpl, timeoutMs: 5000, maxBytes: 1000 });
  assert.deepEqual(calls, ['https://example.com/cal.ics', 'http://example.com/cal.ics']);
  assert.equal(res.finalUrl, 'http://example.com/cal.ics');
  assert.equal(res.text, 'ok-http');
});

test('fetchFeed: no http fallback when URL has credentials', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('x', { cause: { code: 'CERT_HAS_EXPIRED' } }); };
  await assert.rejects(fetchFeed('https://u:p@example.com/cal.ics', { fetchImpl, timeoutMs: 5000 }), FeedFetchError);
  assert.equal(calls, 1, 'must not downgrade to http with credentials in the URL');
});

test('fetchFeed: no http fallback for non-TLS errors', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('x', { cause: { code: 'ECONNREFUSED' } }); };
  await assert.rejects(fetchFeed('https://example.com/cal.ics', { fetchImpl, timeoutMs: 5000 }));
  assert.equal(calls, 1);
});

test('fetchFeed: enforces max bytes', async () => {
  const fetchImpl = async () => fakeResponse('x'.repeat(50), { 'content-length': '50' });
  await assert.rejects(
    fetchFeed('https://example.com/cal.ics', { fetchImpl, timeoutMs: 5000, maxBytes: 10 }),
    (err) => /byte limit/.test(err.message),
  );
});

test('login rate limiter: blocks after N attempts, resets, isolates keys', () => {
  let now = 1_000_000;
  const clock = { now: () => now };
  const limiter = createRateLimiter({ max: 3, windowMs: 60_000, clock });
  for (let i = 0; i < 3; i++) assert.equal(limiter.check('u1@ip').ok, true);
  const blocked = limiter.check('u1@ip');
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterMs > 0);
  assert.equal(limiter.check('u2@ip').ok, true, 'different key is unaffected');
  now += 61_000; // window slides
  assert.equal(limiter.check('u1@ip').ok, true);
  limiter.reset('u2@ip');
  assert.equal(limiter.check('u2@ip').ok, true);
});

test('verifyCredentials uses bcrypt comparison', async () => {
  const bcrypt = (await import('bcryptjs')).default;
  const row = { password_hash: bcrypt.hashSync('correct horse', 4) };
  assert.equal(verifyCredentials(row, 'correct horse'), true);
  assert.equal(verifyCredentials(row, 'wrong'), false);
  assert.equal(verifyCredentials(null, 'whatever'), false);
});
