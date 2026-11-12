// Verify Tier-1 migrations: pairs.filters + pairs.copy_mode columns.
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/calsync/data/calsync.db', { readOnly: true });
const cols = db.prepare('PRAGMA table_info(pairs)').all().map(c => c.name);
console.log('COLUMNS_HAS_FILTERS:', cols.includes('filters'));
console.log('COLUMNS_HAS_COPY_MODE:', cols.includes('copy_mode'));
