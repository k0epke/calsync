// Sync engine: fetch feed -> parse -> window filter -> plan -> Google import
// (sequential with delay + backoff) -> deletion pass -> SQLite bookkeeping.
// All external effects are injected via deps for testability.
import { fetchFeed as defaultFetchFeed } from './fetchfeed.js';
import { parseFeed as defaultParseFeed, toGoogleEvent, contentHashOf } from './icalparse.js';
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
    icloudFactory = () => null, // () => iCloud CalDAV client | null (CalDAV sources)
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
    const log = { fetched: 0, imported: 0, deleted: 0, failed: 0, cancelled: 0, skipped: 0, unchanged: 0, warnings: [], failures: [] };

    try {
      // 1) Fetch the source. Any failure here aborts BEFORE any Google
      //    mutation, so a dead feed can never wipe the calendar.
      //    source_type 'caldav' swaps the HTTP ICS fetch for the iCloud
      //    CalDAV client (one REPORT calendar-query over the same window);
      //    both paths yield the same normalized event model (see lib/
      //    caldav.js), so everything downstream stays identical.
      const window = computeWindow(clock.now(), config);
      let fetchedEvents, warnings, calendarName, vtimezoneStrings, sourceDesc;
      if ((pair.source_type ?? 'url') === 'caldav') {
        const cclcal = icloudFactory();
        if (!cclcal) {
          throw new SyncError('iCloud (CalDAV) source not configured - set ICLOUD_APPLE_ID and ICLOUD_APP_PASSWORD in .env and restart');
        }
        const res = await cclcal.fetchEvents(pair.feed_url, { start: window.start, end: window.end });
        fetchedEvents = res.events ?? [];
        warnings = res.warnings ?? [];
        calendarName = res.calendarName ?? null;
        vtimezoneStrings = res.vtimezoneStrings ?? [];
        sourceDesc = res.href || pair.feed_url;
      } else {
        const feed = await fetchFeedImpl(pair.feed_url, {
          maxBytes: config.maxFeedBytes,
          timeoutMs: config.fetchTimeoutMs,
          logger,
        });
        const parsed = parseFeedImpl(feed.text);
        fetchedEvents = parsed.events;
        warnings = parsed.warnings ?? [];
        calendarName = parsed.calendarName ?? null;
        vtimezoneStrings = parsed.vtimezoneStrings ?? [];
        sourceDesc = feed.finalUrl;
      }
      log.fetched = fetchedEvents.length;
      log.warnings = [...warnings].slice(0, 20);
      logger.info(`Pair ${pairId}: fetched ${log.fetched} event(s) from ${sourceDesc}${calendarName ? ` ("${calendarName}")` : ''}`);

      // 2) Window filter [now-30d, now+1y]; cancelled events pass through
      //    for the deletion planner. The CalDAV REPORT above uses exactly
      //    this window as its time-range, so server-side and client-side
      //    filtering agree.
      const present = filterEventsForWindow(fetchedEvents, window, { timezoneIcs: vtimezoneStrings });

      // 3) Plan the sync run (pure).
      const tracked = db.listSyncedUids(pairId);
      const plan = planSyncImpl({ trackedUids: tracked, events: present });
      log.cancelled = plan.stats.cancelled;
      log.skipped = plan.stats.skipped + (log.fetched - present.length);

      // 4) Google client from the stored refresh token.
      const gclient = googleFactory();
      if (!gclient) throw new SyncError('Google account not connected — connect it in the dashboard first');

      // 5) Skip-unchanged snapshot: ONE paginated read of the target calendar
      //    (maxResults 250/page, pageToken loop, showDeleted:false) plus the
      //    stored per-UID content hashes. The import pass below then only
      //    pushes events that are new, content-changed, or cancelled/missing
      //    on the Google side — burst runs stop re-writing every event,
      //    which is what pushed Google into 429 rate-limit territory. A read
      //    failure aborts here, before any write or delete, exactly like a
      //    feed failure does.
      const storedHashes = db.listSyncedEventHashes(pairId);
      const existingByUid = await gclient.listAllEvents(pair.calendar_id);

      // 6) Sequential import pass with small delay between pushes and
      //    exponential backoff inside the client. Per-event failures logged,
      //    run continues. Skip rule (no API write):
      //      (a) the iCalUID still exists in the target calendar AND
      //      (b) its copy is not cancelled (user-cancelled copies get
      //          repaired by re-import) AND
      //      (c) the stored content hash equals the hash of the event we
      //          would import. Absent from the map or a NULL/missing stored
      //          hash (e.g. migrated rows) always re-imports — so a user
      //          deleting an event inside Google Calendar gets it restored.
      for (const item of plan.import) {
        const gEvent = toGoogleEvent(item.event);
        const hash = contentHashOf(gEvent);
        const existing = existingByUid.get(item.uid);
        if (existing && existing.status !== 'cancelled' && storedHashes.get(item.uid) === hash) {
          log.unchanged += 1;
          continue;
        }
        try {
          await gclient.importEvent(pair.calendar_id, gEvent);
          db.upsertSyncedEvent(pairId, item.uid, new Date(clock.now()).toISOString(), hash);
          log.imported += 1;
        } catch (err) {
          log.failed += 1;
          log.failures.push(`import ${item.uid}: ${truncate(err.message)}`);
        }
        await delayFn(config.pushDelayMs);
      }

      // Safety rule: if EVERY attempted import failed (unchanged skips are
      // not attempts), odds are the Google session/auth broke — skip the
      // deletion pass so a transient outage can't mass-delete the calendar,
      // and surface the error.
      const attemptedImports = plan.import.length - log.unchanged;
      if (attemptedImports > 0 && log.imported === 0 && log.failed === attemptedImports) {
        db.recordRun({
          pair_id: pairId, triggered_by: trigger, started_at: startedAt,
          finished_at: new Date(clock.now()).toISOString(), status: 'error',
          ...log, cancelled: log.cancelled, skipped: log.skipped,
          error: `All ${attemptedImports} import attempt(s) failed (first: ${log.failures[0]}) — deletion pass skipped to protect the calendar`,
          detail: JSON.stringify({ failures: log.failures.slice(0, 50), warnings: log.warnings.slice(0, 20), unchanged: log.unchanged }),
        });
        db.updatePairStatus(pairId, { status: 'error', error: 'All imports failed — deletion pass skipped' });
        db.setPairRunning(pairId, false);
        return { status: 'error', error: `All ${attemptedImports} import attempt(s) failed — deletion pass skipped`, log };
      }

      // 7) Deletion pass: only iCalUIDs previously imported by us (synced_events)
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

      // 8) Persist run + status.
      const status = log.failed > 0 ? 'partial' : 'success';
      const finishedAt = new Date(clock.now()).toISOString();
      db.recordRun({
        pair_id: pairId, triggered_by: trigger, started_at: startedAt, finished_at: finishedAt,
        status, ...log,
        error: null,
        detail: JSON.stringify({ failures: log.failures.slice(0, 50), warnings: log.warnings.slice(0, 20), unchanged: log.unchanged }),
      });
      db.updatePairStatus(pairId, { status, error: log.failures.length ? log.failures[0] : null, ranAt: true, success: status === 'success' });
      db.setPairRunning(pairId, false);
      logger.info(`Pair ${pairId}: sync ${status} — ${log.imported} imported, ${log.unchanged} unchanged, ${log.deleted} deleted, ${log.failed} failed`);
      return { status, log, error: null };
    } catch (err) {
      const finishedAt = new Date(clock.now()).toISOString();
      db.recordRun({
        pair_id: pairId, triggered_by: trigger, started_at: startedAt, finished_at: finishedAt,
        status: 'error', ...log,
        error: truncate(err.message, 500),
        detail: JSON.stringify({ failures: log.failures.slice(0, 50), warnings: log.warnings.slice(0, 20), unchanged: log.unchanged }),
      });
      db.updatePairStatus(pairId, { status: 'error', error: truncate(err.message, 200) });
      db.setPairRunning(pairId, false);
      logger.warn(`Pair ${pairId}: sync error — ${err.message}`);
      return { status: 'error', error: err.message, log };
    }
  }

  return { runPair, isRunning };
}
