// Central dependency import shims so the rest of the code can stay agnostic
// about how each package exposes its API (default export vs namespace).
import * as icalNamespace from 'ical.js';
import * as cronNamespace from 'node-cron';

export const ICAL = icalNamespace.default ?? icalNamespace.ICAL ?? icalNamespace;
export const cron = cronNamespace.default ?? cronNamespace;
