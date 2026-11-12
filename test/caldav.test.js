// iCloud CalDAV client tests: discovery parsing, REPORT calendar-query
// normalization, window propagation, auth-failure redaction and backoff.
// Everything is mocked at the fetchImpl boundary - no network, no real
// iCloud. Fixtures are realistic iCloud-shaped multistatus XML (a scheduling
// inbox and a VTODO-only Reminders collection that MUST be skipped).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../lib/db.js';
import { loadConfig } from '../lib/config.js';
import {
  createIcloudCalDavClient, parseCaldavUrl, caldavUrlOf, icsUtc, calendarQueryBody, CalDavError,
} from '../lib/caldav.js';
import { parseFeed } from '../lib/icalparse.js';
import { icsFor, veventFor, readFixture } from './helpers.js';

const START = Date.parse('2026-11-01T00:00:00Z');
const END = Date.parse('2027-11-01T00:00:00Z');
const SECRET = 'zzqq-wxyy-1a2b-3c4d-5555';

const jsonResponse = (status, { bodyXml = '', headers = {} } = {}) => new Response(bodyXml, { status, headers });

function makeCaldavTestClient({ fetchImpl, sleepFn = async () => {}, retries = 3, password = 'abcd-efgh-ijkl-mnop' } = {}) {
  return createIcloudCalDavClient({
    username: 'owner@example.com',
    appPassword: password,
    fetchImpl,
    baseDelayMs: 10,
    timeoutMs: 5000,
    maxRetries: retries,
    sleepFn,
  });
}

// --- URL encoding -----------------------------------------------------------

test('parseCaldavUrl: caldav:// maps to https, https hrefs accepted, junk rejected', () => {
  const u = parseCaldavUrl('caldav://caldav.icloud.com/1719990123/calendars/home-ABCD-1234/');
  assert.equal(u.protocol, 'https:');
  assert.equal(u.host, 'caldav.icloud.com');
  assert.equal(u.pathname, '/1719990123/calendars/home-ABCD-1234/');
  const v = parseCaldavUrl('https://caldav.icloud.com/1719990123/calendars/calendar/');
  assert.equal(String(v), 'https://caldav.icloud.com/1719990123/calendars/calendar/');
  assert.equal(caldavUrlOf(v), 'caldav://caldav.icloud.com/1719990123/calendars/calendar/');
  assert.throws(() => parseCaldavUrl(''), CalDavError);
  assert.throws(() => parseCaldavUrl('   '), CalDavError);
  assert.throws(() => parseCaldavUrl('ftp://host/x'), /Unsupported CalDAV protocol/);
  assert.throws(() => parseCaldavUrl('not a url'), /Invalid CalDAV calendar URL/);
  assert.throws(() => parseCaldavUrl('caldav://'), /Invalid CalDAV calendar URL|missing its host/, 'empty host fails');
  assert.throws(
    () => parseCaldavUrl('caldav://owner:hunter2@caldav.icloud.com/x'),
    /must not carry credentials/,
    'credentials in the pair URL must be rejected (they live only in .env)',
  );
});

test('icsUtc formats epoch ms as RFC 4791 ICS UTC and rejects junk', () => {
  assert.equal(icsUtc(Date.parse('2026-11-11T12:00:00Z')), '20261111T120000Z');
  assert.equal(icsUtc(0), '19700101T000000Z');
  assert.throws(() => icsUtc(NaN), CalDavError);
  assert.throws(() => icsUtc('nope'), CalDavError);
});

// --- REPORT body --------------------------------------------------------------

