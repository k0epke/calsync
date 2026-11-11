// Development spike v2: probes the exact ical.js API shapes CalSync relies on.
// Every probe is isolated so one failure doesn't kill the run.
import * as ns from 'ical.js';

const ICAL = ns.default ?? ns.ICAL ?? ns;
const label = (n) => console.log(`\n=== ${n}`);
const guard = (name, fn) => {
  try { fn(); } catch (err) { console.log(`!! ${name} THREW: ${err.message}`); }
};

label('namespace');
console.log('ICAL.parse?', typeof ICAL.parse, '| Component.fromString?', typeof ICAL.Component.fromString,
  '| TimezoneService?', typeof ICAL.TimezoneService, '| Timezone?', typeof ICAL.Timezone,
  '| Recur?', typeof ICAL.Recur, '| Duration?', typeof ICAL.Duration);

label('all-day WITHOUT VALUE=DATE (invalid but common)');
guard('all-day-no-param', () => {
  const c = new ICAL.Component(ICAL.parse('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:20260405\r\nEND:VEVENT\r\nEND:VCALENDAR'));
  console.log('getFirstValue ok:', !!c.getFirstSubcomponent('vevent').getFirstProperty('dtstart').getFirstValue());
});

label('all-day WITH VALUE=DATE');
guard('all-day-with-param', () => {
  const c = new ICAL.Component(ICAL.parse('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART;VALUE=DATE:20260405\r\nDTEND;VALUE=DATE:20260406\r\nEND:VEVENT\r\nEND:VCALENDAR'));
  const t = c.getFirstSubcomponent('vevent').getFirstProperty('dtstart').getFirstValue();
  console.log('isDate:', t.isDate, 'Y/M/D:', t.year, t.month, t.day);
  const jcal = c.toJSON ? c.toJSON() : null;
  console.log('jCal dtstart:', JSON.stringify(jcal && jcal[2] && jcal[2][0] && jcal[2][0][2] && [jcal[2][0][1], jcal[2][0][2], jcal[2][0][3]]));
});

label('folded line with LF endings only');
guard('folded-lf', () => {
  const c = new ICAL.Component(ICAL.parse('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDESCRIPTION:This is folded across mu\n ltiple physical lines with LF only\r\nEND:VEVENT\r\nEND:VCALENDAR'));
  console.log('unfolded:', JSON.stringify(c.getFirstSubcomponent('vevent').getFirstPropertyValue('description')));
});

label('RRULE jCal shapes from ICS');
let richEventIcsPart = '';
guard('rrule-shapes', () => {
  const c = new ICAL.Component(ICAL.parse('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:20260101T090000Z\r\nRRULE:FREQ=WEEKLY;UNTIL=20260401T000000Z;INTERVAL=2;BYDAY=MO,WE;BYSETPOS=1;BYMONTHDAY=15\r\nRDATE:20260401T090000Z,20260402T090000Z\r\nEXDATE:20260108T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR'));
  const ev = c.getFirstSubcomponent('vevent');
  for (const name of ['rrule', 'rdate', 'exdate']) {
    const p = ev.getFirstProperty(name);
    console.log(`${name} jCal:`, JSON.stringify(p.toJSON()));
    console.log(`${name} toICALString:`, JSON.stringify(p.toICALString()));
  }
  richEventIcsPart = 'ok';
});

label('recur from jCal OBJECT (ical.js shape: numbers + uppercase)');
guard('recur-object', () => {
  const p = new ICAL.Property(['rrule', {}, 'recur', { freq: 'DAILY', count: 3 }]);
  const v = p.getFirstValue();
  console.log('class:', v && v.constructor && v.constructor.name, '| toObject? freq/count:',
    v && v.freq, v && v.count, '| toString:', v && v.toString ? v.toString() : String(v));
  const ev = new ICAL.Component([['vevent', [['rrule', {}, 'recur', { freq: 'DAILY', count: 3 }], ['dtstart', {}, 'date-time', '2026-01-01T09:00:00']], []]]);
  const it = ev.getFirstSubcomponent('vevent').iterator(ev.getFirstSubcomponent('vevent').getFirstProperty('dtstart').getFirstValue());
  const occ = it.next();
  console.log('first occurrence:', occ && `${occ.year}-${occ.month}-${occ.day}`);
  const occ2 = it.next();
  console.log('second occurrence:', occ2 && `${occ2.year}-${occ2.month}-${occ2.day}`);
});

