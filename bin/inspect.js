#!/usr/bin/env node
// CalSync feed inspector: parse any ICS / VCS / XCal / JCal source and print a
// human summary — handy for debugging feeds without touching Google.
// Usage: node bin/inspect.js <file-or-url>
//   <file-or-url> : local file path, or http(s):// / webcal:// URL (webcal is
//                   treated as https with an http fallback on TLS failure).
import fs from 'node:fs';
import { fetchFeed } from '../lib/fetchfeed.js';
import { parseFeed } from '../lib/icalparse.js';

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node bin/inspect.js <file-or-url>');
  console.error('  e.g. node bin/inspect.js test/fixtures/sample.ics');
  console.error('       node bin/inspect.js https://example.com/calendar.ics');
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
feed.events.forEach((e, i) => {
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
