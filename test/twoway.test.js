// Two-way engine tests: Google-as-source pairs, CalDAV-as-target pairs, the
// adapter guards and - critically - the sync-loop safety scenario set:
//   (i)  initial round trip converges (zero-write next runs),
//   (ii) one edit converges within one full cycle without multiplying,
//   (iii) UIDs are preserved end-to-end (no respawn),
//   (iv) user edits in the middle of the loop stabilize per
//        "source is authority" (by-design, asserted below).
// Everything is mocked: Google at the client boundary (makeGoogleMock +
// snapshotSourceEvents), CalDAV at the fetchImpl boundary
// (makeCaldavWriteMock), SQLite in memory. No network, no cloud.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../lib/db.js';
import { createSyncEngine, pairSemanticError } from '../lib/sync.js';
import { parseFeed, canonicalEventHash, googleItemToEvent } from '../lib/icalparse.js';
import { planSync } from '../lib/planner.js';
import { createIcloudCalDavClient } from '../lib/caldav.js';
import { parseGoogleSourceUrl, googleSourceUrlOf } from '../lib/google.js';
import { FIXED_NOW_MS, icsFor, veventFor, makeGoogleMock, makeCaldavWriteMock } from './helpers.js';

const X_CALDAV_URL = 'caldav://caldav.icloud.com/123/calendars/home/';
const G_CAL = 'cal-target';

const X_EVENT_A_ICS = icsFor([
  veventFor(['UID:evt-a', 'DTSTART:20261115T090000Z', 'DTEND:20261115T093000Z', 'SUMMARY:Event A']),
]);
const X_EVENT_B_ICS = icsFor([
  veventFor(['UID:evt-b', 'DTSTART:20261116T090000Z', 'DTEND:20261116T100000Z', 'SUMMARY:Event B', 'RRULE:FREQ=WEEKLY;BYDAY=MO']),
]);
const X_SEEDS = [
  { uid: 'evt-a', ics: X_EVENT_A_ICS },
  { uid: 'evt-b', ics: X_EVENT_B_ICS },
];

const FEED1 = icsFor([
  veventFor(['UID:evt-a', 'DTSTART:20261115T090000Z', 'DTEND:20261115T093000Z', 'SUMMARY:Event A']),
  veventFor(['UID:evt-b', 'DTSTART:20261116T090000Z', 'DTEND:20261116T100000Z', 'SUMMARY:Event B', 'RRULE:FREQ=WEEKLY;BYDAY=MO']),
]);
// evt-a edited, evt-c new, evt-b gone: one full CRUD diff.
const FEED2 = icsFor([
  veventFor(['UID:evt-a', 'DTSTART:20261115T090000Z', 'DTEND:20261115T093000Z', 'SUMMARY:Event A (edited)']),
  veventFor(['UID:evt-c', 'DTSTART:20261201T090000Z', 'SUMMARY:Event C']),
]);

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const testConfig = {
  pushDelayMs: 0, maxFeedBytes: 1024 * 1024, fetchTimeoutMs: 5000,
  windowPastDays: 30, windowFutureDays: 365,
};

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

function makeIcloudClient(mock) {
  return createIcloudCalDavClient({
    username: 'owner@example.com',
    appPassword: 'abcd-efgh-ijkl-mnop',
    fetchImpl: mock.fetchImpl, // read at factory-call time so tests can wrap it
    baseDelayMs: 10,
    timeoutMs: 5000,
    maxRetries: 3,
    sleepFn: async () => {},
  });
}

// Full loop harness: X (iCloud calendar) <-> mirror pair A (X -> G) and
// mirror pair B (G -> X) sharing one CalDAV write mock and one Google mock.
async function makeLoopHarness({ xSeeds = X_SEEDS } = {}) {
  const db = await openDatabase(':memory:');
  const xMock = makeCaldavWriteMock({ seeds: xSeeds });
  const gHolder = makeGoogleMock();
  const engine = makeEngine(db, {
    googleFactory: () => gHolder.client,
    icloudFactory: () => makeIcloudClient(xMock),
  });
  const pairA = db.createPair({
    name: 'A X->G', feed_url: X_CALDAV_URL, source_type: 'caldav', calendar_id: G_CAL,
    interval_minutes: 60, target_type: 'google',
  });
  const pairB = db.createPair({
    name: 'B G->X', feed_url: googleSourceUrlOf(G_CAL), source_type: 'google', calendar_id: '',
    interval_minutes: 60, target_type: 'caldav', target_url: X_CALDAV_URL,
  });
  return { db, xMock, gHolder, engine, pairA, pairB };
}

const gUids = (holder, cal) => holder.store.eventsOf(cal).filter((e) => e.iCalUID).map((e) => e.iCalUID).sort();

