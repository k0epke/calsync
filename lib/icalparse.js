// Feed parsing: ICS / vCalendar 1.0 (VCS) / XCal (RFC 6321) / JCal (RFC 7265),
// all normalized to jCal (ical.js internal representation) and a plain-JS
// event model used by the sync engine. Format is sniffed from content —
// URL extensions are unreliable.
import crypto from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { ICAL } from './deps.js';

export class ParseError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ParseError';
    if (cause) this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Format sniffing (content-based)
// ---------------------------------------------------------------------------

function looksLikeJCal(t) {
  try {
    const data = JSON.parse(t);
    if (!Array.isArray(data)) return false;
    if (typeof data[0] === 'string' && String(data[0]).toLowerCase() === 'vcalendar') return true;
    return Array.isArray(data[0]) && data[0][0] === 'vcalendar';
  } catch {
    return false;
  }
}

export function sniffFormat(text) {
  if (typeof text !== 'string' || !text.trim()) throw new ParseError('Feed is empty');
  const t = text.replace(/^\uFEFF/, '').trimStart();
  if (t[0] === '[') {
    if (looksLikeJCal(t)) return 'jcal';
    throw new ParseError('Feed starts with "[" (JSON) but is not a valid JCal document');
  }
  if (t[0] === '<') return 'xcal';
  if (/^BEGIN\s*:\s*VCALENDAR/i.test(t)) {
    if (/^VERSION\s*:\s*1\.0\s*$/im.test(t) || /^DSTART\s*[:;]/im.test(t)) return 'vcs';
    return 'ics';
  }
  throw new ParseError('Unrecognized feed format: expected ICS, vCalendar 1.0, XCal XML or JCal JSON');
}

// ---------------------------------------------------------------------------
// ICS leniency: many real-world feeds omit ';VALUE=DATE' on date-only
// DTSTART/DTEND/RDATE/EXDATE/DUE/RECURRENCE-ID values. ical.js rejects those,
// so we insert the parameter before parsing.
// ---------------------------------------------------------------------------

const VALUE_DATE_PROPS = new Set(['dtstart', 'dtend', 'due', 'recurrence-id', 'rdate', 'exdate']);

export function insertValueDateParams(text) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const m = /^([A-Za-z][A-Za-z0-9-]*)((?:;[^:]*)?):(.*?)$/.exec(line);
      if (!m) return line;
      const [, nameRaw, paramsRaw, value] = m;
      const name = nameRaw.toLowerCase();
      if (!VALUE_DATE_PROPS.has(name)) return line;
      const isAllDates = value.length > 0 && value.split(',').every((v) => /^\d{8}$/.test(v.trim()));
      if (!isAllDates) return line;
      if (/;VALUE\s*=|TZID/i.test(paramsRaw)) return line;
      return `${nameRaw}${paramsRaw};VALUE=DATE:${value}`;
    })
    .join('\n');
}

