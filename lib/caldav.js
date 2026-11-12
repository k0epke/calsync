// Minimal iCloud CalDAV client. SOURCE support is read-only; TARGET support
// adds the write path (two-way mirror): Apple offers no REST API for iCloud
// Calendar: access is CalDAV over https://caldav.icloud.com with HTTP Basic
// auth (Apple ID + app-specific password from a 2FA account). Operations:
//   1. discoverCalendars() - PROPFIND Depth 0 on the host root to find the
//      current-user-principal, PROPFIND Depth 0 on the principal to find the
//      calendar-home-set, then a PROPFIND Depth 1 listing of the home;
//      returns the VEVENT-capable calendar collections (scheduling inboxes,
//      trash/notify folders and Reminders/VTODO-only collections are
//      skipped).
//   2. fetchEvents(href, { start, end }) - ONE REPORT calendar-query with a
//      time-range matching the sync window, requesting full calendar-data.
//      The REPORT body is parsed through the SAME feed parser
//      (lib/icalparse.js), so every downstream consumer (window filter,
//      planner, Google import, content hashes, deletion sweep) sees byte-for-
//      byte the same normalized event model as ICS feeds.
//   3. snapshotCalendar(href, { start, end }) - same single REPORT, but the
//      result is keyed Map<iCalUID, { etag, status, event }> for the
//      TARGET-side skip-unchanged comparison: status is 'cancelled' or
//      'confirmed' (lowercase, mirroring the Google-snapshot contract) and
//      event is the SAME normalized model parseFeed produces, so canonical
//      hashes compose between both sync directions. Duplicate UIDs keep the
//      first entry; rows whose calendar-data fails to parse are skipped
//      entirely (an unparseable remote copy is simply "not comparable" - the
//      next run rewrites it).
//   4. putEvent(href, event, opts) - builds a VCALENDAR payload (VEVENT with
//      UID preserved, RRULE/RDATE/EXDATE lines, VTIMEZONE blocks for any
//      TZID references, all serialized via ical.js stringify) and PUTs it to
//      {href}/{UID}.ics idempotently (create or overwrite). When a snapshot
//      showed the event already exists, the PUT carries If-Match with that
//      etag; on 412 the client re-snapshots ONCE and retries with the fresh
//      etag (writing unconditionally if the resource vanished in between). A
//      second 412 propagates - one refresh retry, never an infinite race.
//   5. deleteEventByUid(href, uid) - DELETE {href}/{UID}.ics. 404 means the
//      resource is already gone and is NOT an error (returns false). DELETE
//      is sent without If-Match by choice: the deletion sweep already runs
//      only for UIDs the pair itself previously wrote and that are now
//      absent from the source snapshot, so a racing concurrent edit falls
//      under the documented delete-wins semantics.
// REPORT strategy decision (documented in the README as well):
//   - `expand` was REJECTED: expanded instances all carry the series UID
//     (only their RECURRE-ID differs) and would collapse in the UID-keyed
//     planner/importer; keeping master components with RRULE/RDATE/EXDATE
//     lines lets the existing recurrence pipeline and Google-side expansion
//     work unchanged.
//   - a getetag first pass + calendar-multiget was REJECTED: an extra round
//     trip for nothing, because CalSync always needs full event bodies
//     (skip-unchanged hashing happens on the GOOGLE side, not the source
//     side; deletion detection needs the whole snapshot).
// Credentials are injected per instance and never logged: every error
// message and log line leaving this module is scrubbed of the app-specific
// password and its Basic-authorization encodings.
import { XMLParser } from 'fast-xml-parser';
import { parseFeed } from './icalparse.js';
import { ICAL } from './deps.js';

export const ICLOUD_CALDAV_HOST = 'https://caldav.icloud.com';

export class CalDavError extends Error {
  constructor(message, { cause, status, retryAfter } = {}) {
    super(message);
    this.name = 'CalDavError';
    if (cause) this.cause = cause;
    if (status != null) this.status = status;
    if (retryAfter != null) this.retryAfter = retryAfter;
  }
}

// ---------------------------------------------------------------------------
// caldav:// URL encoding (see README): caldav://<host>/<calendar-path> —
// the discovery href with the scheme renamed. No credentials are ever
// accepted in URLs; a plain https:// CalDAV href is also accepted.
// ---------------------------------------------------------------------------

