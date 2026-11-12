// Target-label resolution: turn raw target refs (Google calendar IDs, CalDAV
// hrefs) into human-readable labels for the dashboard, with a persistent
// DB cache (target_labels table). Pure dashboard presentation - the sync
// engine never uses labels.
// - google targets: resolved via GoogleCalendarClient.getCalendarSummary()
//   (single light call per unknown target, then cached; errors fall back to
//   the raw id and do NOT poison the cache).
// - caldav targets: label derived from the URL path tail (no network call).
// - no google client configured (not connected): raw id fallback.

export async function resolveTargetLabels({ db, googleClient = null, pairs = [], logger = { warn: () => {}, error: () => {} } } = {}) {
  const labels = new Map(); // pairId (string) -> label
  for (const p of pairs ?? []) {
    const key = String(p?.id ?? '');
    try {
      if (p?.target_type === 'caldav') {
        const raw = String(p.target_url ?? '');
        const tail = raw.replace(/\/+$/, '').split('/').pop() ?? '';
        const label = tail ?? raw;
        labels.set(key, label);
        continue;
      }
      const id = String(p?.calendar_id ?? '').trim();
      if (!id) { labels.set(key, '(no target)'); continue; }
      const cacheKey = `google:${id}`;
      const cached = typeof db.getTargetLabel === 'function' ? db.getTargetLabel(cacheKey) : null;
      if (cached) { labels.set(key, cached); continue; }
      if (!googleClient) { labels.set(key, id); continue; }
      let summary = null;
      try {
        summary = await googleClient.getCalendarSummary(id);
      } catch (err) {
        logger.warn(`target label lookup failed for ${id.slice(0, 12)}…: ${err?.message ?? 'error'}`);
      }
      if (summary) {
        if (typeof db.setTargetLabel === 'function') db.setTargetLabel(cacheKey, summary);
        labels.set(key, summary);
      } else {
        labels.set(key, id);
      }
    } catch (err) {
      logger.warn(`target label resolution failed for pair ${key}: ${err?.message ?? 'error'}`);
      labels.set(key, String(p?.calendar_id ?? p?.target_url ?? ''));
    }
  }
  return labels;
}
