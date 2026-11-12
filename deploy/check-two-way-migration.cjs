// Verify two-way migrations: target columns + legacy CHECK removed.
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/calsync/data/calsync.db', { readOnly: true });
const cols = db.prepare('PRAGMA table_info(pairs)').all().map(c => c.name);
console.log('COLUMNS_HAS_TARGET_TYPE:', cols.includes('target_type'));
console.log('COLUMNS_HAS_TARGET_URL:', cols.includes('target_url'));
const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pairs'").get();
const legacy = sql && sql.sql && /CHECK\s*\(source_type IN \('url','caldav'\)\)/i.test(sql.sql);
console.log('LEGACY_CHECK_STILL_PRESENT:', legacy);
const targetCols = db.prepare('PRAGMA table_info(pairs)').all()
  .filter(c => c.name === 'target_type').map(c => c.dflt_value);
console.log('TARGET_TYPE_DEFAULT:', JSON.stringify(targetCols[0]));
