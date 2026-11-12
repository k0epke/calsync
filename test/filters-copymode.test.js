// Tier 1 feature tests: per-pair event filters (+ db migration + engine
// semantics incl. the deletion-sweep interaction) and privacy copy modes on
// BOTH target adapters with hash-after-transform stability. Everything
// mocked: Google at the client boundary, CalDAV at the fetchImpl boundary,
// SQLite in memory. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../lib/db.js';
import { createSyncEngine } from '../lib/sync.js';
import {
  normalizeEventFiltersInput, storedFiltersJson, safeParseStoredEventFilters,
  eventMatchesFilters, applyEventFilters,
} from '../lib/filters.js';
import { COPY_MODES, normalizeCopyMode, applyCopyMode } from '../lib/copymode.js';
import { parseFeed, toGoogleEvent, contentHashOf, canonicalEventHash } from '../lib/icalparse.js';
import { planSync } from '../lib/planner.js';
import { createIcloudCalDavClient } from '../lib/caldav.js';
import { FIXED_NOW_MS, icsFor, veventFor, makeGoogleMock, makeCaldavWriteMock } from './helpers.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const testConfig = {
  pushDelayMs: 0, maxFeedBytes: 1024 * 1024, fetchTimeoutMs: 5000,
  windowPastDays: 30, windowFutureDays: 365,
};

const FEED1 = icsFor([
  veventFor(['UID:evt-a', 'DTSTART:20261115T090000Z', 'DTEND:20261115T093000Z', 'SUMMARY:Standup meeting',
    'DESCRIPTION:Daily sync talk', 'LOCATION:Room 4']),
  veventFor(['UID:evt-b', 'DTSTART:20261116T090000Z', 'DTEND:20261116T100000Z', 'SUMMARY:Gym session',
    'DESCRIPTION:Lifting', 'LOCATION:Basement']),
]);
const FAR_FEED = icsFor([
  veventFor(['UID:evt-a', 'DTSTART:20261115T090000Z', 'DTEND:20261115T093000Z', 'SUMMARY:Standup meeting']),
  veventFor(['UID:evt-b', 'DTSTART:20261116T090000Z', 'DTEND:20261116T100000Z', 'SUMMARY:Gym session']),
  veventFor(['UID:evt-c', 'DTSTART:20261117T090000Z', 'DTEND:20261117T100000Z', 'SUMMARY:Standup far away']),
  veventFor(['UID:evt-far', 'DTSTART:20290101T090000Z', 'DTEND:20290101T100000Z', 'SUMMARY:Standup in 2029']),
]);
const ALLDAY_FEED = icsFor([
  veventFor(['UID:evt-day', 'DTSTART;VALUE=DATE:20261201', 'DTEND;VALUE=DATE:20261202', 'SUMMARY:All day thing', 'LOCATION:Somewhere']),
]);

const feedResponse = (text) => async () => ({ text, finalUrl: 'x', status: 200 });

