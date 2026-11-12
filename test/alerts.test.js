// Tier 1 feature tests: Telegram failure alerts + daily digest (lib/alerts.js),
// all mocked at the fetchImpl boundary, plus the engine failure-hook wiring.
// No network, no cloud.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../lib/db.js';
import { sendTelegramAlert, runFailureMessage, createAlertServices } from '../lib/alerts.js';
import { createSyncEngine } from '../lib/sync.js';
import { parseFeed } from '../lib/icalparse.js';
import { planSync } from '../lib/planner.js';
import { FIXED_NOW_MS, icsFor, veventFor, makeGoogleMock } from './helpers.js';

const TOKEN = '123456:ABC-token-secret-value';
const CHAT = '-1009988776655';
const TEST_NOW = FIXED_NOW_MS; // 2026-11-11T12:00:00Z -> Chicago day 2026-11-11
const FIXED_NOW = () => TEST_NOW;

function mockTelegram({ status = 200, body = '{"ok":true}' } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method, body: String(opts.body ?? ''), headers: opts.headers });
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

function captureLogger() {
  const lines = [];
  const push = (...a) => lines.push(a.join(' '));
  return { lines, warn: push, info: push, error: push, debug: push };
}

const CFG = (over = {}) => ({ alertTelegramToken: TOKEN, alertTelegramChatId: CHAT, alertDigestHour: 8, ...over });

// ---------------------------------------------------------------------------
// sendTelegramAlert (low-level)
// ---------------------------------------------------------------------------

test('sendTelegramAlert: disabled without token or chat id (no-op, no fetch)', async () => {
  const { calls, fetchImpl } = mockTelegram();
  for (const cfg of [{}, { token: TOKEN }, { chatId: CHAT }]) {
    const res = await sendTelegramAlert(cfg, 'hello', { fetchImpl });
    assert.deepEqual(res, { sent: false, reason: 'disabled' });
  }
  assert.equal(calls.length, 0, 'feature off = no network');
});

test('sendTelegramAlert: one POST to the bot URL with chat_id + text (single attempt)', async () => {
  const { calls, fetchImpl } = mockTelegram();
  const res = await sendTelegramAlert({ token: TOKEN, chatId: CHAT }, 'hello world', { fetchImpl });
  assert.equal(res.sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), { chat_id: CHAT, text: 'hello world' });
});

test('sendTelegramAlert: HTTP failure is one attempt, logged, never thrown', async () => {
  const { calls, fetchImpl } = mockTelegram({ status: 500, body: '{"ok":false}' });
  const logger = captureLogger();
  const res = await sendTelegramAlert({ token: TOKEN, chatId: CHAT }, 'x', { fetchImpl, logger });
  assert.equal(res.sent, false);
  assert.match(res.reason, /HTTP 500/);
  assert.ok(!res.reason.includes(TOKEN), 'token scrubbed from the reason');
  assert.equal(calls.length, 1, 'exactly ONE attempt, no retries');
  assert.ok(logger.lines.some((l) => l.includes('HTTP 500') && !l.includes(TOKEN)));
});

test('sendTelegramAlert: thrown errors are scrubbed of token AND chat id, still one attempt', async () => {
  const fetchImpl = async () => { throw new Error(`connect ECONNREFUSED bot${TOKEN} chat ${CHAT}`); };
  const logger = captureLogger();
  const res = await sendTelegramAlert({ token: TOKEN, chatId: CHAT }, 'x', { fetchImpl, logger });
  assert.equal(res.sent, false);
  assert.ok(!res.reason.includes(TOKEN) && !res.reason.includes(CHAT), 'both secrets redacted');
  assert.match(res.reason, /\[redacted\]/);
  assert.ok(logger.lines.every((l) => !l.includes(TOKEN) && !l.includes(CHAT)), 'log lines scrubbed too');
});