test('calendarQueryBody embeds the VEVENT comp-filter and time-range in ICS UTC', () => {
  const body = calendarQueryBody({ startMs: START, endMs: END });
  assert.match(body, /<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">/);
  assert.match(body, /<C:calendar-data\/>/);
  assert.match(body, /<C:comp-filter name="VCALENDAR">/);
  assert.match(body, /<C:comp-filter name="VEVENT">/);
  assert.match(body, /<C:time-range start="20261101T000000Z" end="20271101T000000Z"\/>/);
});

// --- discovery ----------------------------------------------------------------

test('discoverCalendars: principal -> home-set -> depth-1 list, inbox/tasks skipped', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method, depth: opts.headers?.depth, body: opts.body, auth: opts.headers?.authorization });
    if (String(url) === 'https://caldav.icloud.com/') return jsonResponse(200, { bodyXml: readFixture('caldav-principal.xml') });
    if (String(url) === 'https://caldav.icloud.com/1719990123/principal/') return jsonResponse(200, { bodyXml: readFixture('caldav-home-set.xml') });
    return jsonResponse(200, { bodyXml: readFixture('caldav-home-list.xml') });
  };
  const client = makeCaldavTestClient({ fetchImpl });
  const calendars = await client.discoverCalendars();

  assert.deepEqual(calls.map((c) => `${c.method} ${c.url} d=${c.depth}`), [
    'PROPFIND https://caldav.icloud.com/ d=0',
    'PROPFIND https://caldav.icloud.com/1719990123/principal/ d=0',
    'PROPFIND https://caldav.icloud.com/1719990123/calendars/ d=1',
  ], 'standard RFC 4791/6764 discovery chain');
  assert.match(calls[0].body, /<D:current-user-principal\/>/);
  assert.match(calls[1].body, /<C:calendar-home-set\/>/);
  assert.match(calls[2].body, /<C:supported-calendar-component-set\/>/);
  assert.ok(calls.every((c) => typeof c.auth === 'string' && c.auth.startsWith('Basic ')), 'every request carries Basic auth');

  assert.deepEqual(calendars.map((c) => c.name), ['Calendar', 'Home'],
    'home itself, scheduling inbox, trash and the VTODO-only Reminders collection must be skipped');
  assert.deepEqual(calendars.map((c) => c.caldavUrl), [
    'caldav://caldav.icloud.com/1719990123/calendars/calendar/',
    'caldav://caldav.icloud.com/1719990123/calendars/home-ABCD-1234/',
  ]);
});

// --- REPORT calendar-query ------------------------------------------------------

test('fetchEvents: REPORT body carries the window, responses normalize to the ICS event shape', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method, depth: opts.headers?.depth, body: opts.body });
    return jsonResponse(200, { bodyXml: readFixture('caldav-report.xml') });
  };
  const client = makeCaldavTestClient({ fetchImpl });
  const res = await client.fetchEvents('caldav://caldav.icloud.com/1719990123/calendars/home-ABCD-1234/', { start: START, end: END });

  assert.deepEqual(calls.map((c) => c.method), ['REPORT']);
  assert.equal(calls[0].url, 'https://caldav.icloud.com/1719990123/calendars/home-ABCD-1234/');
  assert.equal(calls[0].depth, '1');
  assert.match(calls[0].body, /<C:time-range start="20261101T000000Z" end="20271101T000000Z"\/>/);

  // Normalized events must be indistinguishable from ICS feed parsing output.
  const shape = Object.keys(parseFeed(icsFor([veventFor(['UID:x', 'DTSTART:20261115T090000Z', 'DTEND:20261115T093000Z'])])).events[0]).sort();
  assert.equal(res.events.length, 4, 'four calendar-data blobs parsed; the 404 row contributes nothing');
  for (const ev of res.events) assert.deepEqual(Object.keys(ev).sort(), shape, 'same internal event model as parseFeed');

  const byUid = new Map(res.events.map((e) => [e.uid, e]));
  const standup = byUid.get('standup-0001@icloud');
  assert.equal(standup.summary, 'Standup');
  assert.equal(standup.status, 'CONFIRMED');
  assert.deepEqual(standup.start, { dateTime: '2026-11-15T09:00:00Z' });
  assert.deepEqual(standup.end, { dateTime: '2026-11-15T09:30:00Z' });
  assert.equal(byUid.get('review-0002@icloud').summary, 'Q&A session', 'XML-escaped ICS text is entity-decoded');
  const series = byUid.get('series-0003@icloud');
  assert.deepEqual(series.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO'], 'RRULE lines survive (no expand)');
  assert.equal(byUid.get('cancelled-0004@icloud').status, 'CANCELLED', 'STATUS:CANCELLED maps like ICS feeds');
  assert.equal(res.href, 'https://caldav.icloud.com/1719990123/calendars/home-ABCD-1234/');
});

