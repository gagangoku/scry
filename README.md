# scry

Electron app for macOS to scry Claude transcripts. It runs a local HTTP server that accepts JSONL lines,
appends them to per-session files on disk, and gives a search UI over those
files plus `~/.claude/projects/`.

## Run

```bash
npm install
npm start
```

The app window is a browser on the app's own local server, so the desktop app
and the headless server run the same UI and API: everything works in both, and
while the app runs, `http://127.0.0.1:9999/app` opens the same UI in any browser.
That server listens on localhost only, without basic auth. Only one of the app
and `npm run serve` can hold port 9999 at a time; the app shows an error and
quits if the port is taken.

## macOS app

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

3. Point the plugin at `http://scry_public_ip:9999/ingest` with a project's token,
   where `scry_public_ip` is an address of this machine that Claude can reach.

Notarizing (so step 2 goes away) needs an Apple Developer ID certificate and
electron-builder's `CSC_LINK`/`APPLE_ID` secrets in the workflow, in place of
`mac.identity: "-"`. The app is packaged without asar because `/plugin` runs
`tar` on `claude-chat-logger/`, which must be a real directory.

## Ingest

POST JSONL lines to `http://scry_public_ip:9999/ingest` with a project's token
(see [Projects and tokens](#projects-and-tokens)). Every line needs a
**project**: the `X-Project` header, else a `project` field in the line. A
request where any line has no project is rejected with `400` and nothing is
written. Projects keep different Claude accounts' sessions apart (e.g. `work`,
`personal`). The session id comes from the `X-Session-Id` header, else a
`sessionId` field in each line, else `default`. Lines land in
`~/.jsonl-sessions/<project>/<sessionId>.jsonl`.

```bash
curl -X POST -H "Authorization: Bearer $SCRY_INGEST_TOKEN" \
  -H 'X-Project: work' -H 'X-Session-Id: my-session' \
  --data-binary $'{"msg":"hello"}\n{"msg":"world"}' \
  http://scry_public_ip:9999/ingest
```

### Projects and tokens

Ingest tokens belong to projects, not to the deployment. In the app, **New
project** creates a project and shows its token once; **Token** (with a project
selected) replaces it, retiring the old one, or issues the first token for a
project folder from before tokens existed. `/ingest` needs
`Authorization: Bearer <token>` (401 otherwise), and a token only writes to its
own project (403 for lines naming another). Tokens are stored as SHA-256 hashes
in `<dataDir>/.scry/projects.json`; scry cannot show a token again.

Give each Claude account its own project and set `SCRY_PROJECT` and
`SCRY_INGEST_TOKEN` in that account's environment; the claude-chat-logger
plugin reads both.

## Plugin

`GET /plugin` answers a tar.gz of [`claude-chat-logger/`](claude-chat-logger/),
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

## Web pages

- `/` is a public landing page ([`public/index.html`](public/index.html))
  describing scry, with setup snippets that point at the server serving it. The
  desktop app has no landing page: there `/` redirects to `/app`.
- `/app` is the sessions viewer ([`public/app.html`](public/app.html)), behind
  basic auth when `SCRY_USER` is set.
- `/favicon.svg`, `/favicon.ico` and `/apple-touch-icon.png` are served from
  [`public/`](public/), unauthenticated.

## UI

- **Project menu** in the header: one project, or **All projects**. It scopes
  both the session list and search.
- **claude-code-local** (Electron app only): a read-only project over the
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
- **Search** (`/` to focus): case-insensitive substring scan. With **All
  projects** it covers every `.jsonl` under the search dirs and local projects
  (in the Electron app, `~/.claude/projects/`); with one project, only that project.
  Clicking a hit opens the session scrolled to that line.

Port, data directory, search directories and local projects are set in `CONFIG` at the top of
`main.js`.

## Server (headless)

`npm run serve` runs [`server.js`](server.js): the same server and UI as the
app, without Electron. It is configured by environment: `PORT` (9999), `HOST`
(0.0.0.0), `SCRY_DATA_DIR` (`~/.jsonl-sessions`), `SCRY_SEARCH_DIRS` (extra
`:`-separated dirs), and `SCRY_USER`/`SCRY_PASS` (basic auth for `/app`,
`/search`, `/projects`, `/sessions` and `/session`, and for creating projects).
The JSON API: `GET /search?q=[&project=]`, `GET /projects`,
`POST /projects {"name"}` (answers the new token), `POST /projects/token
{"name"}` (replaces it), `GET /sessions[?project=]`,
`GET /session?project=&id=` — `project` absent means all projects, present and
empty means the legacy files with no project. `GET /healthz`, `GET /plugin`, the
landing page at `/` and the favicons are always open.

## Deployment

The `Dockerfile` packages the headless server (`node:22-alpine`, no npm
dependencies), storing sessions in the `/data` volume.
`.github/workflows/docker.yaml` runs the tests and pushes `teltrix/scry:latest`
and `:<sha>` to Docker Hub on every push to `master` (needs the
`DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repository secrets).
`deploy/hetzner.yaml` runs it on Kubernetes behind Traefik at
`scry.teltrix.ai`, with a 10Gi PersistentVolumeClaim and Keel rolling out each
new `:latest`; its header lists the secret and apply steps. Point senders at
`https://scry.teltrix.ai/ingest` and setup scripts at
`https://scry.teltrix.ai/plugin`.

## Test

```bash
npm test
```

Runs `test/smoke.js` with plain Node (no Electron needed): starts the server,
checks that ingestion without a project is rejected, posts lines for sessions
in two projects, checks the files, lists projects and sessions, reads a
session, and searches across all projects, one project, and a fake
`~/.claude/projects` directory.
