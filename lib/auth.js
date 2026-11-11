// Dashboard auth: bcrypt-hashed admin account, login rate limiting, CSRF.
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

export const BCRYPT_ROUNDS = 10;

export function createRateLimiter({ max, windowMs, clock = { now: () => Date.now() } } = {}) {
  const hits = new Map(); // key -> { count, resetAt }
  return {
    check(key) {
      const now = clock.now();
      const entry = hits.get(key);
      if (!entry || now >= entry.resetAt) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return { ok: true, remaining: max - 1, retryAfterMs: 0 };
      }
      entry.count += 1;
      if (entry.count > max) return { ok: false, remaining: 0, retryAfterMs: Math.max(0, entry.resetAt - now) };
      return { ok: true, remaining: max - entry.count, retryAfterMs: 0 };
    },
    reset(key) { hits.delete(key); },
    resetAll() { hits.clear(); },
  };
}

// Creates the admin account from env config on first boot; refreshes the hash
// if ADMIN_PASSWORD changed. Password never stored in plaintext (bcryptjs).
export function ensureAdminUser(db, config) {
  const existing = db.getUser(config.adminUsername);
  if (!config.adminPassword) {
    if (existing) return { created: false, updated: false };
    // no password configured and no user yet -> caller must abort boot
    return { pending: true };
  }
  if (!existing) {
    db.upsertUser(config.adminUsername, bcrypt.hashSync(config.adminPassword, BCRYPT_ROUNDS));
    return { created: true, updated: false };
  }
  if (!bcrypt.compareSync(config.adminPassword, existing.password_hash)) {
    db.upsertUser(config.adminUsername, bcrypt.hashSync(config.adminPassword, BCRYPT_ROUNDS));
    return { created: false, updated: true };
  }
  return { created: false, updated: false };
}

export function verifyCredentials(userRow, password) {
  if (!userRow || typeof password !== 'string') return false;
  return bcrypt.compareSync(password, userRow.password_hash);
}

export function newCsrfToken() {
  return crypto.randomBytes(24).toString('hex');
}

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
