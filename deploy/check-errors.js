// Read-only probe: failed runs + pair status + totals (run with sudo node).
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/calsync/data/calsync.db', { readOnly: true });
const ps = db.prepare('SELECT * FROM pair_status').all();
console.log('PAIR_STATUS:', JSON.stringify(ps));
const runs = db.prepare("SELECT id, pair_id, triggered_by, started_at, finished_at, status, fetched, imported, deleted, failed, skipped, substr(error,1,200) AS error, substr(detail,1,400) AS detail FROM run_log ORDER BY id DESC LIMIT 12").all();
console.log('RECENT_RUNS:', JSON.stringify(runs));
const counts = db.prepare("SELECT status, COUNT(*) AS n FROM run_log GROUP BY status").all();
console.log('RUN_COUNTS:', JSON.stringify(counts));
const pairs = db.prepare('SELECT id, name, feed_url, interval_minutes, enabled FROM pairs').all();
console.log('PAIRS:', JSON.stringify(pairs));
