# scry

Scry records Claude Code sessions and makes them searchable on your Mac.

```
Claude Code ──POST /ingest──▶ scry server ──sync──▶ Scry for Mac ──backup──▶ your Google Drive
 (plugin)                    (Go, holds only      (local files,
                              unsynced data)       index, search)
```

- **The server** ([`server/`](server/), Go, no dependencies) signs people in
  with Google, issues per-project ingest tokens, meters storage, takes
  payments, and holds each user's new session lines only until their Mac has
  them (at most 50 MB per user), then deletes them. It has no search and no
  session views.
- **The Mac app** (Electron) signs in with the same Google account, syncs
  continuously in the background into `~/.jsonl-sessions/`, indexes what
  arrives, and is where sessions are read and searched. It backs up to the
  user's own Google Drive on a schedule, like WhatsApp.
- **The plugin** ([`claude-chat-logger/`](claude-chat-logger/)) sends each
  prompt and turn from Claude Code to the server.

## Pricing

| | |
|---|---|
| First 20 MB of synced sessions | Free |
| Beyond that | $10 per GB per month |

What is metered is every session line accepted by the server, counted when it
arrives (it then lives on the Mac and in the Drive backup, not on the
server); the total only grows, like an archive. A user's allowance is the free
20 MB, plus the GB of their subscription while it is `active`, `trialing` or
`past_due` (Stripe retrying the card), plus any storage an admin granted. At
the limit, `/ingest` answers `402` and writes nothing; the plugin keeps the
lines queued and they go through once storage is added. If a subscription
ends, nothing synced is lost (it is on the Mac), but new sessions are refused
past the free allowance.

The subscription is one Stripe subscription per user on a recurring
`STRIPE_PRICE_GB` ($10 per unit per month), with the quantity as the number of
GB. The first subscription goes through Stripe Checkout; changing the GB, from
the app or the web account page, updates it in place with proration; it
cannot go below what is already synced. Cancelling, cards and invoices are in
the Stripe Billing Portal. `SCRY_FREE_MB` (20), `SCRY_SPOOL_MB` (50) and
`SCRY_PRICE_PER_GB_MONTH_USD` (10, what the UI shows; Stripe charges the price)
set the numbers.

## Server

```bash
cd server && go run .
```

Configured by environment:

