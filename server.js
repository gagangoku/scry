// Headless scry server (no Electron): the ingest endpoint, /plugin, and the
// search UI in a browser. This is what the Docker image runs; `npm start`
// still runs the desktop app.
//
// Environment:
//   PORT               listen port (default 9999)
//   HOST               listen address (default 0.0.0.0)
//   SCRY_DATA_DIR      where ingested sessions land (default ~/.jsonl-sessions)
//   SCRY_SEARCH_DIRS   extra dirs to search, ':'-separated (the data dir is always searched)
// Ingest tokens are not configured here: each project gets its own, created
// in the UI and stored (hashed) in the data dir.
//   SCRY_USER / SCRY_PASS  when set, the UI and /search require basic auth
const path = require('path');
const os = require('os');
const { createIngestServer } = require('./lib/core');

const env = process.env;
const DATA_DIR = env.SCRY_DATA_DIR || path.join(os.homedir(), '.jsonl-sessions');
const SEARCH_DIRS = [DATA_DIR, ...(env.SCRY_SEARCH_DIRS || '').split(':').filter(Boolean)];

if (!env.SCRY_USER) {
  console.warn('scry: warning: SCRY_USER is not set, the search UI is open to anyone');
}

createIngestServer({
  dataDir: DATA_DIR,
  port: Number(env.PORT || 9999),
  host: env.HOST || '0.0.0.0',
  pluginDir: path.join(__dirname, 'claude-chat-logger'),
  uiFile: path.join(__dirname, 'index.html'),
  searchDirs: SEARCH_DIRS,
  uiUser: env.SCRY_USER || '',
  uiPass: env.SCRY_PASS || '',
}).then((server) => {
  const { address, port } = server.address();
  console.log(`scry: listening on ${address}:${port}, data in ${DATA_DIR}`);
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}).catch((err) => {
  console.error('scry:', err.message);
  process.exit(1);
});