// ---------------------------------------------------------------------------
// google:// source URL encoding
// ---------------------------------------------------------------------------

test('parseGoogleSourceUrl: valid ids, percent-decoding, strict rejection', () => {
  assert.equal(parseGoogleSourceUrl('google://primary'), 'primary');
  assert.equal(parseGoogleSourceUrl('google://abc123@group.calendar.google.com'), 'abc123@group.calendar.google.com');
  assert.equal(parseGoogleSourceUrl('GOOGLE://Abc@Example.Com'), 'Abc@Example.Com');
  assert.equal(parseGoogleSourceUrl('google://abc%40group.calendar.google.com'), 'abc@group.calendar.google.com');
  assert.equal(parseGoogleSourceUrl('  google://primary  '), 'primary');
  assert.equal(googleSourceUrlOf('primary'), 'google://primary');
  assert.equal(googleSourceUrlOf(parseGoogleSourceUrl(googleSourceUrlOf('a@b.c'))), 'google://a@b.c', 'roundtrip stable');
  assert.throws(() => parseGoogleSourceUrl(''), /empty/);
  assert.throws(() => parseGoogleSourceUrl('   '), /empty/);
  assert.throws(() => parseGoogleSourceUrl('https://calendar.google.com/x'), /google:\/\/ scheme/);
  assert.throws(() => parseGoogleSourceUrl('google://'), /missing the calendar ID/);
  assert.throws(() => parseGoogleSourceUrl('google://   '), /missing the calendar ID/);
  assert.throws(() => parseGoogleSourceUrl('google://a/b'), /must not contain/);
  assert.throws(() => parseGoogleSourceUrl('google://a b'), /must not contain/);
  assert.throws(() => parseGoogleSourceUrl('google://a?query=1'), /must not contain/);
  assert.throws(() => parseGoogleSourceUrl('google://a#frag'), /must not contain/);
  assert.throws(() => parseGoogleSourceUrl(`google://${'x'.repeat(301)}`), /too long/);
});

// ---------------------------------------------------------------------------
// Pair semantics guards (shared by server.js create/update and the engine)
// ---------------------------------------------------------------------------

test('pairSemanticError: G->G rejected, CalDAV self-mirror rejected (href-normalized)', () => {
  assert.match(
    pairSemanticError({ source_type: 'google', target_type: 'google', feed_url: 'google://a', calendar_id: 'b' }),
    /degenerate/,
  );
  assert.match(
    pairSemanticError({ source_type: 'caldav', target_type: 'caldav', feed_url: X_CALDAV_URL, target_url: X_CALDAV_URL }),
    /same CalDAV calendar/,
  );
  assert.match(
    pairSemanticError({
      source_type: 'caldav', target_type: 'caldav',
      feed_url: 'caldav://caldav.icloud.com/1/calendars/x',
      target_url: 'https://caldav.icloud.com/1/calendars/x/',
    }),
    /same CalDAV calendar/,
  );
  assert.match(
    pairSemanticError({
      source_type: 'caldav', target_type: 'caldav',
      feed_url: 'CALDAV://CALDAV.ICLOUD.COM/1/calendars/x/',
      target_url: 'caldav://caldav.icloud.com/1/calendars/x',
    }),
    /same CalDAV calendar/,
    'caldav:// vs https://, trailing slashes and host case normalize equal (path case is significant, host case is not)',
  );
  assert.equal(pairSemanticError({
    source_type: 'caldav', target_type: 'caldav',
    feed_url: 'caldav://caldav.icloud.com/1/calendars/x/',
    target_url: 'caldav://caldav.icloud.com/1/calendars/y/',
  }), null, 'two DIFFERENT iCloud calendars mirroring each other is exactly the two-way feature');
  assert.equal(pairSemanticError({ source_type: 'url', target_type: 'google', feed_url: 'https://f', calendar_id: 'c' }), null);
  assert.equal(pairSemanticError({ source_type: 'google', target_type: 'caldav', feed_url: 'google://a', target_url: X_CALDAV_URL }), null);
  assert.equal(pairSemanticError({ source_type: 'url', target_type: 'caldav', feed_url: 'https://f', target_url: X_CALDAV_URL }), null);
  assert.equal(pairSemanticError({ source_type: 'caldav', target_type: 'google', feed_url: X_CALDAV_URL, calendar_id: 'c' }), null,
    'the classic one-way iCloud -> Google pair stays legal');
});

// ---------------------------------------------------------------------------
// CalDAV as a TARGET: full engine CRUD through the write mock
// ---------------------------------------------------------------------------

