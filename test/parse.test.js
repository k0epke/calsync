// Parse tests: format sniffing + ICS/VCS/XCal/JCal -> jCal normalization.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sniffFormat, parseFeed, vcsRruleToIcs, insertValueDateParams, ParseError } from '../lib/icalparse.js';
import { readFixture } from './helpers.js';

function byUid(events, uid) {
  const ev = events.find((e) => e.uid === uid);
  assert.ok(ev, `event with uid ${uid} should exist`);
  return ev;
}

test('sniff: ICS detected by content', () => {
  assert.equal(sniffFormat(readFixture('sample.ics')), 'ics');
  assert.equal(sniffFormat('  \uFEFF\nBEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nEND:VEVENT\r\nEND:VCALENDAR'), 'ics');
});

test('sniff: VCS 1.0 detected by VERSION:1.0/DSTART', () => {
  assert.equal(sniffFormat(readFixture('sample.vcs')), 'vcs');
  assert.equal(sniffFormat('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDSTART:20260101T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR'), 'vcs');
});

test('sniff: XCal detected by XML root', () => {
  assert.equal(sniffFormat(readFixture('sample.xcal')), 'xcal');
  assert.equal(sniffFormat('<icalendar><vcalendar></vcalendar></icalendar>'), 'xcal');
});

test('sniff: JCal detected by JSON payload', () => {
  assert.equal(sniffFormat(readFixture('sample.jcal')), 'jcal');
  assert.equal(sniffFormat('[["vcalendar",[["version",{},"text","2.0"]],[]]]'), 'jcal');
});

test('sniff: garbage rejected', () => {
  assert.throws(() => sniffFormat('not a calendar at all'), ParseError);
  assert.throws(() => sniffFormat('{"json":"but not jcal"}'), ParseError);
  assert.throws(() => sniffFormat(''), ParseError);
});

test('ICS fixture: calendar metadata, counts, X-WR-CALNAME', () => {
  const feed = parseFeed(readFixture('sample.ics'));
  assert.equal(feed.format, 'ics');
  assert.equal(feed.calendarName, 'Test Feed Calendar');
  assert.equal(feed.events.length, 7);
  assert.equal(feed.counts.cancelled, 1);
  assert.equal(feed.counts.withRecurrence, 2);
  assert.ok(feed.vtimezoneStrings.length >= 1);
});

test('ICS fixture: TZID event keeps timezone + DST-correct offset', () => {
  const feed = parseFeed(readFixture('sample.ics'));
  const ev = byUid(feed.events, 'event-simple@example.com');
  assert.equal(ev.summary, 'Simple event');
  assert.equal(ev.start.dateTime, '2026-03-01T09:00:00-06:00'); // CST (DST starts Mar 8 2026)
  assert.equal(ev.start.timeZone, 'America/Chicago');
  assert.equal(ev.end.dateTime, '2026-03-01T10:00:00-06:00');
});

test('ICS fixture: folded description is unfolded, VALARM ignored', () => {
  const feed = parseFeed(readFixture('sample.ics'));
  const ev = byUid(feed.events, 'event-simple@example.com');
  assert.ok(ev.description.includes('folded across multiple physical lines'),
    `description should be unfolded, got: ${JSON.stringify(ev.description)}`);
  const serialized = JSON.stringify(feed.events);
  assert.ok(!serialized.includes('TRIGGER'), 'VALARM content must be ignored');
  assert.ok(!serialized.includes('Reminder'), 'VALARM content must be ignored');
});

test('ICS fixture: RRULE/EXDATE preserved as ICS recurrence lines', () => {
  const feed = parseFeed(readFixture('sample.ics'));
  const ev = byUid(feed.events, 'event-recur@example.com');
  assert.deepEqual(ev.recurrence, [
    'RRULE:FREQ=DAILY;COUNT=20',
    'EXDATE;TZID=America/Chicago:20260305T090000',
  ]);
});

test('ICS fixture: all-day event', () => {
  const feed = parseFeed(readFixture('sample.ics'));
  const ev = byUid(feed.events, 'event-allday@example.com');
  assert.deepEqual(ev.start, { date: '2026-04-01' });
  assert.deepEqual(ev.end, { date: '2026-04-02' });
  assert.equal(ev.allDay, true);
});

test('ICS fixture: cancelled event keeps STATUS:CANCELLED', () => {
  const feed = parseFeed(readFixture('sample.ics'));
  const ev = byUid(feed.events, 'event-cancelled@example.com');
  assert.equal(ev.status, 'CANCELLED');
});

test('ICS fixture: UNTIL rule + tentative UTC event + DURATION end', () => {
  const feed = parseFeed(readFixture('sample.ics'));
  const until = byUid(feed.events, 'event-recur-until@example.com');
  assert.deepEqual(until.recurrence, ['RRULE:FREQ=WEEKLY;UNTIL=20250228T235959Z']);
  assert.equal(until.start.dateTime, '2025-01-06T09:00:00-06:00');

  const utc = byUid(feed.events, 'event-utc@example.com');
  assert.equal(utc.start.dateTime, '2026-06-01T12:00:00Z');
  assert.equal(utc.start.timeZone, undefined);
  assert.equal(utc.status, 'TENTATIVE');

  const dur = byUid(feed.events, 'event-duration@example.com');
  assert.equal(dur.end.dateTime, '2026-03-15T14:30:00-05:00'); // CDT after Mar 8 2026
});