test('fetchEvents propagates the requested window into the REPORT body', async () => {
  let seenBody = '';
  const fetchImpl = async (_url, opts = {}) => {
    seenBody = opts.body;
    return jsonResponse(200, { bodyXml: '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"/>' });
  };
  const client = makeCaldavTestClient({ fetchImpl });
  await client.fetchEvents('caldav://caldav.icloud.com/123/calendars/x/', { start: START, end: END });
  assert.match(seenBody, /start="20261101T000000Z"/);
  assert.match(seenBody, /end="20271101T000000Z"/);
});

test('empty REPORT multistatus yields zero events and a warning', async () => {
  const fetchImpl = async () => jsonResponse(200, { bodyXml: '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"/>' });
  const client = makeCaldavTestClient({ fetchImpl });
  const res = await client.fetchEvents('caldav://caldav.icloud.com/123/calendars/x/', { start: START, end: END });
  assert.equal(res.events.length, 0);
  assert.ok(res.warnings.length >= 1);
});

test('non-iCloud hosts are refused (minimal client, credentials stay with Apple)', async () => {
  const client = makeCaldavTestClient({ fetchImpl: async () => { throw new Error('must never fetch'); } });
  await assert.rejects(
    client.fetchEvents('caldav://caldav.example.com/x/', { start: START, end: END }),
    /only iCloud CalDAV/,
  );
});

// --- auth failure + redaction ---------------------------------------------------

test('401 from iCloud surfaces a clear error and never leaks the app password', async () => {
  const fetchImpl = async () => jsonResponse(401, { bodyXml: '<error/>' });
  const client = makeCaldavTestClient({ fetchImpl, password: SECRET });
  await assert.rejects(
    client.fetchEvents('caldav://caldav.icloud.com/123/calendars/calendar/', { start: START, end: END }),
    (err) => {
      assert.ok(err instanceof CalDavError);
      assert.match(err.message, /HTTP 401/);
      assert.match(err.message, /app-specific password/i);
      assert.ok(!err.message.includes(SECRET), 'password value must not appear in the error');
      const b64 = Buffer.from(`owner@example.com:${SECRET}`, 'utf8').toString('base64');
      assert.ok(!err.message.includes(b64), 'Basic-authorization encoding must not appear either');
      return true;
    },
  );
});

test('failed discovery keeps secrets redacted too', async () => {
  const fetchImpl = async () => jsonResponse(403, { bodyXml: '<error/>' });
  const client = makeCaldavTestClient({ fetchImpl, password: SECRET });
  await assert.rejects(client.discoverCalendars(), (err) => {
    assert.match(err.message, /HTTP 403/);
    assert.ok(!err.message.includes(SECRET));
    return true;
  });
});

// --- backoff ------------------------------------------------------------------------

test('429 is retried honoring Retry-After, then succeeds', async () => {
  const delays = [];
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse(429, { headers: { 'retry-after': '2' } });
    return jsonResponse(200, { bodyXml: readFixture('caldav-report.xml') });
  };
  const client = makeCaldavTestClient({ fetchImpl, sleepFn: async (ms) => { delays.push(ms); } });
  const res = await client.fetchEvents('caldav://caldav.icloud.com/123/calendars/x/', { start: START, end: END });
  assert.equal(calls, 2, 'the second attempt succeeds');
  assert.equal(res.events.length, 4);
  assert.ok(delays.length >= 1);
  assert.ok(delays[0] >= 2000, `retry delay must honor Retry-After seconds (got ${delays[0]})`);
  assert.ok(delays[0] < 2000 + 500, 'Retry-After is not exponentiated further, only jittered');
});

test('5xx exhaust maxRetries and throw a redacted CalDavError', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonResponse(503, { bodyXml: '<error/>' }); };
  const client = makeCaldavTestClient({ fetchImpl, retries: 2, sleepFn: async () => {}, password: SECRET });
  await assert.rejects(client.discoverCalendars(), (err) => {
    assert.ok(err instanceof CalDavError);
    assert.match(err.message, /HTTP 503/);
    assert.ok(!err.message.includes(SECRET));
    return true;
  });
  assert.equal(calls, 3, 'one initial attempt plus maxRetries retries');
});

test('401 is NOT retried (non-retryable status throws immediately)', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonResponse(401, { bodyXml: '<error/>' }); };
  const client = makeCaldavTestClient({ fetchImpl, sleepFn: async () => {} });
  await assert.rejects(client.discoverCalendars(), /HTTP 401/);
  assert.equal(calls, 1);
});