label('recur from jCal OBJECT (RFC 7265 shape: lowercase + string numbers + array byday)');
guard('recur-rfc-object', () => {
  const p = new ICAL.Property(['rrule', {}, 'recur', { freq: 'daily', count: '10', byday: ['mo', 'we'] }]);
  const v = p.getFirstValue();
  console.log('class:', v && v.constructor && v.constructor.name, '| toString:', v && v.toString ? v.toString() : String(v));
});

label('recur from jCal STRING');
guard('recur-string', () => {
  const p = new ICAL.Property(['rrule', {}, 'recur', 'FREQ=DAILY;COUNT=3']);
  const v = p.getFirstValue();
  console.log('class:', v && v.constructor && v.constructor.name, '| toString:', v && v.toString ? v.toString() : String(v));
});

label('unknown TZID (no VTIMEZONE)');
guard('unknown-tzid', () => {
  const c = new ICAL.Component(ICAL.parse('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:y\r\nDTSTART;TZID=America/Chicago:20260405T090000\r\nEND:VEVENT\r\nEND:VCALENDAR'));
  const t = c.getFirstSubcomponent('vevent').getFirstProperty('dtstart').getFirstValue();
  console.log('zone tzid:', t.zone && t.zone.tzid, '| utcOffset():', t.utcOffset ? t.utcOffset() : t.utcOffset);
});

label('VTIMEZONE auto-registration on parse?');
const vtIcs = 'BEGIN:VTIMEZONE\r\nTZID:Test/Local\r\nBEGIN:STANDARD\r\nTZOFFSETFROM:+0000\r\nTZOFFSETTO:+0000\r\nTZNAME:TLT\r\nDTSTART:19700101T000000\r\nEND:STANDARD\r\nEND:VTIMEZONE';
guard('tz-registration', () => {
  let hasBefore;
  try { hasBefore = ICAL.TimezoneService.has('Test/Local'); } catch (err) { hasBefore = `has threw: ${err.message}`; }
  console.log('service.has BEFORE parse:', hasBefore);
  new ICAL.Component(ICAL.parse(`BEGIN:VCALENDAR\r\n${vtIcs}\r\nBEGIN:VEVENT\r\nUID:z\r\nDTSTART;TZID=Test/Local:20260405T090000\r\nEND:VEVENT\r\nEND:VCALENDAR`));
  let hasAfter;
  try { hasAfter = ICAL.TimezoneService.has('Test/Local'); } catch (err) { hasAfter = `has threw: ${err.message}`; }
  console.log('service.has AFTER parse:', hasAfter);
  let tz2 = null;
  try {
    tz2 = new ICAL.Timezone({ component: new ICAL.Component(ICAL.parse(vtIcs)), tzid: 'Test/Local' });
    console.log('new Timezone({component}).tzid:', tz2 && tz2.tzid);
    if (!ICAL.TimezoneService.has('Test/Local')) ICAL.TimezoneService.register(tz2);
    console.log('after manual register, get:', ICAL.TimezoneService.get('Test/Local') && ICAL.TimezoneService.get('Test/Local').tzid);
  } catch (err) { console.log('manual registration failed:', err.message); }
});

label('floating time');
guard('floating', () => {
  const c = new ICAL.Component(ICAL.parse('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:i\r\nDTSTART:20260405T090000\r\nEND:VEVENT\r\nEND:VCALENDAR'));
  console.log('jCal dtstart:', JSON.stringify(c.getFirstSubcomponent('vevent').getFirstProperty('dtstart').toJSON()));
  const t = c.getFirstSubcomponent('vevent').getFirstProperty('dtstart').getFirstValue();
  console.log('zone tzid:', t.zone && t.zone.tzid, '| utcOffset():', t.utcOffset ? t.utcOffset() : null, '| toJSDate:', t.toJSDate && t.toJSDate().toISOString());
});