test('CalDAV target: url source imports via PUT, second identical run is zero-write', async () => {
  const db = await openDatabase(':memory:');
  const xMock = makeCaldavWriteMock();
  const engine = makeEngine(db, { icloudFactory: () => makeIcloudClient(xMock) });
  const pair = db.createPair({
    name: 'feed->icloud', feed_url: 'https://feed.example/cal.ics', source_type: 'url',
    calendar_id: '', target_type: 'caldav', target_url: X_CALDAV_URL, interval_minutes: 60,
  });
  const r1 = await engine.runPair(pair.id, { trigger: 'initial' });
  assert.equal(r1.status, 'success');
  assert.equal(xMock.calls.puts.length, 2);
  assert.deepEqual(xMock.store.uids(), ['evt-a', 'evt-b']);
  assert.match(xMock.store.icsOf('evt-a'), /UID:evt-a/);
  assert.deepEqual(db.listSyncedUids(pair.id).sort(), ['evt-a', 'evt-b']);

  const r2 = await engine.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(r2.status, 'success');
  assert.equal(r2.log.unchanged, 2, 'canonical hash comparison against the live remote copies');
  assert.equal(r2.log.imported, 0);
  assert.equal(xMock.calls.puts.length, 2, 'skip-unchanged: zero PUTs on equal content');
  assert.equal(xMock.calls.deletes.length, 0);
  db.close();
});

test('CalDAV target: edit + new event + vanished event drives exactly one cycle of writes', async () => {
  const db = await openDatabase(':memory:');
  const xMock = makeCaldavWriteMock();
  const engine = makeEngine(db, { icloudFactory: () => makeIcloudClient(xMock) });
  const pair = db.createPair({
    name: 'feed->icloud', feed_url: 'https://feed.example/cal.ics', source_type: 'url',
    calendar_id: '', target_type: 'caldav', target_url: X_CALDAV_URL, interval_minutes: 60,
  });
  await engine.runPair(pair.id, { trigger: 'initial' });

  const engine2 = makeEngine(db, {
    icloudFactory: () => makeIcloudClient(xMock),
    fetchFeedImpl: async () => ({ text: FEED2, finalUrl: 'x', status: 200 }),
  });
  const r2 = await engine2.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(r2.status, 'success');
  assert.deepEqual(xMock.store.uids(), ['evt-a', 'evt-c'], 'evt-a overwritten, evt-c created, evt-b deleted');
  assert.equal(xMock.calls.puts.length, 4, '2 initial + evt-a rewrite + evt-c create (evt-b skipped as unchanged never PUT)');
  assert.match(xMock.store.icsOf('evt-a'), /SUMMARY:Event A \(edited\)/);
  assert.deepEqual(xMock.calls.deletes.map((d) => d.uid), ['evt-b'], 'deletion sweep hits only previously-tracked UIDs');
  assert.deepEqual(db.listSyncedUids(pair.id).sort(), ['evt-a', 'evt-c']);
  db.close();
});

test('CalDAV target: user-deleted iCloud resource is restored on the next run', async () => {
  const db = await openDatabase(':memory:');
  const xMock = makeCaldavWriteMock();
  const engine = makeEngine(db, { icloudFactory: () => makeIcloudClient(xMock) });
  const pair = db.createPair({
    name: 'feed->icloud', feed_url: 'https://feed.example/cal.ics', source_type: 'url',
    calendar_id: '', target_type: 'caldav', target_url: X_CALDAV_URL, interval_minutes: 60,
  });
  await engine.runPair(pair.id, { trigger: 'initial' });
  xMock.store.remove('evt-a'); // user deleted the event inside iCloud
  const r2 = await engine.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(r2.status, 'success');
  assert.equal(r2.log.imported, 1, 'absent from the snapshot map => always re-import');
  assert.deepEqual(xMock.store.uids(), ['evt-a', 'evt-b']);
  db.close();
});

test('CalDAV target: DELETE tolerates 404 (already gone) without failing the run', async () => {
  const db = await openDatabase(':memory:');
  const xMock = makeCaldavWriteMock();
  const pair = db.createPair({
    name: 'feed->icloud', feed_url: 'https://feed.example/cal.ics', source_type: 'url',
    calendar_id: '', target_type: 'caldav', target_url: X_CALDAV_URL, interval_minutes: 60,
  });
  const engine = makeEngine(db, { icloudFactory: () => makeIcloudClient(xMock) });
  const r1 = await engine.runPair(pair.id, { trigger: 'initial' });
  assert.equal(r1.status, 'success');
  // Simulate: evt-b vanished from the feed AND its resource is already gone.
  xMock.store.remove('evt-b');
  const engine2 = makeEngine(db, {
    icloudFactory: () => makeIcloudClient(xMock),
    fetchFeedImpl: async () => ({ text: FEED2, finalUrl: 'x', status: 200 }),
  });
  const r2 = await engine2.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(r2.status, 'success');
  assert.equal(r2.log.deleted, 0, '404 counts as already-gone, not as a failure');
  assert.deepEqual(db.listSyncedUids(pair.id).sort(), ['evt-a', 'evt-c'],
    'evt-b left tracking after its 404 delete; evt-c tracked as usual');
  db.close();
});

