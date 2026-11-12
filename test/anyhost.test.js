// Tier 1 feature tests: generic CalDAV hosts behind CALDAV_ALLOW_ANY_HOST
// (default OFF = current iCloud-only behavior, byte-identical expectations
// preserved). Mocked at the fetchImpl boundary; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../lib/db.js';
import { loadConfig } from '../lib/config.js';
import { createSyncEngine } from '../lib/sync.js';
import { parseFeed } from '../lib/icalparse.js';
import { planSync } from '../lib/planner.js';
import { createIcloudCalDavClient, parseCaldavUrl, CalDavError } from '../lib/caldav.js';
import { FIXED_NOW_MS, icsFor, veventFor, makeGoogleMock, makeCaldavWriteMock } from './helpers.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const testConfig = {
  pushDelayMs: 0, maxFeedBytes: 1024 * 1024, fetchTimeoutMs: 5000,
  windowPastDays: 30, windowFutureDays: 365,
};

const FEED1 = icsFor([
  veventFor(['UID:evt-a', 'DTSTART:20261115T090000Z', 'DTEND:20261115T093000Z', 'SUMMARY:Event A']),
  veventFor(['UID:evt-b', 'DTSTART:20261116T090000Z', 'DTEND:20261116T100000Z', 'SUMMARY:Event B']),
]);
const SEED_A = icsFor([veventFor(['UID:src-1', 'DTSTART:20261115T090000Z', 'DTEND:20261115T093000Z', 'SUMMARY:Self-hosted event'])]);

function makeEngine(db, { googleFactory = () => null, icloudFactory = () => null, fetchFeedImpl } = {}) {
  return createSyncEngine({
    db,
    config: testConfig,
    logger: silentLogger,
    googleFactory,
    icloudFactory,
    fetchFeedImpl: fetchFeedImpl ?? (async () => ({ text: FEED1, finalUrl: 'https://feed.example/cal.ics', status: 200 })),
    parseFeedImpl: parseFeed,
    planSyncImpl: planSync,
    clock: { now: () => FIXED_NOW_MS },
    delayFn: async () => {},
  });
}

