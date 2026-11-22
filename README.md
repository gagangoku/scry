# scry

Electron app for macOS (or a headless server) to scry Claude transcripts. It
runs an HTTP server that accepts end-to-end encrypted JSONL lines, appends them
to per-session files on disk, and gives a UI that decrypts, browses and
searches them in the browser of whoever holds the project's token.

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

## End-to-end encryption

scry is zero-trust: sessions are encrypted on the sending machine, stored as
ciphertext, and decrypted only in the browser of someone who holds the
project's token. The server, its operator, and anyone with a copy of the disk
or a backup cannot read them. The scheme is in [`lib/crypto.js`](lib/crypto.js)
(and mirrored in `public/app.html` and the plugin):

- The token is made in the browser when a project is created and is **never
  sent to the server**. From it, HKDF-SHA256 derives an *auth key* (the
  credential the server checks; it stores only a SHA-256 of it) and a
  *key-encryption key* that never leaves the client.
- Each project has a random 256-bit data key, made in the browser. The server
  keeps it only wrapped (AES-256-GCM) by the key-encryption key.
- Every line is sealed with the data key (AES-256-GCM, random IV, bound to the
  project name) into `{"v":1,"iv":…,"ct":…}` before it is sent. `/ingest`
  refuses anything else, so plaintext never reaches the disk.
- The viewer unwraps the data key with the token, then decrypts sessions and
  runs search locally. Tokens unlocked in a browser stay in that tab's
  `sessionStorage`, or `localStorage` with **Remember on this device**; **Lock**
  forgets one.

What the server still sees: project names, session ids, line counts and sizes,
and when lines arrive. If a project's token is lost, its sessions are
unrecoverable by anyone; that is the point. The browser needs a secure context
for WebCrypto: `https://`, or `http://127.0.0.1` / `localhost`.

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

3. Point the plugin at `http://127.0.0.1:9999/ingest` with a project's token.

Notarizing (so step 2 goes away) needs an Apple Developer ID certificate and
electron-builder's `CSC_LINK`/`APPLE_ID` secrets in the workflow, in place of
`mac.identity: "-"`. The app is packaged without asar because `/plugin` runs
`tar` on `claude-chat-logger/`, which must be a real directory.

## Ingest

POST encrypted JSONL lines to `http://127.0.0.1:9999/ingest` with the
project's auth key as `Authorization: Bearer <authKey>` (`X-Scry-Key` also
works). The project is the auth key's own; an `X-Project` header naming another
gets `403`. A request with any plaintext line is rejected with `400` and
nothing is written. The session id comes from the `X-Session-Id` header, else a
`sessionId` field next to the envelope, else `default`. Lines land in
`~/.jsonl-sessions/<project>/<sessionId>.jsonl`. `GET /ingest/key` (same auth)
answers the project's wrapped data key, which a sender unwraps with its token.

The claude-chat-logger plugin does all of this. By hand, use
[`scripts/scry-crypt.js`](scripts/scry-crypt.js), which reads the token from
the environment:

```bash
export SCRY_INGEST_TOKEN=scry_... SCRY_INGEST_URL=http://127.0.0.1:9999/ingest
printf '%s\n' '{"msg":"hello"}' '{"msg":"world"}' | node scripts/scry-crypt.js encrypt \
  | curl -X POST -H "Authorization: Bearer $(node scripts/scry-crypt.js auth-key)" \
      -H 'X-Session-Id: my-session' --data-binary @- "$SCRY_INGEST_URL"
```

`scry-crypt.js decrypt` turns a stored session file back into plaintext, given
the token.

### Projects and tokens

In the app, **New project** creates a project: the browser makes its token and
data key and shows the token once. **Token** (with a project selected) replaces
the token: unlock the project with the current one first, since the new token
must wrap the same data key; existing sessions stay readable with the new token
and the old one stops working for sending and reading. A project without a key
(a folder from before encryption) can be given its first token without one.

