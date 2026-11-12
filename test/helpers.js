// Shared test helpers + fixture access.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export function fixture(name) { return path.join(TEST_DIR, 'fixtures', name); }
export function readFixture(name) { return fs.readFileSync(fixture(name), 'utf8'); }

function flattenLines(lines) {
  return lines.flatMap((l) => (Array.isArray(l) ? flattenLines(l) : l));
}

export function icsFor(lines) {
  // Accepts a flat array of strings or nested arrays (e.g. icsFor([veventFor(..), veventFor(..)]).
  // Nested arrays would otherwise be joined with commas and corrupt the ICS.
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CalSync Test//EN', ...flattenLines(lines), 'END:VCALENDAR'].join('\n');
}

export function veventFor(lines) {
  return ['BEGIN:VEVENT', ...flattenLines(lines), 'END:VEVENT'];
}

export const FIXED_NOW_MS = Date.parse('2026-11-11T12:00:00Z');

// Stateful fake Google Calendar client shared by sync engine tests.
// - importEvent upserts by iCalUID into a per-calendar store (like the real
//   events.import).
// - deleteAllByUid removes every store entry with that iCalUID.
// - listAllEvents matches the real client's contract (returns
//   Map<iCalUID, {eventId, status}>) and reports how many 250-event pages
//   the snapshot spanned, mirroring events.list pagination.
// - Manipulating the store directly — e.g. store.removeByUid(...) — simulates
//   a user deleting or cancelling an event from inside Google Calendar.
// Seeded entries may carry status: 'cancelled' to model calendar-side
// cancelled copies that the skip-unchanged rule must repair via re-import
// (cancelled *instances* of recurring series are always returned by the API).
export function makeGoogleMock({ failImportUids = [], failAllWith = null, failDeletesFor = [], failListWith = null, seedEvents = [] } = {}) {
  const calls = { imports: [], deletes: [], calendarsCreated: [], calendarLists: 0, listReads: [], listSourceReads: [] };
  const calendars = new Map(); // calendarId -> array of stored Google event resources
  let nextEventId = 1;
  const stateFor = (calendarId) => {
    let state = calendars.get(calendarId);
    if (!state) { state = []; calendars.set(calendarId, state); }
    return state;
  };
  for (const seed of seedEvents) stateFor(seed.calendarId ?? 'cal-target').push({ status: 'confirmed', ...seed });

  // Holder carries mutable failure config: tests may reassign
  // holder.failImportUids / holder.failDeletesFor between runs — both are
  // read on every client call.
  const holder = { calls, failImportUids, failDeletesFor };

  const client = {
    // Mirrors GoogleCalendarClient.listAllEvents (one paginated read per sync
    // run; 250 events per page like the real maxResults).
    async listAllEvents(calendarId) {
      if (failListWith) {
        const err = new Error(failListWith);
        err.status = 500;
        throw err;
      }
      const state = stateFor(calendarId);
      calls.listReads.push({ calendarId, pages: Math.max(1, Math.ceil(state.length / 250)), events: state.length });
      return new Map(state.filter((e) => e.iCalUID)
        .map((e) => [e.iCalUID, { eventId: e.id, status: String(e.status ?? 'confirmed').toLowerCase() }]));
    },
    async importEvent(calendarId, gEvent) {
      if (failAllWith) {
        const err = new Error(String(failAllWith));
        err.status = String(failAllWith).includes('401') ? 401 : 500;
        throw err;
      }
      // Read failure config from the holder on every call so tests can turn
      // injected failures on/off between runs.
      if (holder.failImportUids.includes(gEvent.iCalUID)) {
        const err = new Error('429 backend error');
        err.status = 429;
        throw err;
      }
      calls.imports.push([calendarId, gEvent]);
      const state = stateFor(calendarId);
      const idx = state.findIndex((e) => e.iCalUID === gEvent.iCalUID);
      const stored = { ...gEvent, status: 'confirmed', id: idx >= 0 ? state[idx].id : `gcal-${nextEventId++}` };
      if (idx >= 0) state[idx] = stored;
      else state.push(stored);
      return { data: stored };
    },
    // Google-as-source snapshot: one paginated-style read returning the RAW
    // stored event resources (same contract as the real client's
    // snapshotSourceEvents: master-with-recurrence preferred on iCalUID
    // collisions, deleted/unresourced items absent by construction).
    async snapshotSourceEvents(calendarId) {
      if (failListWith) {
        const err = new Error(failListWith);
        err.status = 500;
        throw err;
      }
      const state = stateFor(calendarId);
      calls.listSourceReads.push({ calendarId, events: state.length });
      const byUid = new Map();
      const unkeyed = [];
      for (const item of state) {
        const uid = item?.iCalUID;
        if (!uid) { unkeyed.push(item); continue; }
        const prev = byUid.get(uid);
        if (!prev || ((prev.recurrence?.length ?? 0) === 0 && (item.recurrence?.length ?? 0) > 0)) byUid.set(uid, item);
      }
      // uid-less resources pass through so the engine warns and skips them.
      return { events: [...byUid.values(), ...unkeyed], warnings: [], calendarId };
    },
    async deleteAllByUid(calendarId, uid) {
      if (holder.failDeletesFor.includes(uid)) throw new Error('delete boom');
      calls.deletes.push([calendarId, uid]);
      const state = stateFor(calendarId);
      const removed = state.filter((e) => e.iCalUID === uid);
      calendars.set(calendarId, state.filter((e) => e.iCalUID !== uid));
      return removed.length;
    },
    async listCalendars() {
      calls.calendarLists += 1;
      return [{ id: 'cal-1', summary: 'My Target' }];
    },
    async createCalendar(name) {
      calls.calendarsCreated.push(name);
      return { id: `created-${name}`, summary: name };
    },
  };

  // Direct store manipulation for simulating user actions inside Google.
  holder.store = {
    eventsOf: (calendarId) => [...stateFor(calendarId)],
    findByUid: (calendarId, uid) => stateFor(calendarId).find((e) => e.iCalUID === uid) ?? null,
    removeByUid: (calendarId, uid) => calendars.set(calendarId, stateFor(calendarId).filter((e) => e.iCalUID !== uid)),
  };
  holder.client = client;
  return holder;
}

