// DB migration tests for the two-way build: old one-way databases (with the
// source_type CHECK constraint and without target columns) must migrate
// safely - CHECK removed via the guarded table rebuild, legacy rows intact
// and reading as Google targets, new source/target kinds accepted, foreign
// key cascades still working, and the migration idempotent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../lib/db.js';

const NOW_ISO = '2026-11-11T12:00:00.000Z';

// The one-way build's exact pairs schema (with a CHECK) - the state a real
// pre-upgrade database file carries.
const OLD_PAIRS_SQL = `
  CREATE TABLE IF NOT EXISTS pairs (
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
  CREATE TABLE IF NOT EXISTS pair_status (
    pair_id INTEGER PRIMARY KEY REFERENCES pairs(id) ON DELETE CASCADE,
    running INTEGER NOT NULL DEFAULT 0,
    last_run_at TEXT,
    last_success_at TEXT,
    last_status TEXT,
    last_error TEXT
  );
  CREATE TABLE IF NOT EXISTS synced_events (
    pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
    ical_uid TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    content_hash TEXT,
    PRIMARY KEY (pair_id, ical_uid)
  );
`;

// (No string surgery on schema text anywhere: each old generation is built
// explicitly above.)

function makeOldDbPath(tag) {
  return path.join(os.tmpdir(), `calsync-twoway-migrate-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e9)}.sqlite`);
}
function rmDb(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
}
const pairsCreateSql = (db) =>
  (db._raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pairs'").get()?.sql ?? '');

async function seedOldRepo({ sql, rows }) {
  const dbPath = makeOldDbPath('seed');
  const raw = new DatabaseSync(dbPath);
  raw.exec(sql);
  for (const row of rows) {
    raw.prepare(
      'INSERT INTO pairs (name, feed_url, source_type, calendar_id, interval_minutes, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
    ).run(row.name, row.feed_url, row.source_type, row.calendar_id, row.interval_minutes, NOW_ISO, NOW_ISO);
  }
  raw.prepare('INSERT INTO synced_events (pair_id, ical_uid, last_seen_at, content_hash) VALUES (1, ?, ?, ?)').run('evt-old', NOW_ISO, 'hash-old');
  raw.prepare('INSERT INTO pair_status (pair_id, running) VALUES (1, 0)').run();
  raw.close();
  return dbPath;
}

const LEGACY_ROWS = [
  { name: 'Legacy url', feed_url: 'https://feed.example/x.ics', source_type: 'url', calendar_id: 'cal-x', interval_minutes: 360 },
  { name: 'Legacy caldav', feed_url: 'caldav://caldav.icloud.com/123/calendars/home-ABCD/', source_type: 'caldav', calendar_id: 'cal-y', interval_minutes: 60 },
];

test('old one-way database: CHECK rebuilt away, google sources accepted, rows intact, cascade working', async () => {
  const dbPath = await seedOldRepo({ sql: OLD_PAIRS_SQL, rows: LEGACY_ROWS });
  // Sanity: the old schema really rejects the new source type before boot.
  const rawProbe = new DatabaseSync(dbPath);
  assert.throws(
    () => rawProbe.prepare("INSERT INTO pairs (name, feed_url, source_type, calendar_id, interval_minutes, enabled, created_at, updated_at) VALUES ('g', 'google://g1', 'google', 'c', 60, 1, 'x', 'x')").run(),
    /CHECK|constraint/i,
    'the pre-migration CHECK blocks source_type google',
  );
  rawProbe.close();

  let db;
  try {
    db = await openDatabase(dbPath);

    // 1) The CHECK clause is gone (stored CREATE statement checked).
    assert.doesNotMatch(pairsCreateSql(db), /CHECK\s*\(\s*source_type/i);

    // 2) Columns added: target_type defaults every legacy row to google.
    const cols = db._raw.prepare("SELECT name FROM pragma_table_info('pairs')").all().map((r) => String(r.name));
    for (const c of ['source_type', 'target_type', 'target_url']) assert.ok(cols.includes(c), `${c} present`);
    const legacy1 = db.getPair(1);
    const legacy2 = db.getPair(2);
    assert.equal(legacy1.name, 'Legacy url');
    assert.equal(legacy1.source_type, 'url');
    assert.equal(legacy1.target_type, 'google', 'legacy rows read as Google targets');
    assert.equal(legacy1.target_url, null);
    assert.equal(legacy2.source_type, 'caldav', 'caldav source rows preserved verbatim');
    assert.equal(legacy2.target_type, 'google');
    assert.deepEqual(db.listSyncedUids(1), ['evt-old'], 'child rows survived the rebuild');

    // 3) The new source/target kinds are accepted after migration.
    const g = db.createPair({
      name: 'G source', feed_url: 'google://primary', source_type: 'google', calendar_id: '',
      target_type: 'caldav', target_url: 'caldav://caldav.icloud.com/1/calendars/a/', interval_minutes: 60,
    });
    assert.equal(g.source_type, 'google');
    assert.equal(g.target_type, 'caldav');
    assert.equal(g.target_url, 'caldav://caldav.icloud.com/1/calendars/a/');

    // 4) Foreign key cascades still reference the rebuilt table.
    const countEvents = (pairId) => db._raw.prepare('SELECT COUNT(*) AS c FROM synced_events WHERE pair_id = ?').get(pairId).c;
    db.upsertSyncedEvent(g.id, 'evt-g', NOW_ISO, 'h');
    assert.equal(countEvents(g.id), 1);
    db.deletePair(g.id);
    assert.equal(countEvents(g.id), 0, 'ON DELETE CASCADE fires against the rebuilt pairs table');
    assert.equal(countEvents(1), 1, 'unrelated pair rows untouched');

    // 5) Legacy status rows still update (INSERT ... ON CONFLICT survives).
    db.updatePairStatus(2, { status: 'success', ranAt: true, success: true });
    assert.equal(db.getStatus(2).last_status, 'success');

    db.close();

    // 6) Reopening the migrated database is idempotent (no rebuild, rows kept).
    db = await openDatabase(dbPath);
    assert.doesNotMatch(pairsCreateSql(db), /CHECK\s*\(\s*source_type/i);
    assert.equal(db.getPair(1).name, 'Legacy url', 'legacy rows still present after reopen');
    assert.equal(db.getPair(1).target_type, 'google');
    assert.equal(db.getPair(3), null, 'the cascade-deleted pair stays deleted');
    db.close();
    db = null;
  } finally {
    if (db) db.close();
    rmDb(dbPath);
  }
});

test('pre-CalDAV database (no source_type at all) migrates through both generations', async () => {
  const dbPath = makeOldDbPath('precaldav');
  const raw2 = new DatabaseSync(dbPath);
  raw2.exec(`
    CREATE TABLE pairs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      feed_url TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL DEFAULT 360 CHECK (interval_minutes >= 15),
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE pair_status (
      pair_id INTEGER PRIMARY KEY REFERENCES pairs(id) ON DELETE CASCADE,
      running INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE synced_events (
      pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
      ical_uid TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (pair_id, ical_uid)
    );
  `);
  raw2.prepare('INSERT INTO pairs (name, feed_url, calendar_id, interval_minutes, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
    .run('Ancient', 'https://feed.example/a.ics', 'cal-a', 360, NOW_ISO, NOW_ISO);
  raw2.close();

  let db;
  try {
    db = await openDatabase(dbPath);
    assert.doesNotMatch(pairsCreateSql(db), /CHECK\s*\(\s*source_type/i);
    const pair = db.getPair(1);
    assert.equal(pair.source_type, 'url', 'source_type added with the url default');
    assert.equal(pair.target_type, 'google', 'target_type added with the google default');
    assert.equal(pair.target_url, null);
    assert.deepEqual(db.listSyncedUids(1), [], 'empty tracked set tolerated');
    db.createPair({ name: 'New', feed_url: 'google://x', source_type: 'google', calendar_id: 'c', interval_minutes: 60 });
    assert.equal(db.getPair(2).source_type, 'google');
    db.close();
    db = null;
  } finally {
    if (db) db.close();
    rmDb(dbPath);
  }
});

test('fresh databases carry no source_type CHECK and normalize target kinds in code', async () => {
  const db = await openDatabase(':memory:');
  assert.doesNotMatch(pairsCreateSql(db), /CHECK\s*\(\s*source_type/i);
  const p1 = db.createPair({ name: 'def', feed_url: 'google://x', source_type: 'google', calendar_id: 'c', interval_minutes: 60 });
  assert.equal(p1.target_type, 'google', 'target_type defaults to google');
  db.updatePair(p1.id, { target_type: 'caldav', target_url: 'caldav://caldav.icloud.com/1/cal/z/' });
  assert.equal(db.getPair(p1.id).target_type, 'caldav');
  assert.equal(db.getPair(p1.id).target_url, 'caldav://caldav.icloud.com/1/cal/z/');
  db.updatePair(p1.id, { target_type: 'bogus' }); // code normalization: junk -> google
  assert.equal(db.getPair(p1.id).target_type, 'google');
  db.updatePair(p1.id, { source_type: 'bogus' }); // code normalization: junk -> url
  assert.equal(db.getPair(p1.id).source_type, 'url');
  db.close();
});
