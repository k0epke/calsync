// Sync engine tests: full plan->import(skip-unchanged)->delete flow against a
// fake Google client and an in-memory SQLite database (no network anywhere).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../lib/db.js';
import { createSyncEngine } from '../lib/sync.js';
import { CONTENT_HASH_FIELDS, parseFeed, toGoogleEvent, contentHashOf } from '../lib/icalparse.js';
import { planSync } from '../lib/planner.js';
import { cronExprForInterval } from '../lib/scheduler.js';
import { FIXED_NOW_MS, icsFor, veventFor, makeGoogleMock } from './helpers.js';

const NOW_ISO = '2026-11-11T12:00:00.000Z';

function makeEngine(db, googleHolder, { fetchFeedImpl } = {}) {
  return createSyncEngine({
    db,
    config: {
      pushDelayMs: 0,
      maxFeedBytes: 1024 * 1024,
      fetchTimeoutMs: 5000,
      windowPastDays: 30,
      windowFutureDays: 365,
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    googleFactory: () => googleHolder.client,
    fetchFeedImpl: fetchFeedImpl ?? (async () => ({ text: FEED1, finalUrl: 'https://feed.example/cal.ics', status: 200 })),
    parseFeedImpl: parseFeed,
    planSyncImpl: planSync,
    clock: { now: () => FIXED_NOW_MS },
    delayFn: async () => {},
  });
}

const FEED1 = icsFor([
  veventFor(['UID:evt-a', 'DTSTART:20261115T090000Z', 'DTEND:20261115T093000Z', 'SUMMARY:Event A']),
  veventFor(['UID:evt-b', 'DTSTART:20261116T090000Z', 'DTEND:20261116T100000Z', 'SUMMARY:Event B',
    'RRULE:FREQ=WEEKLY;BYDAY=MO', 'STATUS:CONFIRMED']),
]);
const FEED2 = icsFor([
  veventFor(['UID:evt-a', 'DTSTART:20261115T090000Z', 'DTEND:20261115T093000Z', 'SUMMARY:Event A (edited)']),
  veventFor(['UID:evt-c', 'DTSTART:20261201T090000Z', 'SUMMARY:Event C']),
]);
// evt-a edited, evt-b unchanged — isolates the changed-event path.
const FEED2B = icsFor([
  veventFor(['UID:evt-a', 'DTSTART:20261115T090000Z', 'DTEND:20261115T093000Z', 'SUMMARY:Event A (edited)']),
  veventFor(['UID:evt-b', 'DTSTART:20261116T090000Z', 'DTEND:20261116T100000Z', 'SUMMARY:Event B',
    'RRULE:FREQ=WEEKLY;BYDAY=MO', 'STATUS:CONFIRMED']),
]);

const feedResponse = (text) => async () => ({ text, finalUrl: 'x', status: 200 });

test('first run imports in-window events and records them', async () => {
  const db = await openDatabase(':memory:');
  const pair = db.createPair({ name: 'P1', feed_url: 'https://feed.example/cal.ics', calendar_id: 'cal-target', interval_minutes: 360 });
  const holder = makeGoogleMock();
  const engine = makeEngine(db, holder);
  const result = await engine.runPair(pair.id, { trigger: 'scheduled' });

  assert.equal(result.status, 'success');
  assert.equal(result.log.fetched, 2);
  assert.equal(holder.calls.imports.length, 2);
  assert.deepEqual(holder.calls.imports.map(([, g]) => g.iCalUID).sort(), ['evt-a', 'evt-b']);
  for (const [, g] of holder.calls.imports) {
    assert.equal(g.status, 'confirmed');
    assert.ok(g.iCalUID.startsWith('evt-'));
  }
  // exactly ONE snapshot read for the whole run (no per-event list calls);
  // the read happens before any import, so a fresh calendar is empty here
  assert.deepEqual(holder.calls.listReads, [{ calendarId: 'cal-target', pages: 1, events: 0 }]);
  assert.deepEqual(db.listSyncedUids(pair.id).sort(), ['evt-a', 'evt-b']);
  const status = db.getStatus(pair.id);
  assert.equal(status.last_status, 'success');
  assert.ok(status.last_success_at);
  db.close();
});

test('second run with a shrunk feed imports changes and deletes vanished events', async () => {
  const db = await openDatabase(':memory:');
  const pair = db.createPair({ name: 'P1', feed_url: 'x', calendar_id: 'cal-target', interval_minutes: 360 });
  const holder = makeGoogleMock();
  const engine = makeEngine(db, holder);
  await engine.runPair(pair.id, { trigger: 'initial' });

  const engine2 = makeEngine(db, holder, { fetchFeedImpl: feedResponse(FEED2) });
  const result = await engine2.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(result.status, 'success');
  // feed membership diff: tracked {evt-a, evt-b} vs feed {evt-a, evt-c}
  assert.deepEqual(holder.calls.deletes, [['cal-target', 'evt-b']]);
  assert.deepEqual(db.listSyncedUids(pair.id).sort(), ['evt-a', 'evt-c']);
  // second-run imports: evt-a (content changed -> hash mismatch) + evt-c (absent from calendar)
  assert.deepEqual(holder.calls.imports.slice(2).map(([, g]) => g.iCalUID).sort(), ['evt-a', 'evt-c']);
  assert.equal(result.log.unchanged, 0);
  db.close();
});

test('second run with a completely unchanged feed performs the list read and ZERO write calls', async () => {
  const db = await openDatabase(':memory:');
  const pair = db.createPair({ name: 'P', feed_url: 'x', calendar_id: 'cal-target', interval_minutes: 360 });
  const holder = makeGoogleMock();
  const engine = makeEngine(db, holder);
  await engine.runPair(pair.id, { trigger: 'initial' });
  assert.equal(holder.calls.imports.length, 2);
  assert.equal(holder.calls.listReads.length, 1);

  const result = await engine.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(result.status, 'success');
  assert.equal(result.log.imported, 0);
  assert.equal(result.log.unchanged, 2);
  assert.equal(result.log.deleted, 0);
  assert.equal(result.log.failed, 0);
  assert.equal(holder.calls.imports.length, 2, 'no new import writes');
  assert.equal(holder.calls.deletes.length, 0, 'nothing deleted');
  assert.equal(holder.calls.listReads.length, 2, 'exactly one list read per run');
  assert.deepEqual(db.listSyncedUids(pair.id).sort(), ['evt-a', 'evt-b'], 'bookkeeping untouched');
  // bookkeeping: the unchanged skip count lands in run_log detail
  const runs = db.listRuns(pair.id);
  assert.equal(runs[0].status, 'success');
  assert.equal(JSON.parse(runs[0].detail).unchanged, 2);
  assert.equal(JSON.parse(runs[1].detail).unchanged, 0);
  db.close();
});

test('an event whose content changed in the feed is re-imported, unchanged ones skipped', async () => {
  const db = await openDatabase(':memory:');
  const pair = db.createPair({ name: 'P', feed_url: 'x', calendar_id: 'cal-target', interval_minutes: 360 });
  const holder = makeGoogleMock();
  const engine = makeEngine(db, holder);
  await engine.runPair(pair.id, { trigger: 'initial' });

  const engine2 = makeEngine(db, holder, { fetchFeedImpl: feedResponse(FEED2B) });
  const result = await engine2.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(result.status, 'success');
  // run 1 imported [evt-a, evt-b]; run 2 imports ONLY the changed evt-a
  assert.deepEqual(holder.calls.imports.slice(2).map(([, g]) => g.iCalUID), ['evt-a']);
  assert.equal(result.log.imported, 1);
  assert.equal(result.log.unchanged, 1);
  assert.equal(holder.calls.deletes.length, 0, 'evt-b still in feed, not deleted');
  db.close();
});

test('user-deleted-in-Google event is re-imported on the next run', async () => {
  const db = await openDatabase(':memory:');
  const pair = db.createPair({ name: 'P', feed_url: 'x', calendar_id: 'cal-target', interval_minutes: 360 });
  const holder = makeGoogleMock();
  const engine = makeEngine(db, holder);
  await engine.runPair(pair.id, { trigger: 'initial' });

  // The user deletes Event A from inside Google Calendar: it disappears from
  // the events.list snapshot (showDeleted: false), so the skip condition's
  // existence check (a) no longer holds and the event MUST be re-imported.
  holder.store.removeByUid('cal-target', 'evt-a');

  const result = await engine.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(result.status, 'success');
  assert.deepEqual(holder.calls.imports.slice(2).map(([, g]) => g.iCalUID), ['evt-a'],
    'iCalUID absent from the calendar map => always re-import');
  assert.equal(result.log.imported, 1);
  assert.equal(result.log.unchanged, 1);
  assert.equal(holder.calls.deletes.length, 0, 'still tracked and present in feed => no delete');
  assert.ok(holder.store.findByUid('cal-target', 'evt-a'), 'event restored in the calendar');
  db.close();
});

test('user-cancelled-in-Google copy (status cancelled in the map) is re-imported', async () => {
  const db = await openDatabase(':memory:');
  const pair = db.createPair({ name: 'P', feed_url: 'x', calendar_id: 'cal-target', interval_minutes: 360 });
  const holder = makeGoogleMock({ seedEvents: [{ iCalUID: 'evt-a', id: 'seed-1', status: 'cancelled' }] });
  const engine = makeEngine(db, holder);
  const result = await engine.runPair(pair.id, { trigger: 'manual' });
  assert.equal(result.status, 'success');
  assert.ok(holder.calls.imports.some(([, g]) => g.iCalUID === 'evt-a'),
    'skip condition (b): a cancelled copy never satisfies the skip');
  assert.equal(result.log.imported, 2);
  assert.equal(result.log.unchanged, 0);
  db.close();
});

test('tracked row without a stored hash (pre-migration) re-imports once, then skips', async () => {
  const db = await openDatabase(':memory:');
  const pair = db.createPair({ name: 'P', feed_url: 'x', calendar_id: 'cal-target', interval_minutes: 360 });
  db.upsertSyncedEvent(pair.id, 'evt-a', NOW_ISO); // old deployment: content_hash NULL
  const holder = makeGoogleMock({ seedEvents: [{ iCalUID: 'evt-a', id: 'seed-1' }] });
  const engine = makeEngine(db, holder);
  const result = await engine.runPair(pair.id, { trigger: 'manual' });
  assert.equal(result.status, 'success');
  assert.ok(holder.calls.imports.some(([, g]) => g.iCalUID === 'evt-a'), 'NULL stored hash === never matches');
  assert.equal(result.log.imported, 2);
  // once hashed, the next unchanged run skips
  const result2 = await engine.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(result2.log.imported, 0);
  assert.equal(result2.log.unchanged, 2);
  assert.equal(holder.calls.deletes.length, 0);
  db.close();
});

test('target calendar larger than one page: one engine-level read, skip still works', async () => {
  const db = await openDatabase(':memory:');
  const pair = db.createPair({ name: 'P', feed_url: 'x', calendar_id: 'cal-target', interval_minutes: 360 });
  // 300 unrelated user events in the target calendar (maxResults 250 page)
  const holder = makeGoogleMock({
    seedEvents: Array.from({ length: 300 }, (_, i) => ({ iCalUID: `user-event-${i}@calsync.test`, id: `u${i}` })),
  });
  const engine = makeEngine(db, holder);
  const r1 = await engine.runPair(pair.id, { trigger: 'initial' });
  assert.equal(r1.status, 'success');
  assert.equal(holder.calls.listReads.length, 1, 'single paginated read for the whole run');
  assert.equal(holder.calls.listReads[0].pages, 2, 'mock paginates at 250/page');
  assert.equal(holder.calls.imports.length, 2);
  assert.equal(holder.calls.deletes.length, 0, 'untracked user events are never touched');

  const r2 = await engine.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(r2.log.imported, 0);
  assert.equal(r2.log.unchanged, 2);
  assert.equal(holder.calls.imports.length, 2);
  db.close();
});

test('list-read failure aborts the run before any write or delete', async () => {
  const db = await openDatabase(':memory:');
  const pair = db.createPair({ name: 'P', feed_url: 'x', calendar_id: 'c', interval_minutes: 360 });
  db.upsertSyncedEvent(pair.id, 'evt-stale', NOW_ISO); // vanished from feed; would be deleted on success
  const holder = makeGoogleMock({ failListWith: 'list backend 500' });
  const engine = makeEngine(db, holder, { fetchFeedImpl: feedResponse(FEED1) });
  const result = await engine.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(result.status, 'error');
  assert.match(result.error, /list backend 500/);
  assert.equal(holder.calls.imports.length, 0);
  assert.equal(holder.calls.deletes.length, 0, 'deletion pass must not run after a failed snapshot');
  assert.deepEqual(db.listSyncedUids(pair.id), ['evt-stale']);
  const status = db.getStatus(pair.id);
  assert.equal(status.last_status, 'error');
  db.close();
});

test('unchanged skips do not mask the all-attempts-failed abort (protection intact)', async () => {
  const db = await openDatabase(':memory:');
  const pair = db.createPair({ name: 'P', feed_url: 'x', calendar_id: 'cal-target', interval_minutes: 360 });
  const holder = makeGoogleMock();
  const engine = makeEngine(db, holder);
  await engine.runPair(pair.id, { trigger: 'initial' });

  holder.failImportUids = ['evt-a']; // starts failing only from now on
  const engine2 = makeEngine(db, holder, { fetchFeedImpl: feedResponse(FEED2B) });
  const result = await engine2.runPair(pair.id, { trigger: 'scheduled' });
  // evt-b skipped as unchanged (not an attempt); evt-a attempted and failed:
  // attempted = 1, failed = 1, imported = 0 => abort before deletion pass.
  assert.equal(result.status, 'error');
  assert.match(result.error, /deletion pass skipped/);
  assert.equal(result.log.unchanged, 1);
  assert.equal(result.log.failed, 1);
  assert.equal(holder.calls.deletes.length, 0);
  db.close();
});

test('deletion pass skipped when every attempted import fails (vanished tracked uid)', async () => {
  const db = await openDatabase(':memory:');
  const pair = db.createPair({ name: 'P', feed_url: 'x', calendar_id: 'cal-target', interval_minutes: 360 });
  const holder = makeGoogleMock({ failImportUids: ['evt-a', 'evt-c'] });
  const engine = makeEngine(db, holder);
  const r1 = await engine.runPair(pair.id, { trigger: 'initial' });
  assert.equal(r1.status, 'partial'); // evt-a fails, evt-b imports
  assert.deepEqual(db.listSyncedUids(pair.id), ['evt-b']);

  const r2 = await engine.runPair(pair.id, { trigger: 'scheduled' }); // FEED2: a edited, c new, b gone
  assert.equal(r2.status, 'error');
  assert.match(r2.error, /deletion pass skipped/);
  assert.equal(holder.calls.deletes.length, 0, 'evt-b must not be deleted while every import attempt failed');
  assert.deepEqual(db.listSyncedUids(pair.id), ['evt-b'], 'deletion bookkeeping untouched on abort');
  db.close();
});

test('cancelled feed events are removed from the target calendar, not imported', async () => {
  const feed = icsFor([
    veventFor(['UID:evt-x', 'DTSTART:20261115T090000Z', 'SUMMARY:X']),
    veventFor(['UID:evt-gone', 'DTSTART:20261116T090000Z', 'SUMMARY:cancelled one', 'STATUS:CANCELLED']),
  ]);
  const db = await openDatabase(':memory:');
  const pair = db.createPair({ name: 'P', feed_url: 'x', calendar_id: 'c', interval_minutes: 360 });
  // Pre-tracked uid that will show up as cancelled in the feed
  db.upsertSyncedEvent(pair.id, 'evt-gone', NOW_ISO);
  const holder = makeGoogleMock({ seedEvents: [{ iCalUID: 'evt-gone', id: 'seed-gone' }] });
  const engine = makeEngine(db, holder, { fetchFeedImpl: feedResponse(feed) });
  const result = await engine.runPair(pair.id, { trigger: 'manual' });
  assert.equal(result.status, 'success');
  assert.ok(!holder.calls.imports.some(([, g]) => g.iCalUID === 'evt-gone'), 'cancelled events must not be imported');
  assert.deepEqual(holder.calls.deletes, [['c', 'evt-gone']], 'cancelled tracked events must be deleted');
  db.close();
});

test('all-imports-failed (auth-style) aborts BEFORE the deletion pass', async () => {
  const db = await openDatabase(':memory:');
  const pair = db.createPair({ name: 'P', feed_url: 'x', calendar_id: 'c', interval_minutes: 360 });
  db.upsertSyncedEvent(pair.id, 'evt-stale', NOW_ISO); // stale: feed2 would delete it
  const holder = makeGoogleMock({ failAllWith: '401 invalid credentials' });
  const engine = makeEngine(db, holder, { fetchFeedImpl: feedResponse(FEED1) });
  const result = await engine.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(result.status, 'error');
  assert.match(result.error, /deletion pass skipped/);
  assert.equal(holder.calls.deletes.length, 0, 'deletions must be skipped when the whole import pass failed');
  assert.deepEqual(db.listSyncedUids(pair.id), ['evt-stale']);
  const status = db.getStatus(pair.id);
  assert.equal(status.last_status, 'error');
  assert.ok(/All imports failed/.test(status.last_error));
  db.close();
});

test('partial failure: per-event failures logged, run continues with deletes', async () => {
  const db = await openDatabase(':memory:');
  const pair = db.createPair({ name: 'P', feed_url: 'x', calendar_id: 'c', interval_minutes: 360 });
  const holder = makeGoogleMock({ failImportUids: ['evt-b'] });
  const engine = makeEngine(db, holder);
  const result = await engine.runPair(pair.id, { trigger: 'manual' });
  assert.equal(result.status, 'partial');
  assert.equal(result.log.failed, 1);
  assert.ok(result.log.failures[0].includes('evt-b'));
  assert.deepEqual(db.listSyncedUids(pair.id).sort(), ['evt-a'], 'only successful imports tracked');
  const runs = db.listRuns(pair.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'partial');
  db.close();
});

test('feed fetch failure produces an error run and touches nothing else', async () => {
  const db = await openDatabase(':memory:');
  const pair = db.createPair({ name: 'P', feed_url: 'x', calendar_id: 'c', interval_minutes: 360 });
  const holder = makeGoogleMock();
  const engine = makeEngine(db, holder, { fetchFeedImpl: async () => { throw new Error('feed down'); } });
  const result = await engine.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(result.status, 'error');
  assert.equal(holder.calls.listReads.length, 0);
  assert.equal(holder.calls.imports.length, 0);
  assert.equal(holder.calls.deletes.length, 0);
  const status = db.getStatus(pair.id);
  assert.equal(status.last_status, 'error');
  assert.equal(Number(status.running), 0, 'running flag must be cleared');
  db.close();
});

test('isRunning guard prevents concurrent runs of the same pair', async () => {
  const db = await openDatabase(':memory:');
  const pair = db.createPair({ name: 'P', feed_url: 'x', calendar_id: 'c', interval_minutes: 360 });
  let releasePending = null;
  let firstImportArrived = false;
  const holder = makeGoogleMock();
  holder.client.importEvent = async (...args) => {
    holder.calls.imports.push(args);
    if (!firstImportArrived) {
      firstImportArrived = true;
      await new Promise((r) => { releasePending = r; }); // only the FIRST import blocks
    }
  };
  const engine = makeEngine(db, holder);
  const first = engine.runPair(pair.id, { trigger: 'manual' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(engine.isRunning(pair.id), true);
  await assert.rejects(engine.runPair(pair.id, { trigger: 'manual' }), (err) => err.alreadyRunning === true);
  releasePending();
  const result = await first;
  assert.equal(result.status, 'success');
  db.close();
});

test('missing pair and missing google client produce clean errors', async () => {
  const db = await openDatabase(':memory:');
  const holder = { client: null };
  const engine = makeEngine(db, holder);
  await assert.rejects(engine.runPair(999), /not found/i);
  const pair = db.createPair({ name: 'P', feed_url: 'x', calendar_id: 'c', interval_minutes: 360 });
  const result = await engine.runPair(pair.id);
  assert.equal(result.status, 'error');
  assert.match(result.error, /Google account not connected/);
  db.close();
});

test('toGoogleEvent maps fields + recurrence as ical lines, sanitizes status', () => {
  const feed = parseFeed(FEED1);
  const g = toGoogleEvent(feed.events.find((e) => e.uid === 'evt-b'));
  assert.equal(g.iCalUID, 'evt-b');
  assert.equal(g.summary, 'Event B');
  assert.equal(g.status, 'confirmed');
  assert.deepEqual(g.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO']);
  assert.deepEqual(g.start, { dateTime: '2026-11-16T09:00:00Z' });
});

test('contentHashOf hashes exactly the toGoogleEvent field set (canonical, change-sensitive)', () => {
  assert.deepEqual(CONTENT_HASH_FIELDS, [
    'iCalUID', 'summary', 'description', 'location', 'start', 'end',
    'recurrence', 'status', 'transparency', 'visibility', 'sequence',
  ]);
  const feed = parseFeed(FEED1);
  const g = toGoogleEvent(feed.events.find((e) => e.uid === 'evt-b'));
  const h = contentHashOf(g);
  assert.match(h, /^[0-9a-f]{64}$/);
  // canonical: input key order and extra unknown fields never change the digest
  const shuffled = { end: g.end, status: g.status, iCalUID: g.iCalUID, start: g.start,
    summary: g.summary, description: g.description, location: g.location,
    recurrence: g.recurrence, visibility: g.visibility, transparency: g.transparency, sequence: g.sequence };
  assert.equal(contentHashOf(shuffled), h, 'field-order independent');
  assert.equal(contentHashOf({ ...g, etag: 'x', htmlLink: 'y', kind: 'calendar#event' }), h, 'unknown fields ignored');
  // every hashed field moves the digest
  assert.notEqual(contentHashOf({ ...g, summary: 'Other' }), h);
  assert.notEqual(contentHashOf({ ...g, description: 'Other' }), h);
  assert.notEqual(contentHashOf({ ...g, location: 'Other' }), h);
  assert.notEqual(contentHashOf({ ...g, start: { ...g.start, dateTime: '2026-11-16T10:00:00Z' } }), h);
  assert.notEqual(contentHashOf({ ...g, end: { ...g.end, dateTime: '2026-11-16T10:30:00Z' } }), h);
  assert.notEqual(contentHashOf({ ...g, recurrence: ['RRULE:FREQ=DAILY'] }), h);
  assert.notEqual(contentHashOf({ ...g, status: 'tentative' }), h);
  assert.notEqual(contentHashOf({ ...g, sequence: (g.sequence ?? 0) + 1 }), h);
  // deterministic across calls
  assert.equal(contentHashOf(toGoogleEvent(feed.events.find((e) => e.uid === 'evt-b'))), h);
});

test('old-schema DB (no content_hash) migrates on boot without losing rows', async () => {
  const dbPath = path.join(os.tmpdir(), `calsync-migrate-${Date.now()}-${Math.floor(Math.random() * 1e9)}.sqlite`);
  const raw = new DatabaseSync(dbPath); // create the PRE-migration schema by hand
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
      PRIMARY KEY (pair_id, ical_uid)
    );
  `);
  raw.prepare('INSERT INTO pairs (name, feed_url, calendar_id, interval_minutes, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
    .run('Legacy pair', 'https://feed.example/x.ics', 'cal-x', 360, NOW_ISO, NOW_ISO);
  raw.prepare('INSERT INTO synced_events (pair_id, ical_uid, last_seen_at) VALUES (1, ?, ?)').run('evt-old', NOW_ISO);
  raw.close();

  try {
    const db = await openDatabase(dbPath); // boot migration must add the column, keep rows
    const cols = db._raw.prepare("SELECT name FROM pragma_table_info('synced_events')").all().map((r) => String(r.name));
    assert.ok(cols.includes('content_hash'), 'content_hash added by migration');
    assert.deepEqual(db.listSyncedUids(1), ['evt-old'], 'existing rows survive');
    const hashes = db.listSyncedEventHashes(1);
    assert.equal(hashes.size, 1);
    assert.ok(hashes.has('evt-old'));
    assert.equal(hashes.get('evt-old'), null, 'migrated rows map to a null hash (re-import once)');
    db.upsertSyncedEvent(1, 'evt-old', NOW_ISO, 'deadbeef');
    assert.equal(db.listSyncedEventHashes(1).get('evt-old'), 'deadbeef', 'hash upserts work on the migrated table');
    db.close();
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  }
});

test('opening the same DB twice does not re-run the migration', async () => {
  const db = await openDatabase(':memory:');
  const cols = db._raw.prepare("SELECT name FROM pragma_table_info('synced_events')").all().map((r) => String(r.name));
  assert.deepEqual(cols, ['pair_id', 'ical_uid', 'last_seen_at', 'content_hash']);
  db.close();
});

test('cronExprForInterval: deterministic pair-id minute offsets, clamping, normalization', () => {
  // sub-hourly: explicit phase-shifted minute list (offset = (id*7) % interval)
  assert.equal(cronExprForInterval(15, 2), '14,29,44,59 * * * *'); // (2*7)%15 = 14
  assert.equal(cronExprForInterval(30, 7), '19,49 * * * *');       // (7*7)%30 = 19
  assert.equal(cronExprForInterval(20, 5), '15,35,55 * * * *');    // (5*7)%20 = 15
  assert.equal(cronExprForInterval(20, 3), '1,21,41 * * * *');     // (3*7)%20 = 1
  assert.equal(cronExprForInterval(25, 3), '6,21,36,51 * * * *');  // normalized to 15m: (3*7)%15 = 6
  assert.equal(cronExprForInterval(10, 2), '14,29,44,59 * * * *'); // clamped to minimum 15m
  // offset 0 keeps the plain step form
  assert.equal(cronExprForInterval(15, 15), '*/15 * * * *'); // (15*7)%15 = 0
  assert.equal(cronExprForInterval(30, 0), '*/30 * * * *');
  // hourly+: minute = (id*7) % 60, hour step unchanged
  assert.equal(cronExprForInterval(360, 4), '28 */6 * * *');
  assert.equal(cronExprForInterval(1440, 2), '14 */24 * * *');
  assert.equal(cronExprForInterval(200, 5), '35 */3 * * *'); // 200min -> 3.3h -> 3h
  assert.equal(cronExprForInterval(90, 0), '0 */2 * * *');   // 90min -> 1.5h -> rounds to 2h
});

test('cron: two pairs sharing an interval get different minute anchors', () => {
  const minuteFieldOf = (interval, id) => cronExprForInterval(interval, id).split(' ')[0];
  for (const interval of [15, 20, 30, 60, 90, 360, 1440]) {
    assert.notEqual(minuteFieldOf(interval, 1), minuteFieldOf(interval, 2), `interval ${interval}: ids 1 vs 2`);
    assert.notEqual(minuteFieldOf(interval, 3), minuteFieldOf(interval, 4), `interval ${interval}: ids 3 vs 4`);
    assert.notEqual(minuteFieldOf(interval, 8), minuteFieldOf(interval, 9), `interval ${interval}: ids 8 vs 9`);
  }
});

test('cron: live set (pair ids 2..9 at 15/30-min intervals) has pairwise disjoint anchors', () => {
  const live = [
    { id: 2, interval: 15 }, { id: 3, interval: 30 },
    { id: 4, interval: 15 }, { id: 5, interval: 30 },
    { id: 6, interval: 15 }, { id: 7, interval: 30 },
    { id: 8, interval: 15 }, { id: 9, interval: 30 },
  ];
  const anchorSets = live.map(({ id, interval }) =>
    cronExprForInterval(interval, id).split(' ')[0].split(',').map(Number));
  for (let i = 0; i < anchorSets.length; i += 1) {
    for (let j = i + 1; j < anchorSets.length; j += 1) {
      for (const minute of anchorSets[i]) {
        assert.ok(!anchorSets[j].includes(minute), `pairs ${live[i].id} and ${live[j].id} both fire at :${minute}`);
      }
    }
  }
  // every sub-hourly pair fires exactly 60/interval times per hour
  anchorSets.forEach((set, idx) => assert.equal(set.length, 60 / live[idx].interval));
});
