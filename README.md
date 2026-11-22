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

POST JSONL lines to `http://127.0.0.1:9999/ingest`. The session id comes from
the `X-Session-Id` header, else a `sessionId` field in each line, else
`default`. Lines land in `~/.jsonl-sessions/<sessionId>.jsonl`.

```bash
curl -X POST -H 'X-Session-Id: my-session' \
  --data-binary $'{"msg":"hello"}\n{"msg":"world"}' \
  http://127.0.0.1:9999/ingest
```

### Auth

Start the app with `SCRY_INGEST_TOKEN` set and `/ingest` requires
`Authorization: Bearer <token>`; requests without it get a 401. Unset, the
endpoint is open — fine on localhost, required when exposing it on a real
hostname. Senders (e.g. the claude-chat-logger plugin) read the same
`SCRY_INGEST_TOKEN` variable.

## Plugin

`GET /plugin` answers a tar.gz of [`claude-chat-logger/`](claude-chat-logger/),
the Claude Code plugin that sends session transcripts to `/ingest`. Cloud
environment setup scripts install the plugin from this endpoint (see the
plugin's README); it is unauthenticated because setup scripts cannot read
secrets, and the tarball is just the plugin's code.

## Search

Type a query in the app window. It does a case-insensitive substring scan of
every `.jsonl` file under `~/.jsonl-sessions/` and `~/.claude/projects/`.

Port, data directory, and search directories are set in `CONFIG` at the top of
`main.js`.

## Server (headless)

`npm run serve` runs [`server.js`](server.js): the same ingest server without
Electron, plus the search UI in a browser at `/` and its JSON API at
`GET /search?q=`. It is configured by environment: `PORT` (9999), `HOST`
(0.0.0.0), `SCRY_DATA_DIR` (`~/.jsonl-sessions`), `SCRY_SEARCH_DIRS` (extra
`:`-separated dirs), `SCRY_INGEST_TOKEN`, and `SCRY_USER`/`SCRY_PASS` (basic
auth for `/` and `/search`). `GET /healthz` and `GET /plugin` are always open.

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
posts lines for two sessions, checks the files, and searches across both the
ingest directory and a fake projects directory.
