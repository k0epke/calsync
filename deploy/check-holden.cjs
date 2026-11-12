// Read-only weekend query for Holden's synced calendar (run via sudo node from /opt/calsync).
const fs = require('fs');
const env = Object.fromEntries(
  fs.readFileSync('/opt/calsync/.env', 'utf8').split(/\r?\n/)
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const { google } = require('googleapis');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/calsync/data/calsync.db', { readOnly: true });
const pair = db.prepare('SELECT id, name, calendar_id FROM pairs WHERE id = 5').get();
const acct = db.prepare('SELECT refresh_token FROM google_accounts').get();
const oauth = new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URL || undefined);
oauth.setCredentials({ refresh_token: acct.refresh_token });
const cal = google.calendar({ version: 'v3', auth: oauth });

function fmt(e) {
  const s = e.start && (e.start.dateTime || e.start.date);
  const en = e.end && (e.end.dateTime || e.end.date);
  return { summary: e.summary, start: s, end: en, location: e.location || null };
}

(async () => {
  console.log('PAIR:', pair.id, pair.name, pair.calendar_id);
  const wk = await cal.events.list({
    calendarId: pair.calendar_id,
    timeMin: '2026-11-13T00:00:00-06:00',
    timeMax: '2026-11-16T00:00:00-06:00',
    singleEvents: true, orderBy: 'startTime', maxResults: 50,
  });
  console.log('WEEKEND:', JSON.stringify((wk.data.items || []).filter(e => e.status !== 'cancelled').map(fmt)));
  const next = await cal.events.list({
    calendarId: pair.calendar_id,
    timeMin: '2026-11-16T00:00:00-06:00',
    singleEvents: true, orderBy: 'startTime', maxResults: 3,
  });
  console.log('NEXT:', JSON.stringify((next.data.items || []).filter(e => e.status !== 'cancelled').map(fmt)));
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
