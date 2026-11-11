// Read-only status probe for the CalSync SQLite DB (run with sudo node).
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/calsync/data/calsync.db', { readOnly: true });
const acc = db.prepare('SELECT email, scope, length(refresh_token) AS tok_len FROM google_accounts').all();
console.log('GOOGLE_ACCOUNTS:', JSON.stringify(acc));
const pairs = db.prepare('SELECT id, name, feed_url, calendar_id, interval_minutes, enabled FROM pairs').all();
console.log('PAIRS:', JSON.stringify(pairs));
const cols = db.prepare("SELECT name FROM pragma_table_info('run_log')").all().map(c => c.name);
console.log('RUN_LOG_COLS:', cols.join(','));
const runs = db.prepare('SELECT * FROM run_log ORDER BY id DESC LIMIT 8').all();
console.log('RUNS:', JSON.stringify(runs));
const se = db.prepare('SELECT pair_id, COUNT(*) AS n FROM synced_events GROUP BY pair_id').all();
console.log('SYNCED_EVENTS:', JSON.stringify(se));