test('CalDAV target: failed REPORT aborts the run before any write', async () => {
  const db = await openDatabase(':memory:');
  const xMock = makeCaldavWriteMock();
  const originalFetch = xMock.fetchImpl;
  xMock.fetchImpl = async (url, opts = {}) => {
    if (String(opts.method).toUpperCase() === 'REPORT') return new Response('<error/>', { status: 500 });
    return originalFetch(url, opts);
  };
  const engine = makeEngine(db, { icloudFactory: () => makeIcloudClient(xMock) });
  const pair = db.createPair({
    name: 'feed->icloud', feed_url: 'https://feed.example/cal.ics', source_type: 'url',
    calendar_id: '', target_type: 'caldav', target_url: X_CALDAV_URL, interval_minutes: 60,
  });
  const r = await engine.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(r.status, 'error');
  assert.match(r.error, /HTTP 500/);
  assert.equal(xMock.calls.puts.length, 0, 'snapshot failure aborts before any write');
  assert.equal(xMock.calls.deletes.length, 0);
  db.close();
});

test('CalDAV target: all-PUT failures skip the deletion pass (protection intact)', async () => {
  const db = await openDatabase(':memory:');
  const xMock = makeCaldavWriteMock();
  let failPuts = false;
  const originalFetch = xMock.fetchImpl;
  xMock.fetchImpl = async (url, opts = {}) => {
    if (failPuts && String(opts.method).toUpperCase() === 'PUT') return new Response('<error/>', { status: 500 });
    return originalFetch(url, opts);
  };
  const engine = makeEngine(db, { icloudFactory: () => makeIcloudClient(xMock) });
  const pair = db.createPair({
    name: 'feed->icloud', feed_url: 'https://feed.example/cal.ics', source_type: 'url',
    calendar_id: '', target_type: 'caldav', target_url: X_CALDAV_URL, interval_minutes: 60,
  });
  const r1 = await engine.runPair(pair.id, { trigger: 'initial' });
  assert.equal(r1.status, 'success');
  assert.deepEqual(db.listSyncedUids(pair.id).sort(), ['evt-a', 'evt-b']);

  failPuts = true; // auth-style outage from now on; FEED2 would delete evt-b
  const engine2 = makeEngine(db, {
    icloudFactory: () => makeIcloudClient(xMock),
    fetchFeedImpl: async () => ({ text: FEED2, finalUrl: 'x', status: 200 }),
  });
  const r2 = await engine2.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(r2.status, 'error');
  assert.match(r2.error, /deletion pass skipped/);
  assert.equal(xMock.calls.deletes.length, 0, 'a broken write path can never mass-delete the target');
  assert.deepEqual(db.listSyncedUids(pair.id).sort(), ['evt-a', 'evt-b'], 'bookkeeping untouched on abort');
  db.close();
});

test('CalDAV target runs fine without a Google client (target adapter decides)', async () => {
  const db = await openDatabase(':memory:');
  const xMock = makeCaldavWriteMock();
  const engine = makeEngine(db, { googleFactory: () => null, icloudFactory: () => makeIcloudClient(xMock) });
  const pair = db.createPair({
    name: 'feed->icloud', feed_url: 'https://feed.example/cal.ics', source_type: 'url',
    calendar_id: '', target_type: 'caldav', target_url: X_CALDAV_URL, interval_minutes: 60,
  });
  const r = await engine.runPair(pair.id, { trigger: 'manual' });
  assert.equal(r.status, 'success');
  assert.equal(xMock.calls.puts.length, 2);
  db.close();
});

test('CalDAV target without iCloud credentials fails cleanly before any write', async () => {
  const db = await openDatabase(':memory:');
  const engine = makeEngine(db, {}); // default icloudFactory returns null
  const pair = db.createPair({
    name: 'feed->icloud', feed_url: 'https://feed.example/cal.ics', source_type: 'url',
    calendar_id: '', target_type: 'caldav', target_url: X_CALDAV_URL, interval_minutes: 60,
  });
  const r = await engine.runPair(pair.id, { trigger: 'manual' });
  assert.equal(r.status, 'error');
  assert.match(r.error, /iCloud \(CalDAV\) target not configured/);
  assert.match(r.error, /ICLOUD_APPLE_ID/);
  db.close();
});

// ---------------------------------------------------------------------------
// Google as a SOURCE
// ---------------------------------------------------------------------------

