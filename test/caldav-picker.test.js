// Tests: the dashboard CalDAV calendar-list picker logic (listIcloudCalendars)
// and the pair-form picker surface. Everything mocked at the fetchImpl
// boundary - no network, no real iCloud.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { listIcloudCalendars } from '../lib/caldav.js';
import { renderPairForm } from '../lib/render.js';

function fixture(name) {
  return fs.readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8');
}

function mkRes(status, xml) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Denied',
    headers: { get: () => null },
    arrayBuffer: async () => Buffer.from(xml, 'utf8'),
  };
}

// Principal -> principal path -> (shard) home-list, matching the discovery chain.
function discoveryFetch() {
  return async (url) => {
    const u = String(url);
    if (u === 'https://caldav.icloud.com/') return mkRes(200, fixture('caldav-principal.xml'));
    if (u === 'https://caldav.icloud.com/1719990123/principal/') return mkRes(200, fixture('caldav-home-set.xml'));
    return mkRes(200, fixture('caldav-home-list.xml'));
  };
}

function discoveryFetch401() {
  return async (url) => mkRes(401, 'denied');
}

test('listIcloudCalendars: discovery returns named calendars with caldav:// URLs', async () => {
  const r = await listIcloudCalendars({ username: 'user@example.com', appPassword: 'abcd-efgh-ijkl-mnop', fetchImpl: discoveryFetch() });
  assert.equal(r.ok, true);
  assert.equal(r.calendars.length, 2);
  assert.equal(r.calendars[0].name, 'Calendar');
  assert.equal(r.calendars[0].caldavUrl, 'caldav://p154-caldav.icloud.com/1719990123/calendars/calendar/');
  assert.equal(r.calendars[1].name, 'Home');
});

test('listIcloudCalendars: missing credentials returns a clean config error', async () => {
  const r = await listIcloudCalendars({ username: '', appPassword: '' });
  assert.equal(r.ok, false);
  assert.match(r.error, /ICLOUD_APPLE_ID/);
});

test('listIcloudCalendars: 401 errors are redacted (no app password in the message)', async () => {
  const r = await listIcloudCalendars({ username: 'user@example.com', appPassword: 'hunter2-secret-pass', fetchImpl: discoveryFetch401() });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.error, /hunter2-secret-pass/, 'the app password never leaks into the error');
  assert.match(r.error, /401/);
});

test('pair form renders the iCloud calendar picker per side (hidden until CalDAV is selected)', () => {
  const { body } = renderPairForm({ pair: null, calendars: [], googleConnected: true, googleError: null, csrf: 'TOK' });
  assert.match(body, /id="caldav-load-source"/);
  assert.match(body, /id="caldav-load-target"/);
  assert.match(body, /id="caldav-picker-source" data-caldav-use="source" hidden/, 'source picker hidden by default');
  assert.match(body, /id="caldav-picker-target" data-caldav-use="target" hidden/, 'target picker hidden by default');
});
