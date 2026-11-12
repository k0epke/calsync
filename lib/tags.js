// Dashboard tag form parsing + POST handlers for the two tag endpoints:
//   POST /tags           - rename/re-color the 10 tag slots (manager form)
//   POST /pairs/:id/tags - replace one pair's tag assignments (row details form)
// Handlers are wired in server.js with the real db/redirect/page404 helpers so
// the same-session/CSRF/redirect-with-flash patterns stay identical to every
// other POST. They are exported factory-style so tests can exercise them with
// plain fakes (no sockets anywhere).
import { TAG_PALETTE } from './db.js';

export const TAG_NAME_MAX = 40;

// Parse the manager form: one name input + one color select per slot. Empty
// name -> null (slot becomes unnamed = not assignable). Colors must come from
// the fixed palette (case-insensitive, stored lowercase). Returns
// { updates: [...] } or { error } without touching the db.
export function parseTagUpdateForm(body) {
  const updates = [];
  for (let slot = 1; slot <= 10; slot++) {
    const name = String(body?.[`name_${slot}`] ?? '').trim();
    const color = String(body?.[`color_${slot}`] ?? '').trim().toLowerCase();
    if (name.length > TAG_NAME_MAX) return { error: `Tag ${slot}: name must be at most ${TAG_NAME_MAX} characters.` };
    if (!TAG_PALETTE.includes(color)) return { error: `Tag ${slot}: color must come from the fixed palette (${TAG_PALETTE.join(', ')}).` };
    updates.push({ slot, name: name || null, color });
  }
  return { updates };
}

// Parse the per-pair assignment form: checkboxes name="tag" (one value per
// checked slot; absent = none). express-formurlencoded yields a string when
// exactly one box is checked and an array for several. Unknown/out-of-range
// slots are rejected here; naming rules are enforced at the db boundary.
export function parsePairTagForm(body) {
  const raw = body?.tag;
  const list = Array.isArray(raw) ? raw : (raw == null || raw === '' ? [] : [raw]);
  const slots = [];
  for (const item of list) {
    const n = Number(String(item).trim());
    if (!Number.isInteger(n) || n < 1 || n > 10) {
      return { error: `Invalid tag slot "${String(item).slice(0, 20)}" - tag slots are 1..10.` };
    }
    if (!slots.includes(n)) slots.push(n);
  }
  return { slots };
}

export function makeSaveTagsHandler(db, redirectWith) {
  return (req, res) => {
    const parsed = parseTagUpdateForm(req.body);
    if (parsed.error) return redirectWith(res, { err: parsed.error });
    try {
      db.setTags(parsed.updates);
    } catch (err) {
      return redirectWith(res, { err: `Could not save tags: ${err.message}` });
    }
    return redirectWith(res, { msg: 'Tags saved.' });
  };
}

export function makePairTagsHandler(db, redirectWith, notFoundPage) {
  return (req, res) => {
    const id = Number(req.params?.id);
    const pair = Number.isInteger(id) && id > 0 ? db.getPair(id) : null;
    if (!pair) return notFoundPage(req, res);
    const parsed = parsePairTagForm(req.body);
    if (parsed.error) return redirectWith(res, { err: parsed.error });
    try {
      db.setPairTags(pair.id, parsed.slots);
    } catch (err) {
      return redirectWith(res, { err: `Could not save tags: ${err.message}` });
    }
    return redirectWith(res, { msg: `Tags for "${pair.name}" updated.` });
  };
}
