// Verify dashboard-org migrations: tags + pair_tags tables, palette seeds.
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/calsync/data/calsync.db', { readOnly: true });
const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tags'").get();
const pt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pair_tags'").get();
const seeded = db.prepare('SELECT COUNT(*) AS n FROM tags').get();
const pairs = db.prepare('SELECT COUNT(*) AS n FROM pairs').get();
console.log('TAGS_TABLE:', Boolean(t));
console.log('PAIR_TAGS_TABLE:', Boolean(pt));
console.log('TAG_SLOTS_SEEDED:', seeded?.n ?? 0);
console.log('PAIRS_COUNT:', pairs?.n ?? 0);
