const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/calsync/data/calsync.db', { readOnly: true });
console.log('--- PAIRS:');
for (const p of db.prepare('SELECT id, name, target_type, calendar_id, target_url FROM pairs').all()) {
  console.log(`#${p.id} ${p.name} | tgt=${p.target_type} | cal=${String(p.calendar_id ?? '').slice(0, 40)} (${String(p.calendar_id ?? '').length}) | url=${String(p.target_url ?? '').slice(0, 40)}`);
}
console.log('--- CACHE:');
for (const r of db.prepare('SELECT target_key, label, updated_at FROM target_labels ORDER BY updated_at').all()) {
  console.log(`${r.target_key} = "${r.label}" (${r.updated_at})`);
}
