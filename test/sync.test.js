// Sync engine tests: full plan->import->delete flow against a fake Google
// client and an in-memory SQLite database (no network anywhere).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../lib/db.js';
import { createSyncEngine } from '../lib/sync.js';
import { parseFeed, toGoogleEvent } from '../lib/icalparse.js';
import { planSync } from '../lib/planner.js';
import { cronExprForInterval } from '../lib/scheduler.js';
import { FIXED_NOW_MS, icsFor, veventFor } from './helpers.js';

const NOW_ISO = '2026-11-11T12:00:00.000Z';

function makeGoogle({ failImportUids = [], failAllWith = null, failDeletesFor = [] } = {}) {
  const calls = { imports: [], deletes: [], calendarsCreated: [], calendarLists: 0 };
  return {
    calls,
    client: {
      async importEvent(calendarId, gEvent) {
        if (failAllWith) {
          const err = new Error(failAllWith);
          err.status = failAllWith.includes('401') ? 401 : 500;
          throw err;
        }
        if (failImportUids.includes(gEvent.iCalUID)) {
          const err = new Error('429 backend error');
          err.status = 429;
          throw err;
        }
        calls.imports.push([calendarId, gEvent]);
      },
      async deleteAllByUid(calendarId, uid) {
        if (failDeletesFor.includes(uid)) throw new Error('delete boom');
        calls.deletes.push([calendarId, uid]);
        return 1;
      },
      async listCalendars() {
        calls.calendarLists += 1;
        return [{ id: 'cal-1', summary: 'My Target' }];
      },
      async createCalendar(name) {
        calls.calendarsCreated.push(name);
        return { id: `created-${name}`, summary: name };
      },
    },
  };
}

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

test('first run imports in-window events and records them', async () => {
  const db = await openDatabase(':memory:');
  const pair = db.createPair({ name: 'P1', feed_url: 'https://feed.example/cal.ics', calendar_id: 'cal-target', interval_minutes: 360 });
  const holder = makeGoogle();
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
  assert.deepEqual(db.listSyncedUids(pair.id).sort(), ['evt-a', 'evt-b']);
  const status = db.getStatus(pair.id);
  assert.equal(status.last_status, 'success');
  assert.ok(status.last_success_at);
  db.close();
});

test('second run with a shrunk feed imports changes and deletes vanished events', async () => {
  const db = await openDatabase(':memory:');
  const pair = db.createPair({ name: 'P1', feed_url: 'x', calendar_id: 'cal-target', interval_minutes: 360 });
  const holder = makeGoogle();
  const engine = makeEngine(db, holder);
  await engine.runPair(pair.id, { trigger: 'initial' });

  const engine2 = makeEngine(db, holder, { fetchFeedImpl: async () => ({ text: FEED2, finalUrl: 'x', status: 200 }) });
  const result = await engine2.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(result.status, 'success');
  // feed membership diff: tracked {evt-a, evt-b} vs feed {evt-a, evt-c}
  assert.deepEqual(holder.calls.deletes, [['cal-target', 'evt-b']]);
  assert.deepEqual(db.listSyncedUids(pair.id).sort(), ['evt-a', 'evt-c']);
  assert.ok(holder.calls.imports.some(([, g]) => g.iCalUID === 'evt-c'), 'new event imported (import is an upsert)');
  db.close();
});

test('cancelled events are removed from the target calendar, not imported', async () => {
  const feed = icsFor([
    veventFor(['UID:evt-x', 'DTSTART:20261115T090000Z', 'SUMMARY:X']),
    veventFor(['UID:evt-gone', 'DTSTART:20261116T090000Z', 'SUMMARY:cancelled one', 'STATUS:CANCELLED']),
  ]);
  const db = await openDatabase(':memory:');
  const pair = db.createPair({ name: 'P', feed_url: 'x', calendar_id: 'c', interval_minutes: 360 });
  // Pre-tracked uid that will show up as cancelled in the feed
  db.upsertSyncedEvent(pair.id, 'evt-gone', NOW_ISO);
  const holder = makeGoogle();
  const engine = makeEngine(db, holder, { fetchFeedImpl: async () => ({ text: feed, finalUrl: 'x', status: 200 }) });
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
  const holder = makeGoogle({ failAllWith: '401 invalid credentials' });
  const engine = makeEngine(db, holder, { fetchFeedImpl: async () => ({ text: FEED1, finalUrl: 'x', status: 200 }) });
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
  const holder = makeGoogle({ failImportUids: ['evt-b'] });
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
  const holder = makeGoogle();
  const engine = makeEngine(db, holder, { fetchFeedImpl: async () => { throw new Error('feed down'); } });
  const result = await engine.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(result.status, 'error');
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
  const holder = makeGoogle();
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

test('cronExprForInterval: minutes, hours with jitter, clamping', () => {
  assert.equal(cronExprForInterval(15, 3), '*/15 * * * *');
  assert.equal(cronExprForInterval(30, 0), '*/30 * * * *');
  assert.equal(cronExprForInterval(360, 4), '4 */6 * * *');
  assert.equal(cronExprForInterval(1440, 2), '2 */24 * * *');
  assert.equal(cronExprForInterval(200, 5), '5 */3 * * *'); // 200min -> 3.3h -> 3h
  assert.equal(cronExprForInterval(25, 1), '*/15 * * * *'); // normalized to a divisor of 60
  assert.equal(cronExprForInterval(10, 2), '*/15 * * * *'); // clamped to minimum 15m
  assert.equal(cronExprForInterval(90, 0), '0 */2 * * *'); // 90min -> 1.5h -> rounds to 2h
});
