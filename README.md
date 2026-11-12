# CalSync

Self-hosted calendar sync: periodically pulls events from remote calendar feeds
and mirrors them into dedicated **Google Calendars** via the official
Google Calendar API v3, with a small authenticated web dashboard.

- **Plain ESM JavaScript** � no TypeScript, no build step. Deploy is `npm ci` && `node server.js`.
- **No native dependencies** � SQLite via the built-in `node:sqlite` module.
- **Node.js >= 22** (Node 22.5+ requires `--experimental-sqlite`; Node 23.4+/24 run unflagged � 24 recommended).

## Features

- **Feed formats ( sniffed from content, URL extensions are ignored ):**
  - **ICS** (iCalendar 2.0, RFC 5545) � folded lines, VTIMEZONE definitions, RRULE/RDATE/EXDATE, VALARM (ignored), STATUS:CANCELLED, all-day and duration events.
  - **VCS** (vCalendar 1.0) � lenient: DSTART/DEND renamed, AALARM/DALARM dropped, common v1 RRULE bases (D/W/MD/MP/YD/YM) converted to RFC 5545; unsupported rules are dropped with a warning.
  - **XCal** (RFC 6321 XML) � mapped to jCal per the RFC, including `<parameters>` and typed value elements.
  - **JCal** (RFC 7265 JSON) � recur values accepted as objects or strings.
  - **webcal://** URLs are treated as `https://` (with a one-shot `http://` fallback *only* when TLS fails and the URL carries no credentials).
- All feeds normalize to **jCal** via `ical.js` (the internal representation everywhere).
- **iCloud (CalDAV) sources (one-way):** authenticated reading of private iCloud calendars -
  CalDAV discovery (principal -> calendar-home -> listing) plus one REPORT calendar-query per run
  over the sync window; Apple ID + app-specific password via `.env` (see the iCloud section below).
- **Per-pair sync into a dedicated Google calendar** using `calendar.events.import` �
  an upsert keyed by `iCalUID`, which makes every run idempotent. Recurrence
  (RRULE/RDATE/EXDATE lines) is preserved; Google expands occurrences.
- **Event window:** only events occurring within `[now - 30 days, now + 1 year]`
  are pushed (recurrence-aware: finite rules that end before the window are skipped,
  still-live infinite rules are kept). Tunable via env.
- **Deletion sync:** after the import pass, events whose `iCalUID` was previously
  recorded in the local `synced_events` table but is now absent from the feed are
  deleted from the target calendar. **Events the app did not import are never
  touched.** Feed `STATUS:CANCELLED` events are treated as "removed by the feed"
  the same way. If fetching or parsing fails, nothing is deleted � and if every
  import in a run fails, the deletion pass is skipped entirely.
- **Rate limiting:** exponential backoff with jitter on HTTP 429/5xx, `Retry-After`
  aware; strictly sequential per-event pushes with a small configurable delay;
  per-event failures are logged to the run log and the run continues (status `partial`).
- **OAuth:** Google login -> consent -> refresh token (access_type=offline,
  prompt=consent) stored in SQLite; the official `googleapis` package.
  "Create new calendar" action uses `calendars.insert`.
- **Scheduler:** node-cron, one schedule per pair. Interval per pair (default 6h,
  min 15m), deterministic per-pair minute anchors ((pairId * 7) mod interval) so
  same-interval pairs never fire together; catch-up run after restart for overdue
  pairs, manual **Sync now** button. Per-pair status, last run and last error
  persist in SQLite.
- **Dashboard:** server-rendered HTML + a little vanilla JS, one small stylesheet,
  no frameworks. Pair CRUD, Google connection state, run history with per-event
  failure details.

## Security model

- Username + password dashboard login (bcryptjs), httpOnly session cookie
  (express-session, in-memory store � restart ? relogin by design), per-IP
  login rate limiting, CSRF tokens on all state-changing POSTs.
- `GET /healthz` is the only unauthenticated route; everything else requires a session.
- Secrets only via environment / `.env` (gitignored, `.env.example` shipped).
  No hardcoded secrets; feed data is HTML-escaped everywhere it renders; `file://`
  fetching is never attempted.
- Default bind is `127.0.0.1`. Binding `0.0.0.0` requires an explicit `HOST=0.0.0.0`
  and logs a hard warning � put nginx with TLS in front (see `deploy/`).

## Google Cloud OAuth setup (one-time)