export function parseCaldavUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new CalDavError('CalDAV calendar URL is empty');
  let s = raw.trim();
  if (/^caldav:\/\//i.test(s)) s = s.replace(/^caldav:\/\//i, 'https://');
  let u;
  try { u = new URL(s); } catch {
    throw new CalDavError(`Invalid CalDAV calendar URL: ${s.slice(0, 200)}`);
  }
  if (u.protocol !== 'https:') {
    throw new CalDavError(`Unsupported CalDAV protocol "${u.protocol}" (use caldav:// or https://)`);
  }
  if (!u.host) throw new CalDavError('CalDAV calendar URL is missing its host');
  if (u.username || u.password) {
    throw new CalDavError('CalDAV calendar URL must not carry credentials - set ICLOUD_APPLE_ID/ICLOUD_APP_PASSWORD in .env instead');
  }
  return u;
}

// Canonical caldav:// form of an https CalDAV href (URL object or string).
export function caldavUrlOf(httpsUrl) {
  const u = httpsUrl instanceof URL ? httpsUrl : new URL(String(httpsUrl));
  return `caldav://${u.host}${u.pathname}`;
}

// Epoch-ms -> RFC 4791 time-range form "YYYYMMDDTHHMMSSZ" (ICS UTC).
export function icsUtc(ms) {
  const msNum = Number(ms);
  const d = new Date(msNum);
  if (!Number.isFinite(msNum) || Number.isNaN(d.getTime())) {
    throw new CalDavError('Invalid time-range bound (not a finite epoch-ms value)');
  }
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// One REPORT per fetch: calendar-query honoring the sync window, full
// calendar-data, no expand (rationale at the top of this file). The
// time-range is optional: snapshotCalendar's post-412 refresh re-snapshots
// without a window when the caller had none.
export function calendarQueryBody({ startMs, endMs } = {}) {
  const timeRange = startMs != null && endMs != null
    ? `    <C:time-range start="${icsUtc(startMs)}" end="${icsUtc(endMs)}"/>`
    : null;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
    ' <D:prop>',
    '  <D:getetag/>',
    '  <C:calendar-data/>',
    ' </D:prop>',
    ' <C:filter>',
    '  <C:comp-filter name="VCALENDAR">',
    '   <C:comp-filter name="VEVENT">',
    timeRange,
    '   </C:comp-filter>',
    '  </C:comp-filter>',
    ' </C:filter>',
    '</C:calendar-query>',
  ].filter(Boolean).join('\r\n');
}

// ---------------------------------------------------------------------------
// VCALENDAR payload generation for CalDAV PUTs (pure; exported for tests).
// Everything is serialized by ical.js (Component#toString) so escaping,
// folding and the ICS basic date forms are guaranteed correct.
// ---------------------------------------------------------------------------

// Timezone names that still emit the UTC form (no TZID param, no VTIMEZONE).
const UTC_TZ_NAMES = /^(?:utc|gmt|z)$/i;

// DTSTART/DTEND (model { date } or { dateTime, timeZone? }) -> jCal property.
// UTC times (Z suffix) keep the Z form with no TZID; TZID'd times use the
// wall-clock form with the offset stripped (the TZID plus an in-band
// VTIMEZONE or the server's zone database re-derives the offset). An offset
// suffix alone ('+01:00') is NOT a UTC marker - that is exactly the shape
// of a zoned time coming out of parseFeed/googleItemToEvent.
function icsDtProperty(name, t) {
  if (!t) return null;
  if (t.date) return [name, {}, 'date', String(t.date)]; // stringify emits VALUE=DATE basic form
  const v = String(t.dateTime ?? '');
  if (!v) return null;
  if (/Z$/i.test(v)) return [name, {}, 'date-time', v];
  const tz = t.timeZone && !UTC_TZ_NAMES.test(String(t.timeZone)) ? String(t.timeZone) : null;
  if (tz) {
    return [name, { TZID: tz }, 'date-time', v.replace(/(?:Z|[+-]\d{2}:?\d{2})$/i, '')];
  }
  return [name, {}, 'date-time', `${v.replace(/(?:Z|[+-]\d{2}:?\d{2})$/i, '')}Z`];
}

// RRULE/RDATE/EXDATE ICS lines (verbatim strings from the internal model) ->
// typed jCal properties. Each line is parsed inside a synthetic VEVENT so
// ical.js does the ICS interpretation (recur objects, multi-values, TZID and
// VALUE=DATE params) and Component#toString writes them back byte-stable.
function recurrenceProps(event, warnings) {
  const out = [];
  for (const raw of event?.recurrence ?? []) {
    const line = String(raw ?? '').trim();
    if (!line) continue;
    try {
      const synth = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT',
        'UID:recurrence-line-holder', line, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
      const holder = new ICAL.Component(ICAL.parse(synth)).getFirstSubcomponent('vevent');
      for (const name of ['rrule', 'rdate', 'exdate']) {
        for (const p of holder.getAllProperties(name)) out.push(p.toJSON());
      }
    } catch (err) {
      warnings.push(`Recurrence line dropped from CalDAV PUT: ${line.slice(0, 60)} (${err.message})`);
    }
  }
  return out;
}