label('duration -> end computation');
guard('duration', () => {
  const c = new ICAL.Component(ICAL.parse('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:g\r\nDTSTART:20260405T090000Z\r\nDURATION:PT90M\r\nEND:VEVENT\r\nEND:VCALENDAR'));
  const ev = c.getFirstSubcomponent('vevent');
  const t0 = ev.getFirstProperty('dtstart').getFirstValue().clone();
  const d = ev.getFirstPropertyValue('duration');
  console.log('duration class:', d && d.constructor && d.constructor.name, '| toSeconds:', d && d.toSeconds ? d.toSeconds() : null);
  t0.addDuration(d);
  console.log('end:', t0.year, t0.month, t0.day, t0.hour, t0.minute, t0.second, '| zone:', t0.zone && t0.zone.tzid);
  const c2 = new ICAL.Component(ICAL.parse('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:g\r\nDTSTART;VALUE=DATE:20260405\r\nDURATION:P1D\r\nEND:VEVENT\r\nEND:VCALENDAR'));
  const ev2 = c2.getFirstSubcomponent('vevent');
  const t2 = ev2.getFirstProperty('dtstart').getFirstValue().clone();
  t2.addDuration(ev2.getFirstPropertyValue('duration'));
  console.log('all-day end: isDate:', t2.isDate, t2.year, t2.month, t2.day);
  const c3 = new ICAL.Component(ICAL.parse('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:g\r\nDTSTART;VALUE=DATE:20260405\r\nDURATION:PT1H30M\r\nEND:VEVENT\r\nEND:VCALENDAR'));
  const ev3 = c3.getFirstSubcomponent('vevent');
  const t3 = ev3.getFirstProperty('dtstart').getFirstValue().clone();
  const d3 = ev3.getFirstPropertyValue('duration');
  t3.addDuration(d3);
  console.log('all-day + PT1H30M: isDate:', t3.isDate, 'Y/M/D h:m:', t3.year, t3.month, t3.day, t3.hour, t3.minute, '| zone:', t3.zone && t3.zone.tzid);
});

label('rdate-only and period iterator');
guard('rdate-iterator', () => {
  const c = new ICAL.Component(ICAL.parse('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:z\r\nDTSTART:20260101T090000Z\r\nRDATE:20261120T120000Z\r\nRDATE;VALUE=PERIOD:20261121T100000Z/PT2H\r\nEND:VEVENT\r\nEND:VCALENDAR'));
  const ev = c.getFirstSubcomponent('vevent');
  const rp = ev.getFirstProperty('rdate;VALUE=PERIOD') || ev.getAllProperties('rdate')[1];
  console.log('period prop jCal:', JSON.stringify(rp && rp.toJSON()));
  const vals = rp ? rp.getValues() : [];
  for (const v of vals) console.log('period value: start?', v && 'start' in v, v && v.start && `${v.start.year}-${v.start.month}-${v.start.day}T${v.start.hour}:${v.start.minute}Z`);
  const it = ev.iterator(ev.getFirstProperty('dtstart').getFirstValue());
  let r; let n = 0;
  while ((r = it.next()) != null && n < 8) {
    n++;
    console.log('occ:', `${r.year}-${r.month}-${r.day}T${r.hour}:${r.minute}`, 'isDate:', r.isDate, r.start != null ? `PERIOD ${r.start.year}-${r.start.month}-${r.start.day}T${r.start.hour}:${r.start.minute}` : '');
  }
});

label('bogus RRULE leniency');
guard('bogus-rrule', () => {
  const c = new ICAL.Component(ICAL.parse('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:q\r\nDTSTART:20261001T090000Z\r\nRRULE:BOGUS\r\nEND:VEVENT\r\nEND:VCALENDAR'));
  const ev = c.getFirstSubcomponent('vevent');
  console.log('bogus rrule jCal:', JSON.stringify(ev.getFirstProperty('rrule').toJSON()));
  const it = ev.iterator(ev.getFirstProperty('dtstart').getFirstValue());
  console.log('first occ:', it.next() && 'yielded');
});

label('X-WR-CALNAME + unknown props');
guard('x-props', () => {
  const c = new ICAL.Component(ICAL.parse('BEGIN:VCALENDAR\r\nX-WR-CALNAME:My Feed Name\r\nPRODNAME:SomeProduct\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:20260401T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR'));
  console.log('name:', JSON.stringify(c.getFirstPropertyValue('x-wr-calname')));
});

console.log('\n=== spike v2 complete');
