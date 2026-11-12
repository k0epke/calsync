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
- **iCloud (CalDAV) sources:** authenticated reading of private iCloud calendars -
  CalDAV discovery (principal -> calendar-home -> listing) plus one REPORT calendar-query per run
  over the sync window; Apple ID + app-specific password via `.env` (see the iCloud section below).
- **Google sources (google://<calendarId>):** mirror a connected Google calendar into another
  target (CalDAV targets; Google targets are rejected as degenerate at pair create/update).
- **iCloud (CalDAV) targets (two-way):** any source type (url / caldav / google) can target an
  iCloud calendar - skip-unchanged against the LIVE remote copy via canonical hashes, PUT/DELETE
  per UID with If-Match, and its own deletion sweep (see the two-way section below).
- **Failure alerts + daily digest (optional Telegram):** one alert per pair on `error`/`partial`
  runs (max one per pair per 30 minutes; `success` never alerts) plus a daily digest cron at
  `ALERT_DIGEST_HOUR` (America/Chicago). Disabled entirely unless `ALERT_TELEGRAM_TOKEN` and
  `ALERT_TELEGRAM_CHAT_ID` are set (see "Failure alerts + daily digest" below).
- **Per-pair event filters:** optional include/exclude keyword lists applied to the SOURCE event
  list after the fetch and before windowing/planning, for every source type. Flipping filters
  prunes previously imported copies via the normal deletion sweep (see "Per-pair event filters" below).
- **Privacy copy modes (per pair):** write-time masking in BOTH target adapters - `full` (default),
  `busy` (summary "Busy", no description/location), `generic` (summary = pair name). Hashes are
  computed after the transform, so masked writes reach a zero-write steady state like any other pair
  (see "Privacy copy modes" below).
- **Generic CalDAV hosts (opt-in, default OFF):** `CALDAV_ALLOW_ANY_HOST=true` accepts any https
  CalDAV host instead of iCloud-only. Credentials still never travel in URLs and redaction still
  applies everywhere (see "Generic CalDAV hosts" below).
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
  failure details, plus dashboard organization: client-side sorting and
  filtering, an auto-derived category column and 10 customizable color-coded
  tag slots (see "Dashboard organization: sorting, filters, category, tags"
  below).

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

## iCloud (CalDAV) calendar source and target

CalSync can read private iCloud calendars as a feed source and mirror
them into Google exactly like a URL feed: sync pairs with `source_type`
`caldav` fetch over CalDAV (`https://caldav.icloud.com`) using HTTP Basic
authentication. Apple offers no REST API for iCloud Calendar; CalDAV is the
only supported access path. Since the two-way build, iCloud calendars can
also be written as a **target** (see "Two-way sync" below); a dashboard
connect flow for iCloud is still future work.

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

- WRITE support is new: Apple does not document CalDAV write rate limits, so
  writes go out strictly sequentially with the usual backoff (see the two-way
  section). A dashboard OAuth-style connect flow for iCloud remains future
  work.
- Apple does not document CalDAV rate limits; the client therefore backs off
  HTTP 429/5xx and network errors with exponential backoff + jitter honoring
  `Retry-After` (`lib/caldav.js`), and a run makes at most one REPORT.
- Only `caldav.icloud.com` is supported; generic CalDAV servers are out of
  scope for this build.
- Reminders (VTODO), scheduling inboxes and non-event collections are
  skipped during discovery; only VEVENT-capable collections are listed.
- Recurring series are imported as masters (RRULE lines) with the planner's
  first-UID-wins duplicate rule, same as ICS feeds containing overrides.

## Two-way sync: CalDAV targets and Google sources

Sync pairs gained a direction choice: every pair still has ONE source and
ONE target, but the target can be an iCloud calendar (CalDAV writes) and the
source can be a Google calendar (google:// encoding). The engine routes all
mutations through a small target-adapter layer; the planner, run_log
bookkeeping, partial-failure protections (all-imports-failed aborts the
deletion pass), unchanged counting, isRunning guard and scheduler are
target-agnostic and behave identically for every target kind.

### Target types

- `target_type = google` (default): the classic flow - the pair mirrors into
  a Google calendar by calendar ID (select / create / manual on the
  dashboard). Legacy database rows read as google targets and behave
  byte-identically to before.
- `target_type = caldav`: the pair writes into an iCloud calendar.
  `target_url` holds the href in the `caldav://<host>/<calendar-path>` form
  (a plain https:// href works identically to the source encoding);
  credentials are NEVER carried in URLs. Writes reuse the SAME `.env` iCloud
  credentials as sources (ICLOUD_APPLE_ID / ICLOUD_APP_PASSWORD) - no new
  secrets were introduced.

### Google sources (google://<calendarId>)

`source_type = google` encodes the source calendar as `google://<calendarId>`
inside the stored feed URL (mirrors the caldav:// discipline: no credentials,
no query strings, strict validation at pair create/update). The engine reads
the calendar with the same paginated `events.list` skeleton the skip logic
uses, maps every resource through the same internal event model, and feeds
planner + target adapter unchanged. Google-as-source into a Google target is
rejected at pair create/update with a clear error: a G->G mirror is
degenerate because the events already live in Google.

### Skip-unchanged for CalDAV targets (canonical hash comparison)

For google targets the skip rule stays exactly as before: the stored
per-UID content hash in `synced_events` is compared against the hash of the
event the pair would import. For caldav targets the comparison is stronger
and self-healing: every run takes ONE REPORT snapshot of the target
calendar, parses each VEVENT through the SAME feed parser, and compares the
live remote copy against the event it would write. Both sides normalize
through ONE canonical function:

    normalizeEventForCompare(event) = toGoogleEvent(event) minus SEQUENCE

so the hashed field subset is exactly CONTENT_HASH_FIELDS and
Google-normalized and CalDAV-normalized representations compare stably.
The explicit exclusion list (tested against a realistic Apple-roundtrip
fixture):

- X- properties, PRODID, DTSTAMP, CREATED, LAST-MODIFIED: the internal
  parser never reads them, so Apple-side rewrites of these fields can never
  phantom-diff.
- SEQUENCE: CalDAV servers may renumber it when storing and Google assigns
  its own sequence numbers on import; mirroring it would make mirrored pairs
  chase each other's metadata forever. Real content changes still re-write.

Writes are idempotent PUTs to `{calendarHref}/{UID}.ics` (create or
overwrite, VEVENT with the UID preserved, RRULE/RDATE/EXDATE lines, and a
VTIMEZONE for every referenced TZID). When the snapshot showed the resource
exists, the PUT carries If-Match with that etag; on 412 (a concurrent
writer moved it) the client re-snapshots exactly once and retries with the
fresh etag - writing unconditionally if the resource vanished in between; a
second 412 surfaces as a per-event failure. DELETEs are sent WITHOUT
If-Match by choice: the sweep only touches UIDs the pair itself wrote, and
404 counts as already-gone, not an error.

### Loop safety (X <-> G mirror pairs)

A two-way setup is two one-way pairs pointing at each other, e.g.

    pair A: source caldav://X,  target google://G
    pair B: source google://G,  target caldav://X

The adapters plus the canonical comparison make this loop converge (the
scenario set is asserted in the test suite):

1. Initial round trip: A imports X into G; B then compares each G event
   against what X already holds and PUTs NOTHING (canonical hashes compare
   equal). After both pairs run, X and G hold equivalent content and BOTH
   pairs' next runs are zero-write.
2. One edit: an edit in X flows through A into G (one import) and B skips
   (X already holds the edit) - converges within one full cycle and does
   not multiply. An edit in G flows through B into X (one PUT) and A's next
   run skips once its stored hash reflects the new content.
3. UIDs are preserved end to end (no event respawn): the CalDAV PUT keeps
   the iCalUID as both the resource name ({UID}.ics) and the VEVENT UID,
   and Google import keys on iCalUID.
4. User edits in the middle of the loop stabilize per "source is
   authority": each pair drives its target toward its own source snapshot,
   so the last writer is whichever source snapshot the pair read (by
   design). A user edit to X between A's read and B's write is overwritten
   by B and the loop stabilizes immediately with no oscillation. User
   events created directly in X are never touched by B (a pair only deletes
   what it itself wrote) - pair A picks them up into G.

Guards: a pair whose source and target resolve to the same CalDAV calendar
(href equality modulo trailing slash, caldav:// vs https:// normalized)
cannot be created or run, and G->G pairs are rejected outright. The
deletion sweep stays pair-scoped: only UIDs previously written by that pair
(synced_events) and now missing from its source snapshot are deleted from
its target - pre-existing content in either side survives untouched.

### Two-way limitations

- Apple does not document CalDAV write rate limits; CalSync therefore
  writes strictly sequentially (one PUT/DELETE at a time, same push delay
  and 429/5xx exponential backoff honoring Retry-After as Google writes)
  and, when every attempted import fails, skips the deletion pass so an
  outage cannot mass-delete the target.
- TZID references: PUT payloads inline VTIMEZONE definitions when one is
  available (shipped with the source or registered by a feed parse). A TZID
  without any definition (possible for google:// sources) is written as a
  TZID reference only - Apple resolves standard Olson zone names itself.
- Per-instance cancellations inside Google recurring series are not
  mirrored to iCloud (masters mirror with their RRULE lines, same as the
  Google import direction).
- SEQUENCE drift converges: a server-side renumbering (Google or Apple) can
  cost exactly one repair write per affected event, then zero-writes.

## Failure alerts + daily digest (optional Telegram)

Both alert channels are OFF unless `ALERT_TELEGRAM_TOKEN` and
`ALERT_TELEGRAM_CHAT_ID` are set in `.env`. With them set:

- **Run failure hook.** After every run finalizes, `error` and `partial`
  runs send ONE message:

  `[CalSync] pair "<name>" (trigger) finished <status>: imported X, deleted Y, failed Z - <first error line, truncated to 300 chars>`

  `success` runs never alert. Bursts are capped in memory: at most one alert
  per pair per 30 minutes, so flapping sources cannot flood the chat.
- **Daily digest.** A node-cron job fires daily at minute 0 of hour
  `ALERT_DIGEST_HOUR` (0-23, default 8) in America/Chicago:

  `CalSync daily digest: <enabled pairs> pairs - <N> success, <M> failed in last 24h; last 10 runs: <one-line statuses>`

  It is a single send per calendar day (a defensive day-guard keeps it that
  way even if the callback fires twice); with no runs in the window it says
  `last 10 runs: none`.
- **Delivery is one attempt, never thrown.** `sendTelegramAlert` posts to
  `https://api.telegram.org/bot<token>/sendMessage` with a 10s timeout,
  exactly once. Failures are logged, not raised - a broken Telegram setup
  must never make sync runs worse. The token, chat id and the full
  `bot<token>` URL prefix are scrubbed from every error and log line.
- The alert hook lives in the sync engine (`lib/sync.js` accepts an `alerts`
  service) and the digest cron in `lib/alerts.js`; both are wired in
  `server.js` and stop cleanly on shutdown.

## Per-pair event filters

Each pair can carry an optional keyword filter, edited from the dashboard
("Include keywords" / "Exclude keywords", comma-separated) and stored in
`pairs.filters` as JSON `{"include": ["kw"], "exclude": ["kw"]}`. `NULL` or
`{}` means no filter. Malformed values fail with a clear validation error at
save time.

- **Semantics.** A source event is kept when ((no include list) OR any
  include keyword is a case-insensitive SUBSTRING of the event summary) AND
  ((no exclude list) OR no exclude keyword is a case-insensitive substring
  of the summary). Keywords are trimmed; matching is case-insensitive.
- **Order of operations (pinned + tested).** source fetch -> filters ->
  window/planner -> write (copy-mode transform) -> hash-after-transform
  skip logic -> write/delete sweep. Filters apply to the SOURCE event list
  for every source type (url, caldav, google); targets receive whatever the
  planner emits - there is no separate target-side filtering.
- **Deletion interaction.** The deletion planner operates on the FILTERED
  source snapshot: adding an exclude keyword that matches previously
  imported events prunes those copies from the target on the next run via
  the normal deletion sweep (only CalSync-imported UIDs are ever touched).
- **Visibility.** Filtered pairs show `inc:`/`exc:` chips on the dashboard,
  and each run records how many source events the filters dropped in its
  run-log detail (`filtered`).
- A stored `filters` value that no longer parses (e.g. edited by hand)
  degrades to "no filter this run" with a run warning instead of failing
  syncs.

## Privacy copy modes (per pair)

Every pair has a **Copy details** setting in the dashboard (stored in
`pairs.copy_mode`, default `full`):

- **Full details** - behavior exactly as before (byte-identical).
- **Busy only** - events are written with summary `Busy`; description and
  location are stripped. Times, all-day flags, recurrence, status and
  sequence are preserved.
- **Generic title** - events are written with the pair name as the summary;
  description and location stripped, times preserved.

The transform is applied **at write time, in both target adapters** (Google
`events.import` and CalDAV PUT), never to the source snapshot. The critical
property is **hash-after-transform**: the content hash used for
skip-unchanged is computed from the TRANSFORMED event, i.e. exactly the
bytes CalSync wrote. On the Google target the stored per-UID hash matches
the transformed hash on every later run; on the CalDAV target the live
remote copy parses back equal to the transformed canonical hash. Either way
a masked pair reaches the same zero-write steady state as a full-detail
pair - no rewrite churn from masking. Because the mask is deterministic,
changing a pair's copy mode costs exactly one repair write per event, then
converges again.

## Dashboard organization: sorting, filters, category, tags

The pairs table gained a dashboard organization surface on top of the sync
state - everything in this section is render/client-side state and never
changes sync behavior.

- **Sorting.** The column headers Name, Category, Target, Interval, Status
  and Last run are clickable: a click toggles ascending/descending and a
  small arrow marks the active sort. Rows are sorted client-side over the
  rendered rows (default: name, ascending). The chosen sort persists in
  localStorage so it survives reloads; when storage is unavailable it
  degrades gracefully to session-only.
- **Filter bar.** Above the table: a free-text search (matches pair name OR
  feed URL, case-insensitive substring), a category picker (All / Google /
  CalDAV / WebCal / ICS feed) and a status picker (All / Enabled / Paused /
  With errors; "With errors" means the last run ended in `error` or
  `partial`). All filters apply live with no reload, persist in localStorage,
  and **Clear filters** resets both inputs and the stored state. Non-matching
  rows are hidden; when nothing matches, a "no sync pairs match" line is
  shown.
- **Category column.** Auto-derived per row, purely for display:
  `source_type` `google` renders **Google**, `caldav` renders **CalDAV
  (iCloud)**, a `webcal://` source renders **WebCal**, and `http(s)://` URL
  feeds render **ICS feed**. The VCS/XCal/JCal sub-formats cannot be known
  statically - they are content-sniffed at sync time - so a URL pair whose
  newest run recorded one of them renders exactly **ICS feed
  (auto-detected)**, with a tooltip; the run history detail line records the
  precise format of every run.
- **Tags.** Ten fixed, customizable color-coded slots, managed in the
  compact **Tags** block above the pairs table: rename inline and recolor
  from the same fixed 10-color palette, applied by one Save form
  (`POST /tags`, CSRF-protected). Pairs can be assigned any named tag(s)
  from the per-pair collapsible Tags section - a server-rendered POST form
  (`POST /pairs/:id/tags`, CSRF-protected) that needs no JavaScript;
  assigned tags render as colored chips in each row. Unassign = uncheck
  (omit). Colors are validated against the fixed palette; only slots with a
  non-empty name are assignable.

**Scope note:** Tags organize the dashboard only; they are not attached to
synced events and the sync engine never reads them. (Attaching tags to
individual events in a target calendar is future work, not part of this
build.) Tags and assignments live in the local SQLite database (`tags` and
`pair_tags` tables, created by a pragma-guarded idempotent migration that is
safe to run on existing databases; deleting a pair cascades away its tag
assignments).

## Generic CalDAV hosts (CALDAV_ALLOW_ANY_HOST)

By default the CalDAV client speaks only iCloud CalDAV
(`caldav.icloud.com` and its `pNN-caldav.icloud.com` shards) - the Apple
credentials in `.env` only ever travel to Apple. Setting
`CALDAV_ALLOW_ANY_HOST=true` in `.env` makes every CalDAV client accept ANY
https CalDAV host, so pairs may point at self-hosted servers (Nextcloud,
Radicale, Baikal, ...). The option is passed from config into every client
construction (source reads AND CalDAV targets).

**Security tradeoff:** this flag decides where your app-specific-password
(Basic auth) header is sent - the pair URL becomes the credential audience.
With generic hosts enabled, a mistake or tampering in a pair URL would send
your stored credentials to that host. Keep it OFF unless you actually
self-host a trusted CalDAV server; keep it ON only on deployments where you
control every pair URL. What still always holds, flag or not: https-only
URLs (`caldav://` is just an alias for `https://`), credentials never
accepted inside pair URLs, and full credential redaction in errors/logs.

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
| `ALERT_TELEGRAM_TOKEN` / `ALERT_TELEGRAM_CHAT_ID` | - | Telegram bot token + chat id for failure alerts and the daily digest; both empty disables all alerting |
| `ALERT_DIGEST_HOUR` | `8` | Daily digest hour (0-23) in America/Chicago; clamped to range, digest disabled without alert credentials |
| `CALDAV_ALLOW_ANY_HOST` | `false` | Opt-in: accept any https CalDAV host (self-hosted servers) instead of iCloud-only; see "Generic CalDAV hosts" |

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
- **`iCloud (CalDAV) target not configured`** on runs - the target side needs the same two variables; they apply to reads and writes alike.
- **`HTTP 412` failures on a pair's runs page** - another writer keeps invalidating CalSync's etags (a second sync app on the same iCloud calendar?); the client refreshes its snapshot once per write and then surfaces the conflict as a per-event failure.

## Development

```bash
npm install
npm test            # node:test runner; ~150 tests, no network; Google / iCloud CalDAV (read + write) / feed calls mocked
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
