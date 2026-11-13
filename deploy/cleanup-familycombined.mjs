// Owner-approved cleanup (option 3): delete ONLY the events whose tracking
// pairs no longer target FamilyCombined (the 8 retargeted CalDAV pairs),
// leaving the three iCloud-source pairs (10, 11, 12) fully intact.
// Read-only DB access; the only writes are Google events.delete calls.
const cal = '945107758a9d2fbe0a7533b923c1d7bb9e410ebd9bab7af4ca10bfa667a54c24@group.calendar.google.com';
const KEEP_PAIRS = new Set([10, 11, 12]);

const configMod = await import('file:///opt/calsync/lib/config.js');
await configMod.loadEnvFile('/opt/calsync/.env');
const cfg = configMod.loadConfig();

const { DatabaseSync } = await import('node:sqlite');
const dbRaw = new DatabaseSync('/opt/calsync/data/calsync.db', { readOnly: true });

const uidPairs = new Map();
for (const r of dbRaw.prepare('SELECT pair_id, ical_uid FROM synced_events').all()) {
  const pid = Number(r.pair_id);
  const set = uidPairs.get(r.ical_uid) ?? new Set();
  set.add(pid);
  uidPairs.set(r.ical_uid, set);
}
const deletable = [...uidPairs.entries()]
  .filter(([, pairs]) => [...pairs].every((pid) => !KEEP_PAIRS.has(pid)))
  .map(([uid]) => uid);

const googleLib = await import('file:///opt/calsync/lib/google.js');
const oc = new googleLib.google.auth.OAuth2(cfg.googleClientId, cfg.googleClientSecret, cfg.googleRedirectUrl);
oc.setCredentials({ refresh_token: dbRaw.prepare('SELECT refresh_token FROM google_accounts LIMIT 1').get().refresh_token });
const client = new googleLib.GoogleCalendarClient(oc, { logger: { warn: () => {}, error: () => {} } });

const events = await client.listAllEvents(cal);
const targets = deletable.filter((uid) => events.has(uid));
console.log('DELETABLE_UIDS:', deletable.length, '| CALENDAR_PRESENT:', events.size, '| TO_DELETE_NOW:', targets.length);

let deleted = 0;
let failed = 0;
for (const uid of targets) {
  try {
    await client.deleteAllByUid(cal, uid);
    deleted += 1;
    if (deleted % 25 === 0) console.log('DELETED_SO_FAR:', deleted);
  } catch (err) {
    failed += 1;
    console.log('DELETE_FAILED:', String(uid).slice(0, 40), '|', String(err?.message ?? err).slice(0, 140));
  }
  await new Promise((r) => setTimeout(r, 100));
}

const after = await client.listAllEvents(cal);
console.log('DELETED:', deleted, '| FAILED:', failed, '| CALENDAR_EVENTS_AFTER:', after.size);
process.exit(0);
