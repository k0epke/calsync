// Upsert/deletion planning (pure function, no I/O).
// Deletion sync rule: remove exactly the target-calendar events whose iCalUID
// was previously recorded as imported (trackedUids) but is missing from the
// current feed. Events the app never imported are NEVER planned for deletion.
// STATUS:CANCELLED feed events count as "absent from the feed" for import
// purposes, which drives their removal from the target calendar too.

export function planSync({ trackedUids = [], events = [] } = {}) {
  const importables = [];
  const feedUids = new Set();
  const cancelledUids = new Set();
  const skipped = [];

  for (const ev of events ?? []) {
    if (!ev || !ev.uid) { skipped.push('event without UID'); continue; }
    if (ev.status === 'CANCELLED') { cancelledUids.add(ev.uid); continue; }
    if (feedUids.has(ev.uid)) continue; // duplicate UID in feed — first wins
    feedUids.add(ev.uid);
    importables.push({ uid: ev.uid, event: ev });
  }

  const tracked = new Set((trackedUids ?? []).map(String));
  const deletes = [...tracked].filter((uid) => !feedUids.has(uid)); // insertion order preserved

  return {
    import: importables,
    delete: deletes,
    stats: {
      feedTotal: (events ?? []).length,
      importable: importables.length,
      cancelled: cancelledUids.size,
      deleted: deletes.length,
      skipped: skipped.length,
      duplicates: feedUids.size,
    },
  };
}