test('google:// source mirrors into a CalDAV target: statuses mapped, warnings for uid-less items, window filter applied', async () => {
  const db = await openDatabase(':memory:');
  const xMock = makeCaldavWriteMock();
  // Seed the Google source calendar directly (importEvent always stores
  // status 'confirmed' - like the real API - so tentative/uid-less variants
  // come through seedEvents, which respect the given status fields).
  const gHolder = makeGoogleMock({
    seedEvents: [
      { calendarId: 'g-src', iCalUID: 'evt-ok', id: 'g1', summary: 'Ok', start: { dateTime: '2026-11-15T09:00:00Z' }, end: { dateTime: '2026-11-15T09:30:00Z' } },
      { calendarId: 'g-src', iCalUID: 'evt-tent', id: 'g2', summary: 'Tentative one', start: { dateTime: '2026-11-16T09:00:00Z' }, status: 'tentative', transparency: 'transparent' },
      { calendarId: 'g-src', id: 'g3', summary: 'No iCalUID here', start: { dateTime: '2026-11-17T09:00:00Z' } },
      { calendarId: 'g-src', iCalUID: 'evt-far', id: 'g4', summary: 'Far future', start: { dateTime: '2029-01-01T00:00:00Z' } },
    ],
  });

  const engine = makeEngine(db, { googleFactory: () => gHolder.client, icloudFactory: () => makeIcloudClient(xMock) });
  const pair = db.createPair({
    name: 'g->icloud', feed_url: 'google://g-src', source_type: 'google',
    calendar_id: '', target_type: 'caldav', target_url: X_CALDAV_URL, interval_minutes: 60,
  });
  const r = await engine.runPair(pair.id, { trigger: 'initial' });
  assert.equal(r.status, 'success');
  assert.equal(r.log.fetched, 3, 'evt-ok, evt-tent, evt-far - the uid-less item is warned BEFORE the pipeline count (like feed parse skips)');
  assert.equal(xMock.store.has('evt-far'), false, 'out-of-window event filtered by the usual window logic');
  assert.equal(r.log.skipped, 1, 'evt-far filtered + counted skipped');
  assert.ok(r.log.warnings.some((w) => /no iCalUID/i.test(w)), 'uid-less Google items are warned and skipped');
  assert.deepEqual(xMock.store.uids(), ['evt-ok', 'evt-tent']);
  assert.match(xMock.store.icsOf('evt-ok'), /STATUS:CONFIRMED/);
  assert.match(xMock.store.icsOf('evt-tent'), /STATUS:TENTATIVE/, 'tentative survives the Google->ICS status mapping');
  assert.match(xMock.store.icsOf('evt-tent'), /TRANSP:TRANSPARENT/);
  db.close();
});

test('cancelled Google events drive deletions from the CalDAV target', async () => {
  const db = await openDatabase(':memory:');
  const xMock = makeCaldavWriteMock();
  const gHolder = makeGoogleMock({
    seedEvents: [{ calendarId: 'g-src', iCalUID: 'evt-gone', id: 'g1', summary: 'Bye', start: { dateTime: '2026-11-15T09:00:00Z' } }],
  });
  const engine = makeEngine(db, { googleFactory: () => gHolder.client, icloudFactory: () => makeIcloudClient(xMock) });
  const pair = db.createPair({
    name: 'g->icloud', feed_url: 'google://g-src', source_type: 'google',
    calendar_id: '', target_type: 'caldav', target_url: X_CALDAV_URL, interval_minutes: 60,
  });
  const r1 = await engine.runPair(pair.id, { trigger: 'initial' });
  assert.equal(r1.status, 'success');
  assert.deepEqual(xMock.store.uids(), ['evt-gone']);

  // The user cancelled the event inside Google ("deleted"): masters read back
  // with status cancelled on the next snapshot.
  gHolder.store.findByUid('g-src', 'evt-gone').status = 'cancelled';
  const r2 = await engine.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(r2.status, 'success');
  assert.deepEqual(xMock.calls.deletes.map((d) => d.uid), ['evt-gone'], 'cancelled source events delete like vanished feed events');
  assert.deepEqual(xMock.store.uids(), []);
  db.close();
});

test('G->G rows are rejected by the engine even if a legacy row existed', async () => {
  const db = await openDatabase(':memory:');
  const gHolder = makeGoogleMock();
  await gHolder.client.importEvent('g-src', { iCalUID: 'evt', summary: 'X', start: { dateTime: '2026-11-15T09:00:00Z' } });
  const engine = makeEngine(db, { googleFactory: () => gHolder.client });
  const pair = db.createPair({
    name: 'g->g', feed_url: 'google://g-src', source_type: 'google', calendar_id: 'cal-other', interval_minutes: 60,
  });
  const r = await engine.runPair(pair.id, { trigger: 'manual' });
  assert.equal(r.status, 'error');
  assert.match(r.error, /degenerate/);
  assert.equal(gHolder.calls.listSourceReads.length, 0, 'guard fires before any source read');
  const status = db.getStatus(pair.id);
  assert.equal(status.last_status, 'error');
  db.close();
});

