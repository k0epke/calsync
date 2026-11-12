#!/usr/bin/env node
// CalSync feed inspector: parse any ICS / VCS / XCal / JCal source and print a
// human summary - handy for debugging feeds without touching Google.
// iCloud mode: --caldav lists the account's event calendars; --caldav <url>
// previews the events a sync run would import from one calendar.
// iCloud credentials come from .env only (ICLOUD_APPLE_ID +
// ICLOUD_APP_PASSWORD) and are never printed.
// Usage: node bin/inspect.js <file-or-url>
//   <file-or-url> : local file path, or http(s):// / webcal:// URL (webcal is
//                   treated as https with an http fallback on TLS failure).
//        --caldav : list iCloud event calendars (name + href + caldav://)
//   --caldav <url> : preview events on one calendar (caldav:// or https href)
import fs from 'node:fs';
import path from 'node:path';
import { loadEnvFile, loadConfig, ROOT_DIR } from '../lib/config.js';
import { fetchFeed } from '../lib/fetchfeed.js';
import { parseFeed } from '../lib/icalparse.js';
import { computeWindow } from '../lib/recurrence.js';
import { createIcloudCalDavClient, ICLOUD_CALDAV_HOST } from '../lib/caldav.js';

const args = process.argv.slice(2);

const consoleLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
  debug: () => {},
};

function printEventList(events) {
  events.forEach((e, i) => {
    const start = e.start.dateTime ?? e.start.date ?? '(none)';
    const end = e.end ? (e.end.dateTime ?? e.end.date) : '(none)';
    const rrule = (e.recurrence ?? []).filter((l) => /^RRULE:/i.test(l)).map((l) => l.replace(/^RRULE:/i, '')).join(' | ');
    const rex = (e.recurrence ?? []).filter((l) => /^(RDATE|EXDATE)/i.test(l));
    console.log(`  ${String(i + 1).padStart(2)}. [${e.status === 'CANCELLED' ? 'CANCELLED' : 'confirmed'}] ${e.summary || '(no summary)'}`);
    console.log(`      UID      : ${e.uid}`);
    console.log(`      Time     : ${start} --> ${end}`);
    if (e.start.timeZone) console.log(`      Timezone : ${e.start.timeZone}`);
    if (rrule) console.log(`      RRULE    : ${rrule}`);
    if (rex.length) console.log(`      R/EXDATE : ${rex.join(' | ')}`);
  });
}

// --- iCloud (CalDAV) mode ---------------------------------------------------
if (args[0] === '--caldav') {
  loadEnvFile(path.join(ROOT_DIR, '.env'));
  const config = loadConfig();
  const { ICLOUD_APPLE_ID, ICLOUD_APP_PASSWORD } = config;
  if (!ICLOUD_APPLE_ID || !ICLOUD_APP_PASSWORD) {
    console.error('Missing iCloud credentials: set ICLOUD_APPLE_ID and ICLOUD_APP_PASSWORD in .env');
    console.error('(Apple ID username + app-specific password from appleid.apple.com; see README).');
    process.exit(2);
  }
  const client = createIcloudCalDavClient({
    username: ICLOUD_APPLE_ID,
    appPassword: ICLOUD_APP_PASSWORD,
    logger: consoleLogger,
    timeoutMs: config.fetchTimeoutMs,
    maxBytes: config.maxFeedBytes,
  });
  try {
    if (!args[1]) {
      console.log(`Listing event calendars on ${ICLOUD_CALDAV_HOST} (principal -> calendar-home-set -> depth-1 PROPFIND) ...`);
      const calendars = await client.discoverCalendars();
      if (!calendars.length) {
        console.log('No VEVENT-capable calendar collections found (inboxes and Reminders are skipped).');
        process.exit(0);
      }
      console.log(`Found ${calendars.length} event calendar(s):\n`);
      for (const c of calendars) {
        console.log(`  - ${c.name}`);
        console.log(`      href      : ${c.href}`);
        console.log(`      caldav:// : ${c.caldavUrl}`);
      }
      console.log('\nPaste the caldav:// URL of one calendar as a CalDAV pair feed_url.');
      process.exit(0);
    }
    const window = computeWindow(Date.now(), config);
    const from = new Date(window.start).toISOString();
    const to = new Date(window.end).toISOString();
    console.log(`Fetching events from ${args[1]} for window ${from} .. ${to} ...\n`);
    const res = await client.fetchEvents(args[1], { start: window.start, end: window.end });
    const active = res.events.filter((e) => e.status !== 'CANCELLED').length;
    const cancelled = res.events.length - active;
    const recurring = res.events.filter((e) => (e.recurrence ?? []).some((l) => /^RRULE:/i.test(l))).length;
    console.log(`Events     : ${res.events.length} in window, ${active} active, ${cancelled} cancelled, ${recurring} recurring (RRULE)`);
    console.log(`Resolved   : ${res.href}`);
    if (res.warnings.length) {
      console.log('Warnings   :');
      for (const w of res.warnings) console.log(`  - ${w}`);
    }
    console.log('');
    printEventList(res.events);
    process.exit(0);
  } catch (err) {
    console.error(`CalDAV request failed: ${err.message}`);
    if (err?.cause) console.error(`Cause: ${err.cause.message ?? err.cause}`);
    process.exit(1);
  }
}

