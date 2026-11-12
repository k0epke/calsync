// Privacy copy modes (per pair, applied at WRITE time in BOTH target
// adapters - Google events.import AND CalDAV PUT).
//
//   'full'    - unchanged (byte-identical legacy behavior)
//   'busy'    - summary becomes 'Busy', description and location stripped;
//               times / start / end / all-day flags / recurrence / status /
//               sequence are preserved verbatim
//   'generic' - summary becomes the pair name, description and location
//               stripped; everything else preserved
//
// HASH STABILITY (load-bearing, documented here and in the README): the
// target adapters transform the normalized event BEFORE the write and
// compute the content hash AFTER the transformation, so the stored per-UID
// hash always describes exactly the bytes CalSync wrote. That is what lets
// privacy-mapped pairs reach a stable zero-write steady state: on the next
// run the freshly transformed event hashes to the SAME value as the stored
// hash (Google target) / canonical-compares equal against the parsed-back
// remote copy (CalDAV target), so no rewrite churn occurs.
//
// Values are validated in code (no DB CHECK constraint, mirroring the
// source_type/target_type style): anything not exactly 'busy' or 'generic'
// normalizes to 'full'.

export const COPY_MODES = Object.freeze(['full', 'busy', 'generic']);

export function normalizeCopyMode(value) {
  return COPY_MODES.includes(value) ? value : 'full';
}

// Pure transform. 'full' returns the input object UNCHANGED (no copy), so
// full-mode behavior stays byte-identical to the pre-feature code path.
export function applyCopyMode(event, copyMode, pairName) {
  const mode = normalizeCopyMode(copyMode);
  if (mode === 'full') return event;
  const summary = mode === 'busy'
    ? 'Busy'
    : (String(pairName ?? '').trim() || 'Event'); // generic: pair name
  return {
    ...event,
    summary,
    description: '', // stripped: adapters omit empty description/location
    location: '',
  };
}
