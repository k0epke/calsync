// Per-pair "Fields to sync" selection (dashboard checkboxes).
//
// Shape stored in pairs.sync_fields (TEXT, JSON): only the STRIPPED fields
// are stored, e.g. {"description":false} or {"description":false,"location":false}.
// NULL (or unset) means ALL fields sync - the exact pre-feature behavior,
// zero migration impact. The All-fields state therefore stores NULL (both
// checked = nothing stripped = no mask).
//
// HONEST SCOPE (write-path survey): description and location are the ONLY
// event body fields CalSync can omit on write. Titles are governed by
// copy_mode (full|busy|generic); reminders and attendees are not synced
// anywhere in either adapter, so there are deliberately NO checkboxes for
// them. This module only ever masks description/location.
//
// Semantics (pinned, mirrored in lib/sync.js + README):
//   - Applied at WRITE time in BOTH target adapters (Google events.import
//     payload + CalDAV PUT props), AFTER the copy_mode transform. The mask
//     can only STRIP - it never adds fields back - so copy_mode=busy/generic
//     (which already strip description/location) make the mask a no-op on
//     those two fields regardless of the checkbox states.
//   - copy_mode=full + mask: description:false -> the Google payload lacks
//     'description' and the CalDAV VEVENT lacks a DESCRIPTION line (the
//     payload builders omit empty/undefined values, never emitting empty
//     DESCRIPTION:/LOCATION: lines). Times, status, transp, class, sequence,
//     UID and the copy_mode-governed title are NEVER maskable in this build.
//   - The content hash is computed AFTER the FULL transform chain
//     (copy_mode + field mask), exactly as for privacy copy modes, so
//     field-masked writes reach the same zero-write steady state (see the
//     hash-after-transform rationale in lib/copymode.js).
//
// Validation mirrors lib/filters.js: strict at SAVE time (db.createPair /
// db.updatePair throw clear errors on malformed JSON, unknown keys or
// non-boolean values); the engine read path is defensive (an unusable
// stored value degrades to "all fields sync" instead of failing the sync).

export const SYNC_FIELD_KEYS = Object.freeze(['description', 'location']);

const SYNC_FIELDS_ERR = 'Sync fields';

// Normalizes/validates a user-supplied value. Accepts:
//   null/undefined/''            -> null = all fields sync
//   {} (empty mask)              -> null = all fields sync (documented call:
//                                   an empty mask strips nothing, so it is
//                                   stored as clean NULL, never '{}' text)
//   { description?: boolean, location?: boolean }
//   a JSON string of exactly that shape (the stored form)
// Missing keys default to true (synced). Returns null when nothing would be
// stripped (all-true), else the effective mask { description, location }.
// Throws Error with a clear message on invalid input.
export function normalizeSyncFieldsInput(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    let parsed;
    try { parsed = JSON.parse(s); } catch (err) {
      throw new Error(`${SYNC_FIELDS_ERR}: malformed JSON - expected {"description":true|false,"location":true|false} (${err.message})`);
    }
    return normalizeSyncFieldsInput(parsed);
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${SYNC_FIELDS_ERR}: expected an object like {"description":false,"location":true}`);
  }
  const unknown = Object.keys(value).filter((k) => !SYNC_FIELD_KEYS.includes(k));
  if (unknown.length) {
    throw new Error(`${SYNC_FIELDS_ERR}: unexpected key(s) ${unknown.join(', ')} - only "description" and "location" are allowed`);
  }
  const normalized = {};
  for (const key of SYNC_FIELD_KEYS) {
    const v = value[key];
    if (v === undefined) { normalized[key] = true; continue; }
    if (typeof v !== 'boolean') {
      throw new Error(`${SYNC_FIELDS_ERR}: "${key}" must be true or false (got ${JSON.stringify(String(v))})`);
    }
    normalized[key] = v;
  }
  if (normalized.description !== false && normalized.location !== false) return null; // all sync
  return { description: normalized.description, location: normalized.location };
}

// Storage form for pairs.sync_fields: null (SQL NULL = all fields sync) or
// compact JSON naming ONLY the stripped fields (e.g. {"description":false}).
// Throws the same clear validation errors as normalizeSyncFieldsInput, so a
// bad value fails loudly at save time, never silently inside the sync engine.
export function storedSyncFieldsJson(value) {
  const mask = normalizeSyncFieldsInput(value);
  if (!mask) return null;
  const out = {};
  if (mask.description === false) out.description = false;
  if (mask.location === false) out.location = false;
  return JSON.stringify(out);
}

// Forgiving read for display/engine consumers: never throws; null on junk
// (= all fields sync, the safe direction: the write path strips nothing).
export function safeParseStoredSyncFields(raw) {
  if (raw == null) return null;
  try { return normalizeSyncFieldsInput(raw); } catch { return null; }
}

// Pure write-time transform. mask null (or unusable) returns the input
// object UNCHANGED (no copy), so unmasked pairs stay byte-identical to the
// pre-feature code path. A mask only CLEARS fields that are PRESENT (sets
// '' like the copy-mode transforms do - both target payload builders then
// omit empty values); it never introduces keys an event lacks and never
// touches any other field.
export function applyFieldMask(event, mask) {
  if (!mask) return event;
  const out = { ...event };
  if (mask.description === false && 'description' in out) out.description = '';
  if (mask.location === false && 'location' in out) out.location = '';
  return out;
}

// Dashboard form mapping: HTML checkboxes post ONLY when checked, so
// present (non-empty) = true, absent/empty = false. The All-fields checkbox
// never posts (it is name-less client-side sugar; see public/app.js).
export function syncFieldMaskFromForm(body) {
  const flag = (v) => v != null && String(v) !== '';
  return {
    description: flag(body?.sync_description),
    location: flag(body?.sync_location),
  };
}
