// Configuration loading: .env file (non-destructive) + environment variables.
// Secrets only ever come from environment variables or .env — never hardcoded.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');

export function loadEnvFile(filePath, target = process.env) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return false; }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length > 1 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    if (key && !(key in target)) target[key] = val; // real env vars win over .env
  }
  return true;
}

export function boolVal(v, dflt = false) {
  if (v == null || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

export function intOr(v, dflt) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

export function loadConfig(env = process.env) {
  const host = env.HOST || '127.0.0.1';
  const port = intOr(env.PORT, 8787);
  return {
    host,
    port,
    dbPath: env.CALSYNC_DB_PATH || path.join(ROOT_DIR, 'data', 'calsync.db'),
    adminUsername: env.ADMIN_USERNAME || 'admin',
    adminPassword: env.ADMIN_PASSWORD || '',
    sessionSecret: env.SESSION_SECRET || '',
    sessionCookieSecure: boolVal(env.SESSION_COOKIE_SECURE, false),
    trustProxy: boolVal(env.TRUST_PROXY, false),
    googleClientId: env.GOOGLE_CLIENT_ID || '',
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || '',
    googleRedirectUrl: env.GOOGLE_REDIRECT_URL || `http://127.0.0.1:${port}/oauth/callback`,
    // iCloud (CalDAV) source credentials: Apple ID username + app-specific
    // password, wired per deployment via env/.env (no dashboard connect flow
    // in this build - see README "iCloud (CalDAV) calendar source").
    icloudAppleId: env.ICLOUD_APPLE_ID || '',
    icloudAppPassword: env.ICLOUD_APP_PASSWORD || '',
    // Feature: Telegram failure alerts + daily digest. BOTH are disabled
    // unless token AND chat id are set (sendTelegramAlert no-ops, the digest
    // cron is never scheduled). Hour is clamped to 0-23 (default 8).
    alertTelegramToken: env.ALERT_TELEGRAM_TOKEN || '',
    alertTelegramChatId: env.ALERT_TELEGRAM_CHAT_ID || '',
    alertDigestHour: Math.min(23, Math.max(0, intOr(env.ALERT_DIGEST_HOUR, 8))),
    // Feature: generic CalDAV hosts. Default OFF - the CalDAV client only
    // speaks iCloud CalDAV unless this is explicitly enabled (see README
    // "Generic CalDAV hosts").
    caldavAllowAnyHost: boolVal(env.CALDAV_ALLOW_ANY_HOST, false),
    pushDelayMs: intOr(env.PUSH_DELAY_MS, 250),
    maxFeedBytes: intOr(env.MAX_FEED_BYTES, 10 * 1024 * 1024),
    fetchTimeoutMs: intOr(env.FETCH_TIMEOUT_MS, 30000),
    windowPastDays: intOr(env.WINDOW_PAST_DAYS, 30),
    windowFutureDays: intOr(env.WINDOW_FUTURE_DAYS, 365),
    loginWindowMs: intOr(env.LOGIN_WINDOW_MINUTES, 15) * 60_000,
    loginMaxAttempts: intOr(env.LOGIN_MAX_ATTEMPTS, 8),
    timezone: env.CALSYNC_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    logLevel: env.LOG_LEVEL || 'info',
  };
}