1. Open <https://console.cloud.google.com> ? create (or pick) a project.
2. **APIs & Services ? Library** ? enable **Google Calendar API**.
3. **APIs & Services ? OAuth consent screen**:
   - User type **External**, add app name + your email;
   - Add scopes: `.../auth/calendar` (and `userinfo.email` for the dashboard display);
   - Add yourself as a **test user** (required while the app is in "Testing").
4. **APIs & Services ? Credentials ? Create credentials ? OAuth client ID**:
   - Application type: **Web application**;
   - **Authorized redirect URI** must exactly match CalSync's redirect URL, e.g.
     - local dev: `http://127.0.0.1:8787/oauth/callback`
     - production: `https://cal.example.com/oauth/callback`
   - Copy the **Client ID** and **Client secret** into `.env`.

The OAuth scope requests `access_type=offline` + `prompt=consent`, which is
Google's equivalent of OAuth2 `offline_access`: it yields a long-lived refresh
token stored (only) in the local SQLite database.

## iCloud (CalDAV) calendar source (one-way)

CalSync can also READ private iCloud calendars as a feed source and mirror
them into Google exactly like a URL feed: sync pairs with `source_type`
`caldav` fetch over CalDAV (`https://caldav.icloud.com`) using HTTP Basic
authentication. Apple offers no REST API for iCloud Calendar; CalDAV is the
only supported access path. This build is strictly **one-way** (iCloud ->
Google, read-only): iCloud as a target, two-way sync and a dashboard connect
flow are future work.

### 1. Create an app-specific password (required)

iCloud CalDAV only accepts an app-specific password, never the account
password (any Apple ID with two-factor authentication qualifies):

1. Sign in at <https://appleid.apple.com> with your Apple ID.
2. Open **Sign-In and Security** -> **App-Specific Passwords**.
3. Click **+**, label it (e.g. `calsync`), and copy the generated password
   (format `abcd-efgh-ijkl-mnop`). It is shown only once.

### 2. Wire the credentials via .env (the only supported path in this build)

CalSync keeps ONE iCloud account per deployment (an Apple ID usually owns
several calendars). Credentials come from environment/.env only:

```
ICLOUD_APPLE_ID=your.name@icloud.com
ICLOUD_APP_PASSWORD=abcd-efgh-ijkl-mnop
```

Restart the service. The values are stored in the local `icloud_accounts`
SQLite table (same single-row pattern as the Google account) and are never
logged, rendered or embedded in URLs. To rotate: change `.env`, restart.
To disable iCloud sources: remove both variables, restart.

### 3. Pick a calendar href

List the event calendars the account can read:

```
node bin/inspect.js --caldav
```

This walks the standard discovery chain (current-user-principal ->
calendar-home-set -> depth-1 PROPFIND of the calendar home), skips
scheduling inboxes and Reminders (VTODO-only) collections, and prints for
every remaining calendar its `caldav://` form:

```
  - Home
      href      : https://caldav.icloud.com/1234567/calendars/ABCD-EFGH-1234/
      caldav:// : caldav://caldav.icloud.com/1234567/calendars/ABCD-EFGH-1234/
```

The pair URL encoding is `caldav://<host>/<calendar-path>`: exactly the
CalDAV href with the scheme renamed, never carrying credentials (those live
only in `.env`). A plain `https://caldav.icloud.com/...` href is accepted
too. Preview what a sync run would import from one calendar:

```
node bin/inspect.js --caldav caldav://caldav.icloud.com/1234567/calendars/ABCD-EFGH-1234/
```

### 4. Create the pair

On the dashboard pick source type **iCloud calendar (CalDAV)** and paste the
`caldav://` URL as the feed URL; pick or create the target Google calendar
as usual. Everything downstream (planner, skip-unchanged hashing, Google
import, deletion sweep, run log) behaves exactly like a URL-feed pair: one
REPORT calendar-query replaces the HTTP ICS fetch and returns the same
normalized event model. STATUS:CANCELLED events and events that disappear
from the REPORT snapshot follow the usual "removed by the feed" rules
(imports and deletions only ever touch events CalSync imported itself).

### How it fetches (REPORT strategy)

A single `REPORT calendar-query` per run with a `time-range` matching the
sync window, requesting full `calendar-data` WITHOUT `expand`. Expanded
instances would all carry the series UID (only RECURRE-ID differs) and
collapse in the UID-keyed importer; keeping master components with
RRULE/RDATE/EXDATE lines lets the existing recurrence pipeline and the
Google-side expansion work unchanged. An etag pre-pass plus
calendar-multiget would double the round trips for nothing, since
skip-unchanged hashing happens on the Google side of the sync.

### Limitations

