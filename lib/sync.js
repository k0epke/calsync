// Sync engine: fetch feed -> parse -> window filter -> plan -> Google import
// (sequential with delay + backoff) -> deletion pass -> SQLite bookkeeping.
// All external effects are injected via deps for testability.
import { fetchFeed as defaultFetchFeed } from './fetchfeed.js';
import { parseFeed as defaultParseFeed, toGoogleEvent } from './icalparse.js';
import { planSync as defaultPlanSync } from './planner.js';
import { computeWindow, filterEventsForWindow } from './recurrence.js';

export class SyncError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'SyncError';
    if (cause) this.cause = cause;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function truncate(text, max = 160) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function createSyncEngine(deps) {
  const {
    db,
    config,
    logger,
    googleFactory, // () => GoogleCalendarClient | null
    fetchFeedImpl = defaultFetchFeed,
    parseFeedImpl = defaultParseFeed,
    planSyncImpl = defaultPlanSync,
    clock = { now: () => Date.now() },
    delayFn = sleep,
  } = deps;

  const running = new Map(); // pairId -> Promise<result>

  function isRunning(pairId) { return running.has(String(pairId)); }

  async function runPair(pairId, { trigger = 'manual' } = {}) {
    const key = String(pairId);
    if (running.has(key)) {
      const err = new SyncError('Sync already running for this pair');
      err.alreadyRunning = true;
      throw err;
    }
    const promise = (async () => {
      try {
        return await execute(key, { trigger });
      } finally {
        running.delete(key);
      }
    })();
    running.set(key, promise);
    return promise;
  }

  async function execute(pairId, { trigger }) {
    const pair = db.getPair(pairId);
    if (!pair) throw new SyncError(`Pair ${pairId} not found`);
    const startedAtMs = clock.now();
    const startedAt = new Date(startedAtMs).toISOString();
    db.setPairRunning(pairId, true);
    db.updatePairStatus(pairId, { ranAt: false }); // ensure row exists while running
    const log = { fetched: 0, imported: 0, deleted: 0, failed: 0, cancelled: 0, skipped: 0, warnings: [], failures: [] };

    try {
      // 1) Fetch + parse the feed. Any failure here aborts BEFORE any
      //    Google mutation, so a dead feed can never wipe the calendar.
      const feed = await fetchFeedImpl(pair.feed_url, {
        maxBytes: config.maxFeedBytes,
        timeoutMs: config.fetchTimeoutMs,
        logger,
      });
      const parsed = parseFeedImpl(feed.text);
      log.fetched = parsed.events.length;
      log.warnings = [...parsed.warnings].slice(0, 20);
      logger.info(`Pair ${pairId}: fetched ${log.fetched} event(s) from ${feed.finalUrl}${parsed.calendarName ? ` ("${parsed.calendarName}")` : ''}`);

      // 2) Window filter [now-30d, now+1y]; cancelled events pass through
      //    for the deletion planner.
      const window = computeWindow(clock.now(), config);
      const present = filterEventsForWindow(parsed.events, window, { timezoneIcs: parsed.vtimezoneStrings });

      // 3) Plan the sync run (pure).
      const tracked = db.listSyncedUids(pairId);
      const plan = planSyncImpl({ trackedUids: tracked, events: present });
      log.cancelled = plan.stats.cancelled;
      log.skipped = plan.stats.skipped + (log.fetched - present.length);

      // 4) Google client from the stored refresh token.
      const gclient = googleFactory();
      if (!gclient) throw new SyncError('Google account not connected — connect it in the dashboard first');

      // 5) Sequential import pass with small delay between pushes and
      //    exponential backoff inside the client. Per-event failures logged,
      //    run continues.
      for (const item of plan.import) {
        try {
          await gclient.importEvent(pair.calendar_id, toGoogleEvent(item.event));
          db.upsertSyncedEvent(pairId, item.uid, new Date(clock.now()).toISOString());
          log.imported += 1;
        } catch (err) {
          log.failed += 1;
          log.failures.push(`import ${item.uid}: ${truncate(err.message)}`);
        }
        await delayFn(config.pushDelayMs);
      }

      // Safety rule: if EVERY attempted import failed, odds are the Google
      // session/auth broke — skip the deletion pass so a transient outage
      // can't mass-delete the calendar, and surface the error.
      if (plan.import.length > 0 && log.imported === 0 && log.failed === plan.import.length) {
        db.recordRun({
          pair_id: pairId, triggered_by: trigger, started_at: startedAt,
          finished_at: new Date(clock.now()).toISOString(), status: 'error',
          ...log, cancelled: log.cancelled, skipped: log.skipped,
          error: `All ${plan.import.length} import attempt(s) failed (first: ${log.failures[0]}) — deletion pass skipped to protect the calendar`,
          detail: JSON.stringify({ failures: log.failures.slice(0, 50), warnings: log.warnings.slice(0, 20) }),
        });
        db.updatePairStatus(pairId, { status: 'error', error: 'All imports failed — deletion pass skipped' });
        db.setPairRunning(pairId, false);
        return { status: 'error', error: `All ${plan.import.length} import attempt(s) failed — deletion pass skipped`, log };
      }

      // 6) Deletion pass: only iCalUIDs previously imported by us (synced_events)
      //    that vanished from the current feed. User-created events in the
      //    target calendar are never touched.
      for (const uid of plan.delete) {
        try {
          const n = await gclient.deleteAllByUid(pair.calendar_id, uid);
          db.removeSyncedEvent(pairId, uid);
          log.deleted += n;
        } catch (err) {
          log.failed += 1;
          log.failures.push(`delete ${uid}: ${truncate(err.message)}`);
        }
        await delayFn(config.pushDelayMs);
      }

      // 7) Persist run + status.
      const status = log.failed > 0 ? 'partial' : 'success';
      const finishedAt = new Date(clock.now()).toISOString();
      db.recordRun({
        pair_id: pairId, triggered_by: trigger, started_at: startedAt, finished_at: finishedAt,
        status, ...log,
        error: null,
        detail: JSON.stringify({ failures: log.failures.slice(0, 50), warnings: log.warnings.slice(0, 20) }),
      });
      db.updatePairStatus(pairId, { status, error: log.failures.length ? log.failures[0] : null, ranAt: true, success: status === 'success' });
      db.setPairRunning(pairId, false);
      logger.info(`Pair ${pairId}: sync ${status} — ${log.imported} imported, ${log.deleted} deleted, ${log.failed} failed`);
      return { status, log, error: null };
    } catch (err) {
      const finishedAt = new Date(clock.now()).toISOString();
      db.recordRun({
        pair_id: pairId, triggered_by: trigger, started_at: startedAt, finished_at: finishedAt,
        status: 'error', ...log,
        error: truncate(err.message, 500),
        detail: JSON.stringify({ failures: log.failures.slice(0, 50), warnings: log.warnings.slice(0, 20) }),
      });
      db.updatePairStatus(pairId, { status: 'error', error: truncate(err.message, 200) });
      db.setPairRunning(pairId, false);
      logger.warn(`Pair ${pairId}: sync error — ${err.message}`);
      return { status: 'error', error: err.message, log };
    }
  }

  return { runPair, isRunning };
}
