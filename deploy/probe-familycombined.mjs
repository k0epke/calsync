// Read-only preflight for the FamilyCombined cleanup.
// Counts what CalSync has tracked vs what actually sits in the Google
// calendar now. WRITES NOTHING (readOnly DB handle + events.list only).
import fs from 'node:fs';
const cal = '945107758a9d2fbe0a7533b923c1d7bb9e410ebd9bab7af4ca10bfa667a54c24@group.calendar.google.com';

const configMod = await import('file:///opt/calsync/lib/config.js');
await configMod.loadEnvFile('/opt/calsync/.env');
const cfg = configMod.loadConfig();

const { DatabaseSync } = await import('node:sqlite');
const dbRaw = new DatabaseSync('/opt/calsync/data/calsync.db', { readOnly: true });

const trackedTotal = dbRaw.prepare('SELECT COUNT(DISTINCT ical_uid) AS n FROM synced_events').get().n;
const perPair = dbRaw.prepare('SELECT p.id, p.name, COUNT(DISTINCT se.ical_uid) AS uids FROM synced_events se JOIN pairs p ON p.id = se.pair_id GROUP BY p.id ORDER BY p.id').all();
const targets = dbRaw.prepare("SELECT DISTINCT calendar_id FROM pairs WHERE target_type = 'google'").all().map((r) => r.calendar_id);
const account = dbRaw.prepare('SELECT refresh_token, email FROM google_accounts LIMIT 1').get();

const googleLib = await import('file:///opt/calsync/lib/google.js');
const oc = new googleLib.google.auth.OAuth2(cfg.googleClientId, cfg.googleClientSecret, cfg.googleRedirectUrl);
oc.setCredentials({ refresh_token: account.refresh_token });
const client = new googleLib.GoogleCalendarClient(oc, { logger: { warn: () => {}, error: () => {} } });

const events = await client.listAllEvents(cal);
const trackedSet = new Set(dbRaw.prepare('SELECT DISTINCT ical_uid FROM synced_events').all().map((r) => r.uid));
let ours = 0;
let notOurs = 0;
for (const [uid] of events.entries()) {
  if (trackedSet.has(uid)) ours += 1; else notOurs += 1;
}

const pg = dbRaw.prepare('SELECT id, name, target_type, calendar_id FROM pairs').all();
console.log('PAIRS_STATE:', JSON.stringify(pg.map((r) => ({ id: r.id, t: r.target_type, c: String(r.calendar_id ?? '').slice(0, 12) }))));
console.log('TARGETS_IN_PAIRS:', JSON.stringify(targets.map((t) => t.slice(0, 12))));
console.log('TRACKED_UIDS_TOTAL:', trackedTotal);
console.log('EVENTS_PRESENT_IN_CALENDAR:', events.size);
console.log('OURS_MATCHED:', ours);
console.log('NOT_OURS_PRESERVED:', notOurs);
console.log('PER_PAIR:', JSON.stringify(perPair));
process.exit(0);
