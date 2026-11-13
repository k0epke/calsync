// Read-only: show the synced_events schema so the probe uses real column names.
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/calsync/data/calsync.db', { readOnly: true });
console.log(db.prepare("SELECT sql FROM sqlite_master WHERE name='synced_events'").get()?.sql);