test('malformed google:// feed_url produces a clean engine error', async () => {
  const db = await openDatabase(':memory:');
  const xMock = makeCaldavWriteMock();
  const gHolder = makeGoogleMock();
  const engine = makeEngine(db, { googleFactory: () => gHolder.client, icloudFactory: () => makeIcloudClient(xMock) });
  const pair = db.createPair({
    name: 'bad', feed_url: 'google://', source_type: 'google',
    calendar_id: '', target_type: 'caldav', target_url: X_CALDAV_URL, interval_minutes: 60,
  });
  const r = await engine.runPair(pair.id, { trigger: 'manual' });
  assert.equal(r.status, 'error');
  assert.match(r.error, /google:\/\/<calendarId>/);
  db.close();
});

test('google-source pairs fail cleanly without a connected Google account', async () => {
  const db = await openDatabase(':memory:');
  const xMock = makeCaldavWriteMock();
  const engine = makeEngine(db, { googleFactory: () => null, icloudFactory: () => makeIcloudClient(xMock) });
  const pair = db.createPair({
    name: 'g->icloud', feed_url: 'google://g-src', source_type: 'google',
    calendar_id: '', target_type: 'caldav', target_url: X_CALDAV_URL, interval_minutes: 60,
  });
  const r = await engine.runPair(pair.id, { trigger: 'manual' });
  assert.equal(r.status, 'error');
  assert.match(r.error, /Google account not connected/);
  assert.equal(xMock.calls.puts.length, 0, 'no target mutations without a source client');
  db.close();
});

// ---------------------------------------------------------------------------
// Loop-safety scenario set: X (iCloud) <-> G (Google) via mirror pair A
// (X->G) and mirror pair B (G->X)
// ---------------------------------------------------------------------------

test('loop (i): initial round trip converges - equivalent content, next runs zero-write', async () => {
  const { db, xMock, gHolder, engine, pairA, pairB } = await makeLoopHarness();

  const rA1 = await engine.runPair(pairA.id, { trigger: 'initial' });
  assert.equal(rA1.status, 'success');
  assert.equal(gHolder.calls.imports.length, 2, 'X content mirrored into G');
  assert.deepEqual(xMock.calls.puts, [], 'pair A never writes X (it is the target? no - the source)');

  const rB1 = await engine.runPair(pairB.id, { trigger: 'initial' });
  assert.equal(rB1.status, 'success');
  assert.equal(rB1.log.unchanged, 2, 'B finds X already equivalent: canonical hashes compare equal');
  assert.equal(rB1.log.imported, 0);
  assert.equal(xMock.calls.puts.length, 0, 'pair B must NOT rewrite what X already holds (the loop-killer)');

  // Convergence proof: for every UID, X and G hold canonical-hash-equal copies.
  for (const uid of xMock.store.uids()) {
    const gItem = gHolder.store.findByUid(G_CAL, uid);
    assert.ok(gItem, `uid ${uid} mirrored into G`);
    assert.equal(
      canonicalEventHash(parseFeed(xMock.store.icsOf(uid)).events[0]),
      canonicalEventHash(googleItemToEvent(gItem)),
      `X copy and G copy of ${uid} normalize equal`,
    );
  }

  // Next runs: BOTH pairs zero-write.
  const rA2 = await engine.runPair(pairA.id, { trigger: 'scheduled' });
  assert.equal(rA2.log.imported, 0);
  assert.equal(rA2.log.unchanged, 2);
  const rB2 = await engine.runPair(pairB.id, { trigger: 'scheduled' });
  assert.equal(rB2.log.imported, 0);
  assert.equal(rB2.log.unchanged, 2);
  assert.equal(gHolder.calls.imports.length, 2, 'no new Google writes');
  assert.equal(xMock.calls.puts.length, 0, 'no new iCloud writes');
  assert.equal(xMock.calls.deletes.length, 0);
  db.close();
});

