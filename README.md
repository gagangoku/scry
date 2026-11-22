# scry

Electron app for macOS to scry Claude transcripts. It runs a local HTTP server that accepts JSONL lines,
appends them to per-session files on disk, and gives a search UI over those
files plus `~/.claude/projects/`.

## Run

```bash
npm install
npm start
```

## Ingest

POST JSONL lines to `http://127.0.0.1:9999/ingest` with a project's token
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
  http://127.0.0.1:9999/ingest
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

## UI

- **Project menu** in the header: one project, or **All projects**. It scopes
  both the session list and search.
- **Sessions** sidebar: every session with its name (first prompt, else id),
  id, created time (first line's `ts`) and last-updated time, newest first,
  with a filter box. Refreshes every 20s.
- Clicking a session opens its full log as a chat: user prompts right-aligned,
  agent responses on the left with Markdown, collapsible thinking, tool calls
  and results, and a badge on aborted/errored turns. Understands both the
  chat-logger format and raw Claude Code transcript lines.
- **Search** (`/` to focus): case-insensitive substring scan. With **All
  projects** it covers every `.jsonl` under the search dirs (in the Electron
  app, also `~/.claude/projects/`); with one project, only that project.
  Clicking a hit opens the session scrolled to that line.

Port, data directory, and search directories are set in `CONFIG` at the top of
`main.js`.

## Server (headless)

`npm run serve` runs [`server.js`](server.js): the same ingest server without
Electron, plus the search UI in a browser at `/` and its JSON API at
`GET /search?q=`. It is configured by environment: `PORT` (9999), `HOST`
(0.0.0.0), `SCRY_DATA_DIR` (`~/.jsonl-sessions`), `SCRY_SEARCH_DIRS` (extra
`:`-separated dirs), and `SCRY_USER`/`SCRY_PASS` (basic auth for `/`,
`/search`, `/projects`, `/sessions` and `/session`, and for creating projects).
The JSON API: `GET /search?q=[&project=]`, `GET /projects`,
`POST /projects {"name"}` (answers the new token), `POST /projects/token
{"name"}` (replaces it), `GET /sessions[?project=]`,
`GET /session?project=&id=` — `project` absent means all projects, present and
empty means the legacy files with no project. `GET /healthz` and `GET /plugin` are always open.

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
