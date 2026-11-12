// Telegram failure alerts + daily digest (self-hosted, optional).
//
// Config (lib/config.js): ALERT_TELEGRAM_TOKEN, ALERT_TELEGRAM_CHAT_ID,
// ALERT_DIGEST_HOUR (0-23, default 8, America/Chicago). Both alert channels
// are DISABLED unless token AND chat id are set: sendTelegramAlert no-ops,
// the engine hook degenerates to "success silent" and the digest cron is
// simply never scheduled.
//
// sendTelegramAlert posts ONE attempt (no retries) with a 10s timeout to
// https://api.telegram.org/bot<token>/sendMessage and NEVER throws: every
// failure is scrubbed of the token / chat id and logged instead.
//
// Redaction: token, the full bot<token> URL prefix and the chat id are
// scrubbed from any error or log line leaving this module (same discipline
// as lib/caldav.js scrubText). Secrets shorter than 4 chars are not scrubbed
// against to protect the message from degenerate replacements.
//   [CalSync] pair "<name>" (trigger) finished <status>: imported X,
//   deleted Y, failed Z - <first error line, truncated 300 chars>
// 'success' runs NEVER alert (the hook is a failure hook only). Bursts are
// capped in-memory: at most ONE alert per pair per 30 minutes.
//
// Daily digest: node-cron at minute 0, hour ALERT_DIGEST_HOUR,
// timezone America/Chicago:
//   CalSync daily digest: <enabled pairs> pairs - <N> success, <M> failed
//   in last 24h; last 10 runs: <one-line statuses>
// A defensive in-memory day-guard (America/Chicago calendar day) makes the
// digest a single send per day even if the callback fires twice.
import { cron } from './deps.js';

const ALERT_HTTP_TIMEOUT_MS = 10_000;
const DEDUP_WINDOW_MS = 30 * 60 * 1000;
const DIGEST_TZ = 'America/Chicago';
const DIGEST_MAX_RUNS_SAMPLED = 10;
const DIGEST_COUNT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DIGEST_COUNT_LIMIT = 500; // generous cap for the 24h counting query

// Scrub token / bot<token> / chat id out of any text leaving this module.
function scrubSecrets(text, { token, chatId }) {
  let s = String(text ?? '');
  const secrets = [token, token ? `bot${token}` : '', chatId == null ? '' : String(chatId)]
    .filter((v) => v && v.length >= 4);
  for (const secret of secrets) s = s.split(secret).join('[redacted]');
  return s;
}

function truncate(text, max = 300) {
  const s = String(text ?? '');
  return s.length > max ? s.slice(0, max) : s;
}

function firstErrorLine(text, max = 300) {
  return truncate(String(text ?? '').split('\n')[0] ?? '', max);
}