function makeEngine(db, { googleFactory = () => null, icloudFactory = () => null, fetchFeedImpl, alerts = null } = {}) {
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
    alerts,
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
// lib/filters.js: normalization, validation, matching
// ---------------------------------------------------------------------------

test('normalizeEventFiltersInput: null/empty -> no filter, trims keywords, object and JSON string forms', () => {
  assert.equal(normalizeEventFiltersInput(null), null);
  assert.equal(normalizeEventFiltersInput(undefined), null);
  assert.equal(normalizeEventFiltersInput(''), null);
  assert.equal(normalizeEventFiltersInput({}), null, 'empty object = no filter');
  assert.equal(normalizeEventFiltersInput({ include: [] }), null);
  assert.deepEqual(normalizeEventFiltersInput({ include: ['  Gym '], exclude: ['x', ' y'] }),
    { include: ['Gym'], exclude: ['x', 'y'] });
  assert.deepEqual(normalizeEventFiltersInput({ include: ['a'], exclude: null }), { include: ['a'], exclude: null });
  assert.deepEqual(normalizeEventFiltersInput('{"include":["standup"]}'), { include: ['standup'], exclude: null },
    'stored JSON string form parses');
  assert.deepEqual(storedFiltersJson({ include: [' Gym '] }), '{"include":["Gym"]}');
  assert.equal(storedFiltersJson(null), null);
  assert.equal(storedFiltersJson({}), null);
});

test('normalizeEventFiltersInput: malformed JSON and bad shapes throw CLEAR save-time errors', () => {
  assert.throws(() => normalizeEventFiltersInput('not json'), /Pair filters: malformed JSON/);
  assert.throws(() => normalizeEventFiltersInput('{"include":'), /Pair filters: malformed JSON/);
  assert.throws(() => normalizeEventFiltersInput([1, 2]), /Pair filters: expected an object/);
  assert.throws(() => normalizeEventFiltersInput('42'), /Pair filters: expected an object/);
  assert.throws(() => normalizeEventFiltersInput({ include: [], bogus: 1 }), /unexpected key\(s\) bogus/);
  assert.throws(() => normalizeEventFiltersInput({ include: 'x' }), /"include" must be an array/);
  assert.throws(() => normalizeEventFiltersInput({ include: [5] }), /must contain only strings/);
  assert.throws(() => normalizeEventFiltersInput({ include: ['  '] }), /must not contain empty keywords/);
  assert.throws(() => normalizeEventFiltersInput({ exclude: ['x'.repeat(201)] }), /longer than 200 chars/);
  assert.throws(() => normalizeEventFiltersInput({ include: Array.from({ length: 26 }, (_, i) => `k${i}`) }),
    /more than 25 keywords/);
});

test('eventMatchesFilters + applyEventFilters: case-insensitive substring, include-OR, exclude-AND, missing summary', () => {
  const ev = (summary) => ({ uid: 'u', summary });
  const f = normalizeEventFiltersInput({ include: ['Standup'], exclude: ['far'] });
  assert.equal(eventMatchesFilters(ev('Standup meeting'), f), true);
  assert.equal(eventMatchesFilters(ev('weekly standup'), f), true, 'case-insensitive');
  assert.equal(eventMatchesFilters(ev('Standup far away'), f), false, 'exclude wins');
  assert.equal(eventMatchesFilters(ev('Gym'), f), false, 'no include keyword hit');
  assert.equal(eventMatchesFilters({ uid: 'u' }, f), false, 'summary-less event with include list');
  assert.equal(eventMatchesFilters({ uid: 'u' }, normalizeEventFiltersInput({ exclude: ['x'] })), true,
    'no include list: summary-less events pass');
  const res = applyEventFilters([ev('Standup'), ev('Gym'), ev('Standup far')], f);
  assert.deepEqual(res.events.map((e) => e.summary), ['Standup']);
  assert.equal(res.dropped, 2);
  assert.deepEqual(applyEventFilters([ev('A')], null), { events: [ev('A')], dropped: 0 }, 'no filter passthrough');
  assert.equal(safeParseStoredEventFilters('not json'), null, 'display-side parse never throws');
  assert.equal(safeParseStoredEventFilters(null), null);
});

// ---------------------------------------------------------------------------
// db layer: migration columns + create/update validation
// ---------------------------------------------------------------------------

test('pairs migrate with filters/copy_mode columns; create/update validate at the boundary', async () => {
  const db = await openDatabase(':memory:');
  const cols = db._raw.prepare("SELECT name FROM pragma_table_info('pairs')").all().map((r) => String(r.name));
  assert.ok(cols.includes('filters'), 'filters column present');
  assert.ok(cols.includes('copy_mode'), 'copy_mode column present');

  const p1 = db.createPair({ name: 'P1', feed_url: 'https://f/x.ics', calendar_id: 'c', interval_minutes: 60 });
  assert.equal(p1.filters, null, 'default = no filter');
  assert.equal(p1.copy_mode, 'full', 'default copy mode');

  const p2 = db.createPair({
    name: 'P2', feed_url: 'x', calendar_id: 'c', interval_minutes: 60,
    filters: { include: [' Gym '], exclude: ['Lunch'] }, copy_mode: 'busy',
  });
  assert.deepEqual(JSON.parse(p2.filters), { include: ['Gym'], exclude: ['Lunch'] });
  assert.equal(p2.copy_mode, 'busy');

  // updatePair: undefined = unchanged, null clears, object stores JSON,
  // junk copy_mode normalizes to full, junk filters throw CLEAR error.
  db.updatePair(p2.id, { name: 'P2 renamed' });
  assert.deepEqual(JSON.parse(db.getPair(p2.id).filters), { include: ['Gym'], exclude: ['Lunch'] }, 'patch without filters key keeps filters');
  db.updatePair(p2.id, { filters: null });
  assert.equal(db.getPair(p2.id).filters, null, 'explicit null clears');
  db.updatePair(p2.id, { filters: '{"include":["a"]}', copy_mode: 'generic' });
  assert.deepEqual(JSON.parse(db.getPair(p2.id).filters), { include: ['a'] });
  assert.equal(db.getPair(p2.id).copy_mode, 'generic');
  db.updatePair(p2.id, { copy_mode: 'weird' });
  assert.equal(db.getPair(p2.id).copy_mode, 'full', 'junk copy_mode normalizes to full');
  db.updatePair(p2.id, { copy_mode: 'busy' });
  assert.equal(db.getPair(p2.id).copy_mode, 'busy');
  assert.throws(() => db.updatePair(p2.id, { filters: 'not json' }), /Pair filters: malformed JSON/,
    'malformed JSON fails loudly at save time');
  assert.throws(() => db.createPair({ name: 'x', feed_url: 'x', calendar_id: 'c', interval_minutes: 60, filters: { include: 5 } }),
    /Pair filters:/);
  db.close();
});

test('legacy one-way database gains filters/copy_mode via guarded ALTERs, rows read as no-filter/full', async () => {
  const dbPath = path.join(os.tmpdir(), `calsync-tier1-migrate-${Date.now()}-${Math.floor(Math.random() * 1e9)}.sqlite`);
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE pairs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      feed_url TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'url' CHECK (source_type IN ('url','caldav')),
      calendar_id TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL DEFAULT 360 CHECK (interval_minutes >= 15),
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE synced_events (
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
  const db = await openDatabase(dbPath);
  const pair = db.getPair(1);
  assert.equal(pair.name, 'Legacy');
  assert.equal(pair.filters, null, 'legacy row = no filter');
  assert.equal(pair.copy_mode, 'full', 'legacy row = full copy mode');
  const p2 = db.createPair({ name: 'New', feed_url: 'https://f/y.ics', calendar_id: 'c', interval_minutes: 60, copy_mode: 'generic' });
  assert.equal(p2.copy_mode, 'generic');
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
});

// ---------------------------------------------------------------------------
// Engine: filter ordering, semantics, and the deletion-sweep interaction
// ---------------------------------------------------------------------------

test('url source + include filter: only matching events reach the target; filtered count lands in run detail', async () => {
  const db = await openDatabase(':memory:');
  const holder = makeGoogleMock();
  const engine = makeEngine(db, { googleFactory: () => holder.client });
  const pair = db.createPair({
    name: 'P', feed_url: 'https://feed.example/cal.ics', calendar_id: 'cal-target', interval_minutes: 60,
    filters: { include: ['standup'] },
  });
  const r = await engine.runPair(pair.id, { trigger: 'initial' });
  assert.equal(r.status, 'success');
  assert.equal(r.log.fetched, 2, 'fetched counts RAW source events (before filters)');
  assert.equal(r.log.filtered, 1, 'evt-b (Gym) dropped by the include filter');
  assert.deepEqual(holder.calls.imports.map(([, g]) => g.iCalUID), ['evt-a']);
  const detail = JSON.parse(db.listRuns(pair.id)[0].detail);
  assert.equal(detail.filtered, 1, 'filtered recorded in run-log detail');
  assert.deepEqual(db.listSyncedUids(pair.id), ['evt-a']);
  db.close();
});

test('pinned order: FILTERS run BEFORE the window (out-of-window+excluded counts as filtered, not skipped)', async () => {
  const db = await openDatabase(':memory:');
  const holder = makeGoogleMock();
  const engine = makeEngine(db, {
    googleFactory: () => holder.client,
    fetchFeedImpl: feedResponse(FAR_FEED),
  });
  const pair = db.createPair({
    name: 'P', feed_url: 'https://feed.example/cal.ics', calendar_id: 'cal-target', interval_minutes: 60,
    filters: { include: ['standup'], exclude: ['far'] },
  });
  const r = await engine.runPair(pair.id, { trigger: 'initial' });
  assert.equal(r.status, 'success');
  // evt-a kept and imported; evt-b dropped by the include list, evt-c dropped
  // by the exclude list (both at the FILTER stage), evt-far passes the filters
  // ("far" is not a substring of "Standup in 2029") and is then dropped by
  // the WINDOW -> skipped. That attribution proves the pinned order:
  // FILTERS run BEFORE windowing.
  assert.equal(r.log.fetched, 4);
  assert.equal(r.log.filtered, 2, 'gym (include miss) + standup-far-away (exclude hit) removed at the FILTER stage');
  assert.equal(r.log.skipped, 1, 'evt-far passes filters, is then dropped by the window');
  assert.equal(r.log.imported, 1, 'evt-a passes filters AND window');
  assert.deepEqual(holder.calls.imports.map(([, g]) => g.iCalUID), ['evt-a']);
  db.close();
});

test('caldav source: exclude filter drops matching events before planning (google target)', async () => {
  const db = await openDatabase(':memory:');
  const CAL_SEEDS = [
    { uid: 'evt-a', ics: icsFor([veventFor(['UID:evt-a', 'DTSTART:20261115T090000Z', 'DTEND:20261115T093000Z', 'SUMMARY:Standup meeting'])]) },
    { uid: 'evt-b', ics: icsFor([veventFor(['UID:evt-b', 'DTSTART:20261116T090000Z', 'DTEND:20261116T100000Z', 'SUMMARY:Gym session'])]) },
  ];
  const xMock = makeCaldavWriteMock({ seeds: CAL_SEEDS });
  const holder = makeGoogleMock();
  const engine = makeEngine(db, {
    googleFactory: () => holder.client,
    icloudFactory: () => makeIcloudClient(xMock),
  });
  const pair = db.createPair({
    name: 'P', feed_url: 'caldav://caldav.icloud.com/123/calendars/home/', source_type: 'caldav',
    calendar_id: 'cal-target', interval_minutes: 60,
    filters: { exclude: ['gym'] },
  });
  const r = await engine.runPair(pair.id, { trigger: 'initial' });
  assert.equal(r.status, 'success');
  assert.equal(r.log.fetched, 2);
  assert.equal(r.log.filtered, 1);
  assert.deepEqual(holder.calls.imports.map(([, g]) => g.iCalUID), ['evt-a'], 'only the non-excluded event synced');
  assert.deepEqual(db.listSyncedUids(pair.id), ['evt-a']);
  db.close();
});

test('google source: filters apply to the google:// source snapshot too', async () => {
  const db = await openDatabase(':memory:');
  const xMock = makeCaldavWriteMock();
  const gHolder = makeGoogleMock({
    seedEvents: [
      { calendarId: 'g-src', iCalUID: 'evt-ok', id: 'g1', summary: 'Standup', start: { dateTime: '2026-11-15T09:00:00Z' } },
      { calendarId: 'g-src', iCalUID: 'evt-no', id: 'g2', summary: 'Gym', start: { dateTime: '2026-11-16T09:00:00Z' } },
    ],
  });
  const engine = makeEngine(db, {
    googleFactory: () => gHolder.client,
    icloudFactory: () => makeIcloudClient(xMock),
  });
  const pair = db.createPair({
    name: 'g->x', feed_url: 'google://g-src', source_type: 'google',
    calendar_id: '', target_type: 'caldav', target_url: 'caldav://caldav.icloud.com/123/calendars/home/', interval_minutes: 60,
    filters: { include: ['standup'] },
  });
  const r = await engine.runPair(pair.id, { trigger: 'initial' });
  assert.equal(r.status, 'success');
  assert.equal(r.log.filtered, 1);
  assert.deepEqual(xMock.store.uids(), ['evt-ok']);
  db.close();
});

test('flipping filters prunes previously-imported excluded events via the deletion sweep', async () => {
  const db = await openDatabase(':memory:');
  const holder = makeGoogleMock();
  const engine = makeEngine(db, { googleFactory: () => holder.client });
  const pair = db.createPair({ name: 'P', feed_url: 'x', calendar_id: 'cal-target', interval_minutes: 60 });
  const r1 = await engine.runPair(pair.id, { trigger: 'initial' });
  assert.equal(r1.status, 'success');
  assert.deepEqual(db.listSyncedUids(pair.id).sort(), ['evt-a', 'evt-b']);

  // Flip: exclude the Gym event that was already imported.
  db.updatePair(pair.id, { filters: { exclude: ['gym'] } });
  const r2 = await engine.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(r2.status, 'success');
  assert.deepEqual(holder.calls.deletes, [['cal-target', 'evt-b']],
    'deletion planner operated on the FILTERED snapshot: evt-b (excluded) is swept');
  assert.deepEqual(holder.calls.imports.slice(2), [], 'evt-a unchanged, no re-import');
  assert.deepEqual(db.listSyncedUids(pair.id), ['evt-a']);
  assert.equal(r2.log.deleted, 1);
  db.close();
});

test('a stored filters value that no longer parses degrades to no-filter with a run warning', async () => {
  const db = await openDatabase(':memory:');
  const holder = makeGoogleMock();
  const engine = makeEngine(db, { googleFactory: () => holder.client });
  const pair = db.createPair({ name: 'P', feed_url: 'x', calendar_id: 'cal-target', interval_minutes: 60 });
  db._raw.prepare('UPDATE pairs SET filters = ? WHERE id = ?').run('not json at all', pair.id);
  const r = await engine.runPair(pair.id, { trigger: 'manual' });
  assert.equal(r.status, 'success', 'junk stored filters never fail the sync');
  assert.equal(r.log.imported, 2, 'both events imported (no filter applied)');
  assert.ok(r.log.warnings.some((w) => /Pair filters ignored/.test(w)), 'run warning explains the degradation');
  db.close();
});

// ---------------------------------------------------------------------------
// Engine: privacy copy modes on BOTH targets, hash-after-transform stability
// ---------------------------------------------------------------------------

test('copy modes: normalization contract (full/busy/generic, junk -> full, full passthrough)', () => {
  assert.deepEqual(COPY_MODES, ['full', 'busy', 'generic']);
  for (const m of COPY_MODES) assert.equal(normalizeCopyMode(m), m);
  assert.equal(normalizeCopyMode('weird'), 'full');
  assert.equal(normalizeCopyMode(undefined), 'full');
  const ev = { uid: 'u', summary: 'Secret standup', description: 'd', location: 'l', start: { dateTime: '2026-11-15T09:00:00Z' }, end: { dateTime: '2026-11-15T09:30:00Z' } };
  assert.equal(applyCopyMode(ev, 'full', 'P'), ev, 'full returns the SAME object (byte-identical passthrough)');
  assert.deepEqual(applyCopyMode(ev, 'busy', 'P'), { ...ev, summary: 'Busy', description: '', location: '' });
  assert.deepEqual(applyCopyMode(ev, 'generic', 'My pair'), { ...ev, summary: 'My pair', description: '', location: '' });
  assert.deepEqual(applyCopyMode(ev, 'generic', '   '), { ...ev, summary: 'Event', description: '', location: '' },
    'empty pair name falls back to a generic label');
});

test('Google target busy mode: masked import, and the SECOND run is zero-write (hash-after-transform)', async () => {
  const db = await openDatabase(':memory:');
  const holder = makeGoogleMock();
  const engine = makeEngine(db, { googleFactory: () => holder.client });
  const pair = db.createPair({ name: 'P', feed_url: 'x', calendar_id: 'cal-target', interval_minutes: 60, copy_mode: 'busy' });
  const r1 = await engine.runPair(pair.id, { trigger: 'initial' });
  assert.equal(r1.status, 'success');
  assert.equal(holder.calls.imports.length, 2);
  for (const [, g] of holder.calls.imports) {
    assert.equal(g.summary, 'Busy', 'masked summary');
    assert.ok(!('description' in g) && !('location' in g), 'description/location stripped');
    assert.ok(g.start && g.end, 'times preserved');
    assert.equal(g.status, 'confirmed');
  }
  const r2 = await engine.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(r2.status, 'success');
  assert.equal(r2.log.imported, 0, 'stored hash was computed AFTER the transform -> matches on rerun');
  assert.equal(r2.log.unchanged, 2);
  assert.equal(holder.calls.imports.length, 2, 'zero-write steady state for masked pairs');
  db.close();
});

test('Google target generic mode: summary is the pair name, times preserved, zero-write rerun', async () => {
  const db = await openDatabase(':memory:');
  const holder = makeGoogleMock();
  const engine = makeEngine(db, { googleFactory: () => holder.client });
  const pair = db.createPair({ name: 'My Private Pair', feed_url: 'x', calendar_id: 'cal-target', interval_minutes: 60, copy_mode: 'generic' });
  const r1 = await engine.runPair(pair.id, { trigger: 'initial' });
  assert.equal(r1.status, 'success');
  for (const [, g] of holder.calls.imports) {
    assert.equal(g.summary, 'My Private Pair');
    assert.ok(!('description' in g) && !('location' in g));
  }
  const r2 = await engine.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(r2.log.imported, 0);
  assert.equal(r2.log.unchanged, 2, 'stable zero-write state');
  assert.equal(holder.calls.imports.length, 2);
  db.close();
});

test('Google target full mode is byte-identical to the pre-feature import path', async () => {
  const db = await openDatabase(':memory:');
  const holder = makeGoogleMock();
  const engine = makeEngine(db, { googleFactory: () => holder.client });
  const pair = db.createPair({ name: 'P', feed_url: 'x', calendar_id: 'cal-target', interval_minutes: 60, copy_mode: 'full' });
  const r1 = await engine.runPair(pair.id, { trigger: 'initial' });
  assert.equal(r1.status, 'success');
  const feed = parseFeed(FEED1);
  const storedHashes = db.listSyncedEventHashes(pair.id);
  for (const [i, ev] of feed.events.entries()) {
    const [, g] = holder.calls.imports[i];
    assert.deepEqual(g, toGoogleEvent(ev), 'import payload identical to plain toGoogleEvent(event)');
    assert.equal(storedHashes.get(ev.uid), contentHashOf(toGoogleEvent(ev)), 'stored hash = hash of the plain toGoogleEvent output (unchanged hash path)');
  }
  assert.match(holder.store.findByUid('cal-target', 'evt-a').description, /Daily sync talk/, 'details intact');
  const r2 = await engine.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(r2.log.unchanged, 2, 'legacy skip-unchanged behavior untouched');
  db.close();
});

test('CalDAV target busy mode: masked PUT payload, and the SECOND run is zero-write', async () => {
  const db = await openDatabase(':memory:');
  const xMock = makeCaldavWriteMock();
  const engine = makeEngine(db, { icloudFactory: () => makeIcloudClient(xMock) });
  const pair = db.createPair({
    name: 'P', feed_url: 'https://feed.example/cal.ics', source_type: 'url',
    calendar_id: '', target_type: 'caldav', target_url: 'caldav://caldav.icloud.com/123/calendars/home/', interval_minutes: 60,
    copy_mode: 'busy',
  });
  const r1 = await engine.runPair(pair.id, { trigger: 'initial' });
  assert.equal(r1.status, 'success');
  assert.equal(xMock.calls.puts.length, 2);
  for (const uid of ['evt-a', 'evt-b']) {
    const ics = xMock.store.icsOf(uid);
    assert.match(ics, /SUMMARY:Busy/);
    assert.doesNotMatch(ics, /DESCRIPTION/);
    assert.doesNotMatch(ics, /LOCATION/);
    assert.match(ics, new RegExp(`DTSTART:${uid === 'evt-a' ? '20261115T090000Z' : '20261116T090000Z'}`), 'times preserved');
  }
  const r2 = await engine.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(r2.status, 'success');
  assert.equal(r2.log.imported, 0, 'canonical hash of the masked write equals the parsed-back remote copy');
  assert.equal(r2.log.unchanged, 2);
  assert.equal(xMock.calls.puts.length, 2, 'zero PUTs on rerun - masked writes are stable');
  db.close();
});

test('CalDAV target generic mode: pair-name summary, all-day events keep DATE form, zero-write rerun', async () => {
  const db = await openDatabase(':memory:');
  const xMock = makeCaldavWriteMock();
  const engine = makeEngine(db, {
    icloudFactory: () => makeIcloudClient(xMock),
    fetchFeedImpl: feedResponse(ALLDAY_FEED),
  });
  const pair = db.createPair({
    name: 'Day Pair', feed_url: 'https://feed.example/cal.ics', source_type: 'url',
    calendar_id: '', target_type: 'caldav', target_url: 'caldav://caldav.icloud.com/123/calendars/home/', interval_minutes: 60,
    copy_mode: 'generic',
  });
  const r1 = await engine.runPair(pair.id, { trigger: 'initial' });
  assert.equal(r1.status, 'success');
  const ics = xMock.store.icsOf('evt-day');
  assert.match(ics, /SUMMARY:Day Pair/);
  assert.doesNotMatch(ics, /LOCATION/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261201/, 'all-day flag preserved');
  const r2 = await engine.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(r2.log.imported, 0);
  assert.equal(r2.log.unchanged, 1);
  assert.equal(xMock.calls.puts.length, 1);
  db.close();
});

test('copy mode + filters compose end-to-end: filtered import masked, then fully converged', async () => {
  const db = await openDatabase(':memory:');
  const holder = makeGoogleMock();
  const engine = makeEngine(db, { googleFactory: () => holder.client });
  const pair = db.createPair({
    name: 'Combo', feed_url: 'https://feed.example/cal.ics', calendar_id: 'cal-target', interval_minutes: 60,
    filters: { include: ['standup'] }, copy_mode: 'busy',
  });
  const r1 = await engine.runPair(pair.id, { trigger: 'initial' });
  assert.equal(r1.status, 'success');
  assert.deepEqual(holder.calls.imports.map(([, g]) => g.iCalUID), ['evt-a']);
  assert.equal(holder.calls.imports[0][1].summary, 'Busy');
  const r2 = await engine.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(r2.log.imported, 0);
  assert.equal(r2.log.filtered, 1, 'filter still drops gym each run');
  assert.equal(r2.log.unchanged, 1);
  db.close();
});

test('canonical hash sanity: a masked event and its parsed-back CalDAV copy normalize EQUAL', () => {
  const ev = parseFeed(FEED1).events[0];
  const masked = applyCopyMode(ev, 'busy', 'P');
  const putIcs = icsFor([veventFor([
    'UID:evt-a', 'DTSTART:20261115T090000Z', 'DTEND:20261115T093000Z', 'SUMMARY:Busy', 'STATUS:CONFIRMED',
  ])]);
  const parsedBack = parseFeed(putIcs).events[0];
  assert.equal(canonicalEventHash(parsedBack), canonicalEventHash(masked),
    'hash-after-transform is what makes the masked write converge');
});
