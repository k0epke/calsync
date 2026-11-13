// CalDAV TARGET (two-way) tests: putEvent payload generation and roundtrip,
// snapshotCalendar mapping, PUT If-Match semantics with the 412 refresh
// retry, DELETE-by-UID with 404 tolerance, and the canonical cross-direction
// hash normalization against a realistic Apple-roundtrip fixture. Everything
// is mocked at the fetchImpl boundary (makeCaldavWriteMock) - no network, no
// real iCloud.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createIcloudCalDavClient, putEventBody, calendarQueryBody, CalDavError,
} from '../lib/caldav.js';
import {
  parseFeed, toGoogleEvent, contentHashOf, canonicalEventHash,
  normalizeEventForCompare, COMPARE_EXCLUDED_FIELDS, CONTENT_HASH_FIELDS,
} from '../lib/icalparse.js';
import { makeCaldavWriteMock } from './helpers.js';
import { icsFor, veventFor } from './helpers.js';

const HREF = 'https://caldav.icloud.com/123/calendars/home/';

const BERLIN_VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
].join('\r\n');

// A realistic Apple-stored copy of the same event: Apple rewrites PRODID,
// adds DTSTAMP/CREATED/LAST-MODIFIED, injects X- properties and bumps
// SEQUENCE. The canonical comparison must normalize this to EQUAL with what
// CalSync would write (see the exclusion-list test below).
const APPLE_FIXTURE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Apple Inc.//iCal 5.0//EN',
  'CALSCALE:GREGORIAN',
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:standup-0001@icloud',
  'SEQUENCE:1',
  'DTSTAMP:20261111T090000Z',
  'CREATED:20261101T000000Z',
  'LAST-MODIFIED:20261111T090000Z',
  'DTSTART;TZID=Europe/Berlin:20261115T090000',
  'DTEND;TZID=Europe/Berlin:20261115T093000',
  'SUMMARY:Standup',
  'X-APPLE-INTERNAL-NOTE:some apple metadata',
  'STATUS:CONFIRMED',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

// The source event as CalSync's internal model would see it (parsed from the
// same calendar through the feed parser).
const SOURCE_ICS = icsFor([
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
  veventFor([
    'UID:standup-0001@icloud',
    'DTSTART;TZID=Europe/Berlin:20261115T090000',
    'DTEND;TZID=Europe/Berlin:20261115T093000',
    'SUMMARY:Standup',
    'STATUS:CONFIRMED',
  ]),
]);

function makeWriteClient(mock) {
  return createIcloudCalDavClient({
    username: 'owner@example.com',
    appPassword: 'abcd-efgh-ijkl-mnop',
    fetchImpl: mock.fetchImpl,
    baseDelayMs: 10,
    timeoutMs: 5000,
    maxRetries: 3,
    sleepFn: async () => {},
  });
}

const SIMPLE_EVENT = {
  uid: 'evt-a',
  summary: 'Event A',
  description: 'Some description',
  location: 'Room 1',
  status: 'CONFIRMED',
  start: { dateTime: '2026-11-15T09:00:00Z' },
  end: { dateTime: '2026-11-15T09:30:00Z' },
  recurrence: [],
  allDay: false,
  transparency: '',
  visibility: '',
  sequence: null,
};

// --- putEventBody (pure payload generation) ----------------------------------

test('putEvent builds a VCALENDAR that parses back to the same normalized model', () => {
  const { body, warnings } = putEventBody(SIMPLE_EVENT);
  assert.deepEqual(warnings, []);
  assert.match(body, /^BEGIN:VCALENDAR\r\n/);
  assert.match(body, /PRODID:-\/\/regimen\.d\/\/calendar sync\/\/EN/);
  assert.match(body, /UID:evt-a\r\n/);
  assert.match(body, /DTSTART:20261115T090000Z/);
  assert.match(body, /DTEND:20261115T093000Z/);
  assert.match(body, /SUMMARY:Event A/);
  const reparsed = parseFeed(body).events[0];
  assert.equal(reparsed.uid, SIMPLE_EVENT.uid);
  assert.equal(reparsed.summary, 'Event A');
  assert.equal(reparsed.description, 'Some description');
  assert.equal(reparsed.location, 'Room 1');
  assert.equal(reparsed.status, 'CONFIRMED');
  assert.deepEqual(reparsed.start, { dateTime: '2026-11-15T09:00:00Z' });
  assert.deepEqual(reparsed.end, { dateTime: '2026-11-15T09:30:00Z' });
  assert.deepEqual(reparsed.recurrence, []);
});

