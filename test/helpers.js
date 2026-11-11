// Shared test helpers + fixture access.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export function fixture(name) { return path.join(TEST_DIR, 'fixtures', name); }
export function readFixture(name) { return fs.readFileSync(fixture(name), 'utf8'); }

function flattenLines(lines) {
  return lines.flatMap((l) => (Array.isArray(l) ? flattenLines(l) : l));
}

export function icsFor(lines) {
  // Accepts a flat array of strings or nested arrays (e.g. icsFor([veventFor(..), veventFor(..)]).
  // Nested arrays would otherwise be joined with commas and corrupt the ICS.
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CalSync Test//EN', ...flattenLines(lines), 'END:VCALENDAR'].join('\n');
}

export function veventFor(lines) {
  return ['BEGIN:VEVENT', ...flattenLines(lines), 'END:VEVENT'];
}

export const FIXED_NOW_MS = Date.parse('2026-11-11T12:00:00Z');
