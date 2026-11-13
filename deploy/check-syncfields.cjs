// Verify sync_fields migration: pairs.sync_fields column landed.
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/calsync/data/calsync.db', { readOnly: true });
const cols = db.prepare('PRAGMA table_info(pairs)').all().map((c) => c.name);
console.log('COLUMNS_HAS_SYNC_FIELDS:', cols.includes('sync_fields'));
console.log('STORED_MASKS:', db.prepare('SELECT COUNT(*) AS n FROM pairs WHERE sync_fields IS NOT NULL').get().n);
