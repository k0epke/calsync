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
import { resolveTargetLabels } from '../lib/labels.js';

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
  assert.ok(first.get('2').startsWith('iCloud: '), 'caldav target label derives from URL tail');
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

test('REGRESSION: dashboard header cell order matches row cell order after Tags column', () => {
  const body = dashboardPage({ pairs: makePairs(), google: GOOGLE_STATE, tags: [] }).body;
  const head = body.match(/<thead><tr>([\s\S]*?)<\/tr><\/thead>/);
  const ths = [...head[1].matchAll(/<th([^>]*)>/g)].map((m) => m[1]);
  assert.equal(ths.length, 9, 'nine header cells');
  const thSortKeys = ths
    .map((attrs) => (attrs.match(/data-sort-key="([a-z_]+)"/) || [])[1] ?? null)
    .filter(Boolean);
  assert.deepEqual(thSortKeys, ['name', 'category', 'target', 'interval', 'status', 'last_run'],
    'sortable headers keep their order with the plain Tags th removed from the end');
  const firstRow = body.match(/<tbody>([\s\S]*?)<\/tbody>/);
  const rowChunk = (firstRow[1].match(/<tr>[\s\S]*?<\/tr>/g) || [])[0] ?? '';
  const tds = [...rowChunk.matchAll(/<td/g)].length;
  assert.equal(tds, 9, 'nine row cells match the nine header cells');
  const rowSortKeys = [...rowChunk.matchAll(/data-sort-key="([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(rowSortKeys, thSortKeys, 'row sort-key sequence equals sortable header sequence');
});

test('target cell renders the resolved label and keeps the raw id in its title', () => {
  const pairs = makePairs();
  pairs[0].target_label = 'Avery Basketball (iCloud mirror)';
  const body = dashboardPage({ pairs, google: GOOGLE_STATE, tags: [] }).body;
  assert.match(body, /Avery Basketball \(iCloud mirror\)/);
  assert.match(body, /title="family00127487564181454180@group\.calendar\.google\.com"/, 'raw id lives in the tooltip');
});
