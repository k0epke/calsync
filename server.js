// kalsynk — self-hosted calendar feed -> Google Calendar sync.
// Plain ESM Node web service: npm ci && node server.js
import express from 'express';
import session from 'express-session';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile, loadConfig, ROOT_DIR } from './lib/config.js';
import { openDatabase } from './lib/db.js';
import { createLogger } from './lib/logger.js';
import { ensureAdminUser, createRateLimiter, verifyCredentials, newCsrfToken, safeEqual } from './lib/auth.js';
import { fetchFeed, normalizeFeedUrl } from './lib/fetchfeed.js';
import { planSync } from './lib/planner.js';
import { parseFeed, ParseError } from './lib/icalparse.js';
import { createSyncEngine, SyncError, pairSemanticError } from './lib/sync.js';
import { createIcloudCalDavClient, parseCaldavUrl, listIcloudCalendars } from './lib/caldav.js';
import { createAlertServices } from './lib/alerts.js';
import { resolveTargetLabels, resolveIdLabels } from './lib/labels.js';
import { normalizeEventFiltersInput } from './lib/filters.js';
import { normalizeCopyMode } from './lib/copymode.js';
import { syncFieldMaskFromForm } from './lib/syncfields.js';
import { makeSaveTagsHandler, makePairTagsHandler } from './lib/tags.js';
import { Scheduler, SYNC_INTERVAL_CHOICES } from './lib/scheduler.js';
import {
  createOAuthClient, authUrlFor, GoogleCalendarClient, google as googleClientLib,
  parseGoogleSourceUrl, googleSourceUrlOf,
} from './lib/google.js';
import { renderLogin, renderDashboard, renderSettings, renderPairForm, renderRuns, renderError, layout, esc } from './lib/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- configuration -----------------------------------------------------------
loadEnvFile(path.join(ROOT_DIR, '.env'));
const config = loadConfig();
const logger = createLogger(config.logLevel);
const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(config.host);
const isProductionBind = !isLoopback;

