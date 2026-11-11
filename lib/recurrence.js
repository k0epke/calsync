// Window planning (pure functions): which feed events are relevant in
// [now - pastDays, now + futureDays], with recurrence-aware evaluation.
import { ICAL } from './deps.js';

// { date } and { dateTime } values -> epoch ms.
export function instantOf(t) {
  if (!t) return NaN;
  if (t.date) {
    const [y, m, d] = t.date.split('-').map(Number);
    if (!y || !m || !d) return NaN;
    return Date.UTC(y, m - 1, d, 12, 0, 0); // midday so day-granularity compares safely
  }
  if (t.dateTime) {
    let s = t.dateTime;
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) s += 'Z';
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? NaN : ms;
  }
  return NaN;
}

export function hasRrule(ev) {
  return (ev?.recurrence ?? []).some((l) => /^RRULE:/i.test(l));
}

function msFromIcalTime(t) {
  if (!t) return NaN;
  if (t.isDate) return Date.UTC(t.year, t.month - 1, t.day, 12, 0, 0);
  if (typeof t.toJSDate === 'function') return t.toJSDate().getTime();
  return NaN;
}

// ical.js 2.x exposes recurrence expansion through ICAL.RecurExpansion
// (Component#iterator does not exist in this version).
function iterateOccurrences(vev) {
  const dtstartProp = vev.getFirstProperty('dtstart');
  const exp = new ICAL.RecurExpansion({
    component: vev,
    dtstart: dtstartProp.getFirstValue(),
  });
  return exp;
}

function dtstartIcsLine(ev) {
  const s = ev.start ?? {};
  if (s.date) return `DTSTART;VALUE=DATE:${s.date.replace(/-/g, '')}`;
  let wall = s.dateTime.replace(/[-:]/g, '');
  wall = wall.replace(/\.\d{1,3}/, '');
  if (s.timeZone) return `DTSTART;TZID=${s.timeZone}:${wall.replace(/Z$|[+-]\d{4}$|[+-]\d{2}:?\d{2}$/, '')}`;
  return `DTSTART:${wall}`;
}

function rdateOccurrencesMs(line) {
  try {
    const synth = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:rdate-probe\r\nDTSTART:20000101T000000Z\r\n${line}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    const comp = new ICAL.Component(ICAL.parse(synth));
    const vev = comp.getFirstSubcomponent('vevent');
    const out = [];
    for (const p of vev.getAllProperties('rdate')) {
      for (const v of p.getValues()) {
        if (v && 'isDate' in v) out.push(msFromIcalTime(v));
        else if (v && v.start && 'isDate' in v.start) out.push(msFromIcalTime(v.start));
      }
    }
    return out.filter(Number.isFinite);
  } catch {
    return [];
  }
}

// Recurrence-aware relevance: does the RRULE produce any occurrence in window?
function rruleReachesWindow(ev, rrules, wsMs, weMs, ctx) {
  try {
    const vtz = (ctx?.timezoneIcs ?? []).filter(Boolean);
    const synth = ['BEGIN:VCALENDAR', 'VERSION:2.0', ...vtz, 'BEGIN:VEVENT',
      dtstartIcsLine(ev), ...rrules, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const comp = new ICAL.Component(ICAL.parse(synth));
    const vev = comp.getFirstSubcomponent('vevent');
    const infinite = rrules.some((l) => {
      const v = l.replace(/^RRULE:/i, '');
      return !/UNTIL=/i.test(v) && !/COUNT=/i.test(v);
    });
    if (infinite) return true;
    const exp = iterateOccurrences(vev);
    let t;
    let guard = 0;
    for (;;) {
      t = exp.next();
      if (t == null) return false; // finite rule exhausted: last occurrence is in the past
      guard += 1;
      if (guard > 100_000) return true; // cannot determine in reasonable time — include
      const ms = msFromIcalTime(t);
      if (!Number.isFinite(ms)) continue;
      if (ms > weMs) return false;
      if (ms >= wsMs) return true;
    }
  } catch {
    return true; // invalid rule / unknown timezone — include (fail open)
  }
}

// Main pure predicate used by the sync engine and tests.
export function isEventInWindow(ev, windowStartMs, windowEndMs, ctx = {}) {
  if (!ev) return false;
  if (ev.status === 'CANCELLED') return false; // handled via deletion sync instead
  const startMs = instantOf(ev.start);
  if (!Number.isFinite(startMs)) return true; // unknown start — include (fail open)
  if (startMs > windowEndMs) return false;
  const rec = (ev.recurrence ?? []).filter((l) => /^(RRULE|RDATE):/i.test(l));
  const rrules = rec.filter((l) => /^RRULE:/i.test(l));
  const rdates = rec.filter((l) => /^RDATE:/i.test(l));
  if (rrules.length === 0 && rdates.length === 0) {
    const endMs = instantOf(ev.end);
    const last = Number.isFinite(endMs) ? endMs : startMs;
    return last >= windowStartMs;
  }
  if (rrules.length === 0) {
    if (startMs >= windowStartMs && startMs <= windowEndMs) return true;
    return rdates.some((l) => rdateOccurrencesMs(l).some((ms) => ms >= windowStartMs && ms <= windowEndMs));
  }
  return rruleReachesWindow(ev, rrules, windowStartMs, windowEndMs, ctx);
}

export function computeWindow(nowMs, config) {
  return {
    start: nowMs - config.windowPastDays * 86_400_000,
    end: nowMs + config.windowFutureDays * 86_400_000,
  };
}

// Filter feed events for a sync run: cancelled events always pass through
// (the planner maps them to deletions), others must be relevant in-window.
export function filterEventsForWindow(events, windowMs, ctx = {}) {
  return (events ?? []).filter((ev) => (
    ev.status === 'CANCELLED' ? true : isEventInWindow(ev, windowMs.start, windowMs.end, ctx)
  ));
}
