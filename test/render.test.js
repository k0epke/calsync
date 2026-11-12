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
  const urlRow = body.split('<tr>').find((r) => r.includes('cal-9') && r.includes('class="namecell"'));
  assert.ok(urlRow && urlRow.includes('cal-9') && !urlRow.includes('iCloud tgt'), 'google-target rows keep showing the calendar id without a CalDAV chip');
  const oneWayRow = body.split('<tr>').find((r) => r.includes('cal-3') && r.includes('class="namecell"'));
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

// --- tier 1 dashboard surface: filter chips + copy modes -------------------

test('dashboard rows show filter chips when filters are set (and nothing when unset/junk)', () => {
  const base = { id: 1, name: 'P', feed_url: 'https://f/x.ics', calendar_id: 'c', interval_minutes: 360, enabled: 1, synced_count: 0, source_type: 'url' };
  const { body } = renderDashboard({
    pairs: [
      { ...base, filters: JSON.stringify({ include: ['standup', 'planning'], exclude: ['gym "leg" day'] }) },
      { ...base, id: 2, name: 'Q', filters: null },
      { ...base, id: 3, name: 'R', filters: 'not json at all' },
      { ...base, id: 4, name: 'S', filters: JSON.stringify({ exclude: ['lunch'] }) },
    ],
    google: { configured: true, connected: true, email: 'x@example.com', redirectUrl: 'https://kalsync.koepke.tech/oauth/callback' },
    csrf: 'TOK',
  });
  const row1 = body.split('<tr>').find((r) => r.includes('>P</strong>'));
  assert.match(row1, />inc: standup, planning<\/span>/, 'include chips render joined keywords');
  assert.match(row1, />exc: gym &quot;leg&quot; day<\/span>/, 'exclude chips render escaped keywords');
  const row2 = body.split('<tr>').find((r) => r.includes('>Q</strong>'));
  assert.ok(!row2.includes('>inc:'), 'no filter chips without filters');
  const row3 = body.split('<tr>').find((r) => r.includes('>R</strong>'));
  assert.ok(!row3.includes('>inc:') && !row3.includes('>exc:'), 'junk stored JSON renders no chips (never throws)');
  const row4 = body.split('<tr>').find((r) => r.includes('>S</strong>'));
  assert.ok(!row4.includes('>inc:') && row4.includes('>exc: lunch</span>'), 'exclude-only pairs show only exc');
});

test('dashboard rows surface the copy mode chip, full mode stays chipless', () => {
  const base = { id: 1, name: 'P', feed_url: 'https://f/x.ics', calendar_id: 'c', interval_minutes: 360, enabled: 1, synced_count: 0, source_type: 'url' };
  const { body } = renderDashboard({
    pairs: [
      { ...base, copy_mode: 'busy' },
      { ...base, id: 2, name: 'Q', copy_mode: 'generic' },
      { ...base, id: 3, name: 'R', copy_mode: 'full' },
      { ...base, id: 4, name: 'S' },
    ],
    google: { configured: true, connected: true, email: 'x@example.com', redirectUrl: 'https://kalsync.koepke.tech/oauth/callback' },
    csrf: 'TOK',
  });
  const rowOf = (name) => body.split('<tr>').find((r) => r.includes(`>${name}</strong>`));
  assert.match(rowOf('P'), />busy only<\/span>/); // ASCII-safe label
  assert.match(rowOf('Q'), />generic title<\/span>/);
  assert.ok(!rowOf('R').includes('>busy only') && !rowOf('R').includes('>generic title'), 'full = chipless (legacy rows too)');
  assert.ok(!rowOf('S').includes('>busy only'));
});

test('pair form offers include/exclude keyword inputs and the Copy details select', () => {
  const filtered = {
    id: 9, name: 'P', feed_url: 'https://x/y.ics', source_type: 'url', calendar_id: 'c1',
    interval_minutes: 60, target_type: 'google',
    filters: JSON.stringify({ include: ['standup'], exclude: ['gym'] }), copy_mode: 'busy',
  };
  const { body } = renderPairForm({ pair: filtered, calendars: [], googleConnected: true, googleError: null, csrf: 'T' });
  assert.match(body, /<label>Include keywords \(comma-separated\)<\/label>/);
  assert.match(body, /<label>Exclude keywords \(comma-separated\)<\/label>/);
  assert.match(body, /name="filters_include"[^>]*value="standup"/, 'include input prefilled from stored JSON');
  assert.match(body, /name="filters_exclude"[^>]*value="gym"/, 'exclude input prefilled from stored JSON');
  assert.match(body, /<select name="copy_mode">/);
  assert.match(body, /<option value="full"[^>]*>Full details<\/option>/, 'ASCII-safe label');
  assert.match(body, /<option value="busy" selected>Busy only<\/option>/, 'current mode pre-selected');
  assert.match(body, /<option value="generic"[^>]*>Generic title<\/option>/);

  const fresh = renderPairForm({ pair: null, calendars: [], googleConnected: true, googleError: null, csrf: 'T' }).body;
  assert.match(fresh, /<option value="full" selected>Full details<\/option>/, 'new pairs default to Full details');
  assert.doesNotMatch(fresh, /name="filters_include"[^>]*value="[^"]+"/, 'new pairs start with empty keyword inputs');
});
