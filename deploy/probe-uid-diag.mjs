// Read-only diagnostic v2: WHY do tracked UIDs not match the calendar's events?
import fs from 'node:fs';

const cal = '945107758a9d2fbe0a7533b923c1d7bb9e410ebd9bab7af4ca10bfa667a54c24@group.calendar.google.com';

const configMod = await import('file:///opt/calsync/lib/config.js');
await configMod.loadEnvFile('/opt/calsync/.env');
const cfg = configMod.loadConfig();

const { DatabaseSync } = await import('node:sqlite');
const dbRaw = new DatabaseSync('/opt/calsync/data/calsync.db', { readOnly: true });

const tracked = dbRaw.prepare('SELECT DISTINCT ical_uid FROM synced_events').all().map((r) => r.ical_uid);
const trackedSet = new Set(tracked);
const trackedLower = new Set(tracked.map((u) => String(u).toLowerCase()));

const googleLib = await import('file:///opt/calsync/lib/google.js');
const oc = new googleLib.google.auth.OAuth2(cfg.googleClientId, cfg.googleClientSecret, cfg.googleRedirectUrl);
oc.setCredentials({ refresh_token: dbRaw.prepare('SELECT refresh_token FROM google_accounts LIMIT 1').get().refresh_token });
const client = new googleLib.GoogleCalendarClient(oc, { logger: { warn: () => {}, error: () => {} } });

const events = await client.listAllEvents(cal);
const eventUids = [...events.keys()];
const eventLower = new Set(eventUids.map((u) => String(u).toLowerCase()));

let exact = 0;
let casefold = 0;
for (const u of eventUids) {
  if (trackedSet.has(String(u))) exact += 1;
  else if (trackedLower.has(String(u).toLowerCase())) casefold += 1;
}

console.log('TRACKED:', tracked.length, '| EVENTS:', eventUids.length, '| EXACT MATCH:', exact, '| CASEFOLD MATCH:', casefold);
console.log('--- first 6 tracked:');
tracked.slice(0, 6).forEach((u) => console.log('  T:', JSON.stringify(u)));
console.log('--- first 6 calendar iCalUIDs:');
eventUids.slice(0, 6).forEach((u) => console.log('  C:', JSON.stringify(u)));
process.exit(0);
