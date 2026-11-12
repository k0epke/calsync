import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDashboard, renderPairForm, layout } from '../lib/render.js';

test('disconnect form carries the stamped CSRF token', () => {
  const { body } = renderDashboard({
    pairs: [],
    google: { configured: true, connected: true, email: 'x@example.com', redirectUrl: 'https://kalsync.koepke.tech/oauth/callback' },
    csrf: 'TOK123',
  });
  const line = body.split('\n').find((l) => l.includes('action="/oauth/disconnect"'));
  assert.ok(line, 'disconnect form rendered');
  assert.match(line, /name="_csrf" value="TOK123"/);
});

test('logout form in layout carries the CSRF token', () => {
  const html = layout({ title: 't', body: '<p>hi</p>', user: 'admin', csrf: 'TOK456' });
  const line = html.split('\n').find((l) => l.includes('action="/logout"'));
  assert.ok(line, 'logout form rendered');
  assert.match(line, /name="_csrf" value="TOK456"/);
});

test('layout tolerates missing csrf (empty token rendered)', () => {
  const html = layout({ title: 't', body: '', user: 'admin' });
  assert.match(html, /name="_csrf" value=""/);
});

test('dashboard marks CalDAV pairs with an iCloud chip, url pairs without', () => {
  const base = {
    id: 1, name: 'P', feed_url: 'caldav://caldav.icloud.com/1/calendars/a/', calendar_id: 'c',
    interval_minutes: 360, enabled: 1, synced_count: 0,
  };
  const { body } = renderDashboard({
    pairs: [
      { ...base, source_type: 'caldav' },
      { ...base, id: 2, name: 'URL pair', feed_url: 'https://feed.example/x.ics', source_type: 'url' },
    ],
    google: { configured: true, connected: true, email: 'x@example.com', redirectUrl: 'https://kalsync.koepke.tech/oauth/callback' },
    csrf: 'TOK',
  });
  assert.match(body, /<span class="chip" title="iCloud CalDAV source \(read-only\)">iCloud<\/span>/);
  const urlRow = body.split('<tr>').find((r) => r.includes('https://feed.example/x.ics'));
  assert.ok(urlRow, 'the url pair row rendered');
  assert.ok(!urlRow.includes('>iCloud</span>'), 'url pairs must not carry the iCloud chip');
});

// --- two-way dashboard surface -------------------------------------------------

test('dashboard rows show source/target chips and the CalDAV target href', () => {
  const base = { id: 1, name: 'P', interval_minutes: 360, enabled: 1, synced_count: 0 };
  const { body } = renderDashboard({
    pairs: [
      {
        ...base,
        feed_url: 'google://g-source-cal', source_type: 'google', calendar_id: '',
        target_type: 'caldav', target_url: 'caldav://caldav.icloud.com/1/calendars/a/',
      },
      {
        ...base, id: 2, name: 'Q', feed_url: 'https://f/x.ics', source_type: 'url',
        calendar_id: 'cal-9', target_type: 'google',
      },
      {
        ...base, id: 3, name: 'R', feed_url: 'caldav://caldav.icloud.com/1/calendars/x/',
        source_type: 'caldav', calendar_id: 'cal-3', target_type: 'google',
      },
    ],
    google: { configured: true, connected: true, email: 'x@example.com', redirectUrl: 'https://kalsync.koepke.tech/oauth/callback' },
    csrf: 'TOK',
  });
  assert.match(body, />G src<\/span>/, 'google-source pairs are chipped');
  assert.match(body, />iCloud tgt<\/span>/, 'caldav-target pairs are chipped');
  const twoWayRow = body.split('<tr>').find((r) => r.includes('caldav://caldav.icloud.com/1/calendars/a/'));
  assert.ok(twoWayRow && twoWayRow.includes('>CalDAV</span>'), 'the target cell shows the CalDAV href with a kind chip');
  const urlRow = body.split('<tr>').find((r) => r.includes('cal-9'));
  assert.ok(urlRow && urlRow.includes('cal-9') && !urlRow.includes('iCloud tgt'), 'google-target rows keep showing the calendar id without a CalDAV chip');
  const oneWayRow = body.split('<tr>').find((r) => r.includes('cal-3'));
  assert.ok(oneWayRow && oneWayRow.includes('>iCloud</span>') && !oneWayRow.includes('G src'));
});

test('pair form offers Google sources and CalDAV targets (radio + href input)', () => {
  const caldavPair = {
    id: 9, name: 'P', feed_url: 'google://g-source-cal', source_type: 'google', calendar_id: '',
    interval_minutes: 60, target_type: 'caldav', target_url: 'caldav://caldav.icloud.com/1/calendars/a/',
  };
  const { body } = renderPairForm({ pair: caldavPair, calendars: [], googleConnected: true, googleError: null, csrf: 'T' });
  assert.match(body, /<option value="google"[^>]*>Google calendar \(google:\/\/&lt;id&gt;\)<\/option>/,
    'source select carries the google:// encoding hint');
  assert.match(body, /<option value="google" selected>/, 'google source pre-selected for google pairs');
  const { body: body3 } = renderPairForm({
    pair: { ...caldavPair, id: 10, feed_url: 'caldav://caldav.icloud.com/1/calendars/b/', source_type: 'caldav' },
    calendars: [], googleConnected: true, googleError: null, csrf: 'T',
  });
  assert.match(body3, /<option value="caldav"[^>]*selected>/, 'caldav source pre-selected for caldav pairs');
  assert.match(body, /name="target_type" value="caldav"[^>]*checked/, 'caldav target radio pre-selected for caldav pairs');
  assert.match(body, /name="target_type" value="google"/);
  assert.match(body, /name="target_url"[^>]*value="caldav:\/\/caldav\.icloud\.com\/1\/calendars\/a\/"/);
  assert.match(body, /name="target_url"[^>]*required/, 'caldav targets require the href');

  const urlPair = { id: 1, name: 'U', feed_url: 'https://x/y.ics', source_type: 'url', calendar_id: 'c1', interval_minutes: 60, target_type: 'google' };
  const { body: body2 } = renderPairForm({ pair: urlPair, calendars: [], googleConnected: true, googleError: null, csrf: 'T' });
  assert.match(body2, /name="target_type" value="google"[^>]*checked/, 'google target pre-selected (default)');
  assert.doesNotMatch(body2, /name="target_url"[^>]*required/, 'google targets never require the caldav href');
});