// --- feed / file mode (unchanged) -------------------------------------------
const arg = args[0];
if (!arg) {
  console.error('Usage: node bin/inspect.js <file-or-url>');
  console.error('       node bin/inspect.js --caldav [caldav-url]');
  console.error('  e.g. node bin/inspect.js test/fixtures/sample.ics');
  console.error('       node bin/inspect.js https://example.com/calendar.ics');
  console.error('       node bin/inspect.js --caldav');
  console.error('       node bin/inspect.js --caldav caldav://caldav.icloud.com/123456/calendars/ABCD-1234/');
  process.exit(2);
}

let text = '';
let sourceDesc = '';
try {
  if (/^(https?|webcal):\/\//i.test(arg)) {
    const res = await fetchFeed(arg);
    text = res.text;
    sourceDesc = res.finalUrl === arg
      ? `${arg} (HTTP ${res.status})`
      : `${arg} -> ${res.finalUrl} (HTTP ${res.status})`;
  } else {
    const buf = await fs.promises.readFile(arg);
    sourceDesc = `${arg} (${(buf.byteLength / 1024).toFixed(1)} KiB)`;
    text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  }
} catch (err) {
  console.error(`Failed to read source: ${err.message}`);
  process.exit(1);
}

let feed;
try {
  feed = parseFeed(text);
} catch (err) {
  console.error(`Parse failed: ${err.message}`);
  if (err?.cause) console.error(`Cause: ${err.cause.message ?? err.cause}`);
  process.exit(1);
}

const active = feed.events.filter((e) => e.status !== 'CANCELLED').length;
const cancelled = feed.events.length - active;
const recurring = feed.events.filter((e) => (e.recurrence ?? []).some((l) => /^RRULE:/i.test(l))).length;

console.log(`Format     : ${feed.format.toUpperCase()} (sniffed from content)`);
console.log(`Source     : ${sourceDesc}`);
if (feed.calendarName) console.log(`Calendar   : ${feed.calendarName} (X-WR-CALNAME)`);
console.log(`Timezones  : ${feed.vtimezoneStrings.length} VTIMEZONE component(s)`);
console.log(`Events     : ${feed.events.length} total, ${active} active, ${cancelled} cancelled, ${recurring} recurring (RRULE)`);
if (feed.warnings.length) {
  console.log('Warnings   :');
  for (const w of feed.warnings) console.log(`  - ${w}`);
}
console.log('');
printEventList(feed.events);