// Low-level Telegram send. cfg = { token, chatId }. Returns
// { sent: boolean, status?, reason? } and never throws.
export async function sendTelegramAlert(cfg, text, {
  fetchImpl = fetch,
  timeoutMs = ALERT_HTTP_TIMEOUT_MS,
  logger = { warn: () => {} },
} = {}) {
  const token = String(cfg?.token ?? '').trim();
  const chatId = String(cfg?.chatId ?? '').trim();
  if (!token || !chatId) return { sent: false, reason: 'disabled' };
  const scrub = (s) => scrubSecrets(s, { token, chatId });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Telegram sendMessage timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: String(text ?? '') }),
      signal: controller.signal,
    });
    if (!res?.ok) {
      const reason = scrub(`Telegram sendMessage failed with HTTP ${res?.status ?? 'n/a'}`);
      logger.warn(reason);
      return { sent: false, reason };
    }
    return { sent: true, status: res?.status ?? 200 };
  } catch (err) {
    const reason = scrub(err?.message ?? String(err));
    logger.warn(`Telegram alert not delivered: ${reason}`);
    return { sent: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

// Exact failure-hook message template (pinned; tested byte-for-byte).
export function runFailureMessage({ pair, trigger, status, log, error }) {
  const source = status === 'error'
    ? (error ?? log?.failures?.[0] ?? 'unknown error')
    : (log?.failures?.[0] ?? error ?? 'unknown failure');
  return `[CalSync] pair "${pair?.name ?? String(pair?.id ?? '?')}" (${trigger}) finished ${status}: `
    + `imported ${log?.imported ?? 0}, deleted ${log?.deleted ?? 0}, failed ${log?.failed ?? 0} `
    + `- ${firstErrorLine(source)}`;
}

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// Alert services wired into server.js (engine hook + digest cron) and tests.
// db only needs: listPairs(), listRecentRuns({ sinceIso, limit }).
export function createAlertServices({ config, db = null, logger = noopLogger, fetchImpl = fetch, now = () => Date.now() } = {}) {
  const cfg = {
    token: String(config?.alertTelegramToken ?? '').trim(),
    chatId: String(config?.alertTelegramChatId ?? '').trim(),
  };
  const credsSet = Boolean(cfg.token && cfg.chatId);
  const lastAlertAt = new Map(); // pairKey -> epoch ms of the last sent alert
  let lastDigestDay = null;
  let digestTask = null;
  const send = (text) => sendTelegramAlert(cfg, text, { fetchImpl, logger });

  // Engine failure hook. Called after EVERY run finalizes; 'success' is
  // silent, 'error'/'partial' alert at most once per pair per 30 minutes.
  async function notifyRunOutcome({ pair, trigger, status, log, error }) {
    if (!credsSet) return { sent: false, reason: 'disabled' };
    if (status !== 'error' && status !== 'partial') return { sent: false, reason: 'silent-status' };
    const key = String(pair?.id ?? pair?.name ?? '?');
    const t = now();
    const prev = lastAlertAt.get(key);
    if (prev != null && t - prev < DEDUP_WINDOW_MS) return { sent: false, reason: 'deduped' };
    lastAlertAt.set(key, t);
    return send(runFailureMessage({ pair, trigger, status, log, error }));
  }

  function runLine(r) {
    const at = String(r.started_at ?? '');
    const hhmm = at.length >= 16 ? at.slice(11, 16) : at;
    return `${hhmm} "${r.pair_name ?? r.pair_id}" ${r.status ?? '?'} (${r.imported ?? 0}i/${r.deleted ?? 0}d/${r.failed ?? 0}f)`;
  }

  function digestText() {
    const pairs = db.listPairs();
    const enabled = pairs.filter((p) => Number(p.enabled)).length;
    const since = new Date(now() - DIGEST_COUNT_WINDOW_MS).toISOString();
    const runs = db.listRecentRuns({ sinceIso: since, limit: DIGEST_COUNT_LIMIT });
    const success = runs.filter((r) => r.status === 'success').length;
    const failed = runs.filter((r) => r.status === 'partial' || r.status === 'error').length;
    const sample = runs.slice(0, DIGEST_MAX_RUNS_SAMPLED).map(runLine).join('; ');
    return `CalSync daily digest: ${enabled} pairs - ${success} success, ${failed} failed in last 24h; `
      + `last 10 runs: ${sample || 'none'}`;
  }

  async function sendDailyDigest() {
    if (!credsSet) return { sent: false, reason: 'disabled' };
    let day = null;
    try {
      day = new Intl.DateTimeFormat('en-CA', { timeZone: DIGEST_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now());
    } catch { day = new Date(now()).toISOString().slice(0, 10); }
    if (lastDigestDay === day) return { sent: false, reason: 'already-sent-today' };
    lastDigestDay = day;
    return send(digestText());
  }

  // Cron wiring: daily at ALERT_DIGEST_HOUR America/Chicago. Returns the cron
  // task or null when the alert credentials are unset (feature disabled).
  function startDailyDigest() {
    if (!credsSet) {
      logger.info('Telegram alerts disabled (ALERT_TELEGRAM_TOKEN / ALERT_TELEGRAM_CHAT_ID unset) - daily digest skipped');
      return null;
    }
    const rawHour = Number(config?.alertDigestHour);
    const hour = Number.isFinite(rawHour) ? Math.min(23, Math.max(0, Math.trunc(rawHour))) : 8;
    const expr = `0 ${hour} * * *`;
    digestTask = cron.schedule(expr, () => {
      sendDailyDigest().catch((err) => logger.warn(`Daily digest failed: ${err.message}`));
    }, { timezone: DIGEST_TZ, scheduled: true });
    try { digestTask.start(); } catch { /* already started by schedule() in some versions */ }
    logger.info(`Daily digest scheduled: "${expr}" ${DIGEST_TZ} (single send per day)`);
    return digestTask;
  }

  function stopAll() {
    if (digestTask) {
      try { digestTask.stop(); } catch { /* ignore */ }
      try { digestTask.destroy?.(); } catch { /* ignore */ }
      digestTask = null;
    }
  }

  // Test/exploration helper: the would-be digest body for the current state.
  const preview = { runFailureMessage, digestText, get lastDigestDay() { return lastDigestDay; } };

  return { notifyRunOutcome, sendDailyDigest, startDailyDigest, stopAll, _sendTelegramAlert: send, _preview: preview };
}
