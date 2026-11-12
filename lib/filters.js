// Per-pair event filters (Feature: pair-level include/exclude keywords).
//
// Shape stored in pairs.filters (TEXT, JSON): {"include": ["kw"], "exclude": ["kw"]}
// NULL or {} means "no filter". Matching semantics (documented in the README
// as well): a source event is kept when
//   ((no include list) OR any include keyword is a case-insensitive
//    SUBSTRING of event.summary)
//   AND
//   ((no exclude list) OR no exclude keyword is a case-insensitive
//    SUBSTRING of event.summary)
//
// The filters apply to the SOURCE event list after the fetch (url / caldav /
// google sources alike) and BEFORE windowing/planning, so the deletion
// planner always operates on the FILTERED source snapshot: flipping a pair's
// filters prunes previously-imported excluded events from the target on the
// next run via the normal deletion sweep. Targets receive whatever the
// planner emits - there is no separate target-side filtering.
//
// Validation is strict at SAVE time (db.createPair/updatePair + server.js
// resolvePairPayload throw clear errors on malformed JSON or wrong shapes);
// the engine read path is defensive (an unusable stored value degrades to
// "no filter this run" with a run warning instead of failing the sync).

const MAX_KEYWORDS_PER_LIST = 25;
const MAX_KEYWORD_LENGTH = 200;

// Normalizes/validates a user-supplied filter value. Accepts:
//   null/undefined/''
//   an object { include?: string[], exclude?: string[] }
//   a JSON string of exactly that shape (stored form)
// Returns null when no filter is active, else a frozen-ish plain object
// { include: string[] | null, exclude: string[] | null } with trimmed,
// non-empty keywords. Throws Error with a clear message on invalid input.
export function normalizeEventFiltersInput(value) {
  if (value == null) return null;
  let obj = value;
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    try { obj = JSON.parse(s); } catch (err) {
      throw new Error(`Pair filters: malformed JSON - expected {"include":["kw"],"exclude":["kw"]} (${err.message})`);
    }
  }
  if (typeof obj !== 'object' || Array.isArray(obj) || obj === null) {
    throw new Error('Pair filters: expected an object like {"include":["kw"],"exclude":["kw"]}');
  }
  const unknown = Object.keys(obj).filter((k) => k !== 'include' && k !== 'exclude');
  if (unknown.length) {
    throw new Error(`Pair filters: unexpected key(s) ${unknown.join(', ')} - only "include" and "exclude" are allowed`);
  }
  const normList = (v, name) => {
    if (v == null) return null;
    if (!Array.isArray(v)) throw new Error(`Pair filters: "${name}" must be an array of strings`);
    if (v.length > MAX_KEYWORDS_PER_LIST) {
      throw new Error(`Pair filters: more than ${MAX_KEYWORDS_PER_LIST} keywords in "${name}"`);
    }
    const out = v.map((kw) => {
      if (typeof kw !== 'string') throw new Error(`Pair filters: "${name}" must contain only strings`);
      const s = kw.trim();
      if (!s) throw new Error(`Pair filters: "${name}" must not contain empty keywords`);
      if (s.length > MAX_KEYWORD_LENGTH) {
        throw new Error(`Pair filters: keyword longer than ${MAX_KEYWORD_LENGTH} chars in "${name}"`);
      }
      return s;
    });
    return out.length ? out : null;
  };
  const include = normList(obj.include, 'include');
  const exclude = normList(obj.exclude, 'exclude');
  if (!include && !exclude) return null; // {} -> no filter
  return { include, exclude };
}

// Storage form for pairs.filters: null (SQL NULL = no filter) or compact JSON
// of exactly the active lists (inactive lists are omitted, so a single include
// keyword stores as {"include":["kw"]}). Throws the same clear validation
// errors as normalizeEventFiltersInput, so a bad value fails loudly at save
// time, never silently inside the sync engine.
export function storedFiltersJson(value) {
  const f = normalizeEventFiltersInput(value);
  if (!f) return null;
  const out = {};
  if (f.include) out.include = f.include;
  if (f.exclude) out.exclude = f.exclude;
  return JSON.stringify(out);
}

// Forgiving read for display (dashboard chips): never throws; null on junk.
export function safeParseStoredEventFilters(raw) {
  try { return normalizeEventFiltersInput(raw); } catch { return null; }
}

// Case-insensitive substring semantics per the module comment.
export function eventMatchesFilters(event, filters) {
  const include = filters?.include ?? null;
  const exclude = filters?.exclude ?? null;
  if (!include && !exclude) return true;
  const summary = String(event?.summary ?? '').toLowerCase();
  const includeOk = !include || include.some((kw) => summary.includes(String(kw).toLowerCase()));
  if (!includeOk) return false;
  const excludeHit = Boolean(exclude) && exclude.some((kw) => summary.includes(String(kw).toLowerCase()));
  return !excludeHit;
}

// Filters a whole event list. Returns { events, dropped } (dropped = removed
// count) so the engine can surface `filtered` in the run detail.
export function applyEventFilters(events, filters) {
  const list = Array.isArray(events) ? events : [];
  if (!filters) return { events: [...list], dropped: 0 };
  const kept = [];
  let dropped = 0;
  for (const ev of list) {
    if (eventMatchesFilters(ev, filters)) kept.push(ev);
    else dropped += 1;
  }
  return { events: kept, dropped };
}