| Variable | |
|---|---|
| `SCRY_GOOGLE_CLIENT_ID` | OAuth client (*Web application*) of the `/app` page. Required. |
| `SCRY_GOOGLE_DESKTOP_CLIENT_ID` | OAuth client (*Desktop app*) of the Mac app; its ID tokens are accepted too. |
| `SCRY_ADMIN_EMAILS` | `,`-separated Google emails: unmetered, see every user's usage, can add storage by hand. |
| `SCRY_PUBLIC_URL` | e.g. `https://scry.teltrix.ai`: Secure cookies, Stripe return URLs. |
| `SCRY_DATA_DIR` | `state.json` and the spool (`/data`). |
| `SCRY_PUBLIC_DIR`, `SCRY_PLUGIN_DIR` | `public/` and `claude-chat-logger/` (set in the Docker image). |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_GB`, `STRIPE_WEBHOOK_SECRET` | Payments. `STRIPE_PRICE_GB` is a recurring monthly $10 price (per unit = per GB); the webhook is `<public url>/billing/webhook` with `checkout.session.completed` and `customer.subscription.created`, `.updated` and `.deleted`. |
| `PORT`, `HOST` | `9999`, `0.0.0.0` |

State (users, projects, token and session hashes, usage, payments) is one
JSON file, `state.json`, rewritten atomically; usage counters are flushed every
2 seconds and on shutdown. All tokens are stored as SHA-256 hashes.

### Routes

- `GET /` landing page, `GET /app` account page (sign-in, storage and buying
  it, projects and tokens, sync status, admin users), `GET /plugin`,
  `GET /healthz`, `GET /version`, favicons: public.
- `GET /auth/config`; `POST /auth/google {credential, device?}`: verifies a
  Google ID token (RS256 against Google's keys, audience, issuer, expiry,
  verified email). A browser gets a 30-day `HttpOnly` `SameSite=Lax` cookie;
  with `device` (the Mac app) the answer carries a one-year device token for
  `Authorization: Bearer scryd_...`. `POST /auth/logout`.
- `GET /me`: usage, allowance, subscription, bytes waiting on the server,
  last sync.
- `GET /projects`, `POST /projects {name}`, `POST /projects/token {name}`:
  per-user projects (two users can both have `work`); a token is shown once.
- `POST /ingest` with `Authorization: Bearer <project token>`: JSONL lines.
  Every line needs a project (`X-Project`, else a `project` field) equal to the
  token's (400/403), the session is `X-Session-Id`, else `sessionId`, else
  `default`. All or nothing; `402` over the allowance, `507` when 50 MB are
  already waiting for the user's Mac.
- Sync, for the Mac app: `POST /sync/pull?wait=25` seals what has arrived and
  lists waiting segments, holding the request until something arrives (long
  poll); `GET /sync/segment?id=` returns one as JSONL records
  `{"project","session","line"}` (`line` is the raw line as sent);
  `POST /sync/ack {ids}` deletes them from the server.
- `POST /billing/storage {gb}`: without a subscription, answers `{url}` of
  Stripe Checkout; with one, changes its quantity (prorated) and answers
  `/me`. `POST /billing/portal` → `{url}` of the Billing Portal.
  `POST /billing/webhook` mirrors the subscription onto the user: events are
  applied as absolute state, and one older than what the user already has is
  ignored (Stripe does not guarantee order).
- `GET /admin/users`, `POST /admin/users/credit {email, gb}` (admins: grant
  storage that does not expire, e.g. comps).

POST routes that use the cookie only accept `application/json`, so a
cross-site form cannot drive them.

## Mac app

```bash
npm install
npm start
```

The window is a browser on the app's own local server
(`http://127.0.0.1:9999/app`, localhost only), which serves the sessions
viewer over `~/.jsonl-sessions/` and `~/.claude/projects/`.

