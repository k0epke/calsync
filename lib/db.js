// SQLite state layer on top of the built-in node:sqlite (no native deps).
import fs from 'node:fs';
import path from 'node:path';

let DatabaseSyncClass = null;
async function getSqlite() {
  if (DatabaseSyncClass) return { DatabaseSync: DatabaseSyncClass };
  try {
    const mod = await import('node:sqlite');
    DatabaseSyncClass = mod.DatabaseSync ?? mod.default?.DatabaseSync;
    if (typeof DatabaseSyncClass !== 'function') {
      throw new Error(`node:sqlite exported no usable DatabaseSync class (keys: ${Object.getOwnPropertyNames(mod).join(',')})`);
    }
    return { DatabaseSync: DatabaseSyncClass };
  } catch (err) {
    throw new Error(
      `node:sqlite is unavailable (${err.message}). Use Node >= 23.4 (Node 24 recommended), ` +
      'or run Node >= 22.5 with --experimental-sqlite.',
    );
  }
}

export function nowIso() { return new Date().toISOString(); }

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS pairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  feed_url TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'url',
  calendar_id TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL DEFAULT 360 CHECK (interval_minutes >= 15),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT 'google',
  target_url TEXT
);
CREATE TABLE IF NOT EXISTS pair_status (
  pair_id INTEGER PRIMARY KEY REFERENCES pairs(id) ON DELETE CASCADE,
  running INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  last_success_at TEXT,
  last_status TEXT,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS synced_events (
  pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  ical_uid TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  content_hash TEXT,
  PRIMARY KEY (pair_id, ical_uid)
);
CREATE TABLE IF NOT EXISTS run_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  triggered_by TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT,
  fetched INTEGER NOT NULL DEFAULT 0,
  imported INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS google_accounts (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  refresh_token TEXT NOT NULL,
  email TEXT,
  scope TEXT,
  connected_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS icloud_accounts (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL,
  app_password TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_log_pair ON run_log(pair_id, id DESC);
`;

export async function openDatabase(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath.trim()) throw new Error('Database path is empty');
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const { DatabaseSync } = await getSqlite();
  const raw = new DatabaseSync(dbPath);
  raw.exec(SCHEMA);

  // Idempotent schema migration: CREATE TABLE IF NOT EXISTS cannot alter a
  // table that already exists, so databases created before content_hash was
  // introduced get the column via ALTER TABLE, guarded by pragma_table_info.
  // Rows created before the migration keep content_hash NULL; the sync engine
  // treats a NULL hash as "never matches" so such events re-import once and
  // then get hashed going forward.
  const syncedEventColumns = () =>
    raw.prepare("SELECT name FROM pragma_table_info('synced_events')").all().map((r) => String(r.name));
  if (!syncedEventColumns().includes('content_hash')) {
    raw.exec('ALTER TABLE synced_events ADD COLUMN content_hash TEXT');
  }

  // iCloud (CalDAV) build: pairs gained a source_type column ('url' default).
  // Databases created before it existed get the column via ALTER TABLE,
  // guarded by pragma_table_info; pre-migration rows read as 'url' pairs and
  // keep syncing exactly as before.
  const pairColumns = () =>
    raw.prepare("SELECT name FROM pragma_table_info('pairs')").all().map((r) => String(r.name));
  if (!pairColumns().includes('source_type')) {
    raw.exec("ALTER TABLE pairs ADD COLUMN source_type TEXT NOT NULL DEFAULT 'url'");
  }

  // ---- Two-way build: CalDAV targets + Google sources ----
  // pairs gained target_type ('google' default) + target_url (the caldav://
  // href when target_type = 'caldav'). Legacy rows read as Google-target
  // pairs and behave byte-identically to before (SQLite allows ADD COLUMN
  // with a NOT NULL DEFAULT).
  if (!pairColumns().includes('target_type')) {
    raw.exec("ALTER TABLE pairs ADD COLUMN target_type TEXT NOT NULL DEFAULT 'google'");
  }
  if (!pairColumns().includes('target_url')) {
    raw.exec('ALTER TABLE pairs ADD COLUMN target_url TEXT');
  }

  // SQLite cannot ALTER a CHECK constraint. Old databases created by the
  // one-way build carry CHECK (source_type IN ('url','caldav')) which would
  // reject the new 'google' source type. Simplest SAFE path (documented):
  // detect the CHECK in the stored CREATE statement and rebuild the table
  // exactly once WITHOUT it - source types are validated in code instead
  // (normalizeSourceType below + server.js). The rebuild follows the SQLite
  // ALTER TABLE recipe: foreign_keys OFF -> create pairs_new -> copy rows by
  // column name -> drop old -> rename -> foreign_key_check -> foreign_keys
  // ON. Child tables (pair_status, synced_events, run_log) keep referencing
  // "pairs" by name across the DROP+RENAME. Idempotent: the CHECK clause is
  // absent afterwards, so subsequent boots skip the rebuild.
  const pairsCreateSql = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pairs'").get()?.sql ?? '';
  if (/CHECK\s*\(\s*source_type/i.test(pairsCreateSql)) {
    raw.exec('PRAGMA foreign_keys = OFF');
    try {
      raw.exec('DROP TABLE IF EXISTS pairs_new');
      raw.exec(`CREATE TABLE pairs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        feed_url TEXT NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'url',
        calendar_id TEXT NOT NULL,
        interval_minutes INTEGER NOT NULL DEFAULT 360 CHECK (interval_minutes >= 15),
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        target_type TEXT NOT NULL DEFAULT 'google',
        target_url TEXT
      )`);
      const cols = pairColumns().map((c) => `"${c}"`).join(', ');
      raw.exec(`INSERT INTO pairs_new (${cols}) SELECT ${cols} FROM pairs`);
      raw.exec('DROP TABLE pairs');
      raw.exec('ALTER TABLE pairs_new RENAME TO pairs');
    } catch (err) {
      raw.exec('DROP TABLE IF EXISTS pairs_new');
      raw.exec('PRAGMA foreign_keys = ON');
      throw err;
    }
    raw.exec('PRAGMA foreign_keys = ON');
    let fkViolations = [];
    try { fkViolations = raw.prepare('PRAGMA foreign_key_check').all(); } catch { /* best-effort validation */ }
    if (fkViolations.length) {
      throw new Error(`pairs table rebuilt but foreign keys are inconsistent: ${JSON.stringify(fkViolations.slice(0, 3))}`);
    }
  }

  // ---- pairs ----
  // source_type is normalized at the boundary: 'caldav' and 'google' pass
  // through, anything else becomes 'url'. server.js validates further (the
  // source type must match the feed_url scheme). target_type normalizes to
  // 'google' unless exactly 'caldav'; no CHECK constraint - rebuilt legacy
  // tables must keep accepting both types, so validation stays in code.
  const normalizeSourceType = (v) => (v === 'caldav' || v === 'google' ? v : 'url');
  const normalizeTargetType = (v) => (v === 'caldav' ? 'caldav' : 'google');
  const listPairs = () => raw.prepare('SELECT * FROM pairs ORDER BY id').all();
  const getPair = (id) => raw.prepare('SELECT * FROM pairs WHERE id = ?').get(id) ?? null;
  const createPair = ({ name, feed_url, calendar_id, interval_minutes, source_type, target_type, target_url }) => {
    const at = nowIso();
    const res = raw.prepare(
      'INSERT INTO pairs (name, feed_url, source_type, calendar_id, interval_minutes, enabled, created_at, updated_at, target_type, target_url) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)',
    ).run(name, feed_url, normalizeSourceType(source_type), calendar_id ?? '', interval_minutes, at, at,
      normalizeTargetType(target_type), target_url ?? null);
    return getPair(Number(res.lastInsertRowid));
  };
  const updatePair = (id, patch) => {
    const allowed = ['name', 'feed_url', 'source_type', 'calendar_id', 'interval_minutes', 'enabled', 'target_type', 'target_url'];
    const setters = { source_type: normalizeSourceType, target_type: normalizeTargetType };
    const sets = [];
    const vals = [];
    for (const key of allowed) {
      if (key in patch) {
        sets.push(`${key} = ?`);
        vals.push(setters[key] ? setters[key](patch[key]) : patch[key]);
      }
    }
    if (!sets.length) return getPair(id);
    sets.push('updated_at = ?');
    vals.push(nowIso(), id);
    raw.prepare(`UPDATE pairs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return getPair(id);
  };
  const deletePair = (id) => { raw.prepare('DELETE FROM pairs WHERE id = ?').run(id); };

  // ---- pair status ----
  const getStatus = (pairId) => raw.prepare('SELECT * FROM pair_status WHERE pair_id = ?').get(pairId) ?? null;
  const setPairRunning = (pairId, running) => {
    raw.prepare(
      `INSERT INTO pair_status (pair_id, running) VALUES (?, ?)
       ON CONFLICT(pair_id) DO UPDATE SET running = excluded.running`,
    ).run(pairId, running ? 1 : 0);
  };
  const updatePairStatus = (pairId, { status = null, error = null, ranAt = true, success = false } = {}) => {
    const at = nowIso();
    raw.prepare(
      `INSERT INTO pair_status (pair_id, running, last_run_at, last_success_at, last_status, last_error)
       VALUES (?, 0, ?, ?, ?, ?)
       ON CONFLICT(pair_id) DO UPDATE SET
         running = 0,
         last_run_at = CASE WHEN ? THEN excluded.last_run_at ELSE pair_status.last_run_at END,
         last_success_at = CASE WHEN ? THEN excluded.last_run_at ELSE pair_status.last_success_at END,
         last_status = excluded.last_status,
         last_error = excluded.last_error`,
    ).run(pairId, at, success ? at : null, status, error, ranAt ? 1 : 0, success ? 1 : 0);
  };
  const listPairsWithStatus = () => {
    const pairs = listPairs();
    const counts = new Map(
      raw.prepare('SELECT pair_id, COUNT(*) AS c FROM synced_events GROUP BY pair_id').all().map((r) => [Number(r.pair_id), Number(r.c)]),
    );
    return pairs.map((p) => ({ ...p, synced_count: counts.get(Number(p.id)) ?? 0, ...getStatus(p.id) && {
      running: Number(getStatus(p.id).running ?? 0),
      last_run_at: getStatus(p.id).last_run_at,
      last_success_at: getStatus(p.id).last_success_at,
      last_status: getStatus(p.id).last_status,
      last_error: getStatus(p.id).last_error,
    } }));
  };

  // ---- run log ----
  const recordRun = (row) => {
    raw.prepare(
      `INSERT INTO run_log (pair_id, triggered_by, started_at, finished_at, status, fetched, imported, deleted, failed, cancelled, skipped, error, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.pair_id, row.triggered_by ?? null, row.started_at, row.finished_at ?? null, row.status ?? null,
      row.fetched ?? 0, row.imported ?? 0, row.deleted ?? 0, row.failed ?? 0, row.cancelled ?? 0,
      row.skipped ?? 0, row.error ?? null, row.detail ?? null,
    );
  };
  const listRuns = (pairId, limit = 25) =>
    raw.prepare('SELECT * FROM run_log WHERE pair_id = ? ORDER BY id DESC LIMIT ?').all(pairId, limit);

  // ---- synced events (import bookkeeping; drives deletion sync) ----
  const listSyncedUids = (pairId) =>
    raw.prepare('SELECT ical_uid FROM synced_events WHERE pair_id = ?').all(pairId).map((r) => String(r.ical_uid));
  // Map<ical_uid, content_hash>; migrated/pre-hash rows map to null.
  const listSyncedEventHashes = (pairId) =>
    new Map(raw.prepare('SELECT ical_uid, content_hash FROM synced_events WHERE pair_id = ?').all(pairId)
      .map((r) => [String(r.ical_uid), r.content_hash == null ? null : String(r.content_hash)]));
  const upsertSyncedEvent = (pairId, uid, at = nowIso(), contentHash = null) => {
    raw.prepare(
      `INSERT INTO synced_events (pair_id, ical_uid, last_seen_at, content_hash) VALUES (?, ?, ?, ?)
       ON CONFLICT(pair_id, ical_uid) DO UPDATE SET last_seen_at = excluded.last_seen_at, content_hash = excluded.content_hash`,
    ).run(pairId, uid, at, contentHash);
  };
  const removeSyncedEvent = (pairId, uid) => {
    raw.prepare('DELETE FROM synced_events WHERE pair_id = ? AND ical_uid = ?').run(pairId, uid);
  };

  // ---- google account ----
  const getGoogleAccount = () => raw.prepare('SELECT * FROM google_accounts WHERE id = 1').get() ?? null;
  const setGoogleAccount = ({ refresh_token, email = null, scope = null }) => {
    raw.prepare(
      `INSERT INTO google_accounts (id, refresh_token, email, scope, connected_at) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET refresh_token = excluded.refresh_token, email = excluded.email,
         scope = excluded.scope, connected_at = excluded.connected_at`,
    ).run(refresh_token, email, scope, nowIso());
  };
  const clearGoogleAccount = () => { raw.prepare('DELETE FROM google_accounts WHERE id = 1').run(); };

  // ---- icloud account (CalDAV sources; mirrors google_accounts) ----
  const getIcloudAccount = () => raw.prepare('SELECT * FROM icloud_accounts WHERE id = 1').get() ?? null;
  const setIcloudAccount = ({ username, app_password }) => {
    raw.prepare(
      `INSERT INTO icloud_accounts (id, username, app_password, updated_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET username = excluded.username, app_password = excluded.app_password,
         updated_at = excluded.updated_at`,
    ).run(username, app_password, nowIso());
  };

  // ---- dashboard users ----
  const getUser = (username) => raw.prepare('SELECT * FROM users WHERE username = ?').get(username) ?? null;
  const upsertUser = (username, passwordHash) => {
    const at = nowIso();
    raw.prepare(
      `INSERT INTO users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at`,
    ).run(username, passwordHash, at, at);
  };

  return {
    dbPath,
    _raw: raw,
    listPairs, getPair, createPair, updatePair, deletePair,
    getStatus, setPairRunning, updatePairStatus, listPairsWithStatus,
    recordRun, listRuns,
    listSyncedUids, listSyncedEventHashes, upsertSyncedEvent, removeSyncedEvent,
    getGoogleAccount, setGoogleAccount, clearGoogleAccount,
    getIcloudAccount, setIcloudAccount,
    getUser, upsertUser,
    close: () => { try { raw.close(); } catch { /* already closed */ } },
  };
}
