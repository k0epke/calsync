// Server-rendered HTML (inline templates). Every dynamic value goes through
// esc() — feed data is untrusted input.
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

export function dashboardPage({ pairs, google }) {
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

  const rows = (pairs ?? []).map((p) => `
  <tr>
    <td class="namecell">
      <strong>${esc(p.name)}</strong>${Number(p.enabled) ? '' : ' <span class="chip">paused</span>'}
      <div class="muted small mono ellipsis" title="${attr(p.feed_url)}">${esc(p.feed_url)}</div>
    </td>
    <td><span class="mono small ellipsis" title="${attr(p.calendar_id)}">${esc(p.calendar_id)}</span></td>
    <td>${esc(intervalLabel(p.interval_minutes))}</td>
    <td>
      ${statusChip(p.last_status, Number(p.running))}
      <div class="muted small">last run: ${esc(fmtWhen(p.last_run_at))}<br>last ok: ${esc(fmtWhen(p.last_success_at))}</div>
      ${p.last_error ? `<details class="errdetails"><summary>error</summary><pre>${esc(p.last_error)}</pre></details>` : ''}
    </td>
    <td>${p.synced_count ?? 0}</td>
    <td class="actions">
      <form class="inline" method="post" action="/pairs/${esc(p.id)}/sync">${csrfHint()}<button type="submit" ${Number(p.enabled) ? '' : 'disabled title="pair is paused"'}>Sync now</button></form>
      <a class="btn" href="/pairs/${esc(p.id)}/edit">Edit</a>
      <form class="inline" method="post" action="/pairs/${esc(p.id)}/toggle">${csrfHint()}<button type="submit">${Number(p.enabled) ? 'Pause' : 'Resume'}</button></form>
      <form class="inline" method="post" action="/pairs/${esc(p.id)}/delete" data-confirm='Delete sync pair "${attr(p.name)}"? Events imported into Google are kept.'>${csrfHint()}<button type="submit" class="danger">Delete</button></form>
      <a class="btn" href="/pairs/${esc(p.id)}/runs">Runs</a>
    </td>
  </tr>`).join('\n');

  const body = `
${googleBox}
<div class="card">
  <div class="card-head"><h1>Sync pairs</h1><a class="btn primary" href="/pairs/new">+ New sync pair</a></div>
  ${pairs?.length ? `<table class="pairs">
    <thead><tr><th>Feed</th><th>Target calendar</th><th>Interval</th><th>Status</th><th>Synced</th><th>Actions</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>` : '<p class="empty">No sync pairs yet. <a href="/pairs/new">Add one</a> to start syncing a calendar feed into Google Calendar.</p>'}
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
export function renderDashboard({ pairs, google, csrf }) {
  const { title, body } = dashboardPage({ pairs, google });
  return { title, body: body.replace(/<input type="hidden" name="_csrf" value="">/g, `<input type="hidden" name="_csrf" value="${esc(csrf)}">`) };
}

export function renderPairForm({ pair, calendars, googleConnected, googleError, csrf }) {
  const isEdit = Boolean(pair);
  const intervals = [15, 30, 60, 120, 180, 240, 360, 480, 720, 1440];
  const intervalOpts = intervals.map((m) =>
    `<option value="${m}" ${pair?.interval_minutes === m ? 'selected' : ''}>${esc(intervalLabel(m))}</option>`).join('');
  const mode = pair ? (pair.calendar_mode || 'select') : 'select';

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
    <div class="field"><label>Feed URL (ICS, VCS, XCal or JCal; webcal:// works)</label>
      <input type="text" name="feed_url" required placeholder="https://example.com/calendar.ics" value="${attr(pair?.feed_url || '')}"></div>
    <div class="field"><label>Sync interval</label>
      <select name="interval_minutes">${intervalOpts}</select>
      <p class="muted small">Runs on a cron schedule with 0–5 min jitter; overdue pairs are caught up after restart. Minimum 15 minutes.</p></div>
    <fieldset class="field"><legend>Target calendar</legend>${calendarSection}</fieldset>
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