// TZIDs the payload references (DTSTART/DTEND timeZone plus TZID params on
// recurrence lines). Every referenced zone gets a VTIMEZONE definition when
// one is available: explicit strings (e.g. the source snapshot's shipped
// definitions) win, then ical.js's global TimezoneService (populated when a
// feed with VTIMEZONEs was parsed in-process). Zones without any definition
// are written as TZID references only - Apple resolves standard Olson names
// from its own database (documented limitation).
function collectTimezoneBlocks(event, explicitStrings, warnings) {
  const tzids = new Set();
  const addTzRef = (t) => {
    if (!t || t.date) return;
    const v = String(t.dateTime ?? '');
    if (!v || /Z$/i.test(v)) return;
    const tz = t.timeZone ? String(t.timeZone) : null;
    if (tz && !UTC_TZ_NAMES.test(tz)) tzids.add(tz);
  };
  addTzRef(event?.start);
  addTzRef(event?.end);
  for (const line of event?.recurrence ?? []) {
    for (const m of String(line).matchAll(/(?:^|;)\s*TZID=([^:;\s]+)/g)) {
      tzids.add(m[1].replace(/^"|"$/g, ''));
    }
  }
  const blocks = [];
  const used = new Set();
  const pushBlock = (tzid, jCal) => {
    if (!tzid || used.has(tzid) || !tzids.has(tzid)) return;
    if (!Array.isArray(jCal) || String(jCal[0]).toLowerCase() !== 'vtimezone') return;
    used.add(tzid);
    blocks.push(jCal);
  };
  for (const raw of explicitStrings ?? []) {
    const s = String(raw ?? '').trim();
    if (!s) continue;
    try {
      const comp = new ICAL.Component(ICAL.parse(s));
      if (String(comp.name).toLowerCase() !== 'vtimezone') continue;
      pushBlock(String(comp.getFirstPropertyValue('tzid') ?? ''), comp.toJSON());
    } catch {
      warnings.push('Unparsable VTIMEZONE definition skipped in CalDAV PUT payload');
    }
  }
  for (const tzid of tzids) {
    if (used.has(tzid)) continue;
    let tz = null;
    try { if (ICAL.TimezoneService.has(tzid)) tz = ICAL.TimezoneService.get(tzid); } catch { tz = null; }
    const comp = tz?.component ?? null;
    const jCal = comp && typeof comp.toJSON === 'function' ? comp.toJSON() : comp;
    if (!jCal) {
      warnings.push(`No VTIMEZONE definition available for TZID ${tzid} - written as a TZID reference without an in-band definition`);
      continue;
    }
    pushBlock(tzid, jCal);
  }
  return blocks;
}

// Builds the full VCALENDAR payload CalSync PUTs to {calendarHref}/{UID}.ics:
// VEVENT with the UID preserved, DTSTART/DTEND, RRULE/RDATE/EXDATE lines,
// VTIMEZONE blocks for every referenced TZID, plus the summary/description,
// location, STATUS, TRANSP, CLASS and SEQUENCE subset CalSync mirrors.
// Returns { body, warnings }.
export function putEventBody(event, { timezoneStrings = [] } = {}) {
  const warnings = [];
  const uid = String(event?.uid ?? '').trim();
  if (!uid) throw new CalDavError('CalDAV PUT requires an event with a UID');
  const dtstart = icsDtProperty('dtstart', event.start);
  if (!dtstart) throw new CalDavError(`Event ${uid} has no usable DTSTART for a CalDAV PUT`);
  const props = [['uid', {}, 'text', uid], dtstart];
  const dtend = icsDtProperty('dtend', event.end);
  if (dtend) props.push(dtend);
  props.push(...recurrenceProps(event, warnings));
  if (event.summary) props.push(['summary', {}, 'text', String(event.summary)]);
  if (event.description) props.push(['description', {}, 'text', String(event.description)]);
  if (event.location) props.push(['location', {}, 'text', String(event.location)]);
  props.push(['status', {}, 'text', String(event.status || 'CONFIRMED').toUpperCase()]);
  const transp = String(event.transparency ?? '').toUpperCase();
  if (transp === 'OPAQUE' || transp === 'TRANSPARENT') props.push(['transp', {}, 'text', transp]);
  const cls = String(event.visibility ?? '').toUpperCase();
  if (['PUBLIC', 'PRIVATE', 'CONFIDENTIAL'].includes(cls)) props.push(['class', {}, 'text', cls]);
  const seqRaw = Number(event.sequence);
  if (event.sequence != null && Number.isFinite(seqRaw)) props.push(['sequence', {}, 'integer', seqRaw]);

  const vcal = ['vcalendar',
    [
      ['version', {}, 'text', '2.0'],
      ['prodid', {}, 'text', '-//CalSync//CalSync//EN'],
      ['calscale', {}, 'text', 'GREGORIAN'],
    ],
    [...collectTimezoneBlocks(event, timezoneStrings, warnings), ['vevent', props, []]]];
  return { body: new ICAL.Component(vcal).toString(), warnings };
}