Give each Claude account its own project and set `SCRY_PROJECT` and
`SCRY_INGEST_TOKEN` in that account's environment; the claude-chat-logger
plugin reads both.

## Plugin

`GET /plugin` answers a tar.gz of [`claude-chat-logger/`](claude-chat-logger/),
the Claude Code plugin that sends session transcripts to `/ingest`. Cloud
environment setup scripts install the plugin from this endpoint (see the
plugin's README); it is unauthenticated because setup scripts cannot read
secrets, and the tarball is just the plugin's code.

### Migrating data from before encryption

Tokens from before encryption no longer work (the server stored a hash of the
token itself, and senders sent plaintext). For each project: select it in the
app, click **Token** to give it a new token, update `SCRY_INGEST_TOKEN` where
it is used, then encrypt its stored sessions in place on the server's disk:

```bash
SCRY_INGEST_TOKEN=scry_... node scripts/scry-crypt.js migrate --data-dir ~/.jsonl-sessions --project work
```

(In the Docker image: `kubectl exec -it deploy/scry -- env SCRY_INGEST_TOKEN=scry_... node scripts/scry-crypt.js migrate --data-dir /data --project work`.)
This is the one step where the token is used on the server, once, to encrypt
data that was already sitting there in plaintext. Until it runs, the viewer
shows those lines with an "unencrypted" badge. Files from before projects
existed, directly in the data dir, must first be moved into a project folder:

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

- **Project menu** in the header: one project, or **All projects** (every
  project readable in this browser: unlocked ones and local ones). It scopes
  both the session list and search. Picking a locked project asks for its token.
- **claude-code-local** (Electron app only): a read-only project over the
  Claude Code transcripts in `~/.claude/projects/` on this machine. Its
  sessions are `~/.claude/projects/<folder>/<id>.jsonl` (subagent transcripts
  deeper down are searchable but not listed). These are Claude Code's own
  plaintext files on your machine, not scry's encrypted store: it has no token,
  nothing is ingested into it, and the local server reads and searches it as is.
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
  sessions; `/sessions` and `/session` answer that link as `webUrl`) or, once
  decrypted, one of its lines has a `remote_session_id`. In the Electron app it
  opens in the default browser.
- **Search** (`/` to focus): case-insensitive substring scan. Encrypted
  projects are searched in the browser, over the decrypted sessions of the
  unlocked projects in scope (fetched once and cached until they grow): the
  server only holds ciphertext and cannot search them. Local projects are
  searched by the local server (`GET /search`). Clicking a hit opens the
  session scrolled to that line.

Port, data directory and local projects are set in `CONFIG` at the top of
`main.js`.

## Server (headless)

`npm run serve` runs [`server.js`](server.js): the same server and UI as the
app, without Electron. It is configured by environment: `PORT` (9999), `HOST`
(0.0.0.0), `SCRY_DATA_DIR` (`~/.jsonl-sessions`), and `SCRY_USER`/`SCRY_PASS`
(basic auth for `/app`, `/projects`, `/sessions` and `/session`, and for
creating projects; an outer lock, not what keeps sessions private). The JSON
API: `GET /projects`, `POST /projects {"name","authKey","wrappedKey"}`,
`POST /projects/token {"name","authKey","wrappedKey"}` (with the current auth
key in `X-Scry-Key`), `GET /sessions?project=` (each with its first encrypted
lines in `head`) and `GET /session?project=&id=` (encrypted lines) — the last
two need the project's auth key in `X-Scry-Key` (local projects need none). `GET /healthz`, `GET /version`, `GET /plugin`,
the landing page at `/` and the favicons are always open.

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

Runs `test/smoke.js` with plain Node (no Electron needed): checks the crypto
round trips and that keys are bound to their project, that plaintext and
foreign keys are refused, that nothing readable (sessions, tokens, keys) lands
on disk, token replacement, `scry-crypt.js` (encrypt, decrypt, migrate), and
the HTTP routes with basic auth and project keys.
