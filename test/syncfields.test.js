// Per-pair "Fields to sync" feature tests: lib/syncfields.js contract, the
// db migration + save-time validation, the write-time field mask on BOTH
// target adapters (Google events.import payload + CalDAV PUT props) layered
// AFTER the copy-mode transform, hash-after-full-chain zero-write stability
// for every mask shape, and the dashboard form render + checkbox mapping.
// Everything mocked: Google at the client boundary, CalDAV at the fetchImpl
// boundary, SQLite in memory. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../lib/db.js';
import { createSyncEngine } from '../lib/sync.js';
import {
  normalizeSyncFieldsInput, storedSyncFieldsJson, safeParseStoredSyncFields,
  applyFieldMask, syncFieldMaskFromForm,
} from '../lib/syncfields.js';
import { applyCopyMode } from '../lib/copymode.js';
import { parseFeed, toGoogleEvent, contentHashOf, canonicalEventHash } from '../lib/icalparse.js';
import { planSync } from '../lib/planner.js';
import { createIcloudCalDavClient, putEventBody } from '../lib/caldav.js';
import { renderPairForm } from '../lib/render.js';
import { FIXED_NOW_MS, icsFor, veventFor, makeGoogleMock, makeCaldavWriteMock } from './helpers.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const testConfig = {
  pushDelayMs: 0, maxFeedBytes: 1024 * 1024, fetchTimeoutMs: 5000,
  windowPastDays: 30, windowFutureDays: 365,
};

// Both events carry description AND location so every mask shape is
// observable.
const FEED1 = icsFor([
  veventFor(['UID:evt-a', 'DTSTART:20261115T090000Z', 'DTEND:20261115T093000Z', 'SUMMARY:Standup meeting',
    'DESCRIPTION:Daily sync talk', 'LOCATION:Room 4']),
  veventFor(['UID:evt-b', 'DTSTART:20261116T090000Z', 'DTEND:20261116T100000Z', 'SUMMARY:Gym session',
    'DESCRIPTION:Lifting', 'LOCATION:Basement']),
]);

// Every mask shape the checkboxes can produce (stored subset form). The
// engine must reach a zero-write steady state for EVERY shape on BOTH
// adapters.
const MASK_SHAPES = [
  { label: 'strip-description-only', json: '{"description":false}' },
  { label: 'strip-location-only', json: '{"location":false}' },
  { label: 'strip-both', json: '{"description":false,"location":false}' },
];

const feedResponse = (text) => async () => ({ text, finalUrl: 'https://feed.example/cal.ics', status: 200 });

function makeEngine(db, { googleFactory = () => null, icloudFactory = () => null, fetchFeedImpl } = {}) {
  return createSyncEngine({
    db,
    config: testConfig,
    logger: silentLogger,
    googleFactory,
    icloudFactory,
    fetchFeedImpl: fetchFeedImpl ?? feedResponse(FEED1),
    parseFeedImpl: parseFeed,
    planSyncImpl: planSync,
    clock: { now: () => FIXED_NOW_MS },
    delayFn: async () => {},
  });
}

function makeIcloudClient(mock) {
  return createIcloudCalDavClient({
    username: 'owner@example.com',
    appPassword: 'abcd-e...mnop',
    fetchImpl: mock.fetchImpl,
    baseDelayMs: 10,
    timeoutMs: 5000,
    maxRetries: 3,
    sleepFn: async () => {},
  });
}

// ---------------------------------------------------------------------------
// lib/syncfields.js: normalization, validation, storage, form mapping
// ---------------------------------------------------------------------------

