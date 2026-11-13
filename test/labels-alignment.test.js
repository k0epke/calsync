// Tests: target-label resolution cache/fallback + THE header/row alignment
// regression (the dashboard once rendered its Tags header at the far end,
// shifting every label one column left), plus target-label cell rendering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../lib/db.js';
import { dashboardPage } from '../lib/render.js';
import { resolveTargetLabels, resolveIdLabels } from '../lib/labels.js';

async function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calsync-labels-'));
  return await openDatabase(path.join(dir, 'test.db'));
}

const GOOGLE_STATE = { configured: true, connected: true, email: 'x@y.z', redirectUrl: 'https://kalsync.koepke.tech/oauth/callback' };

function makePairs() {
  return [
    {
      id: 1, name: 'Avery 26W Basketball', feed_url: 'http://example.test/a.ics',
      source_type: 'url', target_type: 'google', target_url: null,
      calendar_id: 'family00127487564181454180@group.calendar.google.com',
      interval_minutes: 30, enabled: 1, copy_mode: 'full', filters: null,
      last_status: 'success', last_error: null, last_run_at: '2026-11-12T05:44:00Z',
      last_success_at: '2026-11-12T05:44:00Z', last_run_detail: null,
      synced_count: 3,
    },
  ];
}

function caldavPair() {
  return {
    id: 2, name: 'iCloud Home', feed_url: 'https://p154-caldav.icloud.com/116900302/calendars/home/',
    source_type: 'caldav', target_type: 'caldav', target_url: 'https://p154-caldav.icloud.com/116900302/calendars/home/',
    calendar_id: null,
    interval_minutes: 30, enabled: 1, copy_mode: 'full', filters: null,
    last_status: 'success', last_error: null, last_run_at: '2026-11-12T05:40:04Z',
    last_success_at: '2026-11-12T05:40:04Z', last_run_detail: null,
    synced_count: 92,
  };
}

test('target_labels migration + upsert helpers (real DB)', async () => {
  const db = await tmpDb();
  assert.equal(db.getTargetLabel('google:c1'), null);
  db.setTargetLabel('google:c1', 'First Name');
  assert.equal(db.getTargetLabel('google:c1'), 'First Name');
  db.setTargetLabel('google:c1', 'Second Name');
  assert.equal(db.getTargetLabel('google:c1'), 'Second Name', 'ON CONFLICT overwrites');
});

test('resolveTargetLabels: fetch once, cache persists, caldav target derives label', async () => {
  const db = await tmpDb();
  let calls = 0;
  const googleClient = {
    getCalendarSummary: async (id) => { calls += 1; return `Label for ${id.slice(0, 6)}`; },
  };
  const pairs = [...makePairs(), caldavPair()];
  const first = await resolveTargetLabels({ db, googleClient, pairs });
  assert.equal(first.get('1'), 'Label for family', 'google target resolved via API');
  assert.equal(calls, 1, 'one API call for one unknown target');
  assert.equal(db.getTargetLabel(`google:${pairs[0].calendar_id}`), 'Label for family', 'cached');
  assert.ok(first.get('2'), 'caldav target label derives from URL tail');
  assert.equal(first.get('2'), 'home', 'caldav target label derives from URL tail');
  const second = await resolveTargetLabels({ db, googleClient, pairs });
  assert.equal(second.get('1'), 'Label for family');
  assert.equal(calls, 1, 'cache hit: no second API call');
});

test('resolveTargetLabels: API failure falls back to raw id without caching', async () => {
  const db = await tmpDb();
  const googleClient = { getCalendarSummary: async () => { throw new Error('boom'); } };
  const pairs = makePairs();
  const labels = await resolveTargetLabels({ db, googleClient, pairs });
  assert.equal(labels.get('1'), pairs[0].calendar_id, 'raw id fallback');
  assert.equal(db.getTargetLabel(`google:${pairs[0].calendar_id}`), null, 'failure not cached');
});

test('resolveTargetLabels: no google client falls back to raw id', async () => {
  const db = await tmpDb();
  const pairs = makePairs();
  const labels = await resolveTargetLabels({ db, googleClient: null, pairs });
  assert.equal(labels.get('1'), pairs[0].calendar_id);
});