test('ICS leniency: date-only values without VALUE=DATE are repaired', () => {
  const raw = insertValueDateParams('BEGIN:VEVENT\r\nUID:x\r\nDTSTART:20260405\r\nDTEND:20260406,20260407\r\nSUMMARY:y\r\nEND:VEVENT');
  assert.ok(raw.includes('DTSTART;VALUE=DATE:20260405'));
  assert.ok(raw.includes('DTEND;VALUE=DATE:20260406,20260407'));
  // datetime values are untouched
  const raw2 = insertValueDateParams('BEGIN:VEVENT\r\nDTSTART:20260405T090000Z\r\nEND:VEVENT');
  assert.ok(!raw2.includes('VALUE=DATE'));
});

test('ICS full parse: date-only DTSTART without VALUE=DATE works end-to-end', () => {
  const feed = parseFeed('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x@y\r\nDTSTART:20260405\r\nDTEND:20260406\r\nSUMMARY:All day without param\r\nEND:VEVENT\r\nEND:VCALENDAR');
  const ev = feed.events[0];
  assert.deepEqual(ev.start, { date: '2026-04-05' });
  assert.deepEqual(ev.end, { date: '2026-04-06' });
});

test('VCS fixture: DSTART/DEND mapped, alarms dropped, RRULE converted', () => {
  const feed = parseFeed(readFixture('sample.vcs'));
  assert.equal(feed.format, 'vcs');
  assert.equal(feed.events.length, 2);

  const simple = byUid(feed.events, 'vcs-simple@example.com');
  assert.equal(simple.summary, 'VCS Event');
  assert.equal(simple.start.dateTime, '2026-03-01T09:00:00Z');
  assert.equal(simple.end.dateTime, '2026-03-01T10:00:00Z');
  assert.equal(simple.location, 'Legacy Room');

  const serialized = JSON.stringify(feed.events);
  assert.ok(!serialized.includes('AALARM'), 'AALARM (v1 alarm) must be dropped');
  assert.ok(!serialized.includes('DALARM'), 'DALARM (v1 alarm) must be dropped');

  const recur = byUid(feed.events, 'vcs-recur@example.com');
  assert.deepEqual(recur.recurrence, ['RRULE:FREQ=DAILY;COUNT=10']);
});

test('VCS RRULE conversions: monthly-by-position passes through, junk is dropped with a warning', () => {
  assert.equal(vcsRruleToIcs('MP1 1+ MO #4'), 'FREQ=MONTHLY;BYDAY=1MO;COUNT=4');
  assert.equal(vcsRruleToIcs('W2 MO TU #8'), 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TU;COUNT=8');
  assert.equal(vcsRruleToIcs('MD1 15 #12'), 'FREQ=MONTHLY;BYMONTHDAY=15;COUNT=12');
  assert.equal(vcsRruleToIcs('YM1 6 #5'), 'FREQ=YEARLY;BYMONTH=6;COUNT=5');
  assert.equal(vcsRruleToIcs('D3 #0'), 'FREQ=DAILY;INTERVAL=3');
  assert.equal(vcsRruleToIcs('FOO #2'), null);

  const feed = parseFeed('BEGIN:VCALENDAR\r\nVERSION:1.0\r\nBEGIN:VEVENT\r\nUID:r@x\r\nDSTART:20260302T080000Z\r\nSUMMARY:weird\r\nRRULE:FOO #2\r\nEND:VEVENT\r\nEND:VCALENDAR');
  assert.equal(feed.events[0].recurrence.length, 0, 'unsupported v1 RRULE must be dropped');
  assert.ok(feed.warnings.some((w) => w.includes('RRULE')), 'a warning must explain the dropped rule');
});

test('XCal fixture: RFC 6321 XML normalized, entities decoded, parameters mapped', () => {
  const feed = parseFeed(readFixture('sample.xcal'));
  assert.equal(feed.format, 'xcal');
  assert.equal(feed.calendarName, 'XCal Feed');
  assert.equal(feed.events.length, 2);

  const ev = byUid(feed.events, 'xcal-1@example.com');
  assert.equal(ev.summary, 'From XCal');
  assert.equal(ev.description, 'Hello <World> & friends');
  assert.equal(ev.start.dateTime, '2026-03-01T09:00:00-06:00');
  assert.equal(ev.start.timeZone, 'America/Chicago');
  assert.deepEqual(ev.recurrence, ['RRULE:FREQ=DAILY;COUNT=5']);

  const allDay = byUid(feed.events, 'xcal-2@example.com');
  assert.deepEqual(allDay.start, { date: '2026-04-01' });
  assert.deepEqual(allDay.end, { date: '2026-04-02' });
});

test('JCal fixture: RFC 7265 JSON normalized, recur object converted to ical.js shape', () => {
  const feed = parseFeed(readFixture('sample.jcal'));
  assert.equal(feed.format, 'jcal');
  assert.equal(feed.calendarName, 'JCal Feed');
  assert.equal(feed.events.length, 2);

  const ev = byUid(feed.events, 'jcal-1@example.com');
  assert.equal(ev.summary, 'From JCal');
  assert.equal(ev.start.timeZone, 'America/Chicago');
  assert.deepEqual(ev.recurrence, ['RRULE:FREQ=DAILY;COUNT=3']);

  const allDay = byUid(feed.events, 'jcal-2@example.com');
  assert.deepEqual(allDay.start, { date: '2026-04-01' });
});

test('parse failure surfaces a ParseError with cause', () => {
  assert.throws(() => parseFeed('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nNOT-EVENT:broken'),
    (err) => err instanceof ParseError);
});

test('synthetic UID for UID-less events is stable', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20260405T090000Z\r\nSUMMARY:No UID here\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const a = parseFeed(ics).events[0];
  const b = parseFeed(ics).events[0];
  assert.match(a.uid, /^calsync-[0-9a-f]{32}@calsync\.local$/);
  assert.equal(a.uid, b.uid, 'same content -> same synthetic UID (idempotent imports)');
});