test('normalizeSyncFieldsInput: null/empty/{}/all-true -> all fields (null); missing keys default true; stored JSON string parses', () => {
  assert.equal(normalizeSyncFieldsInput(null), null);
  assert.equal(normalizeSyncFieldsInput(undefined), null);
  assert.equal(normalizeSyncFieldsInput(''), null);
  assert.equal(normalizeSyncFieldsInput('   '), null);
  assert.equal(normalizeSyncFieldsInput({}), null, 'empty object strips nothing = all fields (stored as clean NULL)');
  assert.equal(normalizeSyncFieldsInput({ description: true, location: true }), null, 'all-true = all fields');
  assert.equal(normalizeSyncFieldsInput('{"description":true}'), null, 'explicit true-only mask normalizes to all fields');
  assert.deepEqual(normalizeSyncFieldsInput({ description: false }), { description: false, location: true },
    'missing key defaults to synced');
  assert.deepEqual(normalizeSyncFieldsInput({ location: false }), { description: true, location: false });
  assert.deepEqual(normalizeSyncFieldsInput({ description: false, location: false }), { description: false, location: false });
  assert.deepEqual(normalizeSyncFieldsInput('{"description":false,"location":true}'), { description: false, location: true },
    'stored JSON string form parses');
  assert.deepEqual(normalizeSyncFieldsInput('{"description":false,"location":false}'), { description: false, location: false });
});

test('normalizeSyncFieldsInput: malformed JSON / non-objects / unknown keys / non-boolean values throw CLEAR save-time errors', () => {
  assert.throws(() => normalizeSyncFieldsInput('not json'), /Sync fields: malformed JSON/);
  assert.throws(() => normalizeSyncFieldsInput('{"description":'), /Sync fields: malformed JSON/);
  assert.throws(() => normalizeSyncFieldsInput('42'), /Sync fields: expected an object/);
  assert.throws(() => normalizeSyncFieldsInput([1, 2]), /Sync fields: expected an object/);
  assert.throws(() => normalizeSyncFieldsInput({ title: false }), /unexpected key\(s\) title - only "description" and "location" are allowed/,
    '{"title":false} is rejected (fields outside description/location are never maskable)');
  assert.throws(() => normalizeSyncFieldsInput({ description: false, bogus: 1 }), /unexpected key\(s\) bogus/);
  assert.throws(() => normalizeSyncFieldsInput({ description: 'yes' }), /"description" must be true or false/);
  assert.throws(() => normalizeSyncFieldsInput({ location: 1 }), /"location" must be true or false/);
});

test('storedSyncFieldsJson stores ONLY the stripped fields; safeParseStoredSyncFields is the forgiving round-trip read', () => {
  assert.equal(storedSyncFieldsJson(null), null);
  assert.equal(storedSyncFieldsJson(undefined), null);
  assert.equal(storedSyncFieldsJson({}), null);
  assert.equal(storedSyncFieldsJson({ description: true, location: true }), null, 'both true = clean NULL keeps rows tidy');
  assert.equal(storedSyncFieldsJson({ description: false }), '{"description":false}');
  assert.equal(storedSyncFieldsJson({ description: false, location: false }), '{"description":false,"location":false}');
  assert.equal(storedSyncFieldsJson({"description": false, "location": true}), '{"description":false}',
    'the synced field is omitted from storage');
  // Round trip: stored partial mask reads back to the same effective mask.
  for (const shape of MASK_SHAPES) {
    assert.deepEqual(safeParseStoredSyncFields(shape.json), normalizeSyncFieldsInput(shape.json),
      `round trip: ${shape.label}`);
  }
  // Forgiving read never throws: junk -> null (= all fields, safe direction).
  assert.equal(safeParseStoredSyncFields('not json at all'), null);
  assert.equal(safeParseStoredSyncFields(null), null);
  assert.equal(safeParseStoredSyncFields('{"bogus":true}'), null, 'unknown key degrades to all-fields on READ');
  assert.equal(safeParseStoredSyncFields('{"description":"yes"}'), null, 'non-boolean degrades to all-fields on READ');
});

