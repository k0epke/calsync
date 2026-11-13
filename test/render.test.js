import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSettings, renderPairForm, layout } from '../lib/render.js';
import { renderDashboard } from '../lib/render.js';

test('disconnect form carries the stamped CSRF token (Settings page)', () => {
  const { body } = renderSettings({
    google: { configured: true, connected: true, email: 'x@example.com', redirectUrl: 'https://kalsync.koepke.tech/oauth/callback' },
    tags: [],
    csrf: 'TOK123',
  });
  const line = body.split('\n').find((l) => l.includes('action="/oauth/disconnect"'));
  assert.ok(line, 'disconnect form rendered');
  assert.match(line, /name="_csrf" value="TOK123"/);
});

test('dashboard keeps no Google box or tag manager but links to Settings', () => {
  const { body } = renderDashboard({
    pairs: [],
    google: { configured: true, connected: true, email: 'x@example.com', redirectUrl: 'https://kalsync.koepke.tech/oauth/callback' },
    tags: [],
    csrf: 'TOK',
  });
  assert.ok(!body.includes('oauth/disconnect') && !body.includes('oauth/start'), 'no Google box on the dashboard');
  assert.ok(!body.includes('tag-manager'), 'no tag manager on the dashboard');
  assert.match(body, /href="\/settings"/, 'Settings link present');
  const html = layout({ title: 'Dashboard', body, user: 'admin', csrf: 'TOK' });
  assert.match(html, /<a href="\/settings">Settings<\/a>/, 'topnav Settings link between Dashboard and Add sync pair');
  assert.ok(html.indexOf('<a href="/">Dashboard</a>') < html.indexOf('<a href="/settings">Settings</a>'), 'Settings after Dashboard in nav');
  assert.ok(html.indexOf('<a href="/settings">Settings</a>') < html.indexOf('<a href="/pairs/new"'), 'Settings before Add sync pair in nav');
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

test('dashboard shows the Source chip per source type with the full feed_url in its title', () => {
  const base = {
    id: 1, name: 'P', feed_url: 'caldav://caldav.icloud.com/1/calendars/a/', calendar_id: 'c',
    interval_minutes: 360, enabled: 1, synced_count: 0,
  };
  const { body } = renderDashboard({
    pairs: [
      { ...base, source_type: 'caldav' },
      { ...base, id: 2, name: 'URL pair', feed_url: 'https://feed.example/x.ics', source_type: 'url' },
      { ...base, id: 3, name: 'Long URL', feed_url: 'https://verylongurl.example/some/path/feed.ics', source_type: 'url' },
    ],
    google: { configured: true, connected: true, email: 'x@example.com', redirectUrl: 'https://kalsync.koepke.tech/oauth/callback' },
    csrf: 'TOK',
  });
  const caldavRow = body.split('<tr>').find((r) => r.includes('caldav://caldav.icloud.com/1/calendars/a/'));
  assert.ok(caldavRow, 'the caldav pair row rendered');
  assert.match(caldavRow, /data-category="caldav"/, 'row keeps the data-category attribute the filter reads');
  assert.match(caldavRow, /<td data-sort-key="category" data-sort-value="caldav"><span class="chip" title="caldav:\/\/caldav.icloud.com\/1\/calendars\/a\/">a<\/span><\/td>/, 'Source cell shows the URL tail chip with the full feed_url tooltip');
  const urlRow = body.split('<tr>').find((r) => r.includes('https://feed.example/x.ics'));
  assert.ok(urlRow, 'the url pair row rendered');
  assert.match(urlRow, /<span class="chip" title="https:\/\/feed\.example\/x\.ics">https:\/\/fe...<\/span>/, 'url sources show the first 10 chars of feed_url');
  const longRow = body.split('<tr>').find((r) => r.includes('https://verylongurl.example'));
  assert.match(longRow, /<span class="chip" title="https:\/\/verylongurl\.example[^"]*">https:\/\/ve...<\/span>/, 'truncated URLs get an ASCII ellipsis suffix and keep the full URL as the tooltip');
  assert.ok(!body.includes('cat-chip'), 'no cat-chip wrapper remains');
});

// --- two-way dashboard surface -------------------------------------------------

test('dashboard rows keep target data attrs, raw href tooltip and CalDAV/Google qualified labels', () => {
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
  assert.match(body, /data-target="CalDAV - a"/, 'qualified target label exposed for the filter');
  const twoWayRow = body.split('<tr>').find((r) => r.includes('caldav://caldav.icloud.com/1/calendars/a/'));
  assert.ok(twoWayRow && twoWayRow.includes('<span class="mono small">caldav</span> <span class="chip" title="caldav://caldav.icloud.com/1/calendars/a/">a</span>'), 'the target cell shows plain type text + the unprefixed name chip');
  assert.ok(twoWayRow && twoWayRow.includes('title="caldav://caldav.icloud.com/1/calendars/a/"'), 'raw href stays in the tooltip');
  assert.ok(!twoWayRow.includes('>CalDAV - a<'), 'no prefixed qualified text in the visible target cell');
  const urlRow = body.split('<tr>').find((r) => r.includes('cal-9') && r.includes('class="namecell"'));
  assert.ok(urlRow && urlRow.includes('data-target="Google - cal-9"'), 'google-target rows keep the qualified label in the data attr');
  const oneWayRow = body.split('<tr>').find((r) => r.includes('cal-3') && r.includes('class="namecell"'));
  assert.ok(oneWayRow && oneWayRow.includes('data-category="caldav"'), 'source short key still derived');
  assert.ok(!body.includes('iCloud tgt') && !body.includes('G src'), 'decorative chips gone');
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

// --- tier 1 dashboard surface: filters moved to the filter bar + copy-mode select ---

test('dashboard rows carry no filter chips; filter state lives in the filter bar inputs', () => {
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
  // No chip markup anywhere in the rows; junk stored JSON must still render.
  for (const n of ['P', 'Q', 'R', 'S']) {
    const row = body.split('<tr>').find((r) => r.includes(`data-name="${n}"`));
    assert.ok(row, `row ${n} rendered`);
    assert.ok(!row.includes('>inc:'), `row ${n} shows no include chips`);
    assert.ok(!row.includes('>exc:'), `row ${n} shows no exclude chips`);
    const chips = row.match(/<span class="chip/g) ?? [];
    assert.equal(chips.length, 3, `row ${n} carries exactly three chips: the source chip, the target name chip and the status chip in Last run`);
    assert.ok(!row.includes('mono ellipsis'), `row ${n} has no feed-url line`);
    assert.match(row, /<strong>/, `row ${n} keeps the strong name`);
  }
  // Junk JSON never throws (row R rendered above) - and the filter bar exists.
  assert.match(body, /id="filter-category"/, 'category picker present in the filter bar');
});

test('dashboard rows keep the copy mode out of the chips; the option lives in the pair form select', () => {
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
  assert.ok(!body.includes('>busy only<') && !body.includes('>generic title<'), 'no copy-mode chips on the dashboard rows');
  for (const n of ['P', 'Q', 'R', 'S']) {
    const row = body.split('<tr>').find((r) => r.includes(`data-name="${n}"`));
    const chipSpans = (row.match(/<span class="chip/g) || []).length;
    assert.equal(chipSpans, 3, `row ${n} carries exactly three chips: the source chip, the target name chip and the status chip`);
  }
});

test('status chip lives in the Last run cell; paused shows there for disabled pairs', () => {
  const base = { id: 1, name: 'P', feed_url: 'https://f/x.ics', calendar_id: 'c', interval_minutes: 360, enabled: 1, synced_count: 0, source_type: 'url' };
  const { body } = renderDashboard({
    pairs: [
      { ...base, last_status: 'success', last_run_at: '2026-11-12T05:00:00Z' },
      { ...base, id: 2, name: 'Off', enabled: 0, last_status: 'success', last_run_at: '2026-11-12T05:00:00Z' },
      { ...base, id: 3, name: 'OffErr', enabled: 0, last_status: 'error', last_run_at: '2026-11-12T05:00:00Z' },
      { ...base, id: 4, name: 'OffNoRun', enabled: 0, last_run_at: '2026-11-12T05:00:00Z' },
    ],
    google: { configured: true, connected: true, email: 'x@example.com', redirectUrl: 'https://kalsync.koepke.tech/oauth/callback' },
    csrf: 'TOK',
  });
  const onRow = body.split('<tr>').find((r) => r.includes('data-enabled="1"'));
  assert.match(onRow, /chip-ok">ok<\/span>/, 'enabled pair keeps the status chip (in Last run now)');
  assert.ok(!onRow.includes('>paused<'), 'enabled pairs never show paused');
  for (const n of ['Off', 'OffErr', 'OffNoRun']) {
    const row = body.split('<tr>').find((r) => r.includes(`data-name="${n}"`));
    assert.ok(row, `row ${n} rendered`);
    assert.ok(row.includes('data-enabled="0"'), 'data-enabled attr unchanged (client filter dependency)');
    assert.match(row, /<span class="chip">paused<\/span>/, `disabled pair ${n} shows the paused chip in the Last run cell`);
    assert.ok(!row.includes('chip-ok') && !row.includes('chip-err'), 'paused hides the stale run-status look');
    assert.ok(row.includes('data-sort-key="last_run"') && row.includes('last ok:'), 'the chip sits inside the last-run cell');
  }
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