- Read-only, one-way (iCloud into Google). iCloud as a target, two-way sync
  and a dashboard OAuth-style connect flow are future work.
- Apple does not document CalDAV rate limits; the client therefore backs off
  HTTP 429/5xx and network errors with exponential backoff + jitter honoring
  `Retry-After` (`lib/caldav.js`), and a run makes at most one REPORT.
- Only `caldav.icloud.com` is supported; generic CalDAV servers are out of
  scope for this build.
- Reminders (VTODO), scheduling inboxes and non-event collections are
  skipped during discovery; only VEVENT-capable collections are listed.
- Recurring series are imported as masters (RRULE lines) with the planner's
  first-UID-wins duplicate rule, same as ICS feeds containing overrides.

## Setup (Ubuntu / Debian)

```bash
# 1. Packages � Node 24 LTS (NodeSource), git, nginx, certbot
sudo apt update
sudo apt install -y git curl nginx python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs      # node >= 22.5 works; 24 recommended
node -v && npm -v

# 2. App user + directory
sudo useradd --system --create-home --home-dir /opt/calsync --shell /usr/sbin/nologin calsync

# 3. Get the code (clone, or scp the folder)
sudo -u calsync git clone <your-repo-or-copy-path> /opt/calsync/app 2>/dev/null \
  || (sudo mkdir -p /opt/calsync/app && sudo rsync -a ./calsync/ /opt/calsync/app/)
cd /opt/calsync/app
sudo chown -R calsync:calsync /opt/calsync

# 4. Dependencies + configuration
sudo -u calsync npm ci --omit=dev
sudo -u calsync cp .env.example .env
sudo -u calsync chmod 600 .env
sudo -u calsync nano .env    # ADMIN_PASSWORD, SESSION_SECRET, GOOGLE_* keys
sudo -u calsync node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"  # SESSION_SECRET

# 5. Sanity check (parses a local feed without Google)
sudo -u calsync node bin/inspect.js test/fixtures/sample.ics

# 6. systemd
sudo cp deploy/calsync.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now calsync
systemctl status calsync --no-pager
curl -fsS http://127.0.0.1:8787/healthz

# 7. nginx TLS reverse proxy
sudo cp deploy/nginx-calsync.conf /etc/nginx/sites-available/calsync
sudo sed -i 's/cal.example.com/cal.yourdomain.example/' /etc/nginx/sites-available/calsync
sudo ln -sf /etc/nginx/sites-available/calsync /etc/nginx/sites-enabled/calsync
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d cal.yourdomain.example
```

Then open `https://cal.yourdomain.example`, log in with `ADMIN_USERNAME` /
`ADMIN_PASSWORD`, connect the Google account (OAuth consent ? refresh token
stored locally), and add sync pairs.

On **Node 22.x only**, run the service with `--experimental-sqlite`
(edit `ExecStart=/usr/bin/node --experimental-sqlite server.js`) or upgrade to Node 24.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | HTTP listen port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` only behind a proxy) |
| `CALSYNC_DB_PATH` | `<app>/data/calsync.db` | SQLite database file |
| `LOG_LEVEL` | `info` | `debug` `info` `warn` `error` `silent` |
| `ADMIN_USERNAME` | `admin` | Dashboard user (created on first boot) |
| `ADMIN_PASSWORD` | � (**required**) | Dashboard password; bcrypt-hashed in DB, re-hashed when env changes |
| `SESSION_SECRET` | ephemeral on loopback | Cookie signing secret (**required** for non-loopback binds) |
| `SESSION_COOKIE_SECURE` | `false` | Set `true` behind HTTPS |
| `TRUST_PROXY` | `false` | Set `true` behind nginx (correct client IP for rate limiting) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | � | OAuth client from Google Cloud console |
| `GOOGLE_REDIRECT_URL` | `http://127.0.0.1:PORT/oauth/callback` | Must match the OAuth client's redirect URI |
| `CALSYNC_TZ` | system tz | IANA timezone for cron schedules |
| `PUSH_DELAY_MS` | `250` | Delay between sequential Google pushes |
| `MAX_FEED_BYTES` | `10485760` | Max feed size |
| `FETCH_TIMEOUT_MS` | `30000` | Feed fetch timeout |
| `WINDOW_PAST_DAYS` / `WINDOW_FUTURE_DAYS` | `30` / `365` | Event import window |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_WINDOW_MINUTES` | `8` / `15` | Login rate limiting |
| `ICLOUD_APPLE_ID` / `ICLOUD_APP_PASSWORD` | - | iCloud CalDAV source credentials (Apple ID + app-specific password from appleid.apple.com); empty disables iCloud sources |

## Google push algorithm (per sync run)

```
fetch feed (webcal?https, size+timeout caps)
  +- parse (ics/vcs/xcal/jcal ? jCal)           # failure ? run error, no Google mutations
      +- window filter [now-30d, now+1y]         # recurrence-aware; cancelled kept for planner
          +- plan = planSync(tracked uid set, feed events)   # pure function
              +- import pass: events.import per event (sequential, delay, backoff,
              �                iCalUID upsert ? idempotent; failures logged, run continues)
              +- deletion pass: for tracked UIDs absent from the feed:
                    events.list(iCalUID=�) ? events.delete   # ONLY app-imported UIDs
      +- record run row + pair status in SQLite