test('applyFieldMask: strip-only pure transform; null mask returns the SAME object (byte-identical legacy path)', () => {
  const ev = { uid: 'u', summary: 'S', description: 'd', location: 'l' };
  assert.equal(applyFieldMask(ev, null), ev, 'null mask = identity, no copy');
  assert.equal(applyFieldMask(ev, undefined), ev, 'unset mask = identity');
  const once = applyFieldMask(ev, { description: false, location: true });
  assert.equal(once.description, '');
  assert.equal(once.location, 'l');
  assert.equal(once.uid, 'u');
  assert.equal(once.summary, 'S');
  assert.ok(!('description' in applyFieldMask({ uid: 'u' }, { description: false, location: false })),
    'a mask never ADDS fields back to an event that lacks them');
});

test('pinned order: copy_mode transform FIRST, field mask SECOND - the mask cannot undo busy/generic stripping', () => {
  const ev = {
    uid: 'u', summary: 'Secret standup', description: 'd', location: 'l',
    start: { dateTime: '2026-11-15T09:00:00Z' }, end: { dateTime: '2026-11-15T09:30:00Z' },
  };
  const busy = applyCopyMode(ev, 'busy', 'P');
  assert.deepEqual(applyFieldMask(busy, { description: true, location: true }), busy,
    'a keep-everything mask cannot resurrect copy-mode-stripped fields');
  assert.deepEqual(applyFieldMask(applyCopyMode(ev, 'generic', 'My Pair'), { description: false, location: false }),
    { ...ev, summary: 'My Pair', description: '', location: '' },
    'generic + full-strip mask = generic output, mask is a no-op on already-stripped fields');
});

test('server form parsing: checkbox present/absent maps to the mask (present = true, absent = false, empty = absent)', () => {
  assert.deepEqual(syncFieldMaskFromForm({ sync_description: 'on', sync_location: 'on' }), { description: true, location: true });
  assert.deepEqual(syncFieldMaskFromForm({ sync_description: 'on' }), { description: true, location: false });
  assert.deepEqual(syncFieldMaskFromForm({ sync_location: 'on' }), { description: false, location: true });
  assert.deepEqual(syncFieldMaskFromForm({}), { description: false, location: false });
  assert.deepEqual(syncFieldMaskFromForm({ sync_description: '', sync_location: 'on' }),
    { description: false, location: true }, 'empty value counts as absent');
  assert.deepEqual(syncFieldMaskFromForm({ sync_description: null, sync_location: null }),
    { description: false, location: false }, 'null values count as absent');
  // End-to-end composition with the db boundary (as resolvePairPayload does):
  assert.equal(storedSyncFieldsJson(syncFieldMaskFromForm({ sync_description: 'on', sync_location: 'on' })), null,
    'both checked = all fields sync = clean NULL row');
  assert.equal(storedSyncFieldsJson(syncFieldMaskFromForm({ sync_location: 'on' })), '{"description":false}');
  assert.equal(storedSyncFieldsJson(syncFieldMaskFromForm({})), '{"description":false,"location":false}',
    'both unchecked = full-strip mask stored');
});

// ---------------------------------------------------------------------------
// db layer: migration + create/update validation at the boundary
// ---------------------------------------------------------------------------