// XSD-style ("2026-04-05", "2026-04-05T09:00:00Z") vs ICS basic form
// ("20260405", "20260405T090000Z"): XCal/JCal are specified in the extended
// form, but some feeds send ICS-style values — accept both, normalize to
// extended (what ical.js jCal uses internally).
export function normalizeCalendarValue(valueType, value) {
  const s = String(value ?? '').trim();
  if (!s) return s;
  const t = String(valueType ?? '').toLowerCase();
  if (t === 'utc-offset') {
    if (/^[+-]\d{4}$/.test(s)) return `${s.slice(0, 3)}:${s.slice(3)}`;
    return s;
  }
  if (t === 'date-time') {
    let m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(s);
    if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]}`;
    return s;
  }
  if (t === 'date') {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    return s;
  }
  if (t === 'recur') {
    if (/UNTIL/i.test(s)) {
      return s.replace(/UNTIL=(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)/i,
        (_all, y, mo, d, h, mi, se, z) => `UNTIL=${y}-${mo}-${d}T${h}:${mi}:${se}${z.toUpperCase()}`);
    }
    return s;
  }
  return s;
}

// ---------------------------------------------------------------------------
// vCalendar 1.0 (VCS) — lenient preprocessing into ICS 2.0 semantics
// ---------------------------------------------------------------------------

export function preprocessVcs(text) {
  const warnings = [];
  const lines = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (/^[ \t]/.test(rawLine) && lines.length) lines[lines.length - 1] += rawLine.slice(1);
    else lines.push(rawLine);
  }
  const out = [];
  for (const line of lines) {
    const m = /^(DSTART|DEND)([:;].*)$/i.exec(line);
    if (m) { out.push(m[1].toUpperCase() === 'DSTART' ? `DTSTART${m[2]}` : `DTEND${m[2]}`); continue; }
    const r = /^RRULE:(.*)$/i.exec(line);
    if (r) {
      const converted = vcsRruleToIcs(r[1]);
      if (converted) out.push(`RRULE:${converted}`);
      else {
        warnings.push(`Unsupported vCalendar 1.0 RRULE "${r[1].trim()}" — recurrence dropped (single occurrence kept)`);
        out.push(`X-VCS-RRULE-RAW:${r[1].trim()}`);
      }
      continue;
    }
    if (/^\s*(AALARM|DALARM)\s*[:;]/i.test(line)) continue; // v1 alarms: always ignored
    out.push(line);
  }
  return { text: out.join('\n'), warnings };
}

// Convert common vCalendar 1.0 RRULE bases to RFC 5545 form.
// Supported: D<n>, W<n> <days>, MD<n> <monthdays>, MP<n> <pos> <days>,
// YD<n> (BYYEARDAY), YM<n> <months>, optional trailing "#<count>" ("#0" = unbounded).
// Unrecognized input returns null (dropped with a warning).
export function vcsRruleToIcs(value) {
  const tokens = String(value ?? '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const base = /^(D|W|MD|MP|YD|YM)(\d+)$/.exec(tokens[0].toUpperCase());
  if (!base) return null;
  const kind = base[1];
  const interval = Math.max(1, parseInt(base[2], 10) || 1);
  const rest = tokens.slice(1).map((t) => t.replace(/(\d)\+$/, '$1')); // "1+" -> "1"
  let count = null;
  const idx = rest.findIndex((t) => t.startsWith('#'));
  if (idx !== -1) {
    const c = parseInt(rest[idx].slice(1), 10);
    if (Number.isFinite(c) && c > 0) count = c;
    rest.splice(idx, 1);
  }
  const parts = new Map();
  switch (kind) {
    case 'D': parts.set('FREQ', 'DAILY'); break;
    case 'W': parts.set('FREQ', 'WEEKLY'); break;
    case 'MD': case 'MP': parts.set('FREQ', 'MONTHLY'); break;
    case 'YD': case 'YM': parts.set('FREQ', 'YEARLY'); break;
    default: return null;
  }
  if (interval > 1) parts.set('INTERVAL', String(interval));
  const isDay = (t) => /^(MO|TU|WE|TH|FR|SA|SU)$/i.test(t);
  const posOnly = (t) => /^[+-]?\d*[+-]?$/.test(t) && (t.includes('+') || t.includes('-') || /^\d+$/.test(t)) && !isDay(t);
  if (kind === 'W') {
    const days = rest.filter(isDay).map((t) => t.toUpperCase());
    if (days.length) parts.set('BYDAY', days.join(','));
  } else if (kind === 'MD') {
    const nums = rest.filter((t) => /^\d{1,2}$/.test(t));
    if (nums.length) parts.set('BYMONTHDAY', nums.join(','));
  } else if (kind === 'MP') {
    // Position/day groups: "1+ MO" / "2- WE TH" / "-" (last occurrence).
    const byday = [];
    let pending = [];
    for (const t of rest) {
      const dm = /^([+-]?)(\d*)([+-]?)(MO|TU|WE|TH|FR|SA|SU)$/i.exec(t);
      if (dm) {
        const sign1 = dm[1]; const numStr = dm[2]; const sign2 = dm[3]; const day = dm[4].toUpperCase();
        const neg = sign1 === '-' || sign2 === '-';
        const explicitPos = Boolean(numStr || sign1 || sign2);
        if (explicitPos) {
          let pos = numStr ? parseInt(numStr, 10) : null;
          if (pos == null) pos = neg ? -1 : 1;
          else if (neg) pos = -pos;
          pending.push(String(pos));
          for (const p of pending) byday.push(`${p}${day}`);
          pending = [];
        } else if (pending.length) {
          for (const p of pending) byday.push(`${p}${day}`); // pair pending positions with this day
          pending = [];
        } else {
          byday.push(day);
        }
      } else if (isDay(t)) {
        if (pending.length) { for (const p of pending) byday.push(`${p}${t.toUpperCase()}`); pending = []; }
        else byday.push(t.toUpperCase());
      } else if (posOnly(t)) {
        const neg = t.startsWith('-') || t.endsWith('-');
        const num = parseInt(t.replace(/[+-]/g, ''), 10);
        const pos = Number.isFinite(num) ? (neg ? -num : num) : (neg ? -1 : 1);
        pending.push(String(pos));
      }
    }
    if (byday.length) parts.set('BYDAY', byday.join(','));
    else return null;
  } else if (kind === 'YD') {
    const nums = rest.filter((t) => /^\d{1,3}$/.test(t));
    if (nums.length) parts.set('BYYEARDAY', nums.join(','));
  } else if (kind === 'YM') {
    const nums = rest.filter((t) => /^\d{1,2}$/.test(t));
    if (nums.length) parts.set('BYMONTH', nums.join(','));
  }
  if (count) parts.set('COUNT', String(count));
  return [...parts].map(([k, v]) => `${k}=${v}`).join(';');
}

// ---------------------------------------------------------------------------
// recur values -> ical.js jCal object shape.
// ical.js 2.x normalizes recur jCal values to plain objects like
// { freq: 'WEEKLY', until: '2026-04-01T00:00:00Z', interval: 2,
//   byday: ['MO','WE'], bysetpos: 1, bymonthday: 15 }
// lowercase keys, numeric parts as numbers, day codes uppercased.
// ---------------------------------------------------------------------------

const RECUR_NUMERIC_KEYS = new Set(['bysecond', 'byminute', 'byhour', 'count', 'interval',
  'bymonthday', 'byyearday', 'byweekno', 'bymonth', 'bysetpos']);
const RECUR_STRING_KEYS = new Set(['freq', 'until', 'wkst']);

function toNumberOrArray(v) {
  if (Array.isArray(v)) {
    const nums = v.map((x) => Number(x)).filter((n) => Number.isFinite(n));
    return nums.length ? nums : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function recurToIcalJsShape(input) {
  let obj;
  if (typeof input === 'string') {
    obj = {};
    for (const pair of input.split(';')) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      obj[pair.slice(0, eq).trim().toLowerCase()] = pair.slice(eq + 1).trim();
    }
  } else if (input && typeof input === 'object') {
    obj = input;
  } else {
    return null;
  }
  const out = {};
  for (const [rawKey, rawVal] of Object.entries(obj)) {
    const key = String(rawKey).toLowerCase();
    if (rawVal == null || rawVal === '') continue;
    if (RECUR_NUMERIC_KEYS.has(key)) {
      const n = toNumberOrArray(rawVal);
      if (n != null) out[key] = n;
    } else if (key === 'byday') {
      const arr = (Array.isArray(rawVal) ? rawVal : String(rawVal).split(','))
        .map((d) => String(d).trim().toUpperCase()).filter(Boolean);
      if (arr.length) out[key] = arr;
    } else if (RECUR_STRING_KEYS.has(key)) {
      const s = normalizeCalendarValue('recur', `${key}=${rawVal}`).split(/[=:]/).slice(1).join('=') || String(rawVal);
      const cleaned = String(s).trim().toUpperCase();
      if (cleaned) out[key] = cleaned;
    } else {
      out[key] = Array.isArray(rawVal) ? rawVal : String(rawVal);
    }
  }
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------
// XCal (RFC 6321) XML -> jCal
// ---------------------------------------------------------------------------

const COMPONENT_NAMES = new Set([
  'vcalendar', 'vevent', 'vtodo', 'vjournal', 'vfreebusy', 'vtimezone', 'standard', 'daylight',
  'valarm', 'vavailability', 'available', 'vpoll', 'vbusy', 'vlocation', 'vresource', 'partition',
]);

function childNodes(el) { return Array.isArray(el) ? el : []; }

function textOf(children) {
  let s = '';
  for (const child of childNodes(children)) {
    if (child && typeof child === 'object' && '#text' in child) s += String(child['#text']);
  }
  return s.trim();
}

function directText(children) {
  let s = '';
  for (const child of childNodes(children)) {
    if (child && typeof child === 'object') {
      if ('#text' in child) s += String(child['#text']);
    } else if (typeof child === 'string') s += child;
  }
  return s.trim();
}

function findRootNode(tree) {
  const candidates = Array.isArray(tree) ? tree : [tree];
  for (const node of candidates) {
    if (!node || typeof node !== 'object') continue;
    for (const key of Object.keys(node)) {
      if (key.toLowerCase() === 'icalendar') return { name: 'icalendar', children: node[key] };
    }
  }
  throw new ParseError('Not an XCal document: no <icalendar> root element');
}

// Builds a jCal value primitive for one xCal value element.
function xcalValue(children, valueType) {
  const t = String(valueType ?? '').toLowerCase();
  if (t === 'recur') {
    const obj = {};
    for (const child of childNodes(children)) {
      if (!child || typeof child !== 'object') continue;
      for (const key of Object.keys(child)) {
        if (key === '#text' || key === ':@') continue;
        const val = textOf(child[key]);
        if (val !== '') obj[key.toLowerCase()] = val;
      }
    }
    if (Object.keys(obj).length) return recurToIcalJsShape(obj);
    const direct = directText(children);
    if (direct) return recurToIcalJsShape(direct);
    return null;
  }
  // Most value elements wrap their content in a nested value element
  // (e.g. <tzid><text>US/Eastern</text></tzid>) or carry text directly.
  let nested = null;
  for (const child of childNodes(children)) {
    if (!child || typeof child !== 'object') continue;
    for (const key of Object.keys(child)) {
      if (key === '#text' || key === ':@') continue;
      nested = child[key];
    }
  }
  const raw = nested ? textOf(nested) : directText(children);
  return raw === '' ? null : normalizeCalendarValue(t, raw);
}

function componentToJCal(children, name) {
  const props = [];
  const comps = [];
  for (const child of childNodes(children)) {
    if (!child || typeof child !== 'object') continue;
    for (const key of Object.keys(child)) {
      if (key === ':@' || key === '#text') continue;
      const lname = key.toLowerCase();
      if (COMPONENT_NAMES.has(lname)) comps.push(componentToJCal(child[key], lname));
      else props.push(propertyToJCal(child[key], lname));
    }
  }
  return [name, props, comps];
}

function digText(children) {
  // Text held directly, or wrapped in a nested value element
  // (RFC 6321: <tzid><text>US/Eastern</text></tzid>).
  const direct = textOf(children);
  if (direct) return direct;
  for (const c of childNodes(children)) {
    if (!c || typeof c !== 'object') continue;
    for (const k of Object.keys(c)) {
      if (k === ':@' || k === '#text') continue;
      const v = textOf(c[k]);
      if (v) return v;
    }
  }
  return '';
}

function propertyToJCal(el, name) {
  const params = {};
  const values = [];
  let valType = 'text';
  for (const child of childNodes(el)) {
    if (!child || typeof child !== 'object') continue;
    for (const key of Object.keys(child)) {
      if (key === ':@' || key === '#text') continue;
      const lname = key.toLowerCase();
      if (lname === 'parameters') {
        for (const p of childNodes(child[key])) {
          if (!p || typeof p !== 'object') continue;
          for (const pk of Object.keys(p)) {
            if (pk === ':@' || pk === '#text') continue;
            const attrs = p[':@'] ?? {};
            const explicitName = attrs['@_name'] ?? attrs['@_NAME'];
            let paramName = String(explicitName ?? pk).toLowerCase();
            if (paramName.endsWith('-param')) paramName = paramName.slice(0, -6);
            const val = digText(p[pk]);
            if (val !== '') params[paramName] = val;
          }
        }
        continue;
      }
      // A value element: its tag names the value type (text, date-time, date, ...).
      valType = lname.replace(/-param$/, '');
      const v = xcalValue(child[key], valType);
      if (v != null) values.push(v);
    }
  }
  if (!values.length) {
    const fallback = directText(el);
    if (fallback) values.push(normalizeCalendarValue(valType, fallback));
  }
  return [name, params, valType, ...values];
}

export function jCalFromXcal(xmlText) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    preserveOrder: true,
    attributeNamePrefix: '@_',
    processEntities: true,
    parseTagValue: false,
    parseAttributeValue: false,
  });
  let tree;
  try { tree = parser.parse(xmlText); } catch (err) { throw new ParseError(`XCal XML parse failed: ${err.message}`, err); }
  const root = findRootNode(tree);
  const vcalNode = childNodes(root.children).find(
    (n) => n && typeof n === 'object' && Object.keys(n).some((k) => k.toLowerCase() === 'vcalendar'),
  );
  if (!vcalNode) throw new ParseError('XCal document has no <vcalendar> component');
  const vcalKey = Object.keys(vcalNode).find((k) => k.toLowerCase() === 'vcalendar');
  const vcalChildren = childNodes(vcalNode[vcalKey]);
  return { jCal: componentToJCal(vcalChildren, 'vcalendar'), warnings: [] };
}

// ---------------------------------------------------------------------------
// JCal (RFC 7265) JSON -> canonical jCal
// ---------------------------------------------------------------------------

export function jCalFromJcal(jsonText) {
  let data;
  try { data = JSON.parse(jsonText); } catch (err) { throw new ParseError(`Invalid JSON in JCal feed: ${err.message}`, err); }
  if (!Array.isArray(data) || !data.length) throw new ParseError('JCal feed must be a non-empty JSON array');
  if (Array.isArray(data[0])) data = data[0]; // tolerate a wrapper array of vcalendars
  if (data[0] !== 'vcalendar') throw new ParseError('JCal root element must be "vcalendar"');
  return { jCal: normalizeJCalComponent(data), warnings: [] };
}

function normalizeJCalComponent(jc) {
  if (!Array.isArray(jc) || typeof jc[0] !== 'string') throw new ParseError('Malformed JCal component');
  const props = (Array.isArray(jc[1]) ? jc[1] : []).map(normalizeJCalProperty);
  const comps = (Array.isArray(jc[2]) ? jc[2] : []).map(normalizeJCalComponent);
  return [String(jc[0]).toLowerCase(), props, comps];
}

function normalizeJCalProperty(prop) {
  if (!Array.isArray(prop) || prop.length < 4) throw new ParseError('Malformed JCal property');
  const [name, params, type, ...values] = prop;
  const t = String(type).toLowerCase();
  const normValues = values.map((v) => {
    if (t === 'recur') return recurToIcalJsShape(v);
    if (t === 'boolean' && typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'string') return normalizeCalendarValue(t, v);
    return v;
  }).filter((v) => v != null);
  return [String(name).toLowerCase(), params && typeof params === 'object' && !Array.isArray(params) ? params : {},
    String(type).toLowerCase(), ...normValues];
}

// ---------------------------------------------------------------------------
// jCal -> plain-JS event model
// ---------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');

function offsetSecondsOf(t) {
  if (t.isDate) return 0;
  if (typeof t.utcOffset === 'function') {
    const v = t.utcOffset();
    if (typeof v === 'number') return v; // ical.js: seconds east of UTC
  }
  if (typeof t.toJSDate === 'function') {
    // Derived offset: wall-clock-as-UTC minus true instant (sign matters).
    const js = t.toJSDate();
    const wallMs = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
    return Math.round((wallMs - js.getTime()) / 1000);
  }
  return 0;
}

function offsetFmt(seconds) {
  const sign = seconds < 0 ? '-' : '+';
  const abs = Math.abs(seconds);
  return `${sign}${pad2(Math.floor(abs / 3600))}:${pad2(Math.floor((abs % 3600) / 60))}`;
}

// Best-effort offset for an IANA timezone at a given wall time (used when a
// feed references a TZID without shipping a VTIMEZONE definition).
function ianaOffsetSeconds(tzid, wallIsoAtUtc) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid, timeZoneName: 'longOffset', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = dtf.formatToParts(new Date(wallIsoAtUtc));
    const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
    if (!m) return 0; // "GMT" means +00:00
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (parseInt(m[2], 10) * 3600 + (m[3] ? parseInt(m[3], 10) * 60 : 0));
  } catch {
    return null; // unknown zone name — caller falls back
  }
}

// DTSTART/DTEND property -> Google-style { date } or { dateTime, timeZone? }.
function valueFromDt(prop, warnings) {
  const v = prop.getFirstValue();
  if (v == null) throw new Error('empty date value');
  if (typeof v !== 'object' || !('isDate' in v)) {
    // Period or exotic value: use its start.
    if (v && v.start && 'isDate' in v.start) return valueFromTime(v.start, prop, warnings);
    throw new Error('unsupported date value type');
  }
  return valueFromTime(v, prop, warnings);
}

function valueFromTime(t, prop, warnings) {
  if (t.isDate) return { value: { date: `${t.year}-${pad2(t.month)}-${pad2(t.day)}` } };
  const wall = `${t.year}-${pad2(t.month)}-${pad2(t.day)}T${pad2(t.hour)}:${pad2(t.minute)}:${pad2(t.second)}`;
  const wallIsoAtUtc = `${wall}Z`;
  const tzid = prop.getParameter('tzid') ?? prop.getParameter('TZID') ?? null;
  const zoneId = t.zone && t.zone.tzid ? String(t.zone.tzid) : null;
  if (tzid) {
    let offS;
    if (zoneId === 'UTC') {
      return { value: { dateTime: `${wall}Z`, timeZone: String(tzid) } };
    } else if (zoneId && zoneId !== 'floating') {
      offS = offsetSecondsOf(t); // VTIMEZONE-derived offset
    } else {
      offS = ianaOffsetSeconds(String(tzid), wallIsoAtUtc);
      if (offS == null) offS = offsetSecondsOf(t); // unknown zone name: server-local
    }
    return { value: { dateTime: wall + offsetFmt(offS), timeZone: String(tzid) } };
  }
  if (zoneId === 'UTC') return { value: { dateTime: `${wall}Z` } };
  // Floating time (no TZID, no Z): treated as UTC — documented gap.
  if (warnings) warnings.push('Event uses a floating ( timezone-less ) time — interpreted as UTC');
  return { value: { dateTime: `${wall}Z` }, floating: true };
}

function textProp(comp, name) {
  try {
    const v = comp.getFirstPropertyValue(name);
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (v.toString) return String(v);
    return '';
  } catch { return ''; }
}

function eventFromComponent(comp, ctx, warnings) {
  const uidProp = comp.getFirstProperty('uid');
  const rawUid = uidProp ? String(uidProp.getFirstValue() ?? '').trim() : '';
  const dtstartProp = comp.getFirstProperty('dtstart');
  if (!dtstartProp) throw new Error('VEVENT has no DTSTART');
  const startInfo = valueFromDt(dtstartProp, warnings);
  const start = startInfo.value;

  let end = null;
  const dtendProp = comp.getFirstProperty('dtend');
  if (dtendProp) {
    end = valueFromDt(dtendProp, warnings).value;
  } else {
    const durProp = comp.getFirstProperty('duration');
    if (durProp) {
      try {
        const d = durProp.getFirstValue();
        const seconds = d && typeof d.toSeconds === 'function' ? d.toSeconds() : null;
        if (seconds != null && seconds !== 0) {
          if (startInfo.value.date) {
            if (seconds % 86_400 === 0) {
              const days = seconds / 86_400;
              const base = startInfo.value.date.split('-').map(Number);
              const endMs = Date.UTC(base[0], base[1] - 1, base[2]) + days * 86_400_000;
              const dt = new Date(endMs);
              end = { date: `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}` };
            } else {
              // All-day start + sub-day duration: ical.js Date-time drops the
              // remainder, so do the calendar arithmetic here.
              const base = startInfo.value.date.split('-').map(Number);
              const endMs = Date.UTC(base[0], base[1] - 1, base[2]) + seconds * 1000;
              const dt = new Date(endMs);
              const endWall = `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}T${pad2(dt.getUTCHours())}:${pad2(dt.getUTCMinutes())}:${pad2(dt.getUTCSeconds())}`;
              const t0 = dtstartProp.getFirstValue();
              const tzid = dtstartProp.getParameter('tzid') ?? dtstartProp.getParameter('TZID') ?? null;
              if (tzid) {
                let offS = ianaOffsetSeconds(String(tzid), `${endWall}Z`);
                if (offS == null) offS = offsetSecondsOf(t0);
                end = { dateTime: endWall + offsetFmt(offS), timeZone: String(tzid) };
              } else {
                end = { dateTime: `${endWall}Z` };
              }
            }
          } else {
            const t0 = dtstartProp.getFirstValue().clone();
            t0.addDuration(d);
            end = valueFromTime(t0, dtstartProp, warnings).value;
          }
        }
      } catch (err) {
        warnings.push(`Could not compute DTEND from DURATION: ${err.message}`);
      }
    }
  }

  const recurrence = [];
  for (const name of ['rrule', 'rdate', 'exdate']) {
    for (const p of comp.getAllProperties(name)) {
      const line = p.toICALString().trim();
      if (line) recurrence.push(line);
    }
  }

  const statusValue = comp.getFirstPropertyValue('status');
  const status = statusValue ? String(statusValue).toUpperCase() : 'CONFIRMED';
  const transp = String(textProp(comp, 'transp')).toUpperCase();
  const cls = String(textProp(comp, 'class')).toUpperCase();
  const seqVal = comp.getFirstPropertyValue('sequence');
  const seqNum = seqVal != null && Number.isFinite(Number(seqVal)) ? Number(seqVal) : null;

  let uid = rawUid;
  if (!uid) {
    const seed = JSON.stringify([ctx.sourceKey, textProp(comp, 'summary'),
      start.dateTime ?? start.date, end?.dateTime ?? end?.date]);
    uid = `calsync-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32)}@calsync.local`;
    warnings.push(`VEVENT #${ctx.idx + 1} had no UID — synthesized ${uid}`);
  }

  return {
    uid,
    summary: textProp(comp, 'summary'),
    description: textProp(comp, 'description'),
    location: textProp(comp, 'location'),
    status,
    start,
    end,
    recurrence,
    allDay: start.date != null,
    transparency: transp,
    visibility: cls,
    sequence: seqNum,
  };
}

