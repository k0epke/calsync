// Google Calendar API + OAuth wrapper (googleapis), with 429/5xx exponential
// backoff. All methods are called synchronously sequential from the sync
// engine to stay well under Google's per-minute mutation limits.
import { google } from 'googleapis';

// Re-exported so server.js can build fresh OAuth2 clients from stored tokens.
export { google };

// offline access for refresh tokens. Google uses access_type=offline +
// prompt=consent (OAuth "offline_access" is the Google equivalent).
export const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/userinfo.email',
];

export function createOAuthClient(config) {
  if (!config.googleClientId || !config.googleClientSecret) return null;
  return new google.auth.OAuth2(config.googleClientId, config.googleClientSecret, config.googleRedirectUrl);
}

export function authUrlFor(oauthClient) {
  return oauthClient.generateAuthUrl({
    access_type: 'offline',
    scope: CALENDAR_SCOPES,
    prompt: 'consent', // always re-issue a refresh token on (re)connect
  });
}

function statusOf(err) {
  const candidates = [err?.status, err?.response?.status, err?.code, err?.response?.data?.error?.code];
  return candidates.find((c) => typeof c === 'number') ?? undefined;
}

export function isRetryableError(err) {
  const status = statusOf(err);
  if (typeof status === 'number' && (status === 429 || (status >= 500 && status <= 599))) return true;
  const code = err?.cause?.code ?? err?.code;
  if (typeof code === 'string' && ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE', 'ECONNABORTED'].includes(code)) return true;
  return false;
}

export function isAuthError(err) {
  const status = statusOf(err);
  return status === 401 || status === 403 || status === 404 && false;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class GoogleCalendarClient {
  constructor(oauthClient, { logger = { warn: () => {}, error: () => {} }, maxRetries = 5, baseDelayMs = 500 } = {}) {
    if (!oauthClient) throw new Error('Google OAuth client is not configured');
    this.auth = oauthClient;
    this.cal = google.calendar({ version: 'v3', auth: oauthClient });
    this.logger = logger;
    this.maxRetries = maxRetries;
    this.baseDelayMs = baseDelayMs;
  }

  // Runs `fn` with exponential backoff on 429/5xx/network errors; honors
  // Retry-After when Google sends one. Non-retryable errors throw immediately.
  async withBackoff(label, fn) {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return await fn();
      } catch (err) {
        const status = statusOf(err);
        if (!isRetryableError(err) || attempt > this.maxRetries) {
          this.logger.error(`${label} failed permanently (status ${status ?? 'n/a'}, attempt ${attempt}): ${err.message}`);
          throw err;
        }
        let delayMs = this.baseDelayMs * (2 ** (attempt - 1)); // 500, 1000, 2000...
        const retryAfter = Number(err?.response?.headers?.['retry-after'] ?? err?.response?.headers?.get?.('retry-after') ?? NaN);
        if (Number.isFinite(retryAfter) && retryAfter > 0) delayMs = retryAfter * 1000;
        delayMs += Math.floor(Math.random() * this.baseDelayMs); // jitter
        this.logger.warn(`${label} hit HTTP ${status ?? 'network error'} (attempt ${attempt}/${this.maxRetries}) — retrying in ~${Math.round(delayMs)}ms`);
        await sleep(delayMs);
      }
    }
  }

  // calendar.events.import — imports (upserts by iCalUID) an event while
  // preserving recurrence, iCalUID and private properties. Idempotent per run.
  async importEvent(calendarId, gEvent) {
    return this.withBackoff(`import ${gEvent.iCalUID}`, () =>
      this.cal.events.import({ calendarId, requestBody: gEvent, supportsAttachments: false }));
  }

  async listEventsByUid(calendarId, iCalUID) {
    const res = await this.withBackoff(`lookup ${iCalUID}`, () =>
      this.cal.events.list({ calendarId, iCalUID, maxResults: 20, showDeleted: true }));
    return res?.data?.items ?? [];
  }

  // One paginated read of every non-deleted event in the calendar (the sync
  // engine calls this ONCE per run). Returns Map<iCalUID, {eventId, status}>
  // so unchanged imports can be skipped without a write call. Reads route
  // through withBackoff like every other call; duplicate iCalUIDs keep the
  // first entry (deleteAllByUid still cleans up all copies).
  async listAllEvents(calendarId, { pageSize = 250, maxPages = 200 } = {}) {
    const byUid = new Map();
    let pageToken;
    let pages = 0;
    do {
      pages += 1;
      if (pages > maxPages) throw new Error(`events.list for ${calendarId} did not finish within ${maxPages} pages`);
      const res = await this.withBackoff(`list ${calendarId} page ${pages}`, () =>
        this.cal.events.list({ calendarId, maxResults: pageSize, showDeleted: false, pageToken }));
      for (const item of res?.data?.items ?? []) {
        if (!item?.iCalUID) continue;
        if (!byUid.has(item.iCalUID)) {
          byUid.set(item.iCalUID, { eventId: item.id, status: String(item.status ?? '').toLowerCase() });
        }
      }
      pageToken = res?.data?.nextPageToken ?? null;
    } while (pageToken);
    return byUid;
  }

  async deleteEvent(calendarId, eventId) {
    return this.withBackoff(`delete ${eventId}`, () =>
      this.cal.events.delete({ calendarId, eventId }));
  }

  // Deletes every event (max a few) with this iCalUID, returns count deleted.
  async deleteAllByUid(calendarId, iCalUID) {
    const items = await this.listEventsByUid(calendarId, iCalUID);
    const ids = items.map((i) => i.id).filter(Boolean);
    for (const id of ids) {
      try {
        await this.deleteEvent(calendarId, id);
      } catch (err) {
        if (statusOf(err) === 404) continue; // already gone
        throw err;
      }
    }
    return ids.length;
  }

  async listCalendars() {
    const res = await this.withBackoff('calendarList', () =>
      this.cal.calendarList.list({ minAccessRole: 'writer', maxResults: 200 }));
    return res?.data?.items ?? [];
  }

  // "create new calendar" action: calendars.insert.
  async createCalendar(name, timeZone) {
    const res = await this.withBackoff(`createCalendar ${name}`, () =>
      this.cal.calendars.insert({ requestBody: { summary: name, timeZone: timeZone || undefined } }));
    return res?.data ?? null;
  }

  async userInfo() {
    try {
      const res = await this.withBackoff('userinfo', () =>
        google.oauth2({ version: 'v2', auth: this.auth }).userinfo.get());
      return res?.data ?? null;
    } catch {
      return null; // email is cosmetic; never fail sign-in over it
    }
  }

  // Authenticated token check used by GET /healthz?deep or dashboard.
  async verifyAccess(calendarId) {
    await this.withBackoff(`verify ${calendarId}`, () =>
      this.cal.calendars.get({ calendarId }));
    return true;
  }
}