if (!config.adminPassword) {
  logger.error('ADMIN_PASSWORD is not set. Copy .env.example to .env and set ADMIN_PASSWORD (and preferably SESSION_SECRET and the GOOGLE_* keys).');
  process.exit(1);
}
if (!config.sessionSecret) {
  if (isProductionBind) {
    logger.error('SESSION_SECRET is required when binding a non-loopback HOST. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
    process.exit(1);
  }
  config.sessionSecret = crypto.randomBytes(48).toString('hex');
  logger.warn('SESSION_SECRET not set — generated an ephemeral secret (all sessions are invalidated on restart). Set it in .env for stable sessions.');
}
if (isProductionBind) {
  logger.warn(`Binding ${config.host}:${config.port} — this is a PUBLIC bind. Put a TLS reverse proxy in front (see deploy/nginx-kalsynk.conf),`);
  logger.warn('set SESSION_COOKIE_SECURE=true, and make sure ADMIN_PASSWORD/SESSION_SECRET are strong.');
}

// --- state -------------------------------------------------------------------
const db = await openDatabase(config.dbPath);
const adminState = ensureAdminUser(db, config);
if (adminState.pending) {
  logger.error('No dashboard user exists and ADMIN_PASSWORD is empty — refusing to start. Set ADMIN_PASSWORD in .env.');
  db.close();
  process.exit(1);
}
if (adminState.created) logger.info(`Created dashboard admin account "${config.adminUsername}" (bcrypt-hashed).`);
if (adminState.updated) logger.info(`Refreshed stored password hash for "${config.adminUsername}" from ADMIN_PASSWORD env.`);
const loginLimiter = createRateLimiter({ max: config.loginMaxAttempts, windowMs: config.loginWindowMs });

// --- google clients ----------------------------------------------------------
const oauthClient = createOAuthClient(config); // null when GOOGLE_CLIENT_ID/SECRET missing
if (!oauthClient) {
  logger.warn('Google OAuth is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). Sync runs will fail until configured and connected.');
}

function currentGoogleClient() {
  if (!oauthClient) return null;
  const account = db.getGoogleAccount();
  if (!account?.refresh_token) return null;
  const oc = new googleClientLib.auth.OAuth2(config.googleClientId, config.googleClientSecret, config.googleRedirectUrl);
  oc.setCredentials({ refresh_token: account.refresh_token });
  return new GoogleCalendarClient(oc, { logger });
}

// --- iCloud (CalDAV) source account ----------------------------------------------
// Env wiring only in this build: ICLOUD_APPLE_ID + ICLOUD_APP_PASSWORD (an
// app-specific password). The single icloud_accounts row follows the
// google_accounts pattern; env wins on every boot so the DB stays in sync
// with .env. Passwords are never logged and never rendered.
if (config.icloudAppleId && config.icloudAppPassword) {
  db.setIcloudAccount({ username: config.icloudAppleId, app_password: config.icloudAppPassword });
  logger.info(`iCloud CalDAV source account configured for "${config.icloudAppleId}".`);
}

function currentIcloudClient() {
  if (!config.icloudAppleId || !config.icloudAppPassword) return null;
  const account = db.getIcloudAccount();
  if (!account?.username || !account?.app_password) return null;
  return createIcloudCalDavClient({
    username: account.username,
    appPassword: account.app_password,
    logger,
    timeoutMs: config.fetchTimeoutMs,
    maxBytes: config.maxFeedBytes,
    // Config flag (default OFF): accept any https CalDAV host, not just
    // iCloud. Credentials never travel in URLs either way (parseCaldavUrl
    // rejects those) and all redaction stays in place.
    allowAnyHost: config.caldavAllowAnyHost,
  });
}

// --- Telegram failure alerts + daily digest ---------------------------------
// Both channels are disabled unless ALERT_TELEGRAM_TOKEN +
// ALERT_TELEGRAM_CHAT_ID are set (see lib/alerts.js + README).
const alertServices = createAlertServices({ config, db, logger });

// --- sync engine + scheduler ---------------------------------------------------
const engine = createSyncEngine({
  db,
  config,
  logger,
  googleFactory: currentGoogleClient,
  icloudFactory: currentIcloudClient,
  fetchFeedImpl: fetchFeed,
  parseFeedImpl: (text) => parseFeed(text),
  planSyncImpl: planSync,
  alerts: alertServices,
});

const scheduler = new Scheduler({ db, config, runPair: engine.runPair, logger });

// --- app -----------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1);

app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(session({
  name: 'kalsynk.sid',
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.sessionCookieSecure,
    maxAge: 7 * 24 * 3600 * 1000,
  },
}));

function redirectWith(res, params) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''));
  res.redirect(303, `/${qs.toString() ? `?${qs.toString()}` : ''}`);
}

// Like redirectWith but returns the user to the Settings page (the tag
// manager and the Google connection card live there now).
function redirectWithSettings(res, params) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''));
  res.redirect(303, `/settings${qs.toString() ? `?${qs.toString()}` : ''}`);
}

// Pages are rendered through small factories so every route stays terse.
const renderFactory = {
  Dashboard: ({ pairs, google, tags, csrf }) => renderDashboard({ pairs, google, tags, csrf }),
  Settings: ({ google, tags, csrf }) => renderSettings({ google, tags, csrf }),
  PairForm: ({ pair, calendars, googleConnected, googleError, csrf }) => renderPairForm({ pair, calendars, googleConnected, googleError, csrf }),
  Runs: ({ pair, runs }) => renderRuns({ pair, runs }),
  Login: ({ next }) => renderLogin({ next }),
  Error: ({ code, message }) => renderError({ code, message }),
};

function page(req, res, title, data = {}, flash = {}, status = 200) {
  const { msg, err } = flash;
  const { title: t, body } = renderFactory[title]({ ...data, csrf: req.session.csrf ?? '' });
  res.status(status).send(layout({ title: t, body, user: req.session.user, msg, err, csrf: req.session.csrf ?? '' }));
}