test('pairs migrate with the sync_fields column; NULL default; partial masks round-trip; validation is strict at save time', async () => {
  const db = await openDatabase(':memory:');
  const cols = db._raw.prepare("SELECT name FROM pragma_table_info('pairs')").all().map((r) => String(r.name));
  assert.ok(cols.includes('sync_fields'), 'sync_fields column present');

  const p1 = db.createPair({ name: 'P1', feed_url: 'https://f/x.ics', calendar_id: 'c', interval_minutes: 60 });
  assert.equal(p1.sync_fields, null, 'default = all fields sync (exact pre-feature behavior)');

  const p2 = db.createPair({ name: 'P2', feed_url: 'x', calendar_id: 'c', interval_minutes: 60, sync_fields: { description: false, location: true } });
  assert.equal(p2.sync_fields, '{"description":false}');
  assert.deepEqual(safeParseStoredSyncFields(db.getPair(p2.id).sync_fields), { description: false, location: true },
    'stored partial mask round-trips');

  const p3 = db.createPair({ name: 'P3', feed_url: 'x', calendar_id: 'c', interval_minutes: 60, sync_fields: { description: false, location: false } });
  assert.equal(p3.sync_fields, '{"description":false,"location":false}');
  const p4 = db.createPair({ name: 'P4', feed_url: 'x', calendar_id: 'c', interval_minutes: 60, sync_fields: { description: true, location: true } });
  assert.equal(p4.sync_fields, null, 'both true stores clean NULL');
  const p5 = db.createPair({ name: 'P5', feed_url: 'x', calendar_id: 'c', interval_minutes: 60, sync_fields: '{}' });
  assert.equal(p5.sync_fields, null, 'empty object stores clean NULL');
  const p6 = db.createPair({ name: 'P6', feed_url: 'x', calendar_id: 'c', interval_minutes: 60, sync_fields: '{"description":true}' });
  assert.equal(p6.sync_fields, null, 'explicit true-only mask stores clean NULL');

  // updatePair: undefined = unchanged, null clears, object/JSON string store.
  db.updatePair(p2.id, { name: 'P2 renamed' });
  assert.equal(db.getPair(p2.id).sync_fields, '{"description":false}', 'patch without a sync_fields key keeps the mask');
  db.updatePair(p2.id, { sync_fields: null });
  assert.equal(db.getPair(p2.id).sync_fields, null, 'explicit null clears (= all fields sync)');
  db.updatePair(p2.id, { sync_fields: { location: false } });
  assert.equal(db.getPair(p2.id).sync_fields, '{"location":false}');
  db.updatePair(p2.id, { sync_fields: '{"description":false}' });
  assert.equal(db.getPair(p2.id).sync_fields, '{"description":false}', 'stored JSON string form accepted');

  // Save-time validation errors (mirror the filters discipline).
  assert.throws(() => db.updatePair(p2.id, { sync_fields: 'not json' }), /Sync fields: malformed JSON/,
    'malformed JSON fails loudly at save time');
  assert.throws(() => db.createPair({ name: 'x', feed_url: 'x', calendar_id: 'c', interval_minutes: 60, sync_fields: '{"title":false}' }),
    /unexpected key\(s\) title/);
  assert.throws(() => db.updatePair(p2.id, { sync_fields: { description: 'yes' } }), /must be true or false/);
  assert.throws(() => db.createPair({ name: 'x', feed_url: 'x', calendar_id: 'c', interval_minutes: 60, sync_fields: ['description'] }),
    /expected an object/);
  db.close();
});