test('putEvent preserves RRULE/RDATE/EXDATE lines and ICS-escapes text values', () => {
  const event = {
    ...SIMPLE_EVENT,
    uid: 'series-0002@icloud',
    summary: 'Weekly, with; specials',
    start: { dateTime: '2026-11-16T09:00:00Z' },
    end: { dateTime: '2026-11-16T10:00:00Z' },
    recurrence: [
      'RRULE:FREQ=WEEKLY;BYDAY=MO',
      'RDATE;TZID=Europe/Berlin:20261221T100000',
      'EXDATE;TZID=Europe/Berlin:20261228T100000',
    ],
  };
  const { body } = putEventBody(event, { timezoneStrings: [BERLIN_VTIMEZONE] });
  assert.match(body, /BEGIN:VTIMEZONE\r\nTZID:Europe\/Berlin/);
  assert.equal([...body.matchAll(/BEGIN:VTIMEZONE/g)].length, 1, 'each referenced TZID gets one in-band definition');
  assert.match(body, /RRULE:FREQ=WEEKLY;BYDAY=MO/);
  assert.match(body, /RDATE;TZID=Europe\/Berlin:20261221T100000/);
  assert.match(body, /EXDATE;TZID=Europe\/Berlin:20261228T100000/);
  const reparsed = parseFeed(body).events[0];
  assert.equal(reparsed.summary, 'Weekly, with; specials', 'text escaping roundtrips');
  assert.deepEqual(reparsed.recurrence, event.recurrence, 'recurrence lines survive byte-stable (TZID params included)');
});

test('putEvent writes all-day events, TZID wall times, STATUS/TRANSP/CLASS/SEQUENCE', () => {
  const event = {
    ...SIMPLE_EVENT,
    uid: 'mixed@icloud',
    start: { date: '2026-04-05' },
    end: { date: '2026-04-07' },
    status: 'TENTATIVE',
    transparency: 'TRANSPARENT',
    visibility: 'PRIVATE',
    sequence: 3,
  };
  const { body } = putEventBody(event);
  assert.match(body, /DTSTART;VALUE=DATE:20260405/);
  assert.match(body, /DTEND;VALUE=DATE:20260407/);
  assert.match(body, /STATUS:TENTATIVE/);
  assert.match(body, /TRANSP:TRANSPARENT/);
  assert.match(body, /CLASS:PRIVATE/);
  assert.match(body, /SEQUENCE:3/);
  assert.equal(parseFeed(body).events[0].allDay, true);

  const tzEvent = {
    ...SIMPLE_EVENT,
    start: { dateTime: '2026-11-15T09:00:00+01:00', timeZone: 'Europe/Berlin' },
    end: { dateTime: '2026-11-15T09:30:00+01:00', timeZone: 'Europe/Berlin' },
  };
  const { body: tzBody } = putEventBody(tzEvent, { timezoneStrings: [BERLIN_VTIMEZONE] });
  assert.match(tzBody, /DTSTART;TZID=Europe\/Berlin:20261115T090000/,
    'TZID times are written as wall clock (offset re-derivable from the zone)');
  assert.match(tzBody, /BEGIN:VTIMEZONE/, 'referenced TZID gets an in-band definition');
});

test('putEventBody picks VTIMEZONES from the ical.js TimezoneService as fallback', () => {
  parseFeed(SOURCE_ICS); // registers Europe/Berlin like every source parse does
  const tzEvent = {
    ...SIMPLE_EVENT,
    start: { dateTime: '2026-11-15T09:00:00+01:00', timeZone: 'Europe/Berlin' },
    end: { dateTime: '2026-11-15T09:30:00+01:00', timeZone: 'Europe/Berlin' },
  };
  const { body } = putEventBody(tzEvent);
  assert.match(body, /BEGIN:VTIMEZONE\r\nTZID:Europe\/Berlin/, 'service-registered definition inlined');
});