test('loop (iii): UIDs are preserved end-to-end across the full round trip (no respawn)', async () => {
  const { db, xMock, gHolder, engine, pairA, pairB } = await makeLoopHarness();
  await engine.runPair(pairA.id, { trigger: 'initial' });
  await engine.runPair(pairB.id, { trigger: 'initial' });
  const expected = ['evt-a', 'evt-b'];
  assert.deepEqual(xMock.store.uids(), expected, 'X keeps its original UIDs');
  assert.deepEqual(gUids(gHolder, G_CAL), expected, 'G stores the same iCalUIDs');
  assert.deepEqual(db.listSyncedUids(pairA.id).sort(), expected);
  // Pair B found X already equivalent and therefore wrote nothing: its
  // tracked set stays empty BY DESIGN - a pair only tracks (and can only
  // ever delete) resources it itself wrote, which protects pre-existing X
  // content from pair B's fresh G-snapshot authority.
  assert.deepEqual(db.listSyncedUids(pairB.id), []);
  // The resource URL encoding must not mutate UIDs either (already covered at
  // lib level; assert end-to-end here that round-tripping did not rename).
  assert.match(xMock.store.icsOf('evt-a'), /UID:evt-a\r?\n/);
  db.close();
});

test('loop (ii): one edit in X converges within one full cycle and does not multiply', async () => {
  const { db, xMock, gHolder, engine, pairA, pairB } = await makeLoopHarness();
  await engine.runPair(pairA.id, { trigger: 'initial' });
  await engine.runPair(pairB.id, { trigger: 'initial' });
  const importsAfterRound1 = gHolder.calls.imports.length;

  // One edit in X.
  xMock.store.putRaw('evt-a', icsFor([veventFor(['UID:evt-a', 'DTSTART:20261115T090000Z', 'DTEND:20261115T093000Z', 'SUMMARY:Event A (edited in X)'])]));
  const rA2 = await engine.runPair(pairA.id, { trigger: 'scheduled' });
  assert.equal(rA2.status, 'success');
  assert.deepEqual(gHolder.calls.imports.slice(importsAfterRound1).map(([, g]) => g.iCalUID), ['evt-a'],
    'exactly the edited event re-imports into G');
  assert.match(gHolder.store.findByUid(G_CAL, 'evt-a').summary, /edited in X/);

  const putsAfterRound1 = xMock.calls.puts.length;
  const rB2 = await engine.runPair(pairB.id, { trigger: 'scheduled' });
  assert.equal(rB2.status, 'success');
  assert.equal(rB2.log.unchanged, 2, 'B sees X already holds the edited content: skip');
  assert.equal(xMock.calls.puts.length, putsAfterRound1, 'no PUT rounds back into X');

  // The full cycle closed: the NEXT A run must be zero-write again.
  const rA3 = await engine.runPair(pairA.id, { trigger: 'scheduled' });
  assert.equal(rA3.log.imported, 0, 'converged - the edit did not multiply');
  assert.equal(rA3.log.unchanged, 2);
  db.close();
});

// loop (iv), case 1: the user edits X between A's read and B's write. B's
// source snapshot (G) is the authority for pair B, so B overwrites the edit.
// This is BY DESIGN: last-writer semantics = whichever source snapshot the
// pair reads; the loop still stabilizes immediately (no oscillation).
test('loop (iv-a): user edit mid-loop is overwritten by the next authority write and the loop stabilizes', async () => {
  const { db, xMock, gHolder, engine, pairA, pairB } = await makeLoopHarness();
  await engine.runPair(pairA.id, { trigger: 'initial' }); // A reads X (original), writes G
  // --- user edit lands in X while the loop is "in flight" ---
  xMock.store.putRaw('evt-a', icsFor([veventFor(['UID:evt-a', 'DTSTART:20261115T090000Z', 'DTEND:20261115T093000Z', 'SUMMARY:Event A (user edit in X)'])]));
  // BY DESIGN: pair B reads G (still the pre-edit content) and treats it as
  // the authority for X, so it overwrites the user edit. "Source is
  // authority" per pair; the last writer is whichever source the pair read.
  const rB1 = await engine.runPair(pairB.id, { trigger: 'scheduled' });
  assert.equal(rB1.status, 'success');
  assert.equal(rB1.log.imported, 1, 'B rewrites evt-a: remote X differs from its authority snapshot G');
  assert.equal(xMock.calls.puts.length, 1);
  assert.match(xMock.store.icsOf('evt-a'), /SUMMARY:Event A\r?\n/, 'the user edit was overwritten (by design)');

  // The loop MUST stabilize right away: X holds G's content again, so A sees
  // its own stored hash and B sees equivalence.
  const rA2 = await engine.runPair(pairA.id, { trigger: 'scheduled' });
  assert.equal(rA2.log.imported, 0, 'A skips: X was restored to the exact content A previously imported');
  const rB2 = await engine.runPair(pairB.id, { trigger: 'scheduled' });
  assert.equal(rB2.log.imported, 0);
  assert.equal(xMock.calls.puts.length, 1, 'no further writes - stable, no oscillation');
  db.close();
});