test('legacy one-way database gains sync_fields via the guarded ALTER; legacy rows read as all-fields', async () => {
  const dbPath = path.join(os.tmpdir(), `calsync-syncfield-migrate-${Date.now()}-${Math.floor(Math.random() * 1e9)}.sqlite`);
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
  `);
  raw.prepare('INSERT INTO pairs (name, feed_url, calendar_id, interval_minutes, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
    .run('Legacy', 'https://feed.example/x.ics', 'cal-x', 360, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  raw.close();
  const db = await openDatabase(dbPath);
  const cols = db._raw.prepare("SELECT name FROM pragma_table_info('pairs')").all().map((r) => String(r.name));
  assert.ok(cols.includes('sync_fields'), 'sync_fields column added to the legacy table');
  assert.equal(db.getPair(1).sync_fields, null, 'legacy row = NULL = all fields sync');
  const p2 = db.createPair({ name: 'New', feed_url: 'https://f/y.ics', calendar_id: 'c', interval_minutes: 60, sync_fields: { description: false } });
  assert.equal(p2.sync_fields, '{"description":false}');
  // Reopen is idempotent (no second ALTER attempt, row intact).
  db.close();
  const db2 = await openDatabase(dbPath);
  assert.equal(db2.getPair(1).sync_fields, null, 'legacy row still NULL after reopen');
  db2.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
});

// ---------------------------------------------------------------------------
// Google target adapter: full/busy/generic x mask, hash stability
// ---------------------------------------------------------------------------

test('Google target, full mode + every mask shape: strips at write, hash after the FULL chain, rerun is ZERO-write', async () => {
  for (const shape of MASK_SHAPES) {
    const db = await openDatabase(':memory:');
    const holder = makeGoogleMock();
    const engine = makeEngine(db, { googleFactory: () => holder.client });
    const pair = db.createPair({
      name: 'P', feed_url: 'https://feed.example/cal.ics', calendar_id: 'cal-target', interval_minutes: 60,
      sync_fields: shape.json,
    });
    const r1 = await engine.runPair(pair.id, { trigger: 'initial' });
    assert.equal(r1.status, 'success', shape.label);
    assert.equal(holder.calls.imports.length, 2);
    for (const [, g] of holder.calls.imports) {
      if (JSON.parse(shape.json).description === false) {
        assert.ok(!('description' in g), `${shape.label}: description omitted from the import payload`);
      } else {
        assert.ok(g.description && g.description.length, `${shape.label}: description still synced`);
      }
      if (JSON.parse(shape.json).location === false) {
        assert.ok(!('location' in g), `${shape.label}: location omitted from the import payload`);
      } else {
        assert.ok(g.location && g.location.length, `${shape.label}: location still synced`);
      }
      assert.ok(g.start && g.end, `${shape.label}: times always preserved`);
      assert.match(g.summary, /Standup|Gym/, `${shape.label}: titles stay governed by copy_mode, not the mask`);
    }
    // The stored hash describes the MASKED payload (transform chain applied
    // before hashing), so the second run matches everywhere.
    const feed = parseFeed(FEED1);
    const stored = db.listSyncedEventHashes(pair.id);
    for (const ev of feed.events) {
      const expected = contentHashOf(toGoogleEvent(applyFieldMask(ev, safeParseStoredSyncFields(shape.json))));
      assert.equal(stored.get(ev.uid), expected, `${shape.label}: stored hash = hash AFTER copy_mode + field mask`);
    }
    const r2 = await engine.runPair(pair.id, { trigger: 'scheduled' });
    assert.equal(r2.status, 'success', shape.label);
    assert.equal(r2.log.imported, 0, `${shape.label}: second run imports nothing`);
    assert.equal(r2.log.unchanged, 2, `${shape.label}: both events count unchanged`);
    assert.equal(holder.calls.imports.length, 2, `${shape.label}: zero-write steady state on rerun`);
    db.close();
  }
});

test('Google target, NULL mask + full mode is byte-identical to the pre-feature import path', async () => {
  const db = await openDatabase(':memory:');
  const holder = makeGoogleMock();
  const engine = makeEngine(db, { googleFactory: () => holder.client });
  const pair = db.createPair({ name: 'P', feed_url: 'https://feed.example/cal.ics', calendar_id: 'cal-target', interval_minutes: 60 });
  const r1 = await engine.runPair(pair.id, { trigger: 'initial' });
  assert.equal(r1.status, 'success');
  const feed = parseFeed(FEED1);
  const storedHashes = db.listSyncedEventHashes(pair.id);
  for (const [i, ev] of feed.events.entries()) {
    const [, g] = holder.calls.imports[i];
    assert.deepEqual(g, toGoogleEvent(ev), 'import payload identical to plain toGoogleEvent(event)');
    assert.equal(storedHashes.get(ev.uid), contentHashOf(toGoogleEvent(ev)),
      'stored hash = hash of the plain toGoogleEvent output (unchanged hash path)');
  }
  assert.match(holder.store.findByUid('cal-target', 'evt-a').description, /Daily sync talk/, 'details intact');
  const r2 = await engine.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(r2.log.unchanged, 2, 'legacy skip-unchanged behavior untouched');
  db.close();
});

test('Google target, busy mode + any mask: description/location absent (copy mode already stripped them; mask is a no-op), zero-write rerun', async () => {
  for (const syncFields of ['{"description":false,"location":false}', '{"description":false}', null]) {
    const db = await openDatabase(':memory:');
    const holder = makeGoogleMock();
    const engine = makeEngine(db, { googleFactory: () => holder.client });
    const pair = db.createPair({
      name: 'P', feed_url: 'https://feed.example/cal.ics', calendar_id: 'cal-target', interval_minutes: 60,
      copy_mode: 'busy', sync_fields: syncFields,
    });
    const r1 = await engine.runPair(pair.id, { trigger: 'initial' });
    assert.equal(r1.status, 'success');
    for (const [, g] of holder.calls.imports) {
      assert.equal(g.summary, 'Busy');
      assert.ok(!('description' in g) && !('location' in g),
        `busy + mask ${String(syncFields)}: fields absent regardless of the mask (mask never adds fields back)`);
    }
    const r2 = await engine.runPair(pair.id, { trigger: 'scheduled' });
    assert.equal(r2.log.imported, 0);
    assert.equal(r2.log.unchanged, 2, `zero-write steady state for busy + mask ${String(syncFields)}`);
    db.close();
  }
});

test('Google target, generic mode + full-strip mask: title is the pair name, fields absent, zero-write rerun', async () => {
  const db = await openDatabase(':memory:');
  const holder = makeGoogleMock();
  const engine = makeEngine(db, { googleFactory: () => holder.client });
  const pair = db.createPair({
    name: 'My Private Pair', feed_url: 'https://feed.example/cal.ics', calendar_id: 'cal-target', interval_minutes: 60,
    copy_mode: 'generic', sync_fields: '{"description":false,"location":false}',
  });
  const r1 = await engine.runPair(pair.id, { trigger: 'initial' });
  assert.equal(r1.status, 'success');
  for (const [, g] of holder.calls.imports) {
    assert.equal(g.summary, 'My Private Pair', 'title still governed by copy_mode');
    assert.ok(!('description' in g) && !('location' in g));
  }
  const r2 = await engine.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(r2.log.imported, 0);
  assert.equal(r2.log.unchanged, 2);
  db.close();
});

// ---------------------------------------------------------------------------
// CalDAV target adapter: PUT payload stripping + hash stability
// ---------------------------------------------------------------------------

test('CalDAV payload builder: cleared/absent description and location produce NO prop lines (no dangling empty DESCRIPTION:/LOCATION:)', () => {
  const base = {
    uid: 'u-empty', start: { dateTime: '2026-11-15T09:00:00Z' }, end: { dateTime: '2026-11-15T09:30:00Z' },
    summary: 'S', status: 'CONFIRMED',
  };
  const maskedEmpty = putEventBody({ ...base, description: '', location: '' });
  assert.doesNotMatch(maskedEmpty.body, /DESCRIPTION/, 'empty description -> no DESCRIPTION line at all');
  assert.doesNotMatch(maskedEmpty.body, /LOCATION/, 'empty location -> no LOCATION line at all');
  const absent = putEventBody({ ...base });
  assert.doesNotMatch(absent.body, /DESCRIPTION/);
  assert.doesNotMatch(absent.body, /LOCATION/);
  const both = putEventBody({ ...base, description: 'hello', location: 'room' });
  assert.match(both.body, /DESCRIPTION:hello/);
  assert.match(both.body, /LOCATION:room/);
});

test('CalDAV target, full mode + every mask shape: PUT props stripped cleanly, hash after the FULL chain, rerun is ZERO-PUT', async () => {
  for (const shape of MASK_SHAPES) {
    const db = await openDatabase(':memory:');
    const xMock = makeCaldavWriteMock();
    const engine = makeEngine(db, { icloudFactory: () => makeIcloudClient(xMock) });
    const pair = db.createPair({
      name: 'P', feed_url: 'https://feed.example/cal.ics', source_type: 'url',
      calendar_id: '', target_type: 'caldav', target_url: 'caldav://caldav.icloud.com/123/calendars/home/', interval_minutes: 60,
      sync_fields: shape.json,
    });
    const r1 = await engine.runPair(pair.id, { trigger: 'initial' });
    assert.equal(r1.status, 'success', shape.label);
    assert.equal(xMock.calls.puts.length, 2);
    for (const uid of ['evt-a', 'evt-b']) {
      const ics = xMock.store.icsOf(uid);
      if (JSON.parse(shape.json).description === false) {
        assert.doesNotMatch(ics, /DESCRIPTION/, `${shape.label}: no DESCRIPTION prop line in the PUT body`);
      } else {
        assert.match(ics, /DESCRIPTION:/, `${shape.label}: description line still written`);
      }
      if (JSON.parse(shape.json).location === false) {
        assert.doesNotMatch(ics, /LOCATION/, `${shape.label}: no LOCATION prop line in the PUT body`);
      } else {
        assert.match(ics, /LOCATION:/, `${shape.label}: location line still written`);
      }
      assert.match(ics, /SUMMARY:(Standup meeting|Gym session)/, `${shape.label}: title untouched by the mask`);
      assert.match(ics, new RegExp(`DTSTART:${uid === 'evt-a' ? '20261115T090000Z' : '20261116T090000Z'}`), `${shape.label}: times preserved`);
    }
    const r2 = await engine.runPair(pair.id, { trigger: 'scheduled' });
    assert.equal(r2.status, 'success', shape.label);
    assert.equal(r2.log.imported, 0, `${shape.label}: second run writes nothing (canonical hash of the masked write equals the parsed-back copy)`);
    assert.equal(r2.log.unchanged, 2, `${shape.label}: both events unchanged`);
    assert.equal(xMock.calls.puts.length, 2, `${shape.label}: zero-PUT steady state on rerun`);
    db.close();
  }
});

test('CalDAV target, busy mode + mask: SUMMARY Busy with no DESCRIPTION/LOCATION lines, zero-PUT rerun', async () => {
  const db = await openDatabase(':memory:');
  const xMock = makeCaldavWriteMock();
  const engine = makeEngine(db, { icloudFactory: () => makeIcloudClient(xMock) });
  const pair = db.createPair({
    name: 'P', feed_url: 'https://feed.example/cal.ics', source_type: 'url',
    calendar_id: '', target_type: 'caldav', target_url: 'caldav://caldav.icloud.com/123/calendars/home/', interval_minutes: 60,
    copy_mode: 'busy', sync_fields: '{"description":false,"location":false}',
  });
  const r1 = await engine.runPair(pair.id, { trigger: 'initial' });
  assert.equal(r1.status, 'success');
  for (const uid of ['evt-a', 'evt-b']) {
    const ics = xMock.store.icsOf(uid);
    assert.match(ics, /SUMMARY:Busy/);
    assert.doesNotMatch(ics, /DESCRIPTION/);
    assert.doesNotMatch(ics, /LOCATION/);
  }
  const r2 = await engine.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(r2.log.imported, 0);
  assert.equal(r2.log.unchanged, 2);
  assert.equal(xMock.calls.puts.length, 2, 'zero-PUT steady state');
  db.close();
});

test('CalDAV target, NULL mask + full mode is byte-identical to the pre-feature PUT path', async () => {
  const db = await openDatabase(':memory:');
  const xMock = makeCaldavWriteMock();
  const engine = makeEngine(db, { icloudFactory: () => makeIcloudClient(xMock) });
  const pair = db.createPair({
    name: 'P', feed_url: 'https://feed.example/cal.ics', source_type: 'url',
    calendar_id: '', target_type: 'caldav', target_url: 'caldav://caldav.icloud.com/123/calendars/home/', interval_minutes: 60,
  });
  const r1 = await engine.runPair(pair.id, { trigger: 'initial' });
  assert.equal(r1.status, 'success');
  const icsA = xMock.store.icsOf('evt-a');
  assert.match(icsA, /SUMMARY:Standup meeting/);
  assert.match(icsA, /DESCRIPTION:Daily sync talk/, 'description intact without a mask');
  assert.match(icsA, /LOCATION:Room 4/, 'location intact without a mask');
  const r2 = await engine.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(r2.log.imported, 0);
  assert.equal(r2.log.unchanged, 2, 'legacy skip-unchanged behavior untouched');
  assert.equal(xMock.calls.puts.length, 2, 'no rewrites');
  db.close();
});

test('hash-after-full-chain sanity: a field-masked event and its parsed-back CalDAV copy normalize EQUAL', () => {
  const ev = parseFeed(FEED1).events[0];
  const masked = applyFieldMask(ev, safeParseStoredSyncFields('{"description":false}'));
  const putIcs = icsFor([veventFor([
    'UID:evt-a', 'DTSTART:20261115T090000Z', 'DTEND:20261115T093000Z', 'SUMMARY:Standup meeting',
    'LOCATION:Room 4', 'STATUS:CONFIRMED',
  ])]);
  const parsedBack = parseFeed(putIcs).events[0];
  assert.equal(canonicalEventHash(parsedBack), canonicalEventHash(masked),
    'stripped writes parse back identical to the masked canonical form (what makes the rerun zero-write)');
});

// ---------------------------------------------------------------------------
// Dashboard form + client sugar
// ---------------------------------------------------------------------------

test('renderPairForm: Fields-to-sync fieldset renders stored states; All checkbox is name-less sugar; hints present', () => {
  const base = {
    id: 1, name: 'P', feed_url: 'https://x/y.ics', source_type: 'url', calendar_id: 'c',
    interval_minutes: 60, target_type: 'google',
  };
  const args = { calendars: [], googleConnected: false, googleError: null, csrf: 'T' };

  // Stored NULL/inexistent: ALL checked (pre-feature default).
  const a = renderPairForm({ pair: { ...base }, ...args }).body;
  assert.match(a, /<legend>Fields to sync<\/legend>/);
  assert.match(a, /<input type="checkbox" name="sync_description" checked>/);
  assert.match(a, /<input type="checkbox" name="sync_location" checked>/);
  assert.match(a, /<input type="checkbox" id="sync_all" checked>/, 'All sugar renders checked iff both individuals are');
  assert.ok(!a.includes('name="sync_all"'), 'the All checkbox NEVER posts (no name attribute)');
  assert.match(a, /Unchecked fields are omitted when writing to the target calendar\./);
  assert.match(a, /Busy only \/ Generic title already strip description and location; the field checkboxes apply on top\./,
    'copy_mode hint states the layering');

  // Partial mask: description stripped, location kept, All reflects the mix.
  const b = renderPairForm({ pair: { ...base, sync_fields: '{"description":false}' }, ...args }).body;
  assert.match(b, /<input type="checkbox" name="sync_description">/, 'unchecked when stored mask strips the field');
  assert.match(b, /<input type="checkbox" name="sync_location" checked>/);
  assert.match(b, /<input type="checkbox" id="sync_all">/, 'All unchecked when any individual is unchecked');

  // Full-strip mask: both unchecked, All unchecked.
  const c = renderPairForm({ pair: { ...base, sync_fields: '{"description":false,"location":false}' }, ...args }).body;
  assert.match(c, /<input type="checkbox" name="sync_description">/);
  assert.match(c, /<input type="checkbox" name="sync_location">/);
  assert.match(c, /<input type="checkbox" id="sync_all">/);

  // Junk stored value renders as all-checked (forgiving read, never throws).
  const d = renderPairForm({ pair: { ...base, sync_fields: 'not json at all' }, ...args }).body;
  assert.match(d, /<input type="checkbox" name="sync_description" checked>/);
  assert.match(d, /<input type="checkbox" name="sync_location" checked>/);
});
