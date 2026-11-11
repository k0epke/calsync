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
  const calls = { imports: [], deletes: [], calendarsCreated: [], calendarLists: 0, listReads: [] };
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