// loop (iv), case 2: a user event created directly in X (outside any pair's
// authority) survives the loop and converges into G.
test('loop (iv-b): a user event created directly in X survives and converges', async () => {
  const { db, xMock, gHolder, engine, pairA, pairB } = await makeLoopHarness();
  await engine.runPair(pairA.id, { trigger: 'initial' });
  await engine.runPair(pairB.id, { trigger: 'initial' });

  xMock.store.putRaw('evt-user', icsFor([veventFor(['UID:evt-user@icloud', 'DTSTART:20261220T180000Z', 'DTEND:20261220T190000Z', 'SUMMARY:User made this in X'])]));
  // Pair B first: its authority is G, which knows nothing about evt-user, and
  // B never tracked it -> it must NOT delete or rewrite it.
  const rB2 = await engine.runPair(pairB.id, { trigger: 'scheduled' });
  assert.equal(rB2.status, 'success');
  assert.ok(xMock.store.has('evt-user'), 'B must leave untracked user content alone');
  assert.equal(xMock.calls.deletes.length, 0);

  // Pair A then imports the user event into G; the next B run sees it in its
  // authority snapshot AND on X: equivalent -> skip. Stable.
  const rA2 = await engine.runPair(pairA.id, { trigger: 'scheduled' });
  assert.equal(rA2.log.imported, 1);
  assert.ok(gHolder.store.findByUid(G_CAL, 'evt-user@icloud'), 'user event mirrored into G');
  const rB3 = await engine.runPair(pairB.id, { trigger: 'scheduled' });
  assert.equal(rB3.log.unchanged, 3, 'evt-user now compares equal on both sides');
  assert.equal(xMock.calls.puts.length, 0, 'still zero PUTs into X overall');
  const rA3 = await engine.runPair(pairA.id, { trigger: 'scheduled' });
  assert.equal(rA3.log.imported, 0);
  db.close();
});

// The SEQUENCE-exclusion proof: real Google assigns its own sequence numbers
// and Apple renumbers on store; either side must be able to do so without
// the two pairs chasing each other's metadata forever.
test('sequence drift (Google-assigned and Apple-renumbered) converges; SEQUENCE exclusion is load-bearing', async () => {
  const { db, xMock, gHolder, engine, pairA, pairB } = await makeLoopHarness();
  await engine.runPair(pairA.id, { trigger: 'initial' });
  await engine.runPair(pairB.id, { trigger: 'initial' });
  assert.equal(xMock.calls.puts.length, 0);

  // 1) Google assigns sequence 0 to stored events (real-world import behavior).
  gHolder.store.findByUid(G_CAL, 'evt-a').sequence = 0;
  gHolder.store.findByUid(G_CAL, 'evt-b').sequence = 0;
  const rB2 = await engine.runPair(pairB.id, { trigger: 'scheduled' });
  assert.equal(rB2.status, 'success');
  assert.equal(rB2.log.unchanged, 2);
  assert.equal(xMock.calls.puts.length, 0,
    'canonical compare EXCLUDES sequence: Google-side renumbering alone must not PUT');

  // 2) Apple stores a copy with its own SEQUENCE bump plus Apple-style
  //    normalization (PRODID/DTSTAMP/CREATED/LAST-MODIFIED/X- props).
  xMock.store.putRaw('evt-a', [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Apple Inc.//iCal 5.0//EN',
    'BEGIN:VEVENT',
    'UID:evt-a',
    'SEQUENCE:1',
    'DTSTAMP:20261111T090000Z',
    'CREATED:20261111T080000Z',
    'LAST-MODIFIED:20261111T090000Z',
    'DTSTART:20261115T090000Z',
    'DTEND:20261115T093000Z',
    'SUMMARY:Event A',
    'X-APPLE-SOMETHING:meta',
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n'));
  const rB3 = await engine.runPair(pairB.id, { trigger: 'scheduled' });
  assert.equal(rB3.log.unchanged, 2, 'Apple-side SEQUENCE bump alone must not PUT either');
  assert.equal(xMock.calls.puts.length, 0);

  // 3) The Google side converges with ONE repair import (A's stored hash was
  //    written pre-bump), then everything stays zero-write forever.
  const rA2 = await engine.runPair(pairA.id, { trigger: 'scheduled' });
  assert.equal(rA2.log.imported, 1, 'evt-a re-imports exactly once after Apple bumped SEQUENCE');
  const rB4 = await engine.runPair(pairB.id, { trigger: 'scheduled' });
  assert.equal(rB4.log.imported, 0);
  assert.equal(xMock.calls.puts.length, 0);
  const rA3 = await engine.runPair(pairA.id, { trigger: 'scheduled' });
  assert.equal(rA3.log.imported, 0, 'fully converged: zero-write from here on');
  assert.equal(gHolder.calls.imports.length, 3, '2 initial + exactly 1 repair import');
  db.close();
});
