// Sync engine: fetch feed -> parse -> window filter -> plan -> Google import
// (sequential with delay + backoff) -> deletion pass -> SQLite bookkeeping.
// All external effects are injected via deps for testability.
import { fetchFeed as defaultFetchFeed } from './fetchfeed.js';
import {
  parseFeed as defaultParseFeed,
  toGoogleEvent,
  contentHashOf,
  canonicalEventHash,
  googleItemToEvent,
} from './icalparse.js';
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

// ---------------------------------------------------------------------------
// Pair semantics: source/target kinds plus the guards shared by server.js
// (strict validation at pair create/update) and the engine (belt-and-braces
// check before every run, so rows edited outside the dashboard can never
// self-mirror or fall into a sync loop).
// ---------------------------------------------------------------------------

export const SOURCE_TYPES = Object.freeze(['url', 'caldav', 'google']);
export const TARGET_TYPES = Object.freeze(['google', 'caldav']);

export function targetKindOf(pair) {
  return pair?.target_type === 'caldav' ? 'caldav' : 'google';
}

// CalDAV href identity: caldav:// and https:// forms of the same collection
// compare equal, trailing slashes are ignored, host case-insensitive.
function caldavHrefKey(url) {
  try {
    const u = new URL(String(url ?? '').trim().replace(/^caldav:\/\//i, 'https://'));
    if (u.protocol !== 'https:' || !u.host) return null;
    return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

// Returns a human-readable conflict message, or null when the pair may run.
export function pairSemanticError(pair) {
  const source = String(pair?.source_type ?? 'url');
  const target = targetKindOf(pair);
  if (source === 'google' && target === 'google') {
    return 'Google-as-source into a Google target is a degenerate no-op mirror - rejected at pair create/update.';
  }
  if (source === 'caldav' && target === 'caldav') {
    const a = caldavHrefKey(pair.feed_url);
    const b = caldavHrefKey(pair.target_url);
    if (a && b && a === b) {
      return 'Source and target resolve to the same CalDAV calendar - mirroring a calendar onto itself is rejected.';
    }
  }
  return null;
}

// Engine-side extraction of the calendar id from a google:// source URL.
// Strict validation happens at pair create/update (lib/google.js
// parseGoogleSourceUrl); the engine only extracts the id so the sync module
// stays outside the googleapis import graph.
function googleSourceCalendarId(feedUrl) {
  const m = /^google:\/\/(.+)$/i.exec(String(feedUrl ?? '').trim());
  const id = m?.[1]?.trim();
  if (!id) {
    throw new SyncError(`Google source pairs encode the calendar as google://<calendarId> - got "${truncate(feedUrl, 100)}"`);
  }
  return id;
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

  // -----------------------------------------------------------------------
  // Target adapters. The planner, deletion planning, skip rules, run_log
  // bookkeeping, partial-failure protections, unchanged counting, isRunning
  // guard and scheduler are target-agnostic; only the storage calls differ.
  // Interface:
  // {
  //   kind: 'google' | 'caldav',
  //   assertConfigured(): throws SyncError when the client/credentials are
  //                       missing - called before ANY snapshot read or write,
  //   snapshot(start, end): Promise<Map<uid, { ref, status }>> - exactly ONE
  //                       target read per run, before any write; a read
  //                       failure aborts the whole run;
  //   upsert(event):      Promise<{ wrote: boolean }> - writes only when the
  //                       skip rules say so; throws on storage failure,
  //   deleteEventByUid(uid): Promise<number deleted> - tolerant of
  //                       already-gone resources (counts 0 instead).
  // }
  // The google adapter wraps the EXISTING proven lib/google.js functions
  // (listAllEvents / importEvent / deleteAllByUid) - none of them changed.
  // -----------------------------------------------------------------------
  function makeGoogleTargetAdapter(pair, gclient, ctx) {
    const assertConfigured = () => {
      if (!gclient) {
        throw new SyncError('Google account not connected — connect it in the dashboard first');
      }
    };
    let snapshotMap = new Map();
    return {
      kind: 'google',
      assertConfigured,
      async snapshot(start, end) { // eslint-disable-line no-unused-vars
        assertConfigured();
        const map = await gclient.listAllEvents(pair.calendar_id);
        // listAllEvents already returns Map<iCalUID, {eventId, status}> -
        // normalized to the adapter's { ref, status } shape (ref = eventId).
        snapshotMap = new Map([...map].map(([uid, v]) => [uid, { ref: v.eventId, status: String(v.status ?? '') }]));
        return snapshotMap;
      },
      async upsert(event) {
        assertConfigured();
        const gEvent = toGoogleEvent(event);
        const hash = contentHashOf(gEvent);
        const existing = snapshotMap.get(event.uid);
        // Skip rule (unchanged behavior): (a) the iCalUID still exists in the
        // target calendar, (b) its copy is not cancelled, (c) the stored
        // content hash equals the hash of the event we would import. A NULL/
        // missing stored hash always re-imports (migrated rows, user-deleted
        // events get restored).
        if (existing && existing.status !== 'cancelled' && ctx.storedHashes.get(event.uid) === hash) {
          return { wrote: false };
        }
        await gclient.importEvent(pair.calendar_id, gEvent);
        ctx.db.upsertSyncedEvent(ctx.pairId, event.uid, new Date(ctx.clock.now()).toISOString(), hash);
        return { wrote: true, hash };
      },
      async deleteEventByUid(uid) {
        assertConfigured();
        return gclient.deleteAllByUid(pair.calendar_id, uid);
      },
    };
  }

  function makeCaldavTargetAdapter(pair, client, ctx) {
    const assertConfigured = () => {
      if (!client) {
        throw new SyncError('iCloud (CalDAV) target not configured - set ICLOUD_APPLE_ID and ICLOUD_APP_PASSWORD in .env and restart');
      }
    };
    let snapshotMap = new Map();
    return {
      kind: 'caldav',
      assertConfigured,
      async snapshot(start, end) {
        assertConfigured();
        snapshotMap = await client.snapshotCalendar(pair.target_url, { start, end });
        return new Map([...snapshotMap].map(([uid, v]) => [uid, { ref: v.etag, status: v.status }]));
      },
      async upsert(event) {
        assertConfigured();
        // Skip rule: the remote copy exists, is not cancelled, and its LIVE
        // parsed content compares equal to the event we would write. Both
        // sides normalize through canonicalEventHash (toGoogleEvent's
        // CONTENT_HASH_FIELDS subset minus COMPARE_EXCLUDED_FIELDS - i.e.
        // SEQUENCE is dropped, because CalDAV servers may renumber it on
        // store and Google assigns its own sequence on import; comparing it
        // would make mirrored pairs chase each other's metadata). The stored
        // per-UID hash is deliberately NOT consulted here: the live remote
        // comparison is the stronger, self-healing check (user edits inside
        // iCloud are overwritten per "source is authority").
        const existing = snapshotMap.get(event.uid);
        const writeHash = canonicalEventHash(event);
        if (existing && existing.status !== 'cancelled' && existing.event) {
          if (canonicalEventHash(existing.event) === writeHash) return { wrote: false };
        }
        await client.putEvent(pair.target_url, event, {
          ifMatchEtag: existing?.etag ?? null,
          start: ctx.window?.start,
          end: ctx.window?.end,
        });
        ctx.db.upsertSyncedEvent(ctx.pairId, event.uid, new Date(ctx.clock.now()).toISOString(), writeHash);
        return { wrote: true, hash: writeHash };
      },
      async deleteEventByUid(uid) {
        assertConfigured();
        const gone = await client.deleteEventByUid(pair.target_url, uid);
        return gone ? 1 : 0;
      },
    };
  }

  function resolveTargetAdapter(pair, { window: runWindow }) {
    const ctx = {
      db,
      pairId: pair.id,
      clock,
      storedHashes: db.listSyncedEventHashes(pair.id),
      window: runWindow,
    };
    return targetKindOf(pair) === 'caldav'
      ? makeCaldavTargetAdapter(pair, icloudFactory(), ctx)
      : makeGoogleTargetAdapter(pair, googleFactory(), ctx);
  }

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
      // 0) Pair semantic guards (G->G rejection, same-calendar guard). These
      //    are enforced at pair create/update as well; re-checked here so a
      //    row edited outside the dashboard can never self-mirror or loop.
      const semanticError = pairSemanticError(pair);
      if (semanticError) throw new SyncError(semanticError);

      // 1) Fetch the source. Any failure here aborts BEFORE any target
      //    mutation, so a dead source can never wipe the target calendar.
      //    source_type 'caldav' swaps the HTTP ICS fetch for the iCloud
      //    CalDAV client (one REPORT calendar-query over the same window);
      //    source_type 'google' reads a Google calendar through the same
      //    paginated events.list skeleton via snapshotSourceEvents and maps
      //    the resources through googleItemToEvent. All paths yield the same
      //    normalized event model (see lib/caldav.js and lib/icalparse.js),
      //    so everything downstream stays identical.
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
      } else if ((pair.source_type ?? 'url') === 'google') {
        const gsource = googleFactory();
        if (!gsource) throw new SyncError('Google account not connected — connect it in the dashboard first');
        const sourceCalendarId = googleSourceCalendarId(pair.feed_url);
        const res = await gsource.snapshotSourceEvents(sourceCalendarId);
        const warningsList = [...(res.warnings ?? [])];
        fetchedEvents = [];
        for (const item of res.events ?? []) {
          try {
            fetchedEvents.push(googleItemToEvent(item));
          } catch (err) {
            warningsList.push(`Skipped Google event (${truncate(item?.id ?? '?', 40)}): ${err.message}`);
          }
        }
        warnings = warningsList;
        calendarName = null;
        vtimezoneStrings = [];
        sourceDesc = `google://${sourceCalendarId}`;
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

      // 4) Target adapter. assertConfigured() throws at exactly the point
      //    where the old flow raised 'Google account not connected' (after
      //    planning, before any snapshot read or write); CalDAV targets get
      //    the analogous iCloud-credentials error there.
      const target = resolveTargetAdapter(pair, { window });
      target.assertConfigured();

      // 5) Skip-unchanged snapshot: ONE read of the target calendar before
      //    any write (Google: paginated events.list via listAllEvents;
      //    CalDAV: one REPORT calendar-query via snapshotCalendar). The read
      //    itself is the run's snapshot-before-write gate. A read failure
      //    aborts here, before any write or delete, exactly like a feed
      //    failure does.
      await target.snapshot(window.start, window.end);

      // 6) Sequential import pass with a small delay between attempted
      //    pushes and exponential backoff inside the client. Per-event
      //    failures are logged, the run continues. The skip rules live in
      //    the adapter (see the adapter factories above): a target copy that
      //    exists, is not cancelled, and compares equal is counted as
      //    'unchanged' (no API write) - burst runs stop re-writing every
      //    event. Unchanged items take no delay, exactly like before; after
      //    an attempted (succeeded or failed) item the usual push delay
      //    applies.
      for (const item of plan.import) {
        let skippedUnchanged = false;
        try {
          const outcome = await target.upsert(item.event);
          if (outcome?.wrote) log.imported += 1;
          else { log.unchanged += 1; skippedUnchanged = true; }
        } catch (err) {
          log.failed += 1;
          log.failures.push(`import ${item.uid}: ${truncate(err.message)}`);
        }
        if (!skippedUnchanged) await delayFn(config.pushDelayMs);
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
      //    target calendar are never touched. The adapter maps the count
      //    semantics (Google: every copy carrying that iCalUID; CalDAV: the
      //    single {UID}.ics resource, with 404 tolerated as already-gone).
      for (const uid of plan.delete) {
        try {
          const n = await target.deleteEventByUid(uid);
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