// --- config + db wiring --------------------------------------------------------------

test('loadConfig wires ICLOUD_APPLE_ID/ICLOUD_APP_PASSWORD from the environment', () => {
  const cfg = loadConfig({ ICLOUD_APPLE_ID: 'owner@icloud.com', ICLOUD_APP_PASSWORD: 'abcd-efgh-ijkl-mnop' });
  assert.equal(cfg.icloudAppleId, 'owner@icloud.com');
  assert.equal(cfg.icloudAppPassword, 'abcd-efgh-ijkl-mnop');
  const empty = loadConfig({});
  assert.equal(empty.icloudAppleId, '');
  assert.equal(empty.icloudAppPassword, '');

  const client = createIcloudCalDavClient({
    username: cfg.icloudAppleId,
    appPassword: cfg.icloudAppPassword,
    fetchImpl: async () => { throw new Error('no calls in this test'); },
  });
  assert.match(client.describe(), /Apple ID: owner@icloud\.com/);
});

test('icloud_accounts table round-trips a single upserted row', async () => {
  const db = await openDatabase(':memory:');
  db.setIcloudAccount({ username: 'a@icloud.com', app_password: 'xxxx-xxxx-xxxx-xxxx' });
  let acc = db.getIcloudAccount();
  assert.equal(acc.username, 'a@icloud.com');
  assert.equal(acc.app_password, 'xxxx-xxxx-xxxx-xxxx');
  db.setIcloudAccount({ username: 'b@icloud.com', app_password: 'yyyy-yyyy-yyyy-yyyy' });
  acc = db.getIcloudAccount();
  assert.equal(acc.username, 'b@icloud.com', 'still exactly one row (upsert by id=1)');
  assert.equal(acc.app_password, 'yyyy-yyyy-yyyy-yyyy');
  db.close();
});

test('pairs.source_type migrates safely on old databases (default url)', async () => {
  const dbPath = path.join(os.tmpdir(), `calsync-caldav-migrate-${Date.now()}-${Math.floor(Math.random() * 1e9)}.sqlite`);
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE IF NOT EXISTS pairs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      feed_url TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL DEFAULT 360 CHECK (interval_minutes >= 15),
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS synced_events (
      pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
      ical_uid TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      content_hash TEXT,
      PRIMARY KEY (pair_id, ical_uid)
    );
  `);
  raw.prepare('INSERT INTO pairs (name, feed_url, calendar_id, interval_minutes, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
    .run('Legacy', 'https://feed.example/x.ics', 'cal-x', 360, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  raw.close();
  try {
    const db = await openDatabase(dbPath);
    const cols = db._raw.prepare("SELECT name FROM pragma_table_info('pairs')").all().map((r) => String(r.name));
    assert.ok(cols.includes('source_type'), 'source_type added by the boot migration');
    assert.equal(db.getPair(1).source_type, 'url', 'existing pairs read as url pairs');
    db.close();
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  }
});

test('createPair/updatePair normalize source_type (caldav vs url)', async () => {
  const db = await openDatabase(':memory:');
  const p1 = db.createPair({ name: 'url pair', feed_url: 'https://feed.example/x.ics', calendar_id: 'c', interval_minutes: 60 });
  assert.equal(p1.source_type, 'url', 'default is url');
  const p2 = db.createPair({
    name: 'icloud pair', feed_url: 'caldav://caldav.icloud.com/1/calendars/a/', calendar_id: 'c',
    interval_minutes: 60, source_type: 'caldav',
  });
  assert.equal(p2.source_type, 'caldav');
  const p3 = db.createPair({ name: 'junk type', feed_url: 'x', calendar_id: 'c', interval_minutes: 60, source_type: 'ftp' });
  assert.equal(p3.source_type, 'url', 'invalid values normalize to url');
  db.updatePair(p2.id, { source_type: 'url' });
  assert.equal(db.getPair(p2.id).source_type, 'url');
  db.updatePair(p1.id, { source_type: 'caldav', feed_url: 'caldav://caldav.icloud.com/1/calendars/b/' });
  assert.equal(db.getPair(p1.id).source_type, 'caldav');
  db.close();
});
