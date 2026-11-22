# claude-chat-logger

A Claude Code plugin that saves every user prompt and agent response to a JSONL file and ships each line to the [scry](../scry/) ingest endpoint, searchable with a `/chat-search` slash command or the scry app.

## What it does

- Logs two kinds of JSON lines:
  - `{kind: "prompt", ts, session_id, project?, remote_session_id?, prompt}` the moment a prompt is submitted, so a long or interrupted turn never loses it.
  - `{kind: "response", ts, session_id, project?, remote_session_id?, turn_id, reason, response, thinking?}` when the turn ends — any reason, aborted and errored turns included (`reason` says which). `thinking` is the model's streamed thinking for that turn, captured via a pass-through `turn.step` hook. Subagent turns are skipped.
- `remote_session_id` is the claude.ai/code session id (`session_01...`), resolved at session start from the `claude-code-remote` MCP server in cloud sessions; it is also the scry session key, so scry files map to claude.ai/code URLs. Outside cloud sessions the local session UUID is used.
- Appends each line to `~/.claude/chat-log.jsonl`.
- POSTs each line to the endpoint in the `SCRY_INGEST_URL` environment variable (e.g. `https://gagan.ngrok-free.app/ingest`) with the session key in `X-Session-Id` and the `SCRY_PROJECT` environment variable in `X-Project`. scry rejects lines without a project, so when `SCRY_PROJECT` is unset the plugin warns once and logs locally only. Give each Claude account its own project (e.g. `SCRY_PROJECT=work`, `SCRY_PROJECT=personal`) to keep their sessions apart in scry. When `SCRY_INGEST_URL` is unset, HTTP ingestion is off and the plugin only writes the local file. `SCRY_INGEST_TOKEN` is the token scry showed when the project was created (New project in the scry app); set it as a secret. scry is end-to-end encrypted and the token itself is never sent: the plugin derives the project's auth key from it (sent as `Authorization: Bearer`), fetches the project's wrapped data key from `<SCRY_INGEST_URL>/key`, unwraps it with the token, and encrypts every line (AES-256-GCM) before it leaves the machine, so the scry server only ever holds ciphertext. Encryption uses the engine's WebCrypto, falling back to a `node` subprocess where the engine has none. Without a token nothing is sent. When the endpoint is unreachable or rejects the token, the plugin warns once per session and keeps logging locally.
- Registers `/chat-search <text>`: case-insensitive fixed-string search over the local log, prints the last 10 matches.

## Install in Claude Code cloud environments

Cloud sessions ignore plugins enabled by a repository's `.claude/settings.json`, so the plugin is installed per environment. The plugin is downloaded from the running scry server's `GET /plugin` endpoint — no git checkout or Repositories entry needed. In each environment's settings (cloud environment menu in the session title bar → Edit):

1. **Setup script**: paste [`setup.sh`](setup.sh) (or call it from your existing script). It downloads the plugin tarball from the scry server's `/plugin` endpoint and unpacks it to `~/.claude-plugins/chat-logger`. The URL is hardcoded in the script (setup scripts cannot read environment variables); edit `SCRY_PLUGIN_URL` in the pasted text to the host scry is actually exposed on — the same host as `SCRY_INGEST_URL`. A failed or non-tarball download prints a warning and exits 0, so the session still starts — without the plugin.
2. **Environment variables**: add
   ```
   CLAUDE_CODE_PLUGIN_DIRS=~/.claude-plugins/chat-logger
   SCRY_INGEST_URL=https://gagan.ngrok-free.app/ingest
   SCRY_PROJECT=<project created in scry, e.g. one per Claude account>
   SCRY_INGEST_TOKEN=<that project's token>
   ```
   Separate multiple plugin paths with `:`. Store the token as a secret. Leave `SCRY_INGEST_URL` unset to log locally only.

New sessions in that environment then load the plugin at start. To verify, ask the session to run `claude -p "ok" --output-format stream-json --verbose` and check the init event's `plugins` list for `chat-logger@inline`.

These steps are per environment. Repeat them for each environment that should log chats; no per-repo setup is needed.

## Install locally

```bash
claude --plugin-dir /path/to/hotwheels/claude-chat-logger
```

Or set `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.

## Limitations

- The local log at `~/.claude/chat-log.jsonl` is plaintext on the machine running Claude Code (only what goes to scry is encrypted).
- The local log at `~/.claude/chat-log.jsonl` is per machine, and in cloud containers it dies with the container; the scry ingest is what makes exchanges durable and searchable across sessions. If the ingest endpoint is down, those turns' lines exist only in the local file.
- `/chat-search` is substring grep over the local file, not ranked full-text search; cross-session search is the scry app.
- The paired prompt is the one submitted in the session's UI; prompts injected mid-turn by the harness are not recorded.

## Requirements

- Claude Code **v2.1.280 or later**: `CLAUDE_CODE_PLUGIN_DIRS` loading requires 2.1.280, and earlier releases don't support it even where hooks modules load. Tested on 2.1.325 (hooks module, `/chat-search`, and `CLAUDE_CODE_PLUGIN_DIRS` loading in a cloud container).
- No other dependencies: the hook shells out to `sh`, `cat`, `grep`, `tail`.