test('putEventBody rejects UID-less events and events without usable DTSTART', () => {
  assert.throws(() => putEventBody({ ...SIMPLE_EVENT, uid: ' ' }), CalDavError);
  assert.throws(() => putEventBody({ ...SIMPLE_EVENT, start: {} }), CalDavError);
});

// --- canonical compare hash + Apple roundtrip ---------------------------------

test('contentHashOf field list is untouched', () => {
  assert.deepEqual(CONTENT_HASH_FIELDS, [
    'iCalUID', 'summary', 'description', 'location', 'start', 'end',
    'recurrence', 'status', 'transparency', 'visibility', 'sequence',
  ]);
});

test('canonical compare hash normalizes a realistic Apple roundtrip to EQUAL', () => {
  const written = parseFeed(SOURCE_ICS).events[0];
  const stored = parseFeed(APPLE_FIXTURE).events[0];
  // Sanity: both parse through the SAME internal model.
  const shape = Object.keys(written).sort();
  assert.deepEqual(Object.keys(stored).sort(), shape);
  assert.equal(canonicalEventHash(stored), canonicalEventHash(written),
    'Apple-rewritten PRODID/DTSTAMP/CREATED/LAST-MODIFIED/X- props and the SEQUENCE bump must not phantom-diff');
  // The SEQUENCE exclusion is load-bearing: with it, an Apple-side bump or a
  // Google-assigned sequence can never make mirrored pairs rewrite forever.
  assert.notEqual(contentHashOf(toGoogleEvent(stored)), contentHashOf(toGoogleEvent(written)),
    'the FULL hash (with sequence) differs - proving the exclusion is what stabilizes the comparison');
});

test('COMPARE_EXCLUDED_FIELDS is exactly [sequence]; content changes still move the digest', () => {
  assert.deepEqual(COMPARE_EXCLUDED_FIELDS, ['sequence']);
  const written = parseFeed(SOURCE_ICS).events[0];
  const base = canonicalEventHash(written);
  assert.equal(canonicalEventHash({ ...written, sequence: 7 }), base, 'sequence is excluded');
  assert.notEqual(canonicalEventHash({ ...written, summary: 'Changed' }), base);
  assert.notEqual(canonicalEventHash({ ...written, start: { ...written.start, dateTime: '2026-11-15T10:00:00+01:00' } }), base);
  assert.notEqual(canonicalEventHash({ ...written, recurrence: ['RRULE:FREQ=DAILY'] }), base);
  // shape check: normalizeEventForCompare yields the toGoogleEvent subset minus sequence
  const n = normalizeEventForCompare(written);
  assert.ok(!('sequence' in n));
  assert.match(canonicalEventHash(written), /^[0-9a-f]{64}$/);
});

// --- snapshotCalendar ----------------------------------------------------------

test('snapshotCalendar maps uid -> { etag, status, event } through the same parseFeed model', async () => {
  const mock = makeCaldavWriteMock({
    seeds: [
      { uid: 'evt-a', ics: icsFor([veventFor(['UID:evt-a', 'DTSTART:20261115T090000Z', 'DTEND:20261115T093000Z', 'SUMMARY:Event A'])]) },
      { uid: 'evt-c', ics: icsFor([veventFor(['UID:evt-c', 'DTSTART:20261117T080000Z', 'DTEND:20261117T090000Z', 'SUMMARY:Gone', 'STATUS:CANCELLED'])]) },
      { uid: 'evt-broken', ics: 'NONSENSE TEXT', etag: 'broken-1' },
    ],
  });
  const client = makeWriteClient(mock);
  const map = await client.snapshotCalendar(HREF, { start: Date.parse('2026-11-01T00:00:00Z'), end: Date.parse('2027-11-01T00:00:00Z') });

  assert.equal(map.size, 2, 'the unparsable row is skipped entirely (not comparable)');
  const a = map.get('evt-a');
  assert.ok(a.etag.startsWith('"'), 'etag kept in quoted form for If-Match');
  assert.equal(a.status, 'confirmed');
  assert.equal(a.event.summary, 'Event A');
  assert.equal(map.get('evt-c').status, 'cancelled', 'cancelled remote copies mirror the Google-snapshot contract');
  const shape = Object.keys(a.event).sort();
  assert.deepEqual(Object.keys(parseFeed(icsFor([veventFor(['UID:x', 'DTSTART:20261115T090000Z'])])).events[0]).sort(), shape,
    'snapshot events use the identical internal event model');
});

