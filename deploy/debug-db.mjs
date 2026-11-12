// Debug: what does openDatabase actually return?
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { openDatabase } = await import('file:///C:/Users/r00t/.openclaw/workspace/calsync/lib/db.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calsync-debug-'));
const db = await openDatabase(path.join(dir, 'debug.db'));
const keys = Object.keys(db);
console.log('KEY COUNT:', keys.length);
console.log('KEYS:', keys.join(', '));
console.log('typeof getTargetLabel:', typeof db.getTargetLabel);
console.log('typeof setTargetLabel:', typeof db.setTargetLabel);
console.log('typeof listTags:', typeof db.listTags);
process.exit(0);
