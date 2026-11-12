// Server-rendered HTML (inline templates). Every dynamic value goes through
// esc() — feed data is untrusted input.
import { safeParseStoredEventFilters } from './filters.js';
import { normalizeCopyMode } from './copymode.js';
import { TAG_PALETTE } from './db.js';

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function attr(v) { return esc(v).replace(/`/g, '&#96;'); }

export function csrfField(csrf) {
  return `<input type="hidden" name="_csrf" value="${esc(csrf || '')}">`;
}

export function layout({ title, body, user, msg, err, csrf }) {
  const nav = user
    ? `<nav class="topnav"><a href="/">Dashboard</a><a href="/pairs/new">Add sync pair</a>
       <form class="inline" method="post" action="/logout">${csrfField(csrf)}<button type="submit" class="linkish">Log out (${esc(user)})</button></form></nav>`
    : '';
  const flash =
    (msg ? `<div class="flash flash-ok">${esc(msg)}</div>` : '') +
    (err ? `<div class="flash flash-err">${esc(err)}</div>` : '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · CalSync</title>
<link rel="stylesheet" href="/assets/style.css">
<link rel="icon" href="data:,">
</head>
<body>
<header class="topbar"><span class="brand"><span class="logo">🗓</span> CalSync</span>${nav}</header>
<main class="wrap">
${flash}
${body}
</main>
<footer class="footer">CalSync · self-hosted calendar feed sync · <a href="/healthz" rel="external">healthz</a></footer>
<script src="/assets/app.js" defer></script>
</body>
</html>`;
}

export function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

export function intervalLabel(min) {
  const n = Number(min) || 0;
  if (n < 60) return `${n} min`;
  const h = n / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

export function statusChip(status, running) {
  if (running) return '<span class="chip chip-running">running</span>';
  switch (status) {
    case 'success': return '<span class="chip chip-ok">ok</span>';
    case 'partial': return '<span class="chip chip-warn">partial</span>';
    case 'error': return '<span class="chip chip-err">error</span>';
    default: return '<span class="chip">never run</span>';
  }
}

// Tiny filter-chip helper for pair rows: shows the active keyword lists (if
// any) so filtered pairs are visible at a glance. Junk stored JSON renders
// nothing (safeParse never throws).
export function filterChipsHtml(p) {
  const f = safeParseStoredEventFilters(p?.filters);
  if (!f) return '';
  const inc = f.include ?? [];
  const exc = f.exclude ?? [];
  const chips = [];
  if (inc.length) chips.push(`<span class="chip" title="Include keywords (case-insensitive substring on the event summary)">inc: ${esc(inc.join(', '))}</span>`);
  if (exc.length) chips.push(`<span class="chip" title="Exclude keywords (case-insensitive substring on the event summary); flipped filters prune imported copies via the deletion sweep">exc: ${esc(exc.join(', '))}</span>`);
  return chips.length ? ` ${chips.join(' ')}` : '';
}

// Copy-mode label (ASCII-safe): full/busy/generic pair privacy mask.
export function copyModeLabel(mode) {
  switch (normalizeCopyMode(mode)) {
    case 'busy': return 'busy only';
    case 'generic': return 'generic title';
    default: return '';
  }
}

// --- dashboard organization: sort headers, category, tags -------------------

// Client-side sortable columns (rendered order). public/app.js reads the
// data-sort-* attributes below and sorts the rendered rows itself; the server
// never re-renders for sort or filter changes.
const SORTABLE_COLUMNS = [
  ['name', 'Name'], ['category', 'Category'], ['target', 'Target'],
  ['interval', 'Interval'], ['status', 'Status'], ['last_run', 'Last run'],
];

function sortHeaderHtml(key, label) {
  return `<th class="sortable" data-sort-key="${key}"><button type="button" class="th-sort" data-sort-key="${key}">${esc(label)} <span class="sort-arrow"></span></button></th>`;
}

// Category derivation (pure render; dashboard organization only, never read
// by the sync engine). google and caldav come straight from source_type; url
// feeds split by scheme: webcal:// -> WebCal, http(s):// -> ICS family.
// VCS/XCal/JCal sub-formats are content-sniffed at sync time and cannot be
// known statically, so a url+http(s) pair whose NEWEST run recorded one of
// them is labeled exactly "ICS feed (auto-detected)" (with a tooltip); plain
// 'ics' runs (or pairs that never ran) render "ICS feed". The run history
// detail prints the precise per-run format. Odd-scheme sources are rejected
// upstream at pair save; this only ever renders a stable fallback (or nothing
// for caldav/google shapes) and never throws. Unsupported source_type values
// fall through to the ICS label as a defensive default.
export function deriveCategory(sourceType, feedUrl, lastRunFormat = null) {
  const st = String(sourceType ?? '');
  if (st === 'google') return { key: 'google', label: 'Google' };
  if (st === 'caldav') return { key: 'caldav', label: 'CalDAV (iCloud)' };
  let protocol = '';
  try {
    protocol = new URL(String(feedUrl ?? '').trim()).protocol;
  } catch {
    protocol = '';
  }
  if (protocol === 'webcal:') return { key: 'webcal', label: 'WebCal' };
  if (protocol === 'http:' || protocol === 'https:') {
    const fmt = String(lastRunFormat ?? '').toLowerCase();
    if (fmt === 'vcs' || fmt === 'xcal' || fmt === 'jcal') {
      return {
        key: 'ics',
        label: 'ICS feed (auto-detected)',
        tooltip: 'The sub-format (VCS, XCal or JCal) is auto-detected from the feed content at sync time; the run history records the precise format of each run.',
      };
    }
    return { key: 'ics', label: 'ICS feed' };
  }
  return { key: 'ics', label: 'ICS feed' };
}

// Lenient read of the newest run_log detail JSON -> 'ics'|'vcs'|'xcal'|'jcal'
// or null (junk JSON, missing key or unknown value all render as plain ICS).
export function lastRunFormatOf(detailJson) {
  try {
    const f = JSON.parse(String(detailJson ?? ''))?.format;
    return ['ics', 'vcs', 'xcal', 'jcal'].includes(f) ? f : null;
  } catch {
    return null;
  }
}

// Attention-ordered rank for the client-side status sort (never/paused 0,
// running 1, ok 2, partial 3, error 4) so a descending sort puts trouble
// first and ascending puts healthy pairs first.
const STATUS_SORT_RANKS = { running: '1', success: '2', ok: '2', partial: '3', error: '4' };

// Tag colors render ONLY from the fixed palette (defense in depth alongside
// the db boundary validation); anything else renders with the plain chip look.
function tagColorCss(color) {
  const s = String(color ?? '').trim().toLowerCase();
  return TAG_PALETTE.includes(s) ? s : null;
}

function tagChipHtml(tag) {
  const color = tagColorCss(tag?.color);
  const style = color ? ` style="background:${color}"` : '';
  return `<span class="tag-chip" data-tag-slot="${Number(tag?.slot)}"${style}>${esc(tag?.name ?? '')}</span>`;
}

// Per-pair Tags cell: assigned tags as colored chips (always visible) plus a
// server-rendered <details> assignment form (no JS needed) with one checkbox
// per NAMED slot - unnamed slots are not assignable. Unassign = uncheck.
function pairTagsCellHtml(p, tagCatalog) {
  const assigned = new Set((p.tags ?? []).map((t) => Number(t.slot)));
  const chips = (p.tags ?? []).map(tagChipHtml).join('');
  const named = (tagCatalog ?? []).filter((t) => t?.name);
  const boxes = named.map((t) =>
    `<label class="tag-pick"><input type="checkbox" name="tag" value="${Number(t.slot)}"${assigned.has(Number(t.slot)) ? ' checked' : ''}> <span class="color-dot small" style="background:${tagColorCss(t.color)}"></span> ${esc(t.name)}</label>`);
  const inner = named.length
    ? `<form class="tag-form" method="post" action="/pairs/${esc(p.id)}/tags">${csrfHint()}${boxes.join('')}<button type="submit" class="smallbtn">Save tags</button></form>`
    : '<span class="muted small">No named tag slots yet - name them in the Tags manager above.</span>';
  return `<td class="tagscell">${chips}<details class="tag-picker"><summary>Tags</summary>${inner}</details></td>`;
}

// Compact tag manager above the pairs table: one row per slot (color dot,
// name input, color select from the SAME fixed palette) and ONE Save form
// covering all 10 slots (empty name = unnamed = not assignable).
function tagManagerHtml(tags) {
  const bySlot = new Map((tags ?? []).map((t) => [Number(t.slot), t]));
  const slotRows = Array.from({ length: 10 }, (_, i) => {
    const slot = i + 1;
    const t = bySlot.get(slot) ?? { name: null, color: TAG_PALETTE[i] };
    const dotColor = tagColorCss(t.color) ?? TAG_PALETTE[i];
    const colorOpts = TAG_PALETTE.map((c) => `<option value="${c}"${c === dotColor ? ' selected' : ''}>${c}</option>`).join('');
    return `
    <div class="tag-slot-row">
      <span class="color-dot" data-tag-slot="${slot}" style="background:${dotColor}"></span>
      <span class="tag-slot-label">Slot ${slot}${t.name ? '' : ' <span class="muted small">(unnamed)</span>'}</span>
      <input type="text" name="name_${slot}" maxlength="40" placeholder="unnamed" value="${attr(t.name ?? '')}">
      <select name="color_${slot}">${colorOpts}</select>
    </div>`;
  }).join('');
  return `<div class="card" id="tag-manager">
  <h2>Tags</h2>
  <p class="muted small">Tags organize the dashboard only; they are not attached to synced events.</p>
  <form method="post" action="/tags">
    ${csrfHint()}
    <div class="tag-slots">${slotRows}
    </div>
    <button type="submit" class="primary">Save tags</button>
  </form>
</div>`;
}

// Client-side filter bar (above the pairs table). State lives in localStorage
// via public/app.js; "Clear filters" resets both inputs and the stored state.
function filterBarHtml() {
  return `<div class="filterbar" id="pair-filters">
  <input type="search" id="filter-q" placeholder="Search name or feed URL" aria-label="Search pairs by name or feed URL">
  <select id="filter-category" aria-label="Filter by category">
    <option value="">All</option>
    <option value="google">Google</option>
    <option value="caldav">CalDAV</option>
    <option value="webcal">WebCal</option>
    <option value="ics">ICS feed</option>
  </select>
  <select id="filter-status" aria-label="Filter by status">
    <option value="">All</option>
    <option value="enabled">Enabled</option>
    <option value="paused">Paused</option>
    <option value="errors">With errors</option>
  </select>
  <button type="button" id="filter-clear">Clear filters</button>
  <span class="muted small" id="filter-count"></span>
</div>`;
}

export function dashboardPage({ pairs, google, tags }) {
  const googleBox = google.configured
    ? (google.connected
      ? `<div class="card okbox">✅ Google connected${google.email ? ` as <b>${esc(google.email)}</b>` : ''}
         <form class="inline" method="post" action="/oauth/disconnect" data-confirm="Disconnect the Google account? Sync pairs will fail until you reconnect.">${csrfHint()}<button type="submit" class="linkish danger-link">disconnect</button></form>
         <div class="muted small">Redirect URI registered in Google Cloud: <span class="mono">${esc(google.redirectUrl)}</span></div></div>`
      : `<div class="card warnbox">⚠️ Google account not connected — sync runs will fail until you
         <a href="/oauth/start" class="btn">connect a Google account</a>.
         <div class="muted small">Redirect URI to register: <span class="mono">${esc(google.redirectUrl)}</span></div></div>`)
    : `<div class="card warnbox">⚠️ Google OAuth is not configured. Set <span class="mono">GOOGLE_CLIENT_ID</span> and
       <span class="mono">GOOGLE_CLIENT_SECRET</span> in <span class="mono">.env</span> (see README §Google Cloud setup).
       <div class="muted small">Redirect URI to register: <span class="mono">${esc(google.redirectUrl)}</span></div></div>`;

  const rows = (pairs ?? []).map((p) => {
    const sourceChip = p.source_type === 'caldav'
      ? ' <span class="chip" title="iCloud CalDAV source (read-only)">iCloud</span>'
      : p.source_type === 'google'
        ? ' <span class="chip" title="Google calendar source (two-way)">G src</span>'
        : '';
    const isCaldavTarget = p.target_type === 'caldav';
    const targetLabel = isCaldavTarget ? (p.target_url || '') : p.calendar_id;
    const enabled = Number(p.enabled) ? 1 : 0;
    const lastStatus = String(p.last_status ?? '');
    const cat = deriveCategory(p.source_type, p.feed_url, lastRunFormatOf(p.last_run_detail));
    const catTitle = cat.tooltip ? ` title="${attr(cat.tooltip)}"` : '';
    const statusRank = enabled && Object.prototype.hasOwnProperty.call(STATUS_SORT_RANKS, lastStatus) ? STATUS_SORT_RANKS[lastStatus] : '0';
    return `
  <tr>
    <td class="namecell" data-name="${attr(p.name)}" data-url="${attr(p.feed_url)}" data-enabled="${enabled}" data-status="${attr(lastStatus)}" data-category="${attr(cat.key)}" data-sort-key="name" data-sort-value="${attr(p.name)}">
      <strong>${esc(p.name)}</strong>${Number(p.enabled) ? '' : ' <span class="chip">paused</span>'}${sourceChip}${isCaldavTarget ? ' <span class="chip" title="iCloud CalDAV target (two-way)">iCloud tgt</span>' : ''}${filterChipsHtml(p)}${(() => { const cm = copyModeLabel(p.copy_mode); return cm ? ` <span class="chip" title="Privacy copy mode applied when writing to the target">${cm}</span>` : ''; })()}
      <div class="muted small mono ellipsis" title="${attr(p.feed_url)}">${esc(p.feed_url)}</div>
    </td>
    <td data-sort-key="category" data-sort-value="${attr(cat.label)}"><span class="chip cat-chip" data-category="${attr(cat.key)}"${catTitle}>${esc(cat.label)}</span></td>
    ${pairTagsCellHtml(p, tags)}
    <td data-sort-key="target" data-sort-value="${attr(targetLabel)}"><span class="mono small ellipsis" title="${attr(targetLabel)}">${esc(targetLabel)}</span>${isCaldavTarget ? ' <span class="chip" title="target is an iCloud calendar">CalDAV</span>' : ''}</td>
    <td data-sort-key="interval" data-sort-value="${Number(p.interval_minutes) || 0}">${esc(intervalLabel(p.interval_minutes))}</td>
    <td data-sort-key="status" data-sort-value="${statusRank}">
      ${statusChip(p.last_status, Number(p.running))}
      <div class="muted small">last ok: ${esc(fmtWhen(p.last_success_at))}</div>
      ${p.last_error ? `<details class="errdetails"><summary>error</summary><pre>${esc(p.last_error)}</pre></details>` : ''}
    </td>
    <td class="muted small" data-sort-key="last_run" data-sort-value="${attr(p.last_run_at || '9999-12-31T23:59:59Z')}">${esc(fmtWhen(p.last_run_at))}</td>
    <td class="num">${p.synced_count ?? 0}</td>
    <td class="actions">
      <form class="inline" method="post" action="/pairs/${esc(p.id)}/sync">${csrfHint()}<button type="submit" ${Number(p.enabled) ? '' : 'disabled title="pair is paused"'}>Sync now</button></form>
      <a class="btn" href="/pairs/${esc(p.id)}/edit">Edit</a>
      <form class="inline" method="post" action="/pairs/${esc(p.id)}/toggle">${csrfHint()}<button type="submit">${Number(p.enabled) ? 'Pause' : 'Resume'}</button></form>
      <form class="inline" method="post" action="/pairs/${esc(p.id)}/delete" data-confirm='Delete sync pair "${attr(p.name)}"? Events imported into the target calendar are kept.'>${csrfHint()}<button type="submit" class="danger">Delete</button></form>
      <a class="btn" href="/pairs/${esc(p.id)}/runs">Runs</a>
    </td>
  </tr>`;
  }).join('\n');

  const body = `
${tagManagerHtml(tags)}
${googleBox}
<div class="card">
  <div class="card-head"><h1>Sync pairs</h1><a class="btn primary" href="/pairs/new">+ New sync pair</a></div>
  ${pairs?.length ? `${filterBarHtml()}
  <table class="pairs">
    <thead><tr>
      ${SORTABLE_COLUMNS.map(([key, label]) => sortHeaderHtml(key, label)).join('\n      ')}
      <th>Tags</th><th>Synced</th><th>Actions</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="empty" id="no-pairs-match" hidden>No sync pairs match the current filters.</p>` : '<p class="empty">No sync pairs yet. <a href="/pairs/new">Add one</a> to start syncing a calendar feed into Google Calendar.</p>'}
  <p class="muted small">Each pair pulls its feed and mirrors it into a dedicated Google calendar via <span class="mono">events.import</span> (upsert by iCalUID). Recurrence, timezones and cancellations are preserved; only events previously imported by CalSync are ever deleted.</p>
</div>`;
  return { title: 'Dashboard', body };
}

function csrfHint() {
  // Placeholder stamped with the real token by renderDashboard() below.
  return '<input type="hidden" name="_csrf" value="">';
}

// The dashboard body is built before the csrf token is known (request-bound),
// so routes call renderDashboard({..., csrf}) which stamps the token in.
export function renderDashboard({ pairs, google, tags, csrf }) {
  const { title, body } = dashboardPage({ pairs, google, tags });
  return { title, body: body.replace(/<input type="hidden" name="_csrf" value="">/g, `<input type="hidden" name="_csrf" value="${esc(csrf)}">`) };
}

export function renderPairForm({ pair, calendars, googleConnected, googleError, csrf }) {
  const isEdit = Boolean(pair);
  const intervals = [15, 30, 60, 120, 180, 240, 360, 480, 720, 1440];
  const intervalOpts = intervals.map((m) =>
    `<option value="${m}" ${pair?.interval_minutes === m ? 'selected' : ''}>${esc(intervalLabel(m))}</option>`).join('');
  const mode = pair ? (pair.calendar_mode || 'select') : 'select';
  // Per-pair event filters: two optional comma-separated keyword inputs (the
  // values render pre-filled from the stored filters JSON, forgiving parse).
  const storedFilters = safeParseStoredEventFilters(pair?.filters);
  const includeCsv = (storedFilters?.include ?? []).join(', ');
  const excludeCsv = (storedFilters?.exclude ?? []).join(', ');

  const targetKind = pair?.target_type === 'caldav' ? 'caldav' : 'google';
  let calendarSection;
  if (googleConnected) {
    const opts = (calendars ?? []).map((c) => `
      <option value="${attr(c.id)}" ${pair?.calendar_id === c.id ? 'selected' : ''}>${esc(c.summaryOverride || c.summary || c.id)}${c.primary ? ' (primary)' : ''}</option>`).join('');
    calendarSection = `
      ${googleError ? `<div class="flash flash-err">Could not list Google calendars: ${esc(googleError)}</div>` : ''}
      <div class="field radio"><label><input type="radio" name="calendar_mode" value="select" ${mode === 'select' ? 'checked' : ''}> Pick an existing calendar</label>
        <div class="subfield" id="sec-mode-select"><select name="calendar_id_select">${opts || '<option value="">(no writable calendars found)</option>'}</select></div></div>
      <div class="field radio"><label><input type="radio" name="calendar_mode" value="create" ${mode === 'create' ? 'checked' : ''}> Create a new calendar</label>
        <div class="subfield" id="sec-mode-create"><input type="text" name="new_calendar_name" placeholder="e.g. Room bookings feed" value="${attr(pair?.new_calendar_name || '')}"></div></div>
      <div class="field radio"><label><input type="radio" name="calendar_mode" value="manual" ${mode === 'manual' ? 'checked' : ''}> Use a calendar ID</label>
        <div class="subfield" id="sec-mode-manual"><input type="text" name="calendar_id_manual" placeholder="target calendarId" value="${attr(pair?.calendar_id_manual || '')}"></div></div>`;
  } else {
    calendarSection = `
      <div class="field"><label>Target Google calendar ID</label>
        <input type="text" name="calendar_id_manual" placeholder="calendarId" value="${attr(pair?.calendar_id || '')}" required>
        <p class="muted small">Connect a Google account to pick or create calendars from the dashboard.</p></div>`;
  }

  const body = `
<div class="card narrow">
  <h1>${isEdit ? `Edit sync pair` : 'New sync pair'}</h1>
  <form method="post" action="${isEdit ? `/pairs/${esc(pair.id)}` : '/pairs'}">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <div class="field"><label>Name</label>
      <input type="text" name="name" required maxlength="80" placeholder="e.g. Team holidays" value="${attr(pair?.name || '')}"></div>
    <div class="field"><label>Source type</label>
      <select name="source_type">
        <option value="url" ${(pair?.source_type ?? 'url') !== 'caldav' && pair?.source_type !== 'google' ? 'selected' : ''}>URL feed (ICS, VCS, XCal or JCal; webcal:// works)</option>
        <option value="caldav" ${pair?.source_type === 'caldav' ? 'selected' : ''}>iCloud calendar (CalDAV, read-only)</option>
        <option value="google" ${pair?.source_type === 'google' ? 'selected' : ''}>Google calendar (google://&lt;id&gt;)</option>
      </select>
      <p class="muted small">For iCloud pairs paste the <span class="mono">caldav://</span> URL listed by <span class="mono">node bin/inspect.js --caldav</span>; for Google sources use <span class="mono">google://&lt;calendarId&gt;</span>; credentials come from .env (see README). Google sources sync only into CalDAV targets.</p></div>
    <div class="field"><label>Feed URL (URL feed, iCloud caldav:// or google:// source)</label>
      <input type="text" name="feed_url" required placeholder="https://example.com/calendar.ics" value="${attr(pair?.feed_url || '')}"></div>
    <div class="field"><label>Sync interval</label>
      <select name="interval_minutes">${intervalOpts}</select>
      <p class="muted small">Runs on a cron schedule with 0–5 min jitter; overdue pairs are caught up after restart. Minimum 15 minutes.</p></div>
    <div class="field"><label>Include keywords (comma-separated)</label>
      <input type="text" name="filters_include" placeholder="e.g. standup, planning" value="${attr(includeCsv)}">
      <p class="muted small">Optional. Only events whose summary contains any keyword (case-insensitive) are synced; empty = all events.</p></div>
    <div class="field"><label>Exclude keywords (comma-separated)</label>
      <input type="text" name="filters_exclude" placeholder="e.g. gym, lunch" value="${attr(excludeCsv)}">
      <p class="muted small">Optional. Events whose summary contains any keyword are NOT synced. Flipping filters later prunes previously imported copies via the normal deletion sweep.</p></div>
    <div class="field"><label>Copy details</label>
      <select name="copy_mode">
        <option value="full" ${normalizeCopyMode(pair?.copy_mode) === 'full' ? 'selected' : ''}>Full details</option>
        <option value="busy" ${normalizeCopyMode(pair?.copy_mode) === 'busy' ? 'selected' : ''}>Busy only</option>
        <option value="generic" ${normalizeCopyMode(pair?.copy_mode) === 'generic' ? 'selected' : ''}>Generic title</option>
      </select>
      <p class="muted small">Optional privacy mask applied when writing to the target calendar: Busy only writes "Busy" without description/location; Generic title writes the pair name. Times are always preserved.</p></div>
    <fieldset class="field"><legend>Target</legend>
      <div class="field radio"><label><input type="radio" name="target_type" value="google" ${targetKind === 'google' ? 'checked' : ''}> Google calendar</label>
        <div class="subfield">${calendarSection}</div></div>
      <div class="field radio"><label><input type="radio" name="target_type" value="caldav" ${targetKind === 'caldav' ? 'checked' : ''}> iCloud calendar (CalDAV, two-way)</label>
        <div class="subfield"><input type="text" name="target_url" placeholder="caldav://caldav.icloud.com/12345/calendars/abc/" value="${attr(pair?.target_url || '')}"${targetKind === 'google' ? '' : ' required'}>
        <p class="muted small">Uses the iCloud credentials from .env (ICLOUD_APPLE_ID / ICLOUD_APP_PASSWORD). Paste the <span class="mono">caldav://</span> URL listed by <span class="mono">node bin/inspect.js --caldav</span>. The source and target CalDAV calendars must differ.</p></div></div>
    </fieldset>
    <div class="actions-row">
      <button type="submit" class="primary">${isEdit ? 'Save changes' : 'Create pair'}</button>
      <a class="btn" href="/">Cancel</a>
    </div>
  </form>
</div>`;
  return { title: isEdit ? 'Edit pair' : 'New pair', body };
}

export function renderRuns({ pair, runs }) {
  const rows = (runs ?? []).map((r) => `
  <tr>
    <td class="muted small">${esc(fmtWhen(r.started_at))}</td>
    <td>${esc(r.triggered_by || '')}</td>
    <td>${statusChip(r.status, false)}</td>
    <td class="num">${r.fetched}/${r.imported}/${r.deleted}/${r.failed}</td>
    ${r.error || r.detail ? `<td><details class="errdetails"><summary>${esc(r.error ? 'error' : 'detail')}</summary><pre>${esc(r.error || '')}${r.detail ? `\n${esc(prettyDetail(r.detail))}` : ''}</pre></details></td>` : '<td class="muted small">—</td>'}
  </tr>`).join('\n');
  const body = `
<div class="card">
  <div class="card-head"><h1>Run history — ${esc(pair.name)}</h1><a class="btn" href="/">Back</a></div>
  <p class="muted small">fetched / imported / deleted / failed events. Status chips: ok, partial (some per-event failures), error (run aborted).</p>
  ${runs?.length ? `<table class="runs">
    <thead><tr><th>Started</th><th>Trigger</th><th>Status</th><th>f/i/d/f</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>`
    : '<p class="empty">No runs recorded yet.</p>'}
</div>`;
  return { title: `Runs · ${pair.name}`, body };
}

function prettyDetail(detailJson) {
  try {
    const d = JSON.parse(detailJson);
    const out = [];
    if (d?.format) out.push(`format: ${String(d.format).toUpperCase()}`);
    if (d?.failures?.length) out.push(`failures (${d.failures.length}):\n  ${d.failures.join('\n  ')}`);
    if (d?.warnings?.length) out.push(`warnings (${d.warnings.length}):\n  ${d.warnings.join('\n  ')}`);
    return out.join('\n') || detailJson;
  } catch { return String(detailJson); }
}

export function renderLogin({ next }) {
  const body = `
<div class="card narrow login-card">
  <h1>CalSync</h1>
  <p class="muted">Sign in to manage calendar sync pairs.</p>
  <form method="post" action="/login${next ? `?next=${encodeURIComponent(next)}` : ''}">
    <div class="field"><label>Username</label><input type="text" name="username" autocomplete="username" required autofocus></div>
    <div class="field"><label>Password</label><input type="password" name="password" autocomplete="current-password" required></div>
    <button type="submit" class="primary wide">Sign in</button>
  </form>
</div>`;
  return { title: 'Sign in', body };
}

export function renderError({ code, message }) {
  const body = `<div class="card narrow"><h1>${esc(code)}</h1><p>${esc(message || 'Something went wrong.')}</p><a class="btn" href="/">Back to dashboard</a></div>`;
  return { title: String(code), body };
}