// ---------------------------------------------------------------------------
// Stateful in-memory CalDAV WRITE server (two-way target tests)
// ---------------------------------------------------------------------------

// Implements exactly the surface lib/caldav.js's write path exercises, at
// the fetchImpl boundary (no network):
// - REPORT calendar-query: one multistatus row per stored resource with
//   getetag + full calendar-data (ICS bodies stored VERBATIM; Apple-realism
//   normalization is applied by tests via store.putRaw - see the Apple
//   roundtrip fixtures),
// - PUT {UID}.ics: create (201) or overwrite (204); If-Match is honored
//   against the stored entity tag and mismatches yield 412; every successful
//   PUT changes the resource's etag (like any real CalDAV store),
// - DELETE {UID}.ics: 204 on delete, 404 when already gone. DELETEs carry
//   no If-Match by design (documented in lib/caldav.js).
// `racingWriter: true` simulates a concurrent writer that keeps invalidating
// our etags: every PUT carrying If-Match responds 412 without storing, so
// putEvent's documented one-refresh-retry path exhausts and throws.
// The mock ignores the REPORT time-range (a documented simplification: the
// engine window-filters client-side and only compares in-window events).
export function makeCaldavWriteMock({
  calendarHref = 'https://caldav.icloud.com/123/calendars/home/',
  seeds = [],
  racingWriter = false,
} = {}) {
  const calls = { reports: 0, puts: [], deletes: [] };
  const resources = new Map(); // uid -> { ics, etag }
  let etagCounter = 1;
  const nextEtag = () => `"e-${etagCounter++}"`;

  for (const seed of seeds ?? []) {
    resources.set(String(seed.uid), { ics: String(seed.ics ?? ''), etag: `"${seed.etag ?? `seed-${etagCounter++}`}"` });
  }

  const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const statusResponse = (status, bodyXml = '') => new Response(
    status === 204 || status === 201 ? null : bodyXml,
    { status, headers: { 'content-type': 'application/xml; charset=utf-8' } },
  );

  const multistatus = () => {
    const rows = [...resources.entries()].map(([uid, res]) => [
      '  <D:response>',
      `    <D:href>${xmlEscape(`${calendarHref.endsWith('/') ? calendarHref : `${calendarHref}/`}${encodeURIComponent(uid)}.ics`)}</D:href>`,
      '    <D:propstat>',
      '      <D:prop>',
      `        <D:getetag>${xmlEscape(res.etag)}</D:getetag>`,
      `        <C:calendar-data>${xmlEscape(res.ics)}</C:calendar-data>`,
      '      </D:prop>',
      '      <D:status>HTTP/1.1 200 OK</D:status>',
      '    </D:propstat>',
      '  </D:response>',
    ].join('\r\n'));
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
      ...rows,
      '</D:multistatus>',
    ].join('\r\n');
  };

  const uidOf = (url) => {
    try {
      const path = new URL(String(url)).pathname;
      const last = path.split('/').filter(Boolean).pop() ?? '';
      return decodeURIComponent(last.replace(/\.ics$/i, ''));
    } catch { return null; }
  };

  async function fetchImpl(url, opts = {}) {
    const method = String(opts.method ?? 'GET').toUpperCase();
    if (method === 'REPORT') {
      calls.reports += 1;
      return statusResponse(200, multistatus());
    }
    if (method === 'PUT') {
      const uid = uidOf(url);
      const ifMatch = typeof opts.headers?.['if-match'] === 'string' ? opts.headers['if-match'] : null;
      const body = typeof opts.body === 'string' ? opts.body : '';
      const existing = resources.get(uid);
      const record = { uid, ifMatch, created: !existing };
      calls.puts.push(record);
      if (ifMatch) {
        if (!existing || racingWriter || existing.etag !== ifMatch) {
          record.status = 412;
          return statusResponse(412, '<error/>');
        }
      }
      const etag = nextEtag();
      resources.set(uid, { ics: body, etag });
      record.status = existing ? 204 : 201;
      record.etag = etag;
      return statusResponse(record.status);
    }
    if (method === 'DELETE') {
      const uid = uidOf(url);
      const ifMatch = typeof opts.headers?.['if-match'] === 'string' ? opts.headers['if-match'] : null;
      const existing = resources.get(uid);
      const record = { uid, ifMatch };
      calls.deletes.push(record);
      if (!existing) {
        record.status = 404;
        return statusResponse(404, '<error/>');
      }
      if (ifMatch && existing.etag !== ifMatch) {
        record.status = 412;
        return statusResponse(412, '<error/>');
      }
      resources.delete(uid);
      record.status = 204;
      return statusResponse(204);
    }
    return statusResponse(501, '<error/>');
  }

  return {
    // Direct store manipulation for simulating Apple-side storage behavior
    // (user edits, Apple normalization rewrites, etag bumps).
    store: {
      uids: () => [...resources.keys()].sort(),
      has: (uid) => resources.has(String(uid)),
      icsOf: (uid) => resources.get(String(uid))?.ics ?? null,
      etagOf: (uid) => resources.get(String(uid))?.etag ?? null,
      putRaw: (uid, ics, etag) => resources.set(String(uid), { ics: String(ics), etag: etag ?? nextEtag() }),
      remove: (uid) => { resources.delete(String(uid)); },
    },
    calls,
    fetchImpl,
  };
}