test('resolveIdLabels: shared core - source ids resolve cache-first via the same cache', async () => {
  const db = await tmpDb();
  let calls = 0;
  const googleClient = { getCalendarSummary: async (id) => { calls += 1; return `Name for ${id.slice(0, 4)}`; } };
  const first = await resolveIdLabels({ db, googleClient, ids: ['g1', 'g2'] });
  assert.equal(first.get('g1'), 'Name for g1');
  assert.equal(first.get('g2'), 'Name for g2');
  assert.equal(calls, 2, 'one light API call per unknown id');
  assert.equal(db.getTargetLabel('google:g1'), 'Name for g1', 'cached under the same google:<id> key');
  const second = await resolveIdLabels({ db, googleClient, ids: ['g1', 'g2'] });
  assert.equal(calls, 2, 'cache hit: no second API call');
  const failing = { getCalendarSummary: async () => { throw new Error('boom'); } };
  const raw = await resolveIdLabels({ db: { ...db, getTargetLabel: () => null, setTargetLabel: () => {} }, googleClient: failing, ids: ['zz'] });
  assert.equal(raw.get('zz'), 'zz', 'failure falls back to the raw id without caching');
});

test('REGRESSION: dashboard header cell order matches row cell order after Tags column', () => {
  const body = dashboardPage({ pairs: makePairs(), google: GOOGLE_STATE, tags: [] }).body;
  const head = body.match(/<thead><tr>([\s\S]*?)<\/tr><\/thead>/);
  const ths = [...head[1].matchAll(/<th([^>]*)>/g)].map((m) => m[1]);
  assert.equal(ths.length, 8, 'eight header cells');
  const thSortKeys = ths
    .map((attrs) => (attrs.match(/data-sort-key="([a-z_]+)"/) || [])[1] ?? null)
    .filter(Boolean);
  assert.deepEqual(thSortKeys, ['name', 'category', 'target', 'interval', 'last_run'],
    'Status column removed; sortable headers keep their order');
  const firstRow = body.match(/<tbody>([\s\S]*?)<\/tbody>/);
  const rowChunk = (firstRow[1].match(/<tr>[\s\S]*?<\/tr>/g) || [])[0] ?? '';
  const tds = [...rowChunk.matchAll(/<td/g)].length;
  assert.equal(tds, 8, 'eight row cells match the eight header cells');
  const rowSortKeys = [...rowChunk.matchAll(/data-sort-key="([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(rowSortKeys, thSortKeys, 'row sort-key sequence equals sortable header sequence');
});

test('target cell renders the resolved label and keeps the raw id in its title', () => {
  const pairs = makePairs();
  pairs[0].target_label = 'Avery Basketball (iCloud mirror)';
  const body = dashboardPage({ pairs, google: GOOGLE_STATE, tags: [] }).body;
  assert.match(body, /data-target="Google - Avery Basketball \(iCloud mirror\)"/, 'qualified target stays in the data attr + filter dropdown');
  assert.match(body, /<span class="mono small">google<\/span> <span class="chip" title="family00127487564181454180@group\.calendar\.google\.com">Avery Basketball \(iCloud mirror\)<\/span>/, 'plain type text + prefix-stripped name chip with the raw id tooltip');
});

test('target cell strips an existing CalDAV prefix from the resolved label', () => {
  const pairs = makePairs();
  pairs[0].target_type = 'caldav';
  pairs[0].target_url = 'https://p154-caldav.icloud.com/116900302/calendars/home/';
  pairs[0].target_label = 'CalDAV - home';
  const body = dashboardPage({ pairs, google: GOOGLE_STATE, tags: [] }).body;
  assert.ok(!body.includes('>CalDAV - home<'), 'no doubled prefix in the visible cell');
  assert.match(body, /<span class="mono small">caldav<\/span> <span class="chip" title="https:\/\/p154-caldav\.icloud\.com\/116900302\/calendars\/home\/">home<\/span>/);
});

test('filter bar: Target/Tags/Interval dropdowns render with row filter attributes', () => {
  const tags = [{ slot: 1, name: 'Aidan', color: '#e53935' }, { slot: 2, name: '', color: '#43a047' }];
  const body = dashboardPage({ pairs: [...makePairs(), caldavPair()], google: GOOGLE_STATE, tags }).body;
  assert.match(body, /id="filter-target"/, 'target dropdown present');
  assert.match(body, /id="filter-tags"/, 'tags dropdown present');
  assert.match(body, /id="filter-interval"/, 'interval dropdown present');
  assert.match(body, /<option value="Google - family00127487564181454180@group\.calendar\.google\.com">/, 'google targets listed qualified');
  assert.match(body, /<option value="CalDAV - home">/, 'caldav targets listed qualified by URL tail');
  assert.match(body, /<option value="1">Aidan<\/option>/, 'only named tag slots become options');
  assert.doesNotMatch(body, /<option value="2"><\/option>/, 'unnamed slots are not offered');
  assert.match(body, /<option value="30">/, 'interval option present');
  const namecell = (body.match(/<td class="namecell"([^>]*)>/) || [])[1] ?? '';
  assert.match(namecell, /data-target="Google - family00127487564181454180@group\.calendar\.google\.com"/);
  assert.match(namecell, /data-tag-slots=""/, 'pair has no assigned tags yet');
});
