// Verify iCloud migrations landed (icloud_accounts table + pairs.source_type).
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/calsync/data/calsync.db', { readOnly: true });
const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='icloud_accounts'").get();
const cols = db.prepare('PRAGMA table_info(pairs)').all().map(c => c.name);
console.log('ICLOUD_ACCOUNTS_TABLE:', Boolean(t));
console.log('PAIRS_SOURCE_TYPE:', cols.includes('source_type'));