test('snapshotCalendar keeps the first entry per UID and parses Apple fixtures comparably', async () => {
  // A real store cannot hold two resources with one UID; the first-wins rule
  // matters for multi-VEVENT blobs (one calendar-data row carrying the UID
  // twice), which is how duplicate-UID payloads reach parseFeed.
  const dupIcs = icsFor([
    veventFor(['UID:dup-0001@icloud', 'DTSTART:20261115T090000Z', 'DTEND:20261115T093000Z', 'SUMMARY:First']),
    veventFor(['UID:dup-0001@icloud', 'DTSTART:20261122T090000Z', 'DTEND:20261122T093000Z', 'SUMMARY:Second']),
  ]);
  const mock = makeCaldavWriteMock({
    seeds: [
      { uid: 'dup-0001@icloud', ics: dupIcs },
      { uid: 'standup-0001@icloud', ics: APPLE_FIXTURE },
    ],
  });
  const client = makeWriteClient(mock);
  const map = await client.snapshotCalendar(HREF, { start: Date.parse('2026-11-01T00:00:00Z'), end: Date.parse('2027-11-01T00:00:00Z') });
  assert.equal(map.size, 2);
  assert.equal(map.get('dup-0001@icloud').event.summary, 'First', 'first-UID-wins');
  assert.equal(map.get('standup-0001@icloud').event.summary, 'Standup');
  // The Apple-stored copy parses into the identical model shape, so its
  // canonical hash composes with the write-side hash (see the compare tests).
  assert.equal(map.get('standup-0001@icloud').etag, '"seed-2"');
});

// --- putEvent / deleteEventByUid against the write mock ------------------------

test('putEvent creates without If-Match, then overwrites with If-Match (idempotent)', async () => {
  const mock = makeCaldavWriteMock();
  const client = makeWriteClient(mock);
  await client.putEvent(HREF, SIMPLE_EVENT);
  const first = mock.calls.puts[0];
  assert.equal(first.uid, 'evt-a');
  assert.equal(first.ifMatch, null, 'new resource: no If-Match');
  assert.equal(first.created, true);
  assert.deepEqual(mock.store.uids(), ['evt-a']);
  const etag = mock.store.etagOf('evt-a');
  assert.ok(etag, 'resource stored with a fresh etag');

  await client.putEvent(HREF, { ...SIMPLE_EVENT, summary: 'Event A (edited)' }, { ifMatchEtag: etag });
  const second = mock.calls.puts[1];
  assert.equal(second.ifMatch, etag, 'snapshot showed the resource: If-Match carries the current etag');
  assert.equal(second.created, false);
  assert.match(mock.store.icsOf('evt-a'), /SUMMARY:Event A \(edited\)/);
  assert.notEqual(mock.store.etagOf('evt-a'), etag, 'etag changes on every successful PUT');
});

test('putEvent PUTs to {href}/{UID}.ics with an encoded UID path', async () => {
  const mock = makeCaldavWriteMock();
  const client = makeWriteClient(mock);
  await client.putEvent(HREF, { ...SIMPLE_EVENT, uid: 'uid with spaces@calsync' });
  assert.deepEqual(mock.store.uids(), ['uid with spaces@calsync'], 'path percent-encoding decodes back to the same UID');
});

test('putEvent refreshes a raced etag exactly once on 412, then succeeds', async () => {
  const mock = makeCaldavWriteMock({ seeds: [{ uid: 'evt-a', ics: icsFor([veventFor(['UID:evt-a', 'DTSTART:20261115T090000Z', 'SUMMARY:Old'])]) }] });
  const client = makeWriteClient(mock);
  await client.putEvent(HREF, SIMPLE_EVENT, { ifMatchEtag: '"definitely-stale"' });
  assert.equal(mock.calls.puts.length, 2, 'one failed attempt plus exactly one refresh retry');
  assert.equal(mock.calls.puts[0].status, 412);
  assert.equal(mock.calls.puts[1].status, 204);
  assert.equal(mock.calls.puts[1].ifMatch, '"seed-1"',
    'retry carries the etag the refresh REPORT returned (the seeded resource tag)');
  assert.notEqual(mock.store.etagOf('evt-a'), mock.calls.puts[1].ifMatch,
    'the successful retry stored the event under a fresh etag');
  assert.equal(mock.calls.reports, 1, 'the refresh is a single REPORT');
});

