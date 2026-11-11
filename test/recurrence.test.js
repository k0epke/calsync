// Window planning tests: recurrence-aware [now-30d, now+1y] relevance checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isEventInWindow, computeWindow, instantOf } from '../lib/recurrence.js';
import { parseFeed } from '../lib/icalparse.js';
import { FIXED_NOW_MS, icsFor, veventFor } from './helpers.js';

const WS = FIXED_NOW_MS - 30 * 86_400_000; // 2026-10-12T12:00Z
const WE = FIXED_NOW_MS + 365 * 86_400_000; // 2027-11-11T12:00Z

function ev(lines) {
  const feed = parseFeed(icsFor(veventFor(lines)));
  assert.equal(feed.warnings.length, 0, `fixture should parse cleanly: ${feed.warnings.join('; ')}`);
  return feed.events[0];
}

test('computeWindow defaults match the spec: [now-30d, now+1y]', () => {
  const w = computeWindow(FIXED_NOW_MS, { windowPastDays: 30, windowFutureDays: 365 });
  assert.equal(w.start, FIXED_NOW_MS - 30 * 86_400_000);
  assert.equal(w.end, FIXED_NOW_MS + 365 * 86_400_000);
});

test('instantOf handles date vs dateTime (incl. missing offset)', () => {
  assert.equal(instantOf({ date: '2026-04-01' }), Date.UTC(2026, 3, 1, 12, 0, 0));
  assert.equal(instantOf({ dateTime: '2026-04-01T09:00:00Z' }), Date.parse('2026-04-01T09:00:00Z'));
  // floating time is treated as UTC for window comparisons
  assert.equal(instantOf({ dateTime: '2026-04-01T09:00:00' }), Date.parse('2026-04-01T09:00:00Z'));
});

test('infinite weekly rule starting before the window is included', () => {
  const e = ev(['UID:i1', 'DTSTART:20261010T090000Z', 'DTEND:20261010T093000Z', 'RRULE:FREQ=WEEKLY', 'SUMMARY:x']);
  assert.equal(isEventInWindow(e, WS, WE), true);
});

test('rule that ended long ago (UNTIL in the past) is excluded', () => {
  const e = ev(['UID:i2', 'DTSTART:20240106T090000Z', 'DTEND:20240106T093000Z', 'RRULE:FREQ=WEEKLY;UNTIL=20240201T000000Z', 'SUMMARY:x']);
  assert.equal(isEventInWindow(e, WS, WE), false);
});

test('finite COUNT rule reaching into the window is included', () => {
  const e = ev(['UID:i3', 'DTSTART:20261105T090000Z', 'RRULE:FREQ=DAILY;COUNT=10', 'SUMMARY:x']);
  assert.equal(isEventInWindow(e, WS, WE), true); // occurrences Nov 5..14, in window
});

test('finite COUNT rule that ended before the window is excluded', () => {
  const e = ev(['UID:i4', 'DTSTART:20261001T090000Z', 'RRULE:FREQ=DAILY;COUNT=2', 'SUMMARY:x']);
  assert.equal(isEventInWindow(e, WS, WE), false); // Oct 1+2, both before Oct 12
});

test('single events: old excluded, in-window included, far future excluded', () => {
  assert.equal(isEventInWindow(ev(['UID:s1', 'DTSTART:20261001T090000Z', 'SUMMARY:x']), WS, WE), false);
  assert.equal(isEventInWindow(ev(['UID:s2', 'DTSTART:20261020T090000Z', 'SUMMARY:x']), WS, WE), true);
  assert.equal(isEventInWindow(ev(['UID:s3', 'DTSTART:20261201T090000Z', 'SUMMARY:x']), WS, WE), true);
  assert.equal(isEventInWindow(ev(['UID:s4', 'DTSTART:20271201T090000Z', 'SUMMARY:x']), WS, WE), false);
});

test('multi-day all-day events spanning the window edge are included', () => {
  const e = ev(['UID:a1', 'DTSTART;VALUE=DATE:20261010', 'DTEND;VALUE=DATE:20261020', 'SUMMARY:x']);
  assert.equal(isEventInWindow(e, WS, WE), true);
  assert.equal(isEventInWindow(ev(['UID:a2', 'DTSTART;VALUE=DATE:20260901', 'SUMMARY:x']), WS, WE), false);
  assert.equal(isEventInWindow(ev(['UID:a3', 'DTSTART;VALUE=DATE:20261111', 'SUMMARY:x']), WS, WE), true);
});

test('RDATE-only events: only occurrences inside the window count', () => {
  const inside = ev(['UID:r1', 'DTSTART:20260101T090000Z', 'RDATE:20261120T120000Z', 'SUMMARY:x']);
  assert.equal(isEventInWindow(inside, WS, WE), true);
  const outside = ev(['UID:r2', 'DTSTART:20260101T090000Z', 'RDATE:20261001T120000Z', 'SUMMARY:x']);
  assert.equal(isEventInWindow(outside, WS, WE), false);
});

test('cancelled events are never window-relevant (deletion path handles them)', () => {
  const e = ev(['UID:c1', 'DTSTART:20261201T090000Z', 'STATUS:CANCELLED', 'SUMMARY:x']);
  assert.equal(isEventInWindow(e, WS, WE), false);
});

test('invalid RRULE fails open (event included)', () => {
  const e = ev(['UID:b1', 'DTSTART:20240101T090000Z', 'RRULE:TOTALLY-BOGUS', 'SUMMARY:x']);
  assert.equal(isEventInWindow(e, WS, WE), true);
});

test('recurring event with VTIMEZONE evaluates in the right zone', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VTIMEZONE',
    'TZID:America/Chicago',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:-0600',
    'TZOFFSETTO:-0600',
    'TZNAME:CST',
    'DTSTART:19700101T000000',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'UID:tz-check',
    'DTSTART;TZID=America/Chicago:20241111T090000',
    'DTEND;TZID=America/Chicago:20241111T093000',
    'RRULE:FREQ=YEARLY;UNTIL=20271111T235959Z',
    'SUMMARY:yearly in chicago',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\n');
  const feed = parseFeed(ics);
  const e = feed.events[0];
  const feedTz = { timezoneIcs: feed.vtimezoneStrings };
  // Yearly Nov 11 2024 (before window), 2025 (before), 2026 Nov 11 09:00 local -> in window
  assert.equal(isEventInWindow(e, WS, WE, feedTz), true);
});