- **Sign in** (header, **Sign in to sync**): Google OAuth for installed apps
  in the system browser, with a loopback redirect and PKCE
  ([`lib/google-oauth.js`](lib/google-oauth.js)). One consent covers the scry
  server (the ID token is exchanged for a device token) and Drive (scope
  `drive.appdata`: only the app's own hidden folder). The device token and the
  Google refresh token are encrypted with Electron `safeStorage` (Keychain) in
  `~/Library/Application Support/Scry/account.json`. After sign-in the app
  registers itself to open at login, hidden, so it keeps syncing.
- **Sync** ([`lib/sync.js`](lib/sync.js)): a loop long-polls `/sync/pull`,
  downloads each segment, appends its lines to
  `~/.jsonl-sessions/<project>/<session>.jsonl` (fsynced), records the segment
  as applied, then acks it so the server deletes it. A segment applied but not
  acked (the app quit in between) is skipped by id when it comes again, so
  lines are never doubled. Errors back off from 5 s to 5 minutes. It keeps
  running with the window closed (the app stays in the Dock).
- **Search index** ([`lib/index.js`](lib/index.js)): which files contain which
  words, kept in `search-index.json`. Updates are incremental (only bytes
  appended since the last update are read), run after each sync, every minute
  for `~/.claude/projects`, and before each search. Search stays a
  substring match over lines; the index only narrows the files, and never
  drops a file that could match.
- **Google Drive backup** ([`lib/backup.js`](lib/backup.js)): daily by
  default (or weekly, or off), checked hourly, skipped when nothing changed.
  It uploads one `scry-backup.tar.gz` of all session files to the Drive
  `appDataFolder` (resumable upload, streamed from disk), replacing the last
  one. **Restore** downloads it and merges: a session comes back when it is
  missing locally or the local copy is shorter.
- **Account** (the chip in the header): storage used, subscribing (opens
  Stripe Checkout in the browser) or changing the GB, the Billing Portal, sync state and what is waiting on the
  server, backup status and schedule, sign out. **New project** and **Token**
  create and rotate tokens on the server when signed in.
- Signed out, the app still works on local data, and its local
  `/ingest` (projects created in the app, `http://127.0.0.1:9999/ingest`)
  still accepts lines from a plugin on the same Mac.

### Building the DMG

The landing page's download buttons link to
[`Scry-mac-arm64.dmg`](https://github.com/gagangoku/scry/releases/download/mac-latest/Scry-mac-arm64.dmg)
(Apple Silicon) and
[`Scry-mac-x64.dmg`](https://github.com/gagangoku/scry/releases/download/mac-latest/Scry-mac-x64.dmg)
(Intel). [`.github/workflows/mac-app.yaml`](.github/workflows/mac-app.yaml)
builds them on a macOS runner with `npm run dist:mac` (electron-builder) and
replaces the DMGs on the `mac-latest` release. It runs only when triggered by
hand: Actions → **Build macOS app** → **Run workflow**.

To keep the download small, each DMG holds one architecture (a universal build
ships Electron twice), only Electron's English locale, and is LZFSE-compressed
(`ULFO`). The app's version and build (workflow run number, commit, build time)
show in the header of the UI, in **Scry → About Scry**, and at `GET /version`.

It does not install itself:

1. Open the DMG and drag **Scry** into **Applications**.
2. The app is ad-hoc signed but not notarized, so Gatekeeper blocks the first
   launch. Open it once, click **Done**, then in **System Settings → Privacy &
   Security** click **Open Anyway** next to Scry and confirm. Or clear the
   quarantine flag and open it normally:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Scry.app
   ```

3. Click **Sign in to sync** and sign in with Google.

The workflow stamps `build-info.json` with the Google OAuth client the app
signs in with, from the `GOOGLE_DESKTOP_CLIENT_ID` and
`GOOGLE_DESKTOP_CLIENT_SECRET` repository secrets (a *Desktop app* client; its
secret is not confidential, it ships in the app). Without them the app works
locally but cannot sign in.

Notarizing (so step 2 goes away) needs an Apple Developer ID certificate and
electron-builder's `CSC_LINK`/`APPLE_ID` secrets in the workflow, in place of
`mac.identity: "-"`. The app is packaged without asar because `/plugin` runs
`tar` on `claude-chat-logger/`, which must be a real directory.

### Viewer

- **Project menu** in the header: one project, or **All projects**. It scopes
  both the session list and search.
- **claude-code-local**: a read-only project over the
  Claude Code transcripts in `~/.claude/projects/` on this machine. Its
  sessions are `~/.claude/projects/<folder>/<id>.jsonl` (subagent transcripts
  deeper down are searchable but not listed). It has no token, and nothing is
  ingested into it.
- **Sessions** sidebar: every session with its name (first prompt, else id),
  id, created time (first line's `ts`) and last-updated time, newest first,
  with a filter box. Refreshes every 20s.
- Clicking a session opens its full log as a chat: user prompts right-aligned,
  agent responses on the left with Markdown, collapsible thinking, tool calls
  and results, and a badge on aborted/errored turns. Understands both the
  chat-logger format and raw Claude Code transcript lines.
- Cloud (claude.ai/code) sessions get an **Open in Claude** button in the
  session header that opens the session's web chat,
  `https://claude.ai/code/session_01...`. A session counts as a cloud session
  when its id is a `session_01...` id (the chat-logger plugin's key in cloud
  sessions) or one of its first lines has a `remote_session_id`; `/sessions`
  and `/session` answer that link as `webUrl` (null otherwise). In the
  Electron app it opens in the default browser.
- Sessions show the **git repo** they work on, as `⎇ owner/repo @ branch`:
  in the sidebar, and in the session header as a link to the repo at that
  branch. For cloud sessions it comes from the chat-logger plugin's `repos`
  field (the session's repositories and working branch from claude.ai/code,
  else the working directory's `origin` remote); for `claude-code-local`
  transcripts, from the `origin` remote in the transcript's `cwd` and its
  `gitBranch`. `/sessions` and `/session` answer it as
  `repos: [{ name, url, branch? }]` (`[]` when unknown). Sessions logged before
  the plugin sent `repos` show none. The sidebar filter matches repo names and
  branches.
- **Search** (`/` to focus): case-insensitive substring match. With **All
  projects** it covers every synced session and `~/.claude/projects/`; with
  one project, only that project. A local word index (below) narrows which
  files are read. Clicking a hit opens the session scrolled to that line.

Port, data directory, local projects, the server URL and the Google client
are set in `CONFIG` at the top of `main.js`.

## Plugin

The server's `GET /plugin` answers a tar.gz of [`claude-chat-logger/`](claude-chat-logger/),
the Claude Code plugin that sends session transcripts to `/ingest`. Cloud
environment setup scripts install the plugin from this endpoint (see the
plugin's README); it is unauthenticated because setup scripts cannot read
secrets, and the tarball is just the plugin's code.

### Migrating pre-project data

Files ingested before projects existed sit directly in the data dir. The UI
still shows them under **(no project)**; to assign them a project, move them
into a subdirectory:

```bash
mkdir -p ~/.jsonl-sessions/work && mv ~/.jsonl-sessions/*.jsonl ~/.jsonl-sessions/work/
```

On `402` (storage full) and `507` (the Mac has not synced for a while) it
shows a toast and keeps the lines queued.

## Deployment

The `Dockerfile` builds the Go server into a static binary on distroless
(about 7 MB; idle memory around 10 MB), with `public/` and
`claude-chat-logger/`, storing state and the spool in the `/data` volume.
`.github/workflows/docker.yaml` runs the Go tests and the app's tests, then
pushes `teltrix/scry:latest` and `:<sha>` on every push to `master`.
`deploy/hetzner.yaml` runs it on Kubernetes behind Traefik at
`scry.teltrix.ai`; its header lists the `scry-env` secret's keys.

Setup:

1. Google Cloud Console: an OAuth client of type *Web application* with
   `https://scry.teltrix.ai` as an authorized JavaScript origin
   (`SCRY_GOOGLE_CLIENT_ID`), and one of type *Desktop app*
   (`SCRY_GOOGLE_DESKTOP_CLIENT_ID`, and the repository secrets for the Mac
   build). Enable the Google Drive API, and add the `drive.appdata` scope to
   the consent screen.
2. Stripe: a product "Scry storage" with a recurring monthly price of $10 per
   unit (`STRIPE_PRICE_GB`); a webhook to `/billing/webhook` with the events
   above; and the Billing Portal enabled (cancellation, payment methods,
   invoices; quantity changes there are picked up by the webhook too).

The Go server does not read the old Node server's files (`/data/<project>/*.jsonl`,
`/data/.scry/`); copy them into a Mac's `~/.jsonl-sessions/` to keep them.

## Test

```bash
(cd server && go test -race ./...)
npm test
```

- `server/server_test.go`: sign-in (bad signatures, audiences, expiry,
  issuers), per-user projects and tokens, ingest, the spool, long polling,
  acks deleting data, the 402 and 507 limits, the storage subscription
  (Checkout, quantity changes, out-of-order and retried webhooks, past_due,
  cancellation), admin routes, and a restart.
- `test/smoke.js`: the app's local server: ingest, projects, sessions, search.
- `test/index.js`: the search index (incremental updates, truncation, long
  words, and a randomized check that it never misses a match).
- `test/cloud.js`: end to end, building and running the Go server: Google
  sign-in through a fake OAuth endpoint (PKCE checked), project creation,
  ingest, background sync and server-side deletion, local search, Drive
  backup and restore against a fake Drive, restart, sign-out. Skipped
  without Go.
