// Probe: does the icloud_accounts row exist (username + password length only)?
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/calsync/data/calsync.db', { readOnly: true });
const row = db.prepare('SELECT username, length(app_password) AS pw_len FROM icloud_accounts').get();
console.log('ICLOUD_ROW:', JSON.stringify(row ?? null));
