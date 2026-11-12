// Verify target_labels cache table landed and show resolved labels.
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/calsync/data/calsync.db', { readOnly: true });
const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='target_labels'").get();
console.log('TARGET_LABELS_TABLE:', Boolean(t));
const rows = db.prepare('SELECT target_key, label, updated_at FROM target_labels ORDER BY target_key').all();
console.log('CACHE_ROWS:', rows.length);
for (const r of rows) console.log('LABEL:', r.label, '(at', r.updated_at + ')');
