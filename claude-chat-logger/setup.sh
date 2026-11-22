#!/bin/bash
# Installs the chat-logger Claude Code plugin into a cloud container by
# downloading it from the scry server's /plugin endpoint. No git checkout
# needed.
#
# Use as (or call from) a Claude Code cloud environment's Setup script.
# The URL is hardcoded because setup scripts cannot read the environment's
# variables; pass SCRY_PLUGIN_URL in the script's own text to override.
#
# A failed download is a warning, not a failure: the session still starts,
# without the plugin.
#
# Pair with these environment variables (read by the plugin at runtime):
#   CLAUDE_CODE_PLUGIN_DIRS=~/.claude-plugins/chat-logger
#   SCRY_INGEST_URL=https://gagan.ngrok-free.app/ingest   (unset = local-only)
#   SCRY_PROJECT=<project created in scry; one per Claude account>
#   SCRY_INGEST_TOKEN=<that project's token, from scry>                (secret)
set -euo pipefail

URL="${SCRY_PLUGIN_URL:-https://gagan.ngrok-free.app/plugin}"
DEST="$HOME/.claude-plugins/chat-logger"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if ! curl -fsSL --max-time 30 "$URL" -o "$TMP/plugin.tgz"; then
  echo "warning: could not download the chat-logger plugin from $URL." >&2
  echo "chat-logger plugin not installed; the session starts without it." >&2
  exit 0
fi

# A catch-all web server answers 200 with HTML for any path; only a real
# tarball from scry's /plugin endpoint extracts to claude-chat-logger/.
if ! tar -xzf "$TMP/plugin.tgz" -C "$TMP" 2>/dev/null || [ ! -d "$TMP/claude-chat-logger" ]; then
  echo "warning: $URL did not answer a chat-logger tarball (is scry running and the URL routed to it?)." >&2
  echo "chat-logger plugin not installed; the session starts without it." >&2
  exit 0
fi

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -r "$TMP/claude-chat-logger" "$DEST"
echo "chat-logger installed at $DEST"