test('sendTelegramAlert: aborts after the timeout (still one attempt, no throw)', async () => {
  const fetchImpl = async (_url, opts = {}) => new Promise((_resolve, reject) => {
    opts.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const logger = captureLogger();
  const res = await sendTelegramAlert({ token: TOKEN, chatId: CHAT }, 'x', { fetchImpl, logger, timeoutMs: 25 });
  assert.equal(res.sent, false);
  assert.equal(logger.lines.length, 1, 'failure logged exactly once');
});

// ---------------------------------------------------------------------------
// runFailureMessage (exact template, pinned)
// ---------------------------------------------------------------------------

test('runFailureMessage: exact failure template, first error line only, truncated to 300', () => {
  const pair = { id: 7, name: 'Work feed' };
  assert.equal(
    runFailureMessage({ pair, trigger: 'scheduled', status: 'error', log: { imported: 2, deleted: 1, failed: 0 }, error: 'fetch failed\nHTTP 502 from upstream\nmore' }),
    '[CalSync] pair "Work feed" (scheduled) finished error: imported 2, deleted 1, failed 0 - fetch failed',
  );
  const partialLog = { imported: 3, deleted: 0, failed: 1, failures: ['import evt-x: 429 backend error\nretry hint'] };
  assert.equal(
    runFailureMessage({ pair, trigger: 'manual', status: 'partial', log: partialLog }),
    '[CalSync] pair "Work feed" (manual) finished partial: imported 3, deleted 0, failed 1 - import evt-x: 429 backend error',
  );
  const long = 'y'.repeat(500);
  const msg = runFailureMessage({ pair: { name: 'P' }, trigger: 't', status: 'error', log: {}, error: long });
  assert.ok(msg.length < 400, `error part truncated to 300 (got ${msg.length})`);
  assert.ok(msg.endsWith('y'.repeat(300)), 'error line truncated to exactly the first 300 chars');
  assert.equal(
    runFailureMessage({ pair: { id: 3 }, trigger: 'initial', status: 'error', log: {}, error: null }),
    '[CalSync] pair "3" (initial) finished error: imported 0, deleted 0, failed 0 - unknown error',
    'degenerate inputs fall back to the pair id and stay stable',
  );
});

// ---------------------------------------------------------------------------
// createAlertServices: engine hook + dedup
// ---------------------------------------------------------------------------

function servicesOf(over = {}) {
  const tg = mockTelegram();
  const logger = captureLogger();
  const services = createAlertServices({ config: CFG(over.cfg), db: over.db ?? null, fetchImpl: tg.fetchImpl, logger, now: over.now ?? FIXED_NOW });
  return { tg, logger, services };
}

test('notifyRunOutcome: error and partial alert with the pinned message; success is silent', async () => {
  const { tg, services } = servicesOf();
  const pair = { id: 1, name: 'Work feed' };
  await services.notifyRunOutcome({ pair, trigger: 'scheduled', status: 'success', log: { imported: 5, deleted: 0, failed: 0 } });
  assert.equal(tg.calls.length, 0, 'success never alerts on the failure hook');

  await services.notifyRunOutcome({
    pair, trigger: 'scheduled', status: 'error',
    log: { imported: 2, deleted: 1, failed: 0 }, error: 'feed boom',
  });
  assert.equal(tg.calls.length, 1);
  assert.deepEqual(JSON.parse(tg.calls[0].body),
    { chat_id: CHAT, text: '[CalSync] pair "Work feed" (scheduled) finished error: imported 2, deleted 1, failed 0 - feed boom' });

  await services.notifyRunOutcome({
    pair: { id: 2, name: 'Other' }, trigger: 'manual', status: 'partial',
    log: { imported: 1, deleted: 0, failed: 2, failures: ['delete uid-9: 404'] },
  });
  assert.deepEqual(JSON.parse(tg.calls[1].body),
    { chat_id: CHAT, text: '[CalSync] pair "Other" (manual) finished partial: imported 1, deleted 0, failed 2 - delete uid-9: 404' });
});

test('notifyRunOutcome: dedup max 1 alert per pair per 30 minutes (in-memory), per-pair keys', async () => {
  let nowMs = TEST_NOW;
  const { tg, services } = servicesOf({ now: () => nowMs });
  const pairA = { id: 1, name: 'A' };
  const pairB = { id: 2, name: 'B' };
  const outcome = (pair) => ({ pair, trigger: 'scheduled', status: 'error', log: { imported: 0, deleted: 0, failed: 1 }, error: 'boom' });

  assert.equal((await services.notifyRunOutcome(outcome(pairA))).sent, true);
  assert.equal((await services.notifyRunOutcome(outcome(pairA))).reason, 'deduped', 'burst suppressed');
  assert.equal((await services.notifyRunOutcome(outcome(pairA))).sent, false);
  assert.equal(tg.calls.length, 1, 'one alert per pair per window');

  nowMs += 29 * 60 * 1000;
  assert.equal((await services.notifyRunOutcome(outcome(pairA))).reason, 'deduped', 'still inside the window');
  nowMs += 2 * 60 * 1000; // past 30 minutes
  assert.equal((await services.notifyRunOutcome(outcome(pairA))).sent, true, 'window elapsed -> alert again');
  assert.equal(tg.calls.length, 2);

  assert.equal((await services.notifyRunOutcome(outcome(pairB))).sent, true, 'other pairs are deduped independently');
  assert.equal(tg.calls.length, 3);
});

test('notifyRunOutcome: disabled services never send (and never throw)', async () => {
  const { tg, services } = servicesOf({ cfg: { alertTelegramToken: '', alertTelegramChatId: '' } });
  const res = await services.notifyRunOutcome({ pair: { id: 1, name: 'P' }, trigger: 'manual', status: 'error', log: {}, error: 'x' });
  assert.deepEqual(res, { sent: false, reason: 'disabled' });
  assert.equal(tg.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Daily digest: body shape, once per day, disabled no-op, cron wiring
// ---------------------------------------------------------------------------

async function digestDb() {
  const db = await openDatabase(':memory:');
  const p1 = db.createPair({ name: 'P1', feed_url: 'x', calendar_id: 'c', interval_minutes: 60 });
  const p2 = db.createPair({ name: 'P2', feed_url: 'y', calendar_id: 'c', interval_minutes: 60 });
  const pOff = db.createPair({ name: 'Off', feed_url: 'z', calendar_id: 'c', interval_minutes: 60 });
  db.updatePair(pOff.id, { enabled: 0 });
  const run = (pairId, started_at, status, { imported = 0, deleted = 0, failed = 0 } = {}) => db.recordRun({
    pair_id: pairId, triggered_by: 'scheduled', started_at, finished_at: started_at, status, imported, deleted, failed,
  });
  // Inside the 24h window (relative to 2026-11-11T12:00Z):
  run(p1.id, '2026-11-11T07:52:00Z', 'success', { imported: 2 });
  run(p2.id, '2026-11-11T09:30:00Z', 'partial', { imported: 1, failed: 1 });
  // Outside the window (older than 24h) - must not be counted:
  run(p1.id, '2026-11-10T06:00:00Z', 'success');
  // Insert order (=> run_log id order): the sample lists them newest-first.
  return { db, p1, p2, pOff };
}

test('daily digest: body shape (enabled pairs, 24h success/failed counts, last 10 runs newest-first)', async () => {
  const { db, p1, p2 } = await digestDb();
  const { tg, services } = servicesOf({ db });
  // One more in-window run after the sample window starts so ordering shows.
  db.recordRun({ pair_id: p2.id, triggered_by: 'manual', started_at: '2026-11-11T11:05:00Z', finished_at: '2026-11-11T11:06:00Z', status: 'success', imported: 1 });

  const res = await services.sendDailyDigest();
  assert.equal(res.sent, true);
  assert.equal(tg.calls.length, 1);
  const text = JSON.parse(tg.calls[0].body).text;
  assert.equal(
    text,
    'CalSync daily digest: 2 pairs - 2 success, 1 failed in last 24h; last 10 runs: '
    + '11:05 "P2" success (1i/0d/0f); 09:30 "P2" partial (1i/0d/1f); 07:52 "P1" success (2i/0d/0f)',
    'pinned digest format: enabled pair count, 24h counts, newest-first one-liners',
  );
  assert.match(tg.calls[0].body, /P2/, 'pair names inside the one-liners');
  assert.ok(!text.includes('Off'), 'disabled pairs counted out / not listed beyond pairs count');

  // once per calendar day (defensive day-guard on top of the daily cron)
  const second = await services.sendDailyDigest();
  assert.deepEqual(second, { sent: false, reason: 'already-sent-today' });
  assert.equal(tg.calls.length, 1);
  db.close();
});

test('daily digest: no runs in 24h renders "last 10 runs: none"; disabled services never send', async () => {
  const db = await openDatabase(':memory:');
  db.createPair({ name: 'Lonely', feed_url: 'x', calendar_id: 'c', interval_minutes: 60 });
  const { tg, services } = servicesOf({ db });
  const res = await services.sendDailyDigest();
  assert.equal(res.sent, true);
  const text = JSON.parse(tg.calls[0].body).text;
  assert.equal(text, 'CalSync daily digest: 1 pairs - 0 success, 0 failed in last 24h; last 10 runs: none');

  const off = servicesOf({ db, cfg: { alertTelegramToken: TOKEN, alertTelegramChatId: '' } });
  assert.deepEqual(await off.services.sendDailyDigest(), { sent: false, reason: 'disabled' });
  assert.equal(off.tg.calls.length, 0);
  db.close();
});

test('startDailyDigest: null without credentials (never scheduled), cron expr + tz with credentials', async () => {
  const db = await openDatabase(':memory:');
  const off = servicesOf({ cfg: { alertTelegramToken: '', alertTelegramChatId: CHAT } });
  assert.equal(off.services.startDailyDigest(), null);
  assert.equal(off.tg.calls.length, 0);
  assert.ok(off.logger.lines.some((l) => /disabled/.test(l)), 'disabled state is logged');

  const on = servicesOf({ cfg: { alertDigestHour: 8 } });
  const task = on.services.startDailyDigest();
  assert.ok(task, 'cron task exists when enabled');
  on.services.stopAll(); // clean shutdown path

  const late = servicesOf({ cfg: { alertDigestHour: 23 } });
  const task2 = late.services.startDailyDigest();
  assert.ok(task2);
  late.services.stopAll();
  db.close();
});

// ---------------------------------------------------------------------------
// Engine wiring: the failure hook fires after runs finalize (error + dedup)
// ---------------------------------------------------------------------------

const FEED_FAIL = icsFor([
  veventFor(['UID:evt-a', 'DTSTART:20261115T090000Z', 'DTEND:20261115T093000Z', 'SUMMARY:Event A']),
  veventFor(['UID:evt-b', 'DTSTART:20261116T090000Z', 'DTEND:20261116T100000Z', 'SUMMARY:Event B']),
]);

test('engine x alerts: failing run alerts once; repeated failing runs stay deduped; success silent', async () => {
  const db = await openDatabase(':memory:');
  const tg = mockTelegram();
  const alerts = createAlertServices({ config: CFG(), fetchImpl: tg.fetchImpl, logger: captureLogger(), now: FIXED_NOW });
  const engine = createSyncEngine({
    db,
    config: { pushDelayMs: 0, maxFeedBytes: 1024 * 1024, fetchTimeoutMs: 5000, windowPastDays: 30, windowFutureDays: 365 },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    googleFactory: () => makeGoogleMock({ failAllWith: 'mock 500 outage' }).client,
    icloudFactory: () => null,
    fetchFeedImpl: async () => ({ text: FEED_FAIL, finalUrl: 'x', status: 200 }),
    parseFeedImpl: parseFeed,
    planSyncImpl: planSync,
    clock: { now: () => FIXED_NOW_MS },
    delayFn: async () => {},
    alerts,
  });
  const pair = db.createPair({ name: 'Outage pair', feed_url: 'https://feed.example/cal.ics', calendar_id: 'cal-target', interval_minutes: 60 });

  const r1 = await engine.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(r1.status, 'error', 'all imports failed -> error');
  assert.equal(tg.calls.length, 1, 'one alert after the run finalized');
  assert.deepEqual(JSON.parse(tg.calls[0].body), {
    chat_id: CHAT,
    text: '[CalSync] pair "Outage pair" (scheduled) finished error: imported 0, deleted 0, failed 2'
      + ' - All 2 import attempt(s) failed — deletion pass skipped',
  });

  const r2 = await engine.runPair(pair.id, { trigger: 'scheduled' });
  assert.equal(r2.status, 'error');
  assert.equal(tg.calls.length, 1, 'burst dedup: failing again within the 30-minute window sends nothing');

  // A second successful pair must never alert.
  const okHolder = makeGoogleMock();
  const engineOk = createSyncEngine({
    db,
    config: { pushDelayMs: 0, maxFeedBytes: 1024 * 1024, fetchTimeoutMs: 5000, windowPastDays: 30, windowFutureDays: 365 },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    googleFactory: () => okHolder.client,
    icloudFactory: () => null,
    fetchFeedImpl: async () => ({ text: FEED_FAIL, finalUrl: 'x', status: 200 }),
    parseFeedImpl: parseFeed,
    planSyncImpl: planSync,
    clock: { now: () => FIXED_NOW_MS },
    delayFn: async () => {},
    alerts,
  });
  const okPair = db.createPair({ name: 'Good pair', feed_url: 'https://feed.example/cal.ics', calendar_id: 'cal-target', interval_minutes: 60 });
  const rOk = await engineOk.runPair(okPair.id, { trigger: 'manual' });
  assert.equal(rOk.status, 'success');
  assert.equal(okHolder.calls.imports.length, 2);
  assert.equal(tg.calls.length, 1, 'success run added NO alert (and dedup keys are per pair anyway)');
  db.close();
});