function propfindBody(props) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">', ' <D:prop>'];
  for (const p of props) lines.push(`  <${p}/>`);
  lines.push(' </D:prop>', '</D:propfind>');
  return lines.join('\r\n');
}

// ---------------------------------------------------------------------------
// WebDAV multistatus walking (namespace prefixes are stripped at parse time,
// so iCloud's D:/C: tags become plain names).
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
});

function asArray(v) { return v == null ? [] : Array.isArray(v) ? v : [v]; }

// Concatenates every text node (direct text or nested, including CDATA).
function nodeText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(nodeText).join('').trim();
  if (typeof v !== 'object') return String(v).trim();
  let out = '';
  for (const [k, val] of Object.entries(v)) {
    if (k === ':@' || k.startsWith('@_')) continue;
    if (k === '#text' || k === '__cdata') out += nodeText(val);
  }
  return out.trim();
}

function childTags(v) {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return [];
  return Object.keys(v).filter((k) => k !== ':@' && k !== '#text' && k !== '__cdata' && !k.startsWith('@_'));
}

// Parses a 207 multistatus body into [{ href, status, props }]; per-response
// props come from propstat blocks that report HTTP 200 (missing props use
// other statuses and are dropped).
export function parseMultistatus(xmlText) {
  let doc;
  try { doc = xmlParser.parse(xmlText); } catch (err) {
    throw new CalDavError(`CalDAV XML parse failed: ${err.message}`, err);
  }
  const root = doc?.multistatus
    ?? (Array.isArray(doc) ? doc.find((d) => d && typeof d === 'object' && d.multistatus)?.multistatus : null);
  if (root == null || root === '') return []; // empty multistatus: zero responses
  if (typeof root !== 'object') throw new CalDavError('CalDAV response is not a WebDAV multistatus document');
  return asArray(root.response).map((resp) => {
    const href = nodeText(asArray(resp?.href)[0]);
    const status = nodeText(asArray(resp?.status)[0]);
    const props = {};
    for (const ps of asArray(resp?.propstat)) {
      const psStatus = nodeText(asArray(ps?.status)[0]);
      if (psStatus && !/\b200\b/.test(psStatus)) continue;
      for (const [k, v] of Object.entries(ps?.prop ?? {})) {
        if (k === ':@' || k.startsWith('@_')) continue;
        props[k] = v;
      }
    }
    return { href, status, props };
  });
}

function resourcetypeTags(rt) {
  return childTags(asArray(rt)[0]);
}

// Names of CALDAV:comp children (RFC 4791 uses <C:comp name="VEVENT"/>; a
// few servers wrap differently, so any child element with a name attribute
// is accepted).
function supportedComponents(setNode) {
  const v = asArray(setNode)[0];
  if (!v || typeof v !== 'object') return [];
  const names = [];
  for (const tag of childTags(v)) {
    for (const el of asArray(v[tag])) {
      const n = String(el?.['@_name'] ?? '').toUpperCase();
      if (n) names.push(n);
    }
  }
  return names;
}

const NETWORK_RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE', 'ECONNABORTED', 'ABORT_ERR',
]);