// Ensure VTIMEZONE definitions are registered in ical.js's global service so
// TZID lookups resolve (ical.js does not auto-register on parse).
export function registerTimezonesFromJCal(jCal) {
  try {
    const root = new ICAL.Component(jCal);
    if (String(root.name) !== 'vcalendar') return;
    for (const tzComp of root.getAllSubcomponents('vtimezone')) {
      try {
        const tzid = String(tzComp.getFirstPropertyValue('tzid') || '');
        if (!tzid) continue;
        if (ICAL.TimezoneService.has(tzid)) continue; // first definition wins
        ICAL.TimezoneService.register(new ICAL.Timezone({ component: tzComp, tzid }));
      } catch { /* registration is best-effort */ }
    }
  } catch { /* ignore malformed timezone components */ }
}

export function extractEvents(jCal, warnings = []) {
  const root = new ICAL.Component(jCal);
  if (String(root.name) !== 'vcalendar') throw new ParseError('Root component must be vcalendar');
  registerTimezonesFromJCal(jCal);
  const calendarName = textProp(root, 'x-wr-calname') || textProp(root, 'name');
  let vtimezoneStrings = [];
  try { vtimezoneStrings = root.getAllSubcomponents('vtimezone').map((tz) => tz.toString()); } catch { vtimezoneStrings = []; }
  const counts = { total: 0, cancelled: 0, withRecurrence: 0, missingUid: 0 };
  const events = [];
  const vevents = root.getAllSubcomponents('vevent');
  vevents.forEach((comp, idx) => {
    try {
      const ev = eventFromComponent(comp, { sourceKey: 'calendar', idx }, warnings);
      counts.total += 1;
      if (ev.status === 'CANCELLED') counts.cancelled += 1;
      if (ev.recurrence.some((l) => /^RRULE:/i.test(l))) counts.withRecurrence += 1;
      events.push(ev);
    } catch (err) {
      warnings.push(`Skipped VEVENT #${idx + 1}: ${err.message}`);
    }
  });
  return { events, calendarName, vtimezoneStrings, counts, warnings };
}

