// Remote feed fetching with webcal:// rewrite and a TLS-failure -> HTTP
// fallback (only when the URL carries no credentials). Never fetches file://.
export class FeedFetchError extends Error {
  constructor(message, { cause, status } = {}) {
    super(message);
    this.name = 'FeedFetchError';
    if (cause) this.cause = cause;
    if (status != null) this.status = status;
  }
}

// Accepts http/https/webcal; normalizes webcal -> https via string rewrite
// (URL.protocol = 'https:' silently fails for non-special schemes).
// Returns a URL object.
export function normalizeFeedUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new FeedFetchError('Feed URL is empty');
  let s = raw.trim().replace(/^webcal:/i, 'https:');
  let u;
  try { u = new URL(s); } catch {
    throw new FeedFetchError(`Invalid feed URL: ${s.slice(0, 200)}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new FeedFetchError(`Unsupported feed protocol "${u.protocol}" (use http(s):// or webcal://)`);
  }
  return u;
}

export function hasCredentials(url) {
  return Boolean(url.username || url.password);
}

const TLS_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'EPROTO',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

// Walks the error cause chain looking for a TLS-ish code.
export function isTlsError(err) {
  let e = err;
  for (let i = 0; e && i < 5; i++) {
    const code = e.code || e.cause?.code;
    if (code && TLS_ERROR_CODES.has(code)) return true;
    e = e.cause || (typeof e?.cause === 'object' ? e.cause : null);
  }
  return false;
}

export function shouldFallbackToHttp(url, err) {
  return url.protocol === 'https:' && !hasCredentials(url) && isTlsError(err);
}

async function attempt(u, { maxBytes, timeoutMs, fetchImpl, logger }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Feed fetch timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    const res = await fetchImpl(u, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/calendar, application/xml, application/json, text/*;q=0.9, */*;q=0.8',
        'user-agent': 'regimen.d/0.1 (self-hosted calendar sync)',
      },
    });
    if (!res.ok) {
      throw new FeedFetchError(`Feed fetch failed with HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`, { status: res.status });
    }
    const len = Number(res.headers?.get?.('content-length') ?? 0);
    if (Number.isFinite(len) && len > maxBytes) {
      throw new FeedFetchError(`Feed is larger than the ${maxBytes}-byte limit`);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      throw new FeedFetchError(`Feed is larger than the ${maxBytes}-byte limit`);
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    return { text, finalUrl: String(u), status: res.status };
  } catch (err) {
    if (err instanceof FeedFetchError) throw err;
    throw new FeedFetchError(`Feed fetch failed: ${err.message}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

// Fetches a feed URL. webcal:// is rewritten to https://; if TLS fails and the
// URL has no credentials, retries once over http. Throws FeedFetchError.
export async function fetchFeed(rawUrl, { maxBytes = 10 * 1024 * 1024, timeoutMs = 30_000, fetchImpl = fetch, logger = { warn: () => {} } } = {}) {
  const url = normalizeFeedUrl(rawUrl);
  try {
    return await attempt(url, { maxBytes, timeoutMs, fetchImpl, logger });
  } catch (err) {
    if (shouldFallbackToHttp(url, err)) {
      logger.warn(`TLS failure for ${url.host} — retrying over HTTP (no credentials in URL)`);
      const httpUrl = new URL(String(url).replace(/^https:/i, 'http:')); // string-level scheme switch (URL.protocol setter fails for special->special too in some cases)
      return attempt(httpUrl, { maxBytes, timeoutMs, fetchImpl, logger });
    }
    throw err;
  }
}