function makeIcloudClient(mock, opts = {}) {
  return createIcloudCalDavClient({
    username: 'owner@example.com',
    appPassword: 'abcd-e...mnop',
    fetchImpl: mock.fetchImpl,
    baseDelayMs: 10,
    timeoutMs: 5000,
    maxRetries: 3,
    sleepFn: async () => {},
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// Config flag
// ---------------------------------------------------------------------------

test('loadConfig: CALDAV_ALLOW_ANY_HOST defaults false and parses the usual truthy values', () => {
  assert.equal(loadConfig({}).caldavAllowAnyHost, false);
  assert.equal(loadConfig({ CALDAV_ALLOW_ANY_HOST: 'true' }).caldavAllowAnyHost, true);
  assert.equal(loadConfig({ CALDAV_ALLOW_ANY_HOST: '1' }).caldavAllowAnyHost, true);
  assert.equal(loadConfig({ CALDAV_ALLOW_ANY_HOST: 'yes' }).caldavAllowAnyHost, true);
  assert.equal(loadConfig({ CALDAV_ALLOW_ANY_HOST: '0' }).caldavAllowAnyHost, false);
  assert.equal(loadConfig({ CALDAV_ALLOW_ANY_HOST: 'false' }).caldavAllowAnyHost, false);
  assert.equal(loadConfig({ CALDAV_ALLOW_ANY_HOST: 'junk' }).caldavAllowAnyHost, false);
});

test('loadConfig: ALERT_TELEGRAM_*/ALERT_DIGEST_HOUR wiring (digest hour clamped 0-23, default 8)', () => {
  assert.equal(loadConfig({ ALERT_TELEGRAM_TOKEN: 'tok', ALERT_TELEGRAM_CHAT_ID: '@chat' }).alertTelegramToken, 'tok');
  assert.equal(loadConfig({ ALERT_TELEGRAM_CHAT_ID: '@chat' }).alertTelegramChatId, '@chat');
  assert.equal(loadConfig({}).alertTelegramToken, '');
  assert.equal(loadConfig({}).alertDigestHour, 8);
  assert.equal(loadConfig({ ALERT_DIGEST_HOUR: '6' }).alertDigestHour, 6);
  assert.equal(loadConfig({ ALERT_DIGEST_HOUR: '25' }).alertDigestHour, 23, 'clamped high');
  assert.equal(loadConfig({ ALERT_DIGEST_HOUR: '-4' }).alertDigestHour, 0, 'clamped low');
  assert.equal(loadConfig({ ALERT_DIGEST_HOUR: 'junk' }).alertDigestHour, 8, 'junk falls back to the default');
});

// ---------------------------------------------------------------------------
// Default behavior stays exactly as before
// ---------------------------------------------------------------------------

test('default client still refuses non-iCloud hosts (source read)', async () => {
  const xMock = makeCaldavWriteMock({ calendarHref: 'https://caldav.example.com/x/' , seeds: [{ uid: 'src-1', ics: SEED_A }] });
  const client = makeIcloudClient(xMock); // no allowAnyHost -> default OFF
  await assert.rejects(
    client.fetchEvents('caldav://caldav.example.com/x/', { start: FIXED_NOW_MS - 86400000, end: FIXED_NOW_MS + 365 * 86400000 }),
    (err) => {
      assert.ok(err instanceof CalDavError);
      assert.match(err.message, /only iCloud CalDAV/);
      return true;
    },
  );
  assert.equal(xMock.calls.reports, 0, 'no request ever left for a foreign host');
});

test('default engine run against a generic-host CalDAV target fails before any write', async () => {
  const db = await openDatabase(':memory:');
  const xMock = makeCaldavWriteMock({ calendarHref: 'https://caldav.example.com/cal/' });
  const engine = makeEngine(db, { icloudFactory: () => makeIcloudClient(xMock) });
  const pair = db.createPair({
    name: 'P', feed_url: 'https://feed.example/cal.ics', source_type: 'url',
    calendar_id: '', target_type: 'caldav', target_url: 'caldav://caldav.example.com/cal/', interval_minutes: 60,
  });
  const r = await engine.runPair(pair.id, { trigger: 'initial' });
  assert.equal(r.status, 'error');
  assert.match(r.error, /only iCloud CalDAV/);
  assert.equal(xMock.calls.puts.length, 0, 'no PUTs without the opt-in flag');
  db.close();
});

// ---------------------------------------------------------------------------
// CALDAV_ALLOW_ANY_HOST=true: generic hosts accepted, invariants kept
// ---------------------------------------------------------------------------

test('allowAnyHost client reads a generic https CalDAV host (source REPORT path)', async () => {
  const xMock = makeCaldavWriteMock({ calendarHref: 'https://caldav.example.com/x/', seeds: [{ uid: 'src-1', ics: SEED_A }] });
  const client = makeIcloudClient(xMock, { allowAnyHost: true });
  const res = await client.fetchEvents('caldav://caldav.example.com/x/', { start: FIXED_NOW_MS - 86400000, end: FIXED_NOW_MS + 365 * 86400000 });
  assert.equal(res.events.length, 1);
  assert.equal(res.events[0].uid, 'src-1');
  assert.equal(res.events[0].summary, 'Self-hosted event');
  assert.equal(xMock.calls.reports, 1);
});

test('allowAnyHost engine run end-to-end: url feed -> caldav://caldav.example.com/ target', async () => {
  const db = await openDatabase(':memory:');
  const xMock = makeCaldavWriteMock({ calendarHref: 'https://caldav.example.com/cal/' });
  const engine = makeEngine(db, { icloudFactory: () => makeIcloudClient(xMock, { allowAnyHost: true }) });
  const pair = db.createPair({
    name: 'P', feed_url: 'https://feed.example/cal.ics', source_type: 'url',
    calendar_id: '', target_type: 'caldav', target_url: 'caldav://caldav.example.com/cal/', interval_minutes: 60,
  });
  const r1 = await engine.runPair(pair.id, { trigger: 'initial' });
  assert.equal(r1.status, 'success');
  assert.equal(xMock.calls.puts.length, 2);
  assert.deepEqual(xMock.store.uids(), ['evt-a', 'evt-b']);
  assert.match(xMock.store.icsOf('evt-a'), /UID:evt-a/);

  const r2 = await engine.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(r2.status, 'success');
  assert.equal(r2.log.unchanged, 2, 'skip-unchanged behaves identically on generic hosts');
  assert.equal(xMock.calls.puts.length, 2, 'zero PUTs on rerun');
  db.close();
});

test('allowAnyHost engine run end-to-end: caldav://caldav.example.com/ source -> google target', async () => {
  const db = await openDatabase(':memory:');
  const xMock = makeCaldavWriteMock({ calendarHref: 'https://caldav.example.com/src/', seeds: [{ uid: 'src-1', ics: SEED_A }] });
  const holder = makeGoogleMock();
  const engine = makeEngine(db, {
    googleFactory: () => holder.client,
    icloudFactory: () => makeIcloudClient(xMock, { allowAnyHost: true }),
  });
  const pair = db.createPair({
    name: 'P', feed_url: 'caldav://caldav.example.com/src/', source_type: 'caldav',
    calendar_id: 'cal-target', interval_minutes: 60,
  });
  const r = await engine.runPair(pair.id, { trigger: 'initial' });
  assert.equal(r.status, 'success');
  assert.deepEqual(holder.calls.imports.map(([, g]) => g.iCalUID), ['src-1']);
  db.close();
});

test('flag does NOT weaken URL rules: credentials in URLs still rejected, non-https still rejected', () => {
  assert.throws(() => parseCaldavUrl('caldav://owner:hunter2@caldav.example.com/x'), /must not carry credentials/);
  assert.throws(() => parseCaldavUrl('caldav://owner:hunter2@caldav.icloud.com/x'), /must not carry credentials/);
  assert.throws(() => parseCaldavUrl('http://caldav.example.com/x'), /Unsupported CalDAV protocol/);
  // A client constructed with allowAnyHost still goes through parseCaldavUrl
  // for every operation, so these rejections hold on the write path too.
  const xMock = makeCaldavWriteMock({ calendarHref: 'https://caldav.example.com/x/' });
  const client = makeIcloudClient(xMock, { allowAnyHost: true });
  assert.rejects(client.putEvent('caldav://owner:pw@caldav.example.com/x/', { uid: 'u' }, {}));
  assert.equal(xMock.calls.puts.length, 0, 'the credential-carrying URL never reached the network');
});