// Parse any supported feed text into the normalized model.
export function parseFeed(text) {
  const format = sniffFormat(text);
  const warnings = [];
  let jCal;
  if (format === 'ics') {
    try { jCal = ICAL.parse(insertValueDateParams(text)); } catch (err) { throw new ParseError(`ICS parse failed: ${err.message}`, err); }
  } else if (format === 'vcs') {
    const pre = preprocessVcs(text);
    warnings.push(...pre.warnings);
    try { jCal = ICAL.parse(insertValueDateParams(pre.text)); } catch (err) { throw new ParseError(`vCalendar 1.0 parse failed: ${err.message}`, err); }
  } else if (format === 'xcal') {
    const x = jCalFromXcal(text);
    jCal = x.jCal;
    warnings.push(...x.warnings);
  } else {
    const j = jCalFromJcal(text);
    jCal = j.jCal;
    warnings.push(...j.warnings);
  }
  const extracted = extractEvents(jCal, warnings);
  return { format, jCal, ...extracted };
}

// ---------------------------------------------------------------------------
// Google Calendar event mapping
// ---------------------------------------------------------------------------

export function toGoogleEvent(ev) {
  const g = { iCalUID: ev.uid };
  if (ev.summary) g.summary = String(ev.summary).slice(0, 1000);
  if (ev.description) g.description = String(ev.description).slice(0, 8000);
  if (ev.location) g.location = String(ev.location).slice(0, 600);
  g.start = { ...(ev.start ?? {}) };
  delete g.start.floating;
  if (ev.end) { g.end = { ...ev.end }; delete g.end.floating; }
  const recurrence = (ev.recurrence ?? []).map((l) => String(l).trim()).filter(Boolean);
  if (recurrence.length) g.recurrence = recurrence;
  g.status = 'confirmed';
  if (ev.transparency === 'OPAQUE') g.transparency = 'opaque';
  else if (ev.transparency === 'TRANSPARENT') g.transparency = 'transparent';
  if (ev.visibility === 'PUBLIC') g.visibility = 'public';
  else if (ev.visibility === 'PRIVATE') g.visibility = 'private';
  else if (ev.visibility === 'CONFIDENTIAL') g.visibility = 'confidential';
  if (ev.sequence != null) g.sequence = ev.sequence;
  return g;
}

// ---------------------------------------------------------------------------
// Content hashing for skip-unchanged imports
// ---------------------------------------------------------------------------

// Exactly the fields toGoogleEvent can produce on the Google event object,
// in the order they are hashed. Tests rely on this list — keep it in sync
// with toGoogleEvent above.
export const CONTENT_HASH_FIELDS = Object.freeze([
  'iCalUID', 'summary', 'description', 'location', 'start', 'end',
  'recurrence', 'status', 'transparency', 'visibility', 'sequence',
]);

// sha256 over stable JSON of a normalized Google event (toGoogleEvent
// output): fields are picked in CONTENT_HASH_FIELDS order regardless of the
// input object's key order, and undefined fields are omitted so hash digests
// only change when event content changes.
export function contentHashOf(gEvent) {
  const picked = {};
  for (const field of CONTENT_HASH_FIELDS) {
    const value = gEvent?.[field];
    if (value !== undefined) picked[field] = value;
  }
  return crypto.createHash('sha256').update(JSON.stringify(picked)).digest('hex');
}