// Mirrors lib/google.js rules: retry 429/5xx and transient network errors.
function isRetryableCalDavError(err) {
  const status = err?.status;
  if (typeof status === 'number') return status === 429 || (status >= 500 && status <= 599);
  const code = err?.cause?.code ?? err?.code;
  if (typeof code === 'string') return NETWORK_RETRYABLE_CODES.has(code);
  return false;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createIcloudCalDavClient(options = {}) {
  const {
    username,
    appPassword,
    host = ICLOUD_CALDAV_HOST,
    allowedHosts = ['caldav.icloud.com'],
    // Opt-in (config CALDAV_ALLOW_ANY_HOST, default OFF): accept ANY https
    // CalDAV host. Everything else stays unchanged - parseCaldavUrl still
    // enforces https-only and rejects credentials embedded in URLs, and all
    // error/log redaction still applies. See README "Generic CalDAV hosts"
    // for the security tradeoff.
    allowAnyHost = false,
    fetchImpl = fetch,
    logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    maxBytes = 10 * 1024 * 1024,
    timeoutMs = 30_000,
    maxRetries = 5,
    baseDelayMs = 500,
    sleepFn = sleep,
  } = options;

  if (typeof username !== 'string' || !username.trim()) {
    throw new CalDavError('iCloud CalDAV client requires an Apple ID username (ICLOUD_APPLE_ID)');
  }
  if (typeof appPassword !== 'string' || !appPassword.trim()) {
    throw new CalDavError('iCloud CalDAV client requires an app-specific password (ICLOUD_APP_PASSWORD)');
  }

  const baseUrl = new URL(host);
  const userPass = `${username}:${appPassword}`;
  const userPassB64 = Buffer.from(userPass, 'utf8').toString('base64');
  const authHeader = `Basic ${userPassB64}`;

  // Redaction wall: nothing that leaves this module (thrown errors or log
  // lines) may contain the app-specific password or its Basic-authorization
  // encodings. Secrets shorter than 12 chars are never scrubbed against
  // (protects the message from being wiped by degenerate secrets).
  const secrets = [appPassword, userPassB64, authHeader].filter((s) => s && s.length >= 12);
  const scrubText = (text) => {
    let s = String(text ?? '');
    for (const secret of secrets) s = s.split(secret).join('[redacted]');
    return s;
  };
  const scrubbedError = (err) => {
    if (err instanceof CalDavError) {
      return new CalDavError(scrubText(err.message), { cause: err.cause, status: err.status, retryAfter: err.retryAfter });
    }
    return new CalDavError(scrubText(err?.message ?? String(err)), { cause: err, status: err?.status, retryAfter: err?.retryAfter });
  };

  // URL label for messages: same location without userinfo (hrefs come from
  // server XML, so strip defensively even though parseCaldavUrl rejects
  // credential-carrying pair URLs).
  const safeUrlLabel = (u) => {
    try {
      const c = new URL(String(u));
      c.username = '';
      c.password = '';
      return String(c);
    } catch {
      return '(unparsable URL)';
    }
  };

  const assertSupportedHost = (u, what) => {
    if (allowAnyHost) return; // explicit opt-in: any https host (config-gated)
    // Real iCloud discovery redirects to per-account shard hosts
    // (e.g. p154-caldav.icloud.com) - accept listed hosts and their subdomains.
    if (!allowedHosts.includes(u.hostname) && !/^(?:p\d+-)?caldav\.icloud\.com$/.test(u.hostname)) {
      throw new CalDavError(`${what} host "${u.hostname}" is not supported - this client speaks only iCloud CalDAV (${allowedHosts.join(', ')})`);
    }
  };

  const abs = (href, base = baseUrl) => {
    try { return new URL(href, base); } catch {
      throw new CalDavError(`Malformed href in CalDAV response (${scrubText(String(href ?? '').slice(0, 100))})`);
    }
  };

  // One authenticated XML/ICS request with timeout + size caps (mirrors the
  // feed fetcher's caps). Throws CalDavError with status/retryAfter attached.
  // contentType defaults to the XML variant; CalDAV PUTs send text/calendar.
  // extraHeaders carries conditional headers (If-Match) and is never logged.
  async function request(u, { method = 'GET', depth, body, contentType, extraHeaders } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new CalDavError(`CalDAV ${method} request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const headers = {
      authorization: authHeader,
      accept: 'application/xml, text/xml, text/calendar',
      'user-agent': 'CalSync/0.1 (self-hosted calendar sync; CalDAV source/target)',
    };
    if (depth != null) headers.depth = String(depth);
    if (body != null) headers['content-type'] = contentType ?? 'application/xml; charset=utf-8';
    if (extraHeaders) Object.assign(headers, extraHeaders);
    try {
      const res = await fetchImpl(u, { method, redirect: 'follow', signal: controller.signal, headers, body: body ?? undefined });
      const retryAfter = Number(res?.headers?.get?.('retry-after') ?? NaN);
      if (!res?.ok) {
        const hint = (res?.status === 401 || res?.status === 403)
          ? ' - iCloud rejected the credentials; check ICLOUD_APPLE_ID and re-issue the app-specific password (ICLOUD_APP_PASSWORD) at appleid.apple.com'
          : '';
        throw new CalDavError(
          `CalDAV ${method} on ${safeUrlLabel(u)} failed with HTTP ${res?.status ?? 'n/a'}${res?.statusText ? ` ${res.statusText}` : ''}${hint}`,
          { status: res?.status, retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined },
        );
      }
      const len = Number(res?.headers?.get?.('content-length') ?? 0);
      if (Number.isFinite(len) && len > maxBytes) {
        throw new CalDavError(`CalDAV response from ${safeUrlLabel(u)} is larger than the ${maxBytes}-byte limit`, { status: res.status });
      }
      const buf = await res.arrayBuffer();
      if (buf.byteLength > maxBytes) {
        throw new CalDavError(`CalDAV response from ${safeUrlLabel(u)} is larger than the ${maxBytes}-byte limit`, { status: res.status });
      }
      return new TextDecoder('utf-8', { fatal: false }).decode(buf);
    } catch (err) {
      throw scrubbedError(err);
    } finally {
      clearTimeout(timer);
    }
  }

  // Exponential backoff with jitter, honoring Retry-After (see google.js
  // withBackoff); Apple rate limits are undocumented, so 429s are backed off
  // aggressively instead of hammered.
  async function withBackoff(label, fn) {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return await fn();
      } catch (err) {
        if (!isRetryableCalDavError(err) || attempt > maxRetries) {
          logger.error(`${label} failed permanently (status ${err?.status ?? 'n/a'}, attempt ${attempt}): ${scrubText(err?.message ?? '')}`);
          throw scrubbedError(err);
        }
        let delayMs = baseDelayMs * (2 ** (attempt - 1));
        const ra = Number(err?.retryAfter ?? NaN);
        if (Number.isFinite(ra) && ra > 0) delayMs = ra * 1000;
        delayMs += Math.floor(Math.random() * baseDelayMs);
        logger.warn(`${label} hit HTTP ${err?.status ?? 'network error'} (attempt ${attempt}/${maxRetries}) - retrying in ~${Math.round(delayMs)}ms`);
        await sleepFn(delayMs);
      }
    }
  }

  // PROPFIND Depth 0 helper returning the single response row.
  async function propfindRow(u, { props, label }) {
    const xml = await withBackoff(label, () => request(u, { method: 'PROPFIND', depth: '0', body: propfindBody(props) }));
    const rows = parseMultistatus(xml);
    if (!rows.length || !rows[0].href) throw new CalDavError(`${label}: empty or malformed PROPFIND response`);
    return rows[0];
  }

  // Standard RFC 6764/4791 discovery: root -> current-user-principal ->
  // calendar-home-set -> Depth 1 listing of the calendar home. Only
  // VEVENT-capable calendar collections are returned.
  async function discoverCalendars() {
    assertSupportedHost(baseUrl, 'iCloud CalDAV');
    const rootUrl = new URL('/', baseUrl);

    const principalRow = await propfindRow(rootUrl, {
      props: ['D:current-user-principal'],
      label: 'current-user-principal discovery',
    });
    const principalHref = nodeText(asArray(principalRow.props['current-user-principal']?.href)[0]);
    if (!principalHref) throw new CalDavError('current-user-principal discovery returned no principal (check the Apple ID credentials)');
    const principalUrl = abs(principalHref, rootUrl);
    assertSupportedHost(principalUrl, 'current-user-principal');

    const homeRow = await propfindRow(principalUrl, {
      props: ['C:calendar-home-set'],
      label: 'calendar-home-set discovery',
    });
    const homeHref = nodeText(asArray(homeRow.props['calendar-home-set']?.href)[0]);
    if (!homeHref) throw new CalDavError('calendar-home-set discovery returned no home collection');
    const homeUrl = abs(homeHref, principalUrl);
    assertSupportedHost(homeUrl, 'calendar-home');

    const xml = await withBackoff('calendar list', () => request(homeUrl, {
      method: 'PROPFIND',
      depth: '1',
      body: propfindBody(['D:displayname', 'D:resourcetype', 'C:supported-calendar-component-set']),
    }));
    const rows = parseMultistatus(xml);

    const calendars = [];
    for (const row of rows) {
      // Skip: the home itself, scheduling inboxes, notify/trash folders and
      // any collection without a calendar resourcetype.
      if (!resourcetypeTags(row.props['resourcetype']).includes('calendar')) continue;
      // Skip: Reminders/tasks collections (VTODO-only).
      if (!supportedComponents(row.props['supported-calendar-component-set']).includes('VEVENT')) continue;
      const url = abs(row.href, homeUrl);
      assertSupportedHost(url, 'calendar href');
      const displayName = nodeText(row.props['displayname']);
      const name = displayName || decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '') || 'calendar';
      calendars.push({ name, href: String(url), caldavUrl: caldavUrlOf(url) });
    }
    return calendars;
  }

  // Shared REPORT calendar-query: one request + multistatus parse. Used by
  // fetchEvents (source events), snapshotCalendar (target skip map) and the
  // post-412 refresh inside putEvent.
  async function reportCalendarQuery(hrefUrl, { startMs, endMs }) {
    const body = calendarQueryBody({ startMs, endMs });
    const xml = await withBackoff(`calendar-query ${safeUrlLabel(hrefUrl)}`, () =>
      request(hrefUrl, { method: 'REPORT', depth: '1', body }));
    return parseMultistatus(xml);
  }

  function assertWindowBounds({ start, end }, { allowMissing = false } = {}) {
    if (start == null && end == null && allowMissing) return null;
    const startMs = Number(start);
    const endMs = Number(end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
      throw new CalDavError('CalDAV read requires numeric epoch-ms start/end with end >= start');
    }
    return { startMs, endMs };
  }

  // REPORT calendar-query over [start, end] (epoch ms) on one calendar href
  // (caldav:// or https://). Each returned calendar-data blob is parsed with
  // the repository's feed parser, so the normalized events and the internal
  // event model are IDENTICAL to ICS feed parsing output.
  async function fetchEvents(calendarHrefOrUrl, { start, end } = {}) {
    const hrefUrl = parseCaldavUrl(calendarHrefOrUrl);
    assertSupportedHost(hrefUrl, 'calendar href');
    const bounds = assertWindowBounds({ start, end });
    const rows = await reportCalendarQuery(hrefUrl, bounds);

    const events = [];
    const warnings = [];
    const vtimezoneStrings = [];
    let calendarName = null;
    let dataCount = 0;
    for (const row of rows) {
      if (!row.props || row.props['calendar-data'] == null) continue;
      const ics = nodeText(row.props['calendar-data']);
      if (!ics) continue;
      dataCount += 1;
      try {
        const parsed = parseFeed(ics);
        events.push(...parsed.events);
        warnings.push(...parsed.warnings);
        vtimezoneStrings.push(...parsed.vtimezoneStrings);
        if (!calendarName && parsed.calendarName) calendarName = parsed.calendarName;
      } catch (err) {
        warnings.push(`Skipped calendar-data at ${row.href.slice(-40)}: ${err.message}`);
      }
    }
    if (!rows.length && !dataCount) warnings.push('CalDAV REPORT returned an empty multistatus (no events in range)');
    return { events, warnings, calendarName, vtimezoneStrings, href: String(hrefUrl), reportResponses: rows.length };
  }

  // Snapshot of a target calendar for skip-unchanged comparison, keyed
  // Map<iCalUID, { etag, status, event }>. event is the SAME normalized
  // internal model parseFeed yields for ICS feeds (hashes compose between
  // both sync directions); status mirrors the Google-snapshot contract
  // ('cancelled' | 'confirmed'). Rows whose calendar-data fails to parse are
  // skipped entirely ("not comparable" -> the next run rewrites the copy).
  async function snapshotCalendar(calendarHrefOrUrl, { start, end } = {}) {
    const hrefUrl = parseCaldavUrl(calendarHrefOrUrl);
    assertSupportedHost(hrefUrl, 'calendar href');
    const bounds = assertWindowBounds({ start, end }, { allowMissing: true });
    const rows = await reportCalendarQuery(hrefUrl, bounds ?? {});
    const map = new Map();
    for (const row of rows) {
      if (!row.props || row.props['calendar-data'] == null) continue;
      const ics = nodeText(row.props['calendar-data']);
      if (!ics) continue;
      let parsed;
      try {
        parsed = parseFeed(ics);
      } catch { continue; }
      const etag = String(nodeText(row.props['getetag']) || '') || null;
      for (const ev of parsed.events) {
        if (!ev?.uid || map.has(ev.uid)) continue;
        map.set(ev.uid, {
          etag,
          status: ev.status === 'CANCELLED' ? 'cancelled' : 'confirmed',
          event: ev,
        });
      }
    }
    return map;
  }

  // {calendarHref}/{UID}.ics resource URL for PUT/DELETE (UID is a single
  // encoded path segment; both write directions use the identical mapping so
  // create/overwrite/delete stay consistent).
  function calendarResourceUrl(hrefUrl, uid) {
    const base = String(hrefUrl);
    const path = `${base.endsWith('/') ? base : `${base}/`}${encodeURIComponent(uid)}.ics`;
    try { return new URL(path); } catch {
      throw new CalDavError(`Malformed calendar resource URL derived from ${safeUrlLabel(hrefUrl)}`);
    }
  }

  // Idempotent upsert: PUT {href}/{UID}.ics (create or overwrite). When the
  // snapshot showed the resource exists, the first PUT carries If-Match with
  // that etag. On 412 (someone wrote after our snapshot) the client
  // re-snapshots ONCE and retries with the fresh etag - writing
  // unconditionally when the resource vanished in the meantime ("then
  // proceed"). A second 412 propagates: one refresh retry, never an infinite
  // race. start/end (epoch ms, optional) scope the refresh REPORT.
  async function putEvent(calendarHrefOrUrl, event, { ifMatchEtag = null, timezoneStrings, start, end } = {}) {
    const hrefUrl = parseCaldavUrl(calendarHrefOrUrl);
    assertSupportedHost(hrefUrl, 'calendar href');
    const uid = String(event?.uid ?? '').trim();
    if (!uid) throw new CalDavError('CalDAV PUT requires an event with a UID');
    const { body, warnings } = putEventBody(event, { timezoneStrings });
    const url = calendarResourceUrl(hrefUrl, uid);
    const ifMatch = ifMatchEtag ? { 'if-match': String(ifMatchEtag) } : {};
    try {
      await withBackoff(`caldav put ${uid}`, () =>
        request(url, { method: 'PUT', body, contentType: 'text/calendar; charset=utf-8', extraHeaders: ifMatch }));
    } catch (err) {
      if (err?.status !== 412 || !ifMatchEtag) throw err;
      const fresh = await snapshotCalendar(calendarHrefOrUrl, { start, end });
      const freshEtag = fresh.get(uid)?.etag ?? null;
      const retryHeaders = freshEtag ? { 'if-match': String(freshEtag) } : {};
      await withBackoff(`caldav put ${uid} (post-412 refresh)`, () =>
        request(url, { method: 'PUT', body, contentType: 'text/calendar; charset=utf-8', extraHeaders: retryHeaders }));
    }
    return { url: String(url), warnings };
  }

  // DELETE {href}/{UID}.ics; already-gone (404) is NOT an error. Returns
  // true when a resource was deleted, false when it was already absent
  // (deleteAllByUid-style count semantics for the engine's deletion pass).
  async function deleteEventByUid(calendarHrefOrUrl, uid, { ifMatchEtag = null } = {}) {
    const hrefUrl = parseCaldavUrl(calendarHrefOrUrl);
    assertSupportedHost(hrefUrl, 'calendar href');
    if (!String(uid ?? '').trim()) throw new CalDavError('CalDAV DELETE requires a UID');
    const url = calendarResourceUrl(hrefUrl, uid);
    const ifMatch = ifMatchEtag ? { 'if-match': String(ifMatchEtag) } : {};
    try {
      await withBackoff(`caldav delete ${uid}`, () =>
        request(url, { method: 'DELETE', extraHeaders: ifMatch }));
      return true;
    } catch (err) {
      if (err?.status === 404) return false;
      throw err;
    }
  }

  return {
    discoverCalendars,
    fetchEvents,
    snapshotCalendar,
    putEvent,
    deleteEventByUid,
    describe: () => `iCloud CalDAV source (Apple ID: ${username}, host: ${safeUrlLabel(baseUrl)})`,
  };
}
// JSON for the dashboard picker: discovery -> [{ name, href, caldavUrl }].
// Never throws; ok:false carries a scrubbed explanation.
export async function listIcloudCalendars({ username, appPassword, logger = { warn: () => {}, error: () => {} }, maxBytes = 10 * 1024 * 1024, timeoutMs = 30_000, fetchImpl = fetch } = {}) {
  if (!String(username ?? '').trim() || !String(appPassword ?? '').trim()) {
    return { ok: false, error: 'iCloud credentials not configured - set ICLOUD_APPLE_ID and ICLOUD_APP_PASSWORD in .env, then restart.' };
  }
  try {
    const client = createIcloudCalDavClient({ username, appPassword, logger, maxBytes, timeoutMs, fetchImpl });
    const calendars = await client.discoverCalendars();
    return { ok: true, calendars: calendars.map((c) => ({ name: c.name, href: c.href, caldavUrl: c.caldavUrl })) };
  } catch (err) {
    const message = err instanceof CalDavError ? err.message : String(err?.message ?? err);
    return { ok: false, error: message };
  }
}
