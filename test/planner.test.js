// Planner tests: upsert/deletion planning (pure, protected against deleting
// events CalSync never imported).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planSync } from '../lib/planner.js';

test('plans imports for present events and nothing else', () => {
  const plan = planSync({
    trackedUids: ['a', 'b'],
    events: [
      { uid: 'a', status: 'CONFIRMED', summary: 'A' },
      { uid: 'd', status: 'CONFIRMED', summary: 'D' },
    ],
  });
  assert.deepEqual(plan.import.map((i) => i.uid), ['a', 'd']);
  assert.deepEqual(plan.delete, ['b']);
  assert.equal(plan.stats.importable, 2);
  assert.equal(plan.stats.deleted, 1);
  assert.equal(plan.stats.cancelled, 0);
});

test('cancelled feed events are not imported but drive deletions when tracked', () => {
  const plan = planSync({
    trackedUids: ['a', 'gone'],
    events: [
      { uid: 'a', status: 'CONFIRMED', summary: 'A' },
      { uid: 'gone', status: 'CANCELLED', summary: 'was cancelled upstream' },
    ],
  });
  assert.deepEqual(plan.import.map((i) => i.uid), ['a']);
  assert.deepEqual(plan.delete, ['gone']);
  assert.equal(plan.stats.cancelled, 1);
});

test('user-created events (never tracked) are NEVER deleted', () => {
  const plan = planSync({
    trackedUids: [],
    events: [{ uid: 'a', status: 'CONFIRMED', summary: 'A' }],
  });
  assert.deepEqual(plan.import.map((i) => i.uid), ['a']);
  assert.deepEqual(plan.delete, [], 'no deletion ever planned without prior imports');
});

test('empty feed deletes exactly the previously tracked events', () => {
  const plan = planSync({ trackedUids: ['x', 'y'], events: [] });
  assert.deepEqual(plan.import, []);
  assert.deepEqual(plan.delete, ['x', 'y']);
});

test('events without UID are skipped, not crashed on', () => {
  const plan = planSync({
    trackedUids: ['a'],
    events: [
      { uid: null, status: 'CONFIRMED' },
      { summary: 'no uid field at all' },
      { uid: 'a', status: 'CONFIRMED' },
    ],
  });
  assert.deepEqual(plan.import.map((i) => i.uid), ['a']);
  assert.deepEqual(plan.delete, []);
  assert.equal(plan.stats.skipped, 2);
});

test('duplicate feed UIDs import only once', () => {
  const plan = planSync({
    trackedUids: [],
    events: [
      { uid: 'dup', status: 'CONFIRMED', summary: 'first' },
      { uid: 'dup', status: 'CONFIRMED', summary: 'second' },
    ],
  });
  assert.equal(plan.import.length, 1);
  assert.equal(plan.import[0].event.summary, 'first');
  assert.equal(plan.stats.duplicates, 1);
});

test('deletion plan never includes uids absent from tracking', () => {
  const plan = planSync({
    trackedUids: ['ours-1'],
    events: [
      { uid: 'user-made', status: 'CONFIRMED' }, // exists in Google, not tracked
      { uid: 'ours-1', status: 'CONFIRMED' },
    ],
  });
  assert.deepEqual(plan.delete, []);
  assert.ok(!plan.delete.includes('user-made'));
});