test('putEvent gives up after the second 412 (one refresh retry, never an infinite race)', async () => {
  const mock = makeCaldavWriteMock({
    racingWriter: true,
    seeds: [{ uid: 'evt-a', ics: icsFor([veventFor(['UID:evt-a', 'DTSTART:20261115T090000Z', 'SUMMARY:Raced'])]) }],
  });
  const client = makeWriteClient(mock);
  await assert.rejects(
    client.putEvent(HREF, SIMPLE_EVENT, { ifMatchEtag: '"stale"' }),
    (err) => err instanceof CalDavError && err.status === 412,
  );
  assert.equal(mock.calls.puts.length, 2, 'documented single-refresh retry: no third attempt');
  assert.match(mock.store.icsOf('evt-a'), /SUMMARY:Raced/, 'racing writer wins the resource in this scenario');
});

test('putEvent writes unconditionally when the raced resource vanished before the retry', async () => {
  const mock = makeCaldavWriteMock({
    seeds: [{ uid: 'evt-a', ics: icsFor([veventFor(['UID:evt-a', 'DTSTART:20261115T090000Z', 'SUMMARY:Old'])]) }],
  });
  const originalFetch = mock.fetchImpl;
  mock.fetchImpl = async (url, opts = {}) => {
    // Right after the refresh REPORT (which no longer sees the resource),
    // the resource is gone: the retry PUT must NOT carry If-Match ("then
    // proceed" = create it).
    if (String(opts.method).toUpperCase() === 'REPORT' && mock.calls.reports === 0) {
      mock.store.remove('evt-a');
    }
    return originalFetch(url, opts);
  };
  const client = makeWriteClient(mock);
  await client.putEvent(HREF, SIMPLE_EVENT, { ifMatchEtag: '"definitely-stale"' });
  assert.equal(mock.calls.puts.length, 2);
  assert.equal(mock.calls.puts[0].status, 412, 'If-Match on a vanished resource => 412');
  assert.equal(mock.calls.puts[1].ifMatch, null, 'vanishing between snapshot and retry means create, unconditionally');
  assert.ok(mock.store.has('evt-a'));
});

// RFC semantics: If-Match on a resource that does not exist is a 412, which
// the client treats like the raced-write case above (refresh once, then
// proceed) - covered by the previous two tests.

test('deleteEventByUid deletes, tolerates 404 as already-gone, and reports counts', async () => {
  const mock = makeCaldavWriteMock({
    seeds: [{ uid: 'evt-a', ics: icsFor([veventFor(['UID:evt-a', 'DTSTART:20261115T090000Z'])]) }],
  });
  const client = makeWriteClient(mock);
  assert.equal(await client.deleteEventByUid(HREF, 'evt-a'), true, 'existing resource deleted');
  assert.equal(mock.store.has('evt-a'), false);
  assert.equal(await client.deleteEventByUid(HREF, 'evt-a'), false, 'already gone: 404 is NOT an error');
  assert.equal(mock.calls.deletes[1].status, 404);
  await assert.rejects(client.deleteEventByUid(HREF, ''), CalDavError);
});

test('non-iCloud hosts are refused on the write path too', async () => {
  const mock = makeCaldavWriteMock();
  const client = makeWriteClient(mock);
  await assert.rejects(client.putEvent('caldav://caldav.example.com/x/', SIMPLE_EVENT), /only iCloud CalDAV/);
  await assert.rejects(client.deleteEventByUid('caldav://caldav.example.com/x/', 'u'), /only iCloud CalDAV/);
  await assert.rejects(client.snapshotCalendar('caldav://caldav.example.com/x/', { start: 0, end: 1 }), /only iCloud CalDAV/);
});

// --- REPORT body without a time-range (post-412 refresh variant) ---------------

test('calendarQueryBody omits the time-range when no window is given', () => {
  const body = calendarQueryBody({});
  assert.doesNotMatch(body, /time-range/);
  assert.match(body, /<C:comp-filter name="VEVENT">/);
  const scoped = calendarQueryBody({ startMs: 0, endMs: 1000 });
  assert.match(scoped, /<C:time-range start="19700101T000000Z" end="19700101T000001Z"\/>/);
});