function safeNext(n) {
  if (typeof n !== 'string' || !n.startsWith('/') || n.startsWith('//') || n.length > 200) return null;
  return n;
}

// --- public, unauthenticated ---------------------------------------------------
app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true, service: 'kalsynk', uptime: Math.round(process.uptime()) });
});

// Static assets are authenticated like everything else.
const ASSETS = path.join(__dirname, 'public');
app.use('/assets', (req, res, next) => {
  if (req.session?.user) return next();
  if (req.method === 'GET') return res.redirect('/login');
  res.status(401).json({ ok: false, error: 'Not authenticated' });
}, express.static(ASSETS, { index: false, maxAge: 0 }));

// --- login/logout (rate limited) ------------------------------------------------
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect(303, '/');
  page(req, res, 'Login', { next: safeNext(req.query.next) });
});

app.post('/login', (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  const ip = req.ip ?? 'unknown';
  const key = `${ip}|${username.toLowerCase()}`;
  const check = loginLimiter.check(key);
  if (!check.ok) {
    logger.warn(`Login rate limit hit for ${ip} (user "${username}")`);
    return page(req, res, 'Login', { next: safeNext(req.query.next) },
      { err: 'Too many login attempts — try again in a few minutes.' }, 429);
  }
  const user = username ? db.getUser(username) : null;
  if (!verifyCredentials(user, password)) {
    return page(req, res, 'Login', { next: safeNext(req.query.next) },
      { err: 'Invalid username or password.' }, 401);
  }
  loginLimiter.reset(key);
  req.session.regenerate((err) => {
    if (err) return page(req, res, 'Login', { next: null }, { err: 'Login failed — session error.' }, 500);
    req.session.user = username;
    req.session.csrf = newCsrfToken();
    const nextUrl = safeNext(req.query.next);
    res.redirect(303, nextUrl ?? '/');
  });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect(303, '/login'));
});

// --- CSRF guard for all state-changing POSTs except login ------------------------
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  if (req.path === '/login') return next();
  if (!req.session.user) return next(); // auth gate rejects first
  const token = req.body?._csrf ?? req.get('x-csrf-token') ?? '';
  if (!safeEqual(token, req.session.csrf ?? '')) {
    logger.warn(`CSRF token mismatch for ${req.ip} on ${req.path}`);
    return redirectWith(res, { err: 'Invalid or missing CSRF token — reload the page and try again.' });
  }
  return next();
});

