// Dashboard organization build tests: tag slots (db migrations + endpoints),
// the category column derivation, and the rendered sort/filter/tag surface.
// Everything runs against fakes/temp SQLite files - no network anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase, TAG_PALETTE } from '../lib/db.js';
import {
  parseTagUpdateForm, parsePairTagForm, makeSaveTagsHandler, makePairTagsHandler, TAG_NAME_MAX,
} from '../lib/tags.js';
import { renderDashboard, renderSettings, renderRuns, deriveCategory, lastRunFormatOf } from '../lib/render.js';
import { createSyncEngine } from '../lib/sync.js';
import { planSync } from '../lib/planner.js';
import { parseFeed } from '../lib/icalparse.js';
import { makeGoogleMock, icsFor, veventFor, FIXED_NOW_MS } from './helpers.js';

const EXPECTED_PALETTE = [
  '#e53935', '#fb8c00', '#fdd835', '#43a047', '#00897b',
  '#1e88e5', '#3949ab', '#8e24aa', '#d81b60', '#6d4c41',
];
const NOW_ISO = '2026-11-11T12:00:00.000Z';

function tempDbPath(tag) {
  return path.join(os.tmpdir(), `calsync-dash-org-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e9)}.sqlite`);
}
function rmDb(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
}
async function withDb(fn) {
  const db = await openDatabase(':memory:');
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------ migrations

const EXPECTED_PALETTE_LENGTH_ASSERT = 10;
test('fresh database: tag slots 1..10 seeded with the fixed default palette, unnamed', async () => {
  assert.equal(TAG_PALETTE.length, EXPECTED_PALETTE_LENGTH_ASSERT);
  assert.deepEqual([...TAG_PALETTE], EXPECTED_PALETTE);

  await withDb(async (db) => {
    const tags = db.listTags().map((t) => ({ slot: Number(t.slot), name: t.name, color: t.color }));
    assert.equal(tags.length, 10);
    for (let i = 0; i < 10; i++) {
      assert.equal(tags[i].slot, i + 1);
      assert.equal(tags[i].name, null, `slot ${i + 1} starts unnamed`);
      assert.equal(tags[i].color, EXPECTED_PALETTE[i], `slot ${i + 1} carries palette color ${i + 1}`);
    }
    // Schema-level guard: a slot outside 1..10 is rejected by the CHECK.
    assert.throws(
      () => db._raw.prepare("INSERT INTO tags (slot, name, color) VALUES (11, 'nope', '#e53935')").run(),
      /CHECK|constraint/i,
    );
    assert.throws(
      () => db._raw.prepare("INSERT INTO tags (slot, name, color) VALUES (0, 'nope', '#e53935')").run(),
      /CHECK|constraint/i,
    );
  });
});

test('legacy database without tags tables: migration seeds slots, pairs and run detail stay intact', async () => {
  const dbPath = tempDbPath('legacy');
  try {
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE pairs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        feed_url TEXT NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'url',
        calendar_id TEXT NOT NULL,
        interval_minutes INTEGER NOT NULL DEFAULT 360 CHECK (interval_minutes >= 15),
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        target_type TEXT NOT NULL DEFAULT 'google',
        target_url TEXT,
        filters TEXT,
        copy_mode TEXT NOT NULL DEFAULT 'full'
      );
      CREATE TABLE pair_status (
        pair_id INTEGER PRIMARY KEY REFERENCES pairs(id) ON DELETE CASCADE,
        running INTEGER NOT NULL DEFAULT 0,
        last_run_at TEXT,
        last_success_at TEXT,
        last_status TEXT,
        last_error TEXT
      );
      CREATE TABLE synced_events (
        pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
        ical_uid TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        content_hash TEXT,
        PRIMARY KEY (pair_id, ical_uid)
      );
      CREATE TABLE run_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
        triggered_by TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT,
        fetched INTEGER NOT NULL DEFAULT 0,
        imported INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        cancelled INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        detail TEXT
      );
    `);
    raw.prepare('INSERT INTO pairs (name, feed_url, calendar_id, interval_minutes, enabled, created_at, updated_at) VALUES (?, ?, ?, 360, 1, ?, ?)')
      .run('Live pair', 'https://feed.example/x.ics', 'cal-x', NOW_ISO, NOW_ISO);
    raw.prepare("INSERT INTO run_log (pair_id, triggered_by, started_at, status, detail) VALUES (1, 'manual', ?, 'success', '{\"failures\":[],\"warnings\":[],\"unchanged\":0,\"filtered\":0,\"format\":\"vcs\"}')")
      .run(NOW_ISO);
    raw.close();

    const db = await openDatabase(dbPath);
    const tags = db.listTags();
    assert.equal(tags.length, 10, 'tag slots seeded into the upgraded database');
    for (let i = 0; i < 10; i++) assert.equal(tags[i].color, EXPECTED_PALETTE[i]);
    assert.equal(db.getPair(1).name, 'Live pair', 'pre-migration pair rows untouched');
    // Newer run detail (with a format key) is readable for the category label.
    assert.equal(lastRunFormatOf(db.lastRunDetailByPair().get(1)), 'vcs');
    db.close();
  } finally {
    rmDb(dbPath);
  }
});

test('tags migration is idempotent: custom names/colors survive reopen unhurt', async () => {
  const dbPath = tempDbPath('idempotent');
  try {
    let db = await openDatabase(dbPath);
    db.setTags([{ slot: 1, name: 'Work', color: '#1e88e5' }, { slot: 7, name: 'Family', color: '#fdd835' }]);
    db.close();

    db = await openDatabase(dbPath);
    const bySlot = new Map(db.listTags().map((t) => [Number(t.slot), t]));
    assert.equal(bySlot.get(1).name, 'Work', 'custom name kept across reopen');
    assert.equal(bySlot.get(1).color, '#1e88e5', 'custom color kept across reopen');
    assert.equal(bySlot.get(2).name, null, 're-seeding never overwrites customized slots');
    assert.equal(bySlot.get(2).color, EXPECTED_PALETTE[1], 'remaining slots keep palette colors');
    assert.equal(bySlot.get(7).name, 'Family');
    assert.equal(bySlot.get(7).color, '#fdd835');
    db.close();
  } finally {
    rmDb(dbPath);
  }
});

// ------------------------------------------------------- db-level tag semantics

test('pair tags: assign/replace/unassign round trip and ON DELETE CASCADE', async () => {
  await withDb(async (db) => {
    db.setTags([{ slot: 2, name: 'Work', color: '#1e88e5' }, { slot: 4, name: 'Home', color: '#43a047' }]);
    const p = db.createPair({ name: 'P', feed_url: 'https://feed.example/x.ics', calendar_id: 'c', interval_minutes: 60 });

    // Unnamed slot rejected without touching assignments.
    assert.throws(() => db.setPairTags(p.id, [1]), /unnamed/i);
    assert.deepEqual(db.listPairTags(p.id), []);

    // Assign (duplicates collapse), ordered by slot, palette color joined.
    db.setPairTags(p.id, [2, 4, 2]);
    let rows = db.listPairTags(p.id).map((r) => ({ slot: Number(r.slot), name: r.name, color: r.color }));
    assert.deepEqual(rows, [
      { slot: 2, name: 'Work', color: '#1e88e5' },
      { slot: 4, name: 'Home', color: '#43a047' },
    ]);

    // Unassign by omission (replace semantics).
    db.setPairTags(p.id, [4]);
    rows = db.listPairTags(p.id).map((r) => Number(r.slot));
    assert.deepEqual(rows, [4]);

    // Unassign everything.
    db.setPairTags(p.id, []);
    assert.deepEqual(db.listPairTags(p.id), []);

    // Cascade: deleting the pair clears its assignments.
    db.setPairTags(p.id, [2, 4]);
    assert.equal(db._raw.prepare('SELECT COUNT(*) AS c FROM pair_tags WHERE pair_id = ?').get(p.id).c, 2);
    db.deletePair(p.id);
    assert.equal(db._raw.prepare('SELECT COUNT(*) AS c FROM pair_tags WHERE pair_id = ?').get(p.id).c, 0,
      'ON DELETE CASCADE clears pair_tags rows');
    // The tag catalog itself is untouched by pair deletion.
    assert.equal(db.listTags().map((t) => t.name).filter(Boolean).length, 2);
  });
});

test('setTags boundary validation: bad color, oversized name, out-of-range slot', async () => {
  await withDb(async (db) => {
    assert.throws(() => db.setTags([{ slot: 1, name: 'X', color: 'red' }]), /palette/i, 'non-palette hex rejected');
    assert.throws(() => db.setTags([{ slot: 1, name: 'X', color: '#e53936' }]), /palette/i);
    assert.throws(() => db.setTags([{ slot: 1, name: 'y'.repeat(41), color: '#e53935' }]), /40 characters/);
    assert.throws(() => db.setTags([{ slot: 11, name: 'X', color: '#e53935' }]), /1 and 10/);
    assert.throws(() => db.setTags([{ slot: 0, name: 'X', color: '#e53935' }]), /1 and 10/);
    assert.throws(() => db.setTags([{ slot: 'two', name: 'X', color: '#e53935' }]), /1 and 10/);
    db.setTags('nonsense'); // non-array input: defensible no-op, never crashes the boundary
    assert.equal(db.listTags()[0].name, null, 'rejected writes never mutate the catalog');

    // Valid bulk update renames + recolors every slot in one call.
    db.setTags(Array.from({ length: 10 }, (_, i) => ({ slot: i + 1, name: `S${i + 1}`, color: ' #1E88E5 ' })));
    const colors = db.listTags().map((t) => t.color);
    assert.deepEqual(colors, Array(10).fill('#1e88e5'), 'colors normalize to lowercase palette hex');
    assert.equal(db.listTags()[0].name, 'S1');
  });
});

test('tagMapForPairs: one render pass gets every pair assignment', async () => {
  await withDb(async (db) => {
    db.setTags([{ slot: 1, name: 'Work', color: '#1e88e5' }, { slot: 2, name: 'Home', color: '#43a047' }]);
    const p1 = db.createPair({ name: 'P1', feed_url: 'https://f.example/a.ics', calendar_id: 'c', interval_minutes: 60 });
    const p2 = db.createPair({ name: 'P2', feed_url: 'webcal://f.example/b.ics', calendar_id: 'c', interval_minutes: 60 });
    db.setPairTags(p1.id, [1]);
    db.setPairTags(p2.id, [1, 2]);
    const map = db.tagMapForPairs();
    assert.deepEqual(map.get(Number(p1.id)).map((t) => t.slot), [1]);
    assert.deepEqual(map.get(Number(p2.id)).map((t) => t.slot), [1, 2]);
    assert.equal(map.get(Number(p1.id))[0].color, '#1e88e5');
  });
});

// ---------------------------------------------------------------- form parsers

test('parseTagUpdateForm: trimming, uppercase colors, junk rejection, full-save shape', () => {
  const good = {};
  for (let s = 1; s <= 10; s++) {
    good[`name_${s}`] = '  ';
    good[`color_${s}`] = (s === 2 ? ' #FB8C00 ' : EXPECTED_PALETTE[s - 1].toUpperCase());
  }
  const r = parseTagUpdateForm(good);
  assert.equal(r.error, undefined);
  assert.equal(r.updates.length, 10, 'one update per slot');
  assert.equal(r.updates[0].slot, 1);
  assert.equal(r.updates[0].name, null, 'whitespace-only name = unnamed');
  assert.equal(r.updates[0].color, '#e53935');
  assert.equal(r.updates[1].color, '#fb8c00', 'colors trim + normalize to lowercase');
  assert.equal(r.updates[9].slot, 10);
  assert.equal(r.updates[9].color, '#6d4c41');

  const r2 = parseTagUpdateForm({ ...good, name_3: '  Gym  ' });
  assert.equal(r2.updates[2].name, 'Gym', 'names trim and keep content');
  assert.equal(r2.updates[2].color, EXPECTED_PALETTE[2]);

  const r3 = parseTagUpdateForm({ ...good, name_2: 'y'.repeat(TAG_NAME_MAX + 1) });
  assert.match(r3.error, /Tag 2: name/, 'oversized name rejected with the slot number');

  const r4 = parseTagUpdateForm({ ...good, color_5: 'hotpink' });
  assert.match(r4.error, /Tag 5: color/, 'off-palette color rejected with the slot number');

  const r5 = parseTagUpdateForm({ ...good, color_6: '#43a047', color_5: '#43a047' });
  assert.equal(r5.error, undefined, 'duplicate palette colors across slots are fine');
});

test('parsePairTagForm: string, array, none, dedup, out-of-range and junk slots', () => {
  assert.deepEqual(parsePairTagForm({ tag: '2' }).slots, [2], 'single checkbox arrives as a string');
  assert.deepEqual(parsePairTagForm({ tag: ['1', '3'] }).slots, [1, 3]);
  assert.deepEqual(parsePairTagForm({ tag: ['3', '3', '1'] }).slots, [3, 1], 'duplicates collapse');
  assert.deepEqual(parsePairTagForm({ tag: ' 7 ' }).slots, [7]);
  assert.deepEqual(parsePairTagForm({ tag: '' }).slots, [], 'empty = no assignment');
  assert.deepEqual(parsePairTagForm({}).slots, [], 'absent = no assignment');
  assert.match(parsePairTagForm({ tag: '11' }).error, /1\.\.10/);
  assert.match(parsePairTagForm({ tag: '0' }).error, /1\.\.10/);
  assert.match(parsePairTagForm({ tag: 'abc' }).error, /Invalid tag slot/);
  assert.match(parsePairTagForm({ tag: ['2', 'oops'] }).error, /Invalid tag slot/);
});

// --------------------------------------------------------- endpoint handlers

test('save-tags endpoint: full save writes all slots; form and db errors redirect with a flash', async () => {
  await withDb(async (db) => {
    const flashes = [];
    const redirectWith = (res, params) => { flashes.push(params); return res; };
    const handler = makeSaveTagsHandler(db, redirectWith);

    const body = {};
    for (let s = 1; s <= 10; s++) {
      body[`name_${s}`] = s === 1 ? 'Work' : `Slot ${s}`;
      body[`color_${s}`] = EXPECTED_PALETTE[s - 1];
    }
    handler({ body }, {});
    assert.deepEqual(flashes, [{ msg: 'Tags saved.' }]);
    assert.equal(db.listTags()[0].name, 'Work');
    assert.deepEqual(db.listTags().map((t) => Number(t.slot)), Array.from({ length: 10 }, (_, i) => i + 1));

    flashes.length = 0;
    handler({ body: { ...body, color_3: 'magenta' } }, {});
    assert.match(flashes[0].err, /Tag 3: color/, 'bad color redirects with a clear flash');
    assert.equal(db.listTags()[2].name, 'Slot 3', 'rejected form never writes');

    flashes.length = 0;
    handler({ body: { ...body, name_4: 'z'.repeat(41) } }, {});
    assert.match(flashes[0].err, /Tag 4: name/);

    // Defensive db-boundary path (direct throw -> generic flash).
    const failing = { setTags: () => { throw new Error('disk error'); } };
    const seen = [];
    makeSaveTagsHandler(failing, (res, params) => { seen.push(params); return res; })({ body }, {});
    assert.match(seen[0].err, /Could not save tags: disk error/);
  });
});

test('pair-tags endpoint: unknown pair -> 404 page; invalid -> redirect without write; valid writes', async () => {
  await withDb(async (db) => {
    db.setTags([{ slot: 3, name: 'Work', color: '#1e88e5' }]);
    const p = db.createPair({ name: 'P', feed_url: 'https://feed.example/x.ics', calendar_id: 'c', interval_minutes: 60 });
    const flashes = [];
    const redirects = (res, params) => { flashes.push(params); return res; };
    const notFound = [];
    const notFoundPage = (req, res) => { notFound.push(req.params?.id); return res; };
    const handler = makePairTagsHandler(db, redirects, notFoundPage);

    handler({ params: { id: '999' }, body: {} }, {});
    handler({ params: { id: 'abc' }, body: {} }, {});
    assert.deepEqual(notFound, ['999', 'abc'], 'unknown/garbled pair id renders the 404 page');
    assert.deepEqual(flashes, []);

    handler({ params: { id: String(p.id) }, body: { tag: '66' } }, {});
    assert.match(flashes[0].err, /tag slots are 1\.\.10/, 'out-of-range slot rejected');
    assert.deepEqual(db.listPairTags(p.id), [], 'invalid request never writes');

    flashes.length = 0;
    handler({ params: { id: String(p.id) }, body: { tag: ['3'] } }, {});
    assert.deepEqual(flashes, [{ msg: 'Tags for "P" updated.' }]);
    assert.deepEqual(db.listPairTags(p.id).map((r) => Number(r.slot)), [3]);

    // Assigning an unnamed slot: rejected at the boundary, flash, no write.
    flashes.length = 0;
    handler({ params: { id: String(p.id) }, body: { tag: ['3', '9'] } }, {});
    assert.match(flashes[0].err, /unnamed/i);
    assert.deepEqual(db.listPairTags(p.id).map((r) => Number(r.slot)), [3], 'assignment unchanged after rejection');

    // Unassign via omission (no checkboxes submitted).
    handler({ params: { id: String(p.id) }, body: {} }, {});
    assert.deepEqual(db.listPairTags(p.id), []);
  });
});

// ----------------------------------------------------------- category column

test('deriveCategory: all four static shapes plus the exact auto-detected label', () => {
  const g = deriveCategory('google', 'google://primary');
  assert.deepEqual({ key: g.key, label: g.label }, { key: 'google', label: 'Google' });

  const c = deriveCategory('caldav', 'caldav://caldav.icloud.com/1/calendars/a/');
  assert.deepEqual({ key: c.key, label: c.label }, { key: 'caldav', label: 'CalDAV (iCloud)' });

  const w = deriveCategory('url', 'webcal://example.com/feed.ics');
  assert.deepEqual({ key: w.key, label: w.label }, { key: 'webcal', label: 'WebCal' });

  const icsH = deriveCategory('url', 'https://example.com/feed.ics', 'ics');
  assert.deepEqual({ key: icsH.key, label: icsH.label }, { key: 'ics', label: 'ICS feed' });

  const icsPlain = deriveCategory('url', 'http://example.com/feed.ics', null);
  assert.deepEqual({ key: icsPlain.key, label: icsPlain.label }, { key: 'ics', label: 'ICS feed' });

  for (const fmt of ['vcs', 'xcal', 'jcal']) {
    const auto = deriveCategory('url', 'https://example.com/feed.ics', fmt);
    assert.equal(auto.label, 'ICS feed (auto-detected)', `exact label for ${fmt}`);
    assert.equal(auto.key, 'ics');
    assert.ok(auto.tooltip, 'tooltip note rendered');
    assert.match(auto.tooltip, /auto-detected/);
    assert.match(auto.tooltip, /run history/);
  }

  // Unknown run formats, non-run state, junk urls and odd schemes stay stable
  // (odd schemes are rejected upstream at pair save; render never throws).
  assert.equal(deriveCategory('url', 'https://example.com/feed.ics', 'bogus').label, 'ICS feed');
  assert.equal(deriveCategory('url', 'not a url at all', 'vcs').label, 'ICS feed');
  assert.equal(deriveCategory('url', 'ftp://example.com/feed.ics', null).label, 'ICS feed');
  assert.equal(deriveCategory('', 'https://example.com/feed.ics', null).label, 'ICS feed');
  assert.equal(deriveCategory('weird-type', null, null).label, 'ICS feed');
});

test('lastRunFormatOf: lenient read of the run detail JSON', () => {
  assert.equal(lastRunFormatOf(JSON.stringify({ format: 'vcs' })), 'vcs');
  assert.equal(lastRunFormatOf(JSON.stringify({ format: 'jcal' })), 'jcal');
  assert.equal(lastRunFormatOf(JSON.stringify({ format: 'xcal' })), 'xcal');
  assert.equal(lastRunFormatOf(JSON.stringify({ format: 'ics' })), 'ics');
  assert.equal(lastRunFormatOf(JSON.stringify({ format: 'bogus' })), null);
  assert.equal(lastRunFormatOf(JSON.stringify({ failures: [] })), null);
  assert.equal(lastRunFormatOf('not json at all'), null);
  assert.equal(lastRunFormatOf(null), null);
  assert.equal(lastRunFormatOf(undefined), null);
});

// ----------------------------------------------------------------- rendering

function basePair(over = {}) {
  return {
    id: 1, name: 'P', feed_url: 'https://feed.example/x.ics', calendar_id: 'cal-1',
    interval_minutes: 60, enabled: 1, synced_count: 0, source_type: 'url',
    ...over,
  };
}
function googleStateStub() {
  return { configured: true, connected: true, email: 'a@b.c', redirectUrl: 'https://x/oauth/callback' };
}
function rowFor(body, name) {
  return body.split('<tr>').find((r) => r.includes(`data-name="${name}"`));
}
function matchRowChip(row, text, msg) {
  assert.ok(row.includes(`>${text}</span>`), msg ?? `chip text ${text} present in the row`);
}

test('render: five sortable headers...; no Status column anywhere', () => {
  const { body } = renderDashboard({ pairs: [basePair()], google: googleStateStub(), tags: [], csrf: 'TOK' });
  for (const key of ['name', 'category', 'target', 'interval', 'last_run']) {
    const line = body.split('\n').find((l) => l.includes(`th class="sortable" data-sort-key="${key}"`));
    assert.ok(line, `${key} header rendered with its sort key`);
    assert.match(line, /class="th-sort" data-sort-key=/, 'button carries the key for a11y/clicks');
    assert.match(line, /<span class="sort-arrow"><\/span>/, 'arrow placeholder present');
  }
  assert.match(body, /<th>Tags<\/th>/);
  assert.match(body, /<th>Synced<\/th>/);
  assert.match(body, /<th>Actions<\/th>/);
});

test('render: filter bar with search, category + status pickers, clear button and no-match line', () => {
  const { body } = renderDashboard({ pairs: [basePair()], google: googleStateStub(), tags: [], csrf: 'TOK' });
  assert.match(body, /id="filter-q"[^>]*placeholder="Search name or feed URL"/);
  assert.match(body, /<select id="filter-category"/);
  assert.match(body, /<option value="google">google<\/option>/);
  assert.match(body, /<option value="caldav">caldav<\/option>/);
  assert.match(body, /<option value="webcal">webcal<\/option>/);
  assert.match(body, /<option value="ics">ics<\/option>/);
  assert.match(body, /<select id="filter-status"/);
  assert.match(body, /<option value="enabled">Enabled<\/option>/);
  assert.match(body, /<option value="paused">Paused<\/option>/);
  assert.match(body, /<option value="errors">With errors<\/option>/);
  assert.match(body, /<button type="button" id="filter-clear">Clear filters<\/button>/);
  assert.match(body, /id="no-pairs-match"[^>]*hidden/, 'no-pairs-match line renders hidden');
});

test('render: Source column chip per shape, tooltip for the auto-detected sub-format', () => {
  const pairs = [
    basePair({ id: 1, name: 'G', feed_url: 'google://g1', source_type: 'google' }),
    basePair({ id: 2, name: 'C', feed_url: 'caldav://caldav.icloud.com/1/calendars/a/', source_type: 'caldav', calendar_id: 'cal-2' }),
    basePair({ id: 3, name: 'W', feed_url: 'webcal://example.com/f.ics' }),
    basePair({ id: 4, name: 'I', feed_url: 'https://example.com/f.ics' }),
    basePair({ id: 5, name: 'V', feed_url: 'https://example.com/f.ics', last_run_detail: JSON.stringify({ format: 'vcs' }) }),
  ];
  const { body } = renderDashboard({ pairs, google: googleStateStub(), tags: [], csrf: 'TOK' });

  const expectChip = (row, text) => {
    const chip = (row.match(/data-sort-key="category"[^>]*><span class="chip"[^>]*>([^<]*)<\/span><\/td>/) || [])[1];
    assert.equal(chip, text, `source cell chip text is ${text}`);
  };
  const gRow = rowFor(body, 'G');
  assert.match(gRow, /class="namecell" data-name="G"[^>]*data-category="google"/, 'row-level category attribute doubles as the filter target');
  assert.match(gRow, /title="google:\/\/g1"/, 'full feed_url lives in the chip tooltip');
  expectChip(gRow, 'g1');
  const cRow = rowFor(body, 'C');
  assert.match(cRow, /data-category="caldav"/);
  expectChip(cRow, 'a');
  const wRow = rowFor(body, 'W');
  assert.match(wRow, /data-category="webcal"/);
  expectChip(wRow, 'webcal://e...');
  const iRow = rowFor(body, 'I');
  assert.match(iRow, /data-category="ics"/);
  expectChip(iRow, 'https://ex...');
  const vRow = rowFor(body, 'V');
  expectChip(vRow, 'https://ex...');
  assert.match(vRow, /title="The sub-format \(VCS, XCal or JCal\) is auto-detected/, 'tooltip note attached as the cell title');
  assert.ok(!body.includes('cat-chip'), 'no cat-chip wrapper on the Source cell');
});

test('render: rows carry the data attributes the client sort and filter read', () => {
  const pairs = [
    basePair(),
    basePair({ id: 9, name: 'E', last_status: 'error', last_error: 'boom' }),
    basePair({ id: 10, name: 'D', enabled: 0 }),
    basePair({ id: 11, name: 'R', last_run_at: '2026-11-10T00:00:00.000Z', interval_minutes: 360 }),
  ];
  const { body } = renderDashboard({ pairs, google: googleStateStub(), tags: [], csrf: 'TOK' });

  const pRow = rowFor(body, 'P');
  assert.match(pRow, /data-name="P"\s+data-url="https:\/\/feed\.example\/x\.ics"/, 'name + feed url exposed for the search');
  assert.match(pRow, /data-enabled="1"/);
  assert.match(pRow, /data-status=""/, 'no run yet');
  assert.match(pRow, /data-sort-key="name" data-sort-value="P"/);
  assert.match(pRow, /data-sort-key="interval" data-sort-value="60"/);
  assert.match(pRow, /data-sort-key="last_run" data-sort-value="9999-12-31T23:59:59Z"/, 'never-run pinned last ascending');

  const eRow = rowFor(body, 'E');
  assert.match(eRow, /data-status="error"/);
  matchRowChip(eRow, 'error', 'error state surfaces as the chip in Last run');
  const dRow = rowFor(body, 'D');
  assert.match(dRow, /data-enabled="0"/);
  matchRowChip(dRow, 'paused', 'paused state surfaces as the chip in Last run');
  const rRow = rowFor(body, 'R');
  assert.match(rRow, /data-sort-key="last_run" data-sort-value="2026-11-10T00:00:00\.000Z"/);
  assert.match(rRow, /data-sort-key="interval" data-sort-value="360"/);
});

test('render: tags manager with 10 slot rows, palette selects, one save form and the scope note (Settings page)', () => {
  const catalog = Array.from({ length: 10 }, (_, i) => ({ slot: i + 1, name: i === 0 ? 'Work' : null, color: EXPECTED_PALETTE[i] }));
  const { body } = renderSettings({ google: googleStateStub(), tags: catalog, csrf: 'TOK123' });
  assert.match(body, /<div class="card" id="tag-manager">/);
  assert.match(body, /Tags organize the dashboard only; they are not attached to synced events\./);
  assert.match(body, /<form method="post" action="\/tags">/, 'single Save form for the whole manager');

  const manager = body.slice(body.indexOf('id="tag-manager"'), body.indexOf('</form>\n</div>'));
  for (let s = 1; s <= 10; s++) {
    assert.match(manager, new RegExp(`name="name_${s}"`), `name input for slot ${s}`);
    assert.match(manager, new RegExp(`name="color_${s}"`), `color select for slot ${s}`);
  }
  assert.match(manager, /#e53935/, 'palette option rendered');
  assert.match(manager, /#6d4c41/, 'palette option rendered');
  assert.match(manager, /Slot 1/);
  assert.match(manager, /Slot 10/);
  assert.match(manager, /value="Work"/, 'existing name prefilled');
  assert.match(manager, /unnamed/, 'unnamed slots labeled');

  const firstPage = body.slice(0, body.indexOf('</body>'));
  assert.match(firstPage, /name="_csrf" value="TOK123"/, 'CSRF token stamped into the manager form');
});

test('render: per-pair tag checkboxes only for named slots, assigned rendered checked, colored chips', () => {
  const catalog = Array.from({ length: 10 }, (_, i) => ({
    slot: i + 1,
    name: i === 0 ? 'Work' : (i === 1 ? 'Home' : null),
    color: EXPECTED_PALETTE[i],
  }));
  const pair = basePair({ id: 7, tags: [{ slot: 1, name: 'Work', color: '#1e88e5' }] });
  const { body } = renderDashboard({ pairs: [pair], google: googleStateStub(), tags: catalog, csrf: 'TOK' });

  const row = rowFor(body, 'P');
  assert.match(row, /<span class="tag-chip" data-tag-slot="1" style="background:#1e88e5">Work<\/span>/, 'assigned tag renders as a colored chip');
  assert.ok(!row.includes('data-tag-slot="2"'), 'unassigned tags render no chips');

  const boxes = row.match(/<input type="checkbox" name="tag" value="(\d+)"([^>]*)>/g) ?? [];
  assert.equal(boxes.length, 2, 'checkboxes only for the two NAMED slots');
  const checked = boxes.filter((b) => / checked/.test(b)).map((b) => /value="(\d+)"/.exec(b)[1]);
  assert.deepEqual(checked, ['1'], 'currently assigned slot pre-checked');

  assert.match(row, /<form class="tag-form" method="post" action="\/pairs\/7\/tags">/, 'no-JS assignment form');
  assert.match(row, /name="_csrf" value="TOK"/, 'per-pair form carries the CSRF token');
  assert.match(row, /<summary>Tags<\/summary>/, 'collapsible details UI');
});

test('render: pair tag cell without any named slot shows guidance and no form', () => {
  const { body } = renderDashboard({ pairs: [basePair({ id: 2 })], google: googleStateStub(), tags: [], csrf: 'TOK' });
  assert.match(body, /No named tag slots yet - name them on the <a href="\/settings">Settings<\/a> page\./);
  assert.ok(!body.includes('/pairs/2/tags'), 'no assignment form when nothing is assignable');
});

test('render: Settings page hosts the Google card in all three states', () => {
  // configured + connected: email, disconnect form, redirect URI
  const connected = renderSettings({
    google: { configured: true, connected: true, email: 'x@example.com', redirectUrl: 'https://r/cb' },
    tags: [], csrf: 'TOK',
  });
  assert.equal(connected.title, 'Settings');
  assert.match(connected.body, /Google connected as <b>x@example\.com<\/b>/);
  assert.match(connected.body, /action="\/oauth\/disconnect"/, 'disconnect form on Settings');
  assert.match(connected.body, /data-confirm="Disconnect the Google account/, 'disconnect confirm dialog');
  assert.match(connected.body, /<span class="mono">https:\/\/r\/cb<\/span>/, 'redirect URI shown');

  // configured + not connected: connect CTA
  const unconnected = renderSettings({
    google: { configured: true, connected: false, email: null, redirectUrl: 'https://r/cb' },
    tags: [], csrf: 'TOK',
  });
  assert.match(unconnected.body, /href="\/oauth\/start"/, 'connect CTA on Settings');

  // not configured: setup hint
  const unconfigured = renderSettings({
    google: { configured: false, connected: false, email: null, redirectUrl: 'https://r/cb' },
    tags: [], csrf: 'TOK',
  });
  assert.match(unconfigured.body, /Google OAuth is not configured/);
});

test('renderRuns: run history shows the precise sniffed format line', () => {
  const run = {
    id: 1, pair_id: 1, triggered_by: 'manual', started_at: NOW_ISO, status: 'success',
    fetched: 2, imported: 2, deleted: 0, failed: 0, cancelled: 0, skipped: 0,
    error: null,
    detail: JSON.stringify({ failures: [], warnings: [], unchanged: 0, filtered: 0, format: 'vcs' }),
  };
  const { body } = renderRuns({ pair: basePair({ id: 5, name: 'V' }), runs: [run] });
  assert.match(body, /format: VCS/, 'run history prints the precise format from the detail JSON');
});

// ------------------------------------------------- engine plumbing for format

const FEED1 = icsFor([
  veventFor(['UID:evt-a', 'DTSTART:20261115T090000Z', 'DTEND:20261115T093000Z', 'SUMMARY:Event A']),
  veventFor(['UID:evt-b', 'DTSTART:20261116T090000Z', 'DTEND:20261116T100000Z', 'SUMMARY:Event B']),
]);

function makeEngine(db, holder, { parseFeedImpl = parseFeed } = {}) {
  return createSyncEngine({
    db,
    config: {
      pushDelayMs: 0, maxFeedBytes: 1024 * 1024, fetchTimeoutMs: 5000,
      windowPastDays: 30, windowFutureDays: 365,
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    googleFactory: () => holder.client,
    icloudFactory: () => null,
    fetchFeedImpl: async () => ({ text: FEED1, finalUrl: 'https://feed.example/cal.ics', status: 200 }),
    parseFeedImpl,
    planSyncImpl: planSync,
    clock: { now: () => FIXED_NOW_MS },
    delayFn: async () => {},
  });
}

test('run_log detail records the sniffed wire format (engine -> dashboard plumbing)', async () => {
  await withDb(async (db) => {
    const holder = makeGoogleMock();
    const engine = makeEngine(db, holder);
    const pair = db.createPair({ name: 'P', feed_url: 'https://feed.example/cal.ics', calendar_id: 'cal-target', interval_minutes: 60 });
    const result = await engine.runPair(pair.id, { trigger: 'manual' });
    assert.equal(result.status, 'success');

    const runs = db.listRuns(pair.id);
    assert.equal(runs.length, 1);
    assert.equal(JSON.parse(runs[0].detail).format, 'ics', 'real ICS parse lands as ics');

    // A parser-level fake marking the content as JCal still lands in detail -
    // and the format key stays inert for sync behavior (import counts unchanged).
    const holder2 = makeGoogleMock();
    const engine2 = makeEngine(db, holder2, {
      parseFeedImpl: (text) => ({ ...parseFeed(text), format: 'jcal' }),
    });
    const pair2 = db.createPair({ name: 'P2', feed_url: 'https://feed.example/other.ics', calendar_id: 'cal-target', interval_minutes: 60 });
    const result2 = await engine2.runPair(pair2.id, { trigger: 'manual' });
    assert.equal(result2.status, 'success');
    const runs2 = db.listRuns(pair2.id);
    assert.equal(JSON.parse(runs2[0].detail).format, 'jcal');
    assert.equal(JSON.parse(runs2[0].detail).unchanged, 0);
    assert.deepEqual([...db.lastRunDetailByPair().keys()].sort((a, b) => a - b), [pair.id, pair2.id].sort((a, b) => a - b));
  });
});

test('vcs-marked content labels a url+http(s) pair as "ICS feed (auto-detected)" end to end', async () => {
  await withDb(async (db) => {
    const holder = makeGoogleMock();
    const engine = makeEngine(db, holder, {
      parseFeedImpl: (text) => ({ ...parseFeed(text), format: 'vcs' }),
    });
    const pair = db.createPair({ name: 'V', feed_url: 'https://feed.example/cal.ics', calendar_id: 'cal-target', interval_minutes: 60 });
    await engine.runPair(pair.id, { trigger: 'manual' });

    const lastDetails = db.lastRunDetailByPair();
    const enriched = [{ ...pair, last_run_detail: lastDetails.get(Number(pair.id)) ?? null, tags: [] }];
    const { body } = renderDashboard({ pairs: enriched, google: googleStateStub(), tags: [], csrf: 'T' });
    assert.match(body, /data-sort-value="ics"[^>]*><span class="chip"[^>]*>https:\/\/fe...<\/span><\/td>/, 'runtime-detected sub-format keeps the ics key and renders the source chip');
    assert.match(body, /title="The sub-format \(VCS, XCal or JCal\) is auto-detected/);
  });
});