```

Safety rails: feed fetch/parse failure aborts **before** any Google mutation;
if **all** imports of a run fail (typically an auth outage), the deletion pass
is skipped that run so an outage cannot mass-delete the calendar.

## Troubleshooting

- **`node:sqlite is unavailable`** � your Node is too old. Use Node = 23.4 (24 recommended) or add `--experimental-sqlite` on Node 22.5+.
- **Login loops after restart** � expected without `SESSION_SECRET` (ephemeral secret); set it in `.env`.
- **`Google account not connected`** on runs � click *connect a Google account* on the dashboard; `GOOGLE_CLIENT_ID/SECRET` must be set first.
- **`Google did not return a refresh token`** � the app was previously authorized; revoke it at <https://myaccount.google.com/permissions>, then reconnect (forces `prompt=consent`).
- **Pair shows `partial` status** � open the pair's *Runs* page; per-event failure reasons (imports and deletes) are listed there.
- **Feed shows `error: All imports failed�`** � usually an expired/revoked Google grant or API quota; the calendar was deliberately protected from deletions.
- **Events shifted by one hour around DST** � feeds that reference `TZID` names *without* a `VTIMEZONE` definition are handled via the IANA database when the name is a standard zone; exotic `X-` zone names fall back to server-local time (see known gaps).
- **Rate limited (`401` on login)** � too many failed attempts; the limiter window resets after `LOGIN_WINDOW_MINUTES`.

- **iCloud pair shows `HTTP 401 ...`** - the app-specific password expired or was revoked; re-issue one at <https://appleid.apple.com> (Sign-In and Security -> App-Specific Passwords), update `ICLOUD_APP_PASSWORD` in `.env` and restart.
- **`iCloud (CalDAV) source not configured`** on runs - set `ICLOUD_APPLE_ID` and `ICLOUD_APP_PASSWORD` in `.env`, then restart the service.

## Development

```bash
npm install
npm test            # node:test runner; ~100 tests, no network; Google / iCloud CalDAV / feed calls mocked
npm run inspect -- test/fixtures/sample.vcs   # parse any feed without Google
node scripts/ical-spike.js                    # probe raw ical.js API behavior
node bin/inspect.js --caldav                   # list iCloud event calendars or preview one (creds from .env)
```

Tests cover: content sniffing, ICS/VCS/XCal/JCal ? jCal normalization (fixtures
with folded lines, RRULE, VTIMEZONE, X-WR-CALNAME, a vCalendar 1.0 sample,
an XCal sample, a JCal sample), window/relevance logic, upsert/deletion planning
and the full sync engine against a mocked Google client (in-memory SQLite).
iCloud (CalDAV) support adds multistatus fixture coverage for discovery and
REPORT parsing, credential redaction, backoff and the identical sync-engine
flow behind a mocked iCloud CalDAV client.

## Known gaps / limitations

- **vCalendar 1.0 recurrence is best-effort**: `MP` position groups with
  unusual layouts, and non-standard RRULE bodies, are dropped (single occurrence
  kept) with a visible warning; `YD` maps to `BYYEARDAY`.
- **Floating times** (no TZID, no `Z`) are interpreted as UTC and flagged in the run warnings.
- `TZID`s without a shipped `VTIMEZONE` resolve via the IANA database when the
  name is standard; unknown zone names fall back to the server's timezone.
- Imports don't diff content � every run re-imports the feed's events (idempotent
  `events.import` upsert by iCalUID makes this safe, at the cost of API calls).
- Sessions are in-memory: restarting the service logs dashboard users out.
- Recurrence window gating approximates EXDATE handling (an occurrence excluded
  by EXDATE may still keep an otherwise-expired event in the import window � harmless).

## License

MIT

## License

MIT ? see [LICENSE](LICENSE).