// --- auth gate: everything below requires a session -------------------------------
app.use((req, res, next) => {
  if (req.session?.user) return next();
  if (req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')) {
    return res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  return res.status(401).json({ ok: false, error: 'Not authenticated' });
});

// --- dashboard -------------------------------------------------------------------
function googleState() {
  const account = db.getGoogleAccount();
  return {
    configured: Boolean(oauthClient),
    connected: Boolean(account?.refresh_token),
    email: account?.email ?? null,
    redirectUrl: config.googleRedirectUrl,
  };
}

// JSON list of the account's iCloud calendars for the pair-form picker.
app.get('/caldav/calendars', async (req, res) => {
  const result = await listIcloudCalendars({
    username: config.icloudAppleId,
    appPassword: config.icloudAppPassword,
    logger,
    maxBytes: config.maxFeedBytes,
    timeoutMs: config.fetchTimeoutMs,
  });
  res.status(result.ok ? 200 : 400).json(result);
});

app.get('/', async (req, res) => {
  // Dashboard organization inputs (render-only): the tag catalog, per-pair
  // assignments, newest run detail per pair, and human-readable target labels
  // (lib/labels.js). The sync engine never reads tags or labels; category and
  // label derivation are pure presentation.
  const tags = db.listTags();
  const tagMap = db.tagMapForPairs();
  const lastRunDetails = db.lastRunDetailByPair();
  const gclient = typeof currentGoogleClient === 'function' ? currentGoogleClient() : null;
  const pairsEnriched = db.listPairsWithStatus();
  const targetLabels = await resolveTargetLabels({ db, googleClient: gclient, pairs: pairsEnriched, logger });
  // Source labels for google:// sources (same cache, same fallback rules).
  const sourceIds = [...new Set(pairsEnriched
    .filter((p) => p.source_type === 'google')
    .map((p) => String(p.feed_url ?? '').startsWith('google://')
      ? String(p.feed_url).slice('google://'.length).trim()
      : '')
    .filter(Boolean))];
  const sourceIdLabels = await resolveIdLabels({ db, googleClient: gclient, ids: sourceIds, logger });
  const pairs = pairsEnriched.map((p) => ({
    ...p,
    tags: tagMap.get(Number(p.id)) ?? [],
    last_run_detail: lastRunDetails.get(Number(p.id)) ?? null,
    target_label: targetLabels.get(String(p.id)) ?? null,
    source_label: p.source_type === 'google' && String(p.feed_url ?? '').startsWith('google://')
      ? (sourceIdLabels.get(String(p.feed_url).slice('google://'.length).trim()) ?? null)
      : null,
  }));
  page(req, res, 'Dashboard', { pairs, google: googleState(), tags },
    { msg: req.query.msg, err: req.query.err });
});

app.get('/settings', (req, res) => {
  page(req, res, 'Settings', { google: googleState(), tags: db.listTags() },
    { msg: req.query.msg, err: req.query.err });
});

// --- sync pairs -------------------------------------------------------------------
async function listCalendarsSafe() {
  const gclient = currentGoogleClient();
  if (!gclient) {
    return { calendars: [], googleConnected: Boolean(db.getGoogleAccount()), googleError: null };
  }
  try {
    const items = await gclient.listCalendars();
    return { calendars: items, googleConnected: true, googleError: null };
  } catch (err) {
    return { calendars: [], googleConnected: true, googleError: err.message };
  }
}

app.get('/pairs/new', async (req, res) => {
  const { calendars, googleConnected, googleError } = await listCalendarsSafe();
  page(req, res, 'PairForm', {
    pair: null,
    calendars,
    googleConnected: googleConnected && Boolean(oauthClient),
    googleError,
  }, { msg: req.query.msg, err: req.query.err });
});

app.post('/pairs', async (req, res) => {
  const created = await resolvePairPayload(req);
  if (created.error) return redirectWith(res, { err: created.error });
  const pair = db.createPair(created.fields);
  scheduler.addPair(pair);
  logger.info(`Pair ${pair.id} "${pair.name}" created (triggering initial sync)`);
  engine.runPair(pair.id, { trigger: 'initial' }).catch(
    (err) => logger.error(`Initial sync for pair ${pair.id}: ${err.message}`));
  redirectWith(res, { msg: `Sync pair "${pair.name}" created — initial sync started in the background.` });
});

app.get('/pairs/:id/edit', async (req, res) => {
  const pair = db.getPair(Number(req.params.id));
  if (!pair) return page404(req, res);
  const { calendars, googleConnected, googleError } = await listCalendarsSafe();
  page(req, res, 'PairForm', {
    pair: { ...pair, calendar_mode: String(req.query.mode ?? 'select') },
    calendars,
    googleConnected: googleConnected && Boolean(oauthClient),
    googleError,
  }, { msg: req.query.msg, err: req.query.err });
});

app.post('/pairs/:id', async (req, res) => {
  const pair = db.getPair(Number(req.params.id));
  if (!pair) return page404(req, res);
  const parsed = await resolvePairPayload(req, pair);
  if (parsed.error) return redirectWith(res, { err: parsed.error });
  db.updatePair(pair.id, parsed.fields);
  const updated = db.getPair(pair.id);
  scheduler.addPair(updated);
  redirectWith(res, { msg: `Sync pair "${updated.name}" updated (schedule re-armed).` });
});

// Validate + build pair fields; resolves the source encoding (url / caldav://
// / google://) and the target (Google calendar select/create/manual, or a
// CalDAV href pointing at an iCloud calendar). Semantic guards (G->G mirror,
// same-CalDAV-calendar) run here at pair create/update per the two-way spec.
async function resolvePairPayload(req, existing = null) {
  const name = String(req.body?.name ?? '').trim();
  const feedUrlRaw = String(req.body?.feed_url ?? '').trim();
  const interval = Number(req.body?.interval_minutes ?? 0);
  const sourceTypeRaw = String(req.body?.source_type ?? '').trim();
  if (!['url', 'caldav', 'google'].includes(sourceTypeRaw || 'url')) {
    return { error: 'Source type must be "url", "caldav" or "google".' };
  }
  const sourceType = sourceTypeRaw || 'url';
  const targetRaw = String(req.body?.target_type ?? '').trim().toLowerCase();
  const targetType = targetRaw === 'caldav' ? 'caldav' : 'google';
  const errors = [];
  if (!name || name.length > 80) errors.push('Name must be 1-80 characters.');
  let normalizedUrl = '';
  if (sourceType === 'caldav') {
    try {
      normalizedUrl = String(parseCaldavUrl(feedUrlRaw));
    } catch (err) {
      errors.push(`CalDAV calendar URL: ${err.message}`);
    }
  } else if (sourceType === 'google') {
    try {
      normalizedUrl = googleSourceUrlOf(parseGoogleSourceUrl(feedUrlRaw));
    } catch (err) {
      errors.push(`Google source URL: ${err.message}`);
    }
  } else {
    try {
      normalizedUrl = String(normalizeFeedUrl(feedUrlRaw));
    } catch (err) {
      errors.push(`Feed URL: ${err.message}`);
    }
  }
  if (!SYNC_INTERVAL_CHOICES.includes(interval)) {
    errors.push(`Interval must be one of: ${SYNC_INTERVAL_CHOICES.join(', ')} minutes.`);
  }
  if (errors.length) return { error: errors.join(' ') };

  let targetUrl = existing?.target_url ?? null;
  let calendarId = String(existing ? existing.calendar_id : '').trim();
  if (targetType === 'caldav') {
    // CalDAV target: a caldav:// or https:// href of the iCloud calendar to
    // mirror into; credentials come from .env like every other CalDAV access
    // (no new secrets, no creds in URLs).
    const rawTarget = String(req.body?.target_url ?? '').trim() || (existing?.target_url ?? '');
    try {
      targetUrl = String(parseCaldavUrl(rawTarget));
    } catch (err) {
      return { error: `CalDAV target URL: ${err.message}` }; 
    }
    calendarId = '';
  } else {
    const mode = String(req.body?.calendar_mode ?? 'manual');
    if (oauthClient && db.getGoogleAccount()) {
      if (mode === 'select') {
        const picked = String(req.body?.calendar_id_select ?? '').trim();
        if (!picked) return { error: 'Pick a target calendar.' };
        calendarId = picked;
      } else if (mode === 'create') {
        const newCalName = String(req.body?.new_calendar_name ?? '').trim();
        if (!newCalName || newCalName.length > 1024) return { error: 'New calendar name must be 1-1024 characters.' };
        try {
          const gclient = currentGoogleClient();
          if (!gclient) return { error: 'Google account not connected — cannot create a calendar.' };
          const cal = await gclient.createCalendar(newCalName, config.timezone);
          if (!cal?.id) return { error: 'Calendar creation did not return an id.' };
          calendarId = cal.id;
          logger.info(`Created Google calendar "${newCalName}" (${cal.id})`);
        } catch (err) {
          return { error: `Calendar creation failed: ${err.message}` };
        }
      } else {
        const manual = String(req.body?.calendar_id_manual ?? '').trim();
        if (!/^[^\s]{5,300}$/.test(manual)) return { error: 'Custom calendar ID is empty or malformed.' };
        calendarId = manual;
      }
    } else {
      const manual = String(req.body?.calendar_id_manual ?? '').trim();
      if (manual) calendarId = manual;
    }
    if (!calendarId) return { error: 'A target Google calendar ID is required.' };
  }
  const fields = {
    name, feed_url: normalizedUrl, source_type: sourceType, calendar_id: calendarId,
    target_type: targetType, target_url: targetUrl, interval_minutes: interval,
  };
  const conflict = pairSemanticError(fields);
  if (conflict) return { error: conflict };

  // --- Per-pair event filters (optional; empty = no filter) ---
  // Dashboard sends two comma-separated keyword lists. Validation happens
  // here AND at the db boundary (storedFiltersJson) so malformed values
  // fail with a clear message at save time.
  const parseKeywordCsv = (raw, label) => {
    if (raw == null) return null;
    const s = String(raw);
    if (!s.trim()) return null;
    const arr = s.split(',').map((k) => k.trim()).filter(Boolean);
    if (!arr.length) return null;
    if (arr.some((k) => k.length > 200)) return { error: `${label} keyword is longer than 200 characters.` };
    return arr;
  };
  const includeRaw = parseKeywordCsv(req.body?.filters_include, 'Include keywords');
  if (includeRaw?.error) return { error: includeRaw.error };
  const excludeRaw = parseKeywordCsv(req.body?.filters_exclude, 'Exclude keywords');
  if (excludeRaw?.error) return { error: excludeRaw.error };
  try {
    fields.filters = (includeRaw || excludeRaw)
      ? normalizeEventFiltersInput({ include: includeRaw ?? null, exclude: excludeRaw ?? null })
      : null;
  } catch (err) {
    return { error: err.message };
  }

  // --- Privacy copy mode ('full'|'busy'|'generic', junk normalizes) ---
  fields.copy_mode = normalizeCopyMode(String(req.body?.copy_mode ?? '').trim());

  // --- Fields to sync (description/location checkboxes) ---
  // HTML checkboxes post ONLY when checked: present (non-empty) = true,
  // absent = false. Both checked (or both absent, i.e. an old client that
  // strips the fieldset) maps through storedSyncFieldsJson at the db
  // boundary: nothing stripped -> NULL (= all fields sync, keeps rows
  // clean); malformed sync_fields never reach this path because the form
  // can only post the two booleans.
  fields.sync_fields = syncFieldMaskFromForm(req.body);

  return { fields };
}

app.post('/pairs/:id/sync', async (req, res) => {
  const pair = db.getPair(Number(req.params.id));
  if (!pair) return page404(req, res);
  if (engine.isRunning(pair.id)) {
    return redirectWith(res, { err: `Sync for "${pair.name}" is already running.` });
  }
  const result = await engine.runPair(pair.id, { trigger: 'manual' });
  if (result.status === 'success') {
    redirectWith(res, { msg: `Sync finished: ${result.log.imported} imported, ${result.log.deleted} deleted, 0 failed.` });
  } else if (result.status === 'partial') {
    redirectWith(res, { msg: `Sync finished with ${result.log.failed} failure(s): ${result.log.imported} imported, ${result.log.deleted} deleted. See runs for details.` });
  } else {
    redirectWith(res, { err: `Sync failed: ${result.error}` });
  }
});

app.post('/pairs/:id/toggle', (req, res) => {
  const pair = db.getPair(Number(req.params.id));
  if (!pair) return page404(req, res);
  const enabled = Number(pair.enabled) ? 0 : 1;
  db.updatePair(pair.id, { enabled });
  scheduler.addPair(db.getPair(pair.id));
  redirectWith(res, { msg: `Sync pair "${pair.name}" ${enabled ? 'resumed' : 'paused'}.` });
});

app.post('/pairs/:id/delete', (req, res) => {
  const pair = db.getPair(Number(req.params.id));
  if (!pair) return page404(req, res);
  scheduler.removePair(pair.id);
  db.deletePair(pair.id);
  redirectWith(res, { msg: `Sync pair "${pair.name}" deleted. Events already imported into Google were kept.` });
});

app.get('/pairs/:id/runs', (req, res) => {
  const pair = db.getPair(Number(req.params.id));
  if (!pair) return page404(req, res);
  page(req, res, 'Runs', { pair, runs: db.listRuns(pair.id, 30) },
    { msg: req.query.msg, err: req.query.err });
});

// --- dashboard tags (organization only) --------------------------------------
// Same session/CSRF/flash-redirect patterns as every other POST (the global
// CSRF guard + auth gate already ran; the handlers parse, validate, and
// redirect with a flash). Tags are dashboard state and never leave it.
app.post('/tags', makeSaveTagsHandler(db, redirectWithSettings));
app.post('/pairs/:id/tags', makePairTagsHandler(db, redirectWith, page404));

// --- Google OAuth ------------------------------------------------------------------
app.get('/oauth/start', (req, res) => {
  if (!oauthClient) {
    return redirectWith(res, { err: 'Google OAuth is not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.' });
  }
  res.redirect(303, authUrlFor(oauthClient));
});

app.get('/oauth/callback', async (req, res) => {
  try {
    if (!oauthClient) return redirectWith(res, { err: 'Google OAuth is not configured.' });
    if (req.query.error) return redirectWith(res, { err: `Google authorization failed: ${req.query.error}` });
    const code = String(req.query.code ?? '');
    if (!code) return redirectWith(res, { err: 'Missing authorization code.' });
    const { tokens } = await oauthClient.getToken(code);
    if (!tokens.refresh_token) {
      return redirectWith(res, { err: 'Google did not return a refresh token — revoke kalsynk at https://myaccount.google.com/permissions then reconnect.' });
    }
    oauthClient.setCredentials(tokens);
    const probe = new GoogleCalendarClient(oauthClient, { logger });
    const info = await probe.userInfo();
    db.setGoogleAccount({
      refresh_token: tokens.refresh_token,
      email: info?.email ?? null,
      scope: tokens.scope ?? null,
    });
    logger.info(`Google account connected${info?.email ? ` (${info.email})` : ''}`);
    redirectWith(res, { msg: `Google account connected${info?.email ? ` as ${info.email}` : ''}.` });
  } catch (err) {
    logger.warn(`OAuth callback failed: ${err.message}`);
    redirectWith(res, { err: `Token exchange failed: ${err.message}` });
  }
});

app.post('/oauth/disconnect', (req, res) => {
  db.clearGoogleAccount();
  redirectWithSettings(res, { msg: 'Google account disconnected. Refresh token removed from local database.' });
});

// --- fallbacks ----------------------------------------------------------------------
function page404(req, res) {
  if ((req.headers.accept ?? '').includes('text/html')) {
    const { title, body } = renderError({ code: '404', message: 'Page not found.' });
    return res.status(404).send(layout({ title, body, user: req.session.user, csrf: req.session.csrf ?? '' }));
  }
  res.status(404).json({ ok: false, error: 'Not found' });
}
app.use((req, res) => page404(req, res));

app.use((err, req, res, _next) => { // eslint-disable-line no-unused-vars
  logger.error(`Unhandled error on ${req.method} ${req.path}: ${err?.message ?? err}`);
  if (res.headersSent) return;
  if ((req.headers.accept ?? '').includes('text/html')) {
    const { title, body } = renderError({ code: '500', message: 'Internal server error — see server logs.' });
    return res.status(500).send(layout({ title, body, user: req.session?.user }));
  }
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

// --- boot ---------------------------------------------------------------------------
const server = app.listen(config.port, config.host, () => {
  logger.info(`kalsynk listening on http://${config.host}:${config.port}`);
  logger.info('GET /healthz is public; everything else requires login.');
  logger.info(`SQLite database: ${config.dbPath}`);
  scheduler.startAll();
  alertServices.startDailyDigest(); // no-op (never scheduled) without alert credentials
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received — shutting down`);
  scheduler.stopAll();
  alertServices.stopAll();
  server.close(() => {
    try { db.close(); } catch { /* ignore */ }
    logger.info('Shutdown complete');
    process.exit(0);
  });
  setTimeout(() => {
    logger.warn('Forcing exit after 5s');
    process.exit(0);
  }, 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, config, db, engine, scheduler, server };
