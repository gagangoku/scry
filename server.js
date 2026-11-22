// Headless scry server (no Electron): the ingest endpoint, /plugin, and the
// search UI in a browser. This is what the Docker image runs; `npm start`
// still runs the desktop app.
//
// Environment:
//   PORT               listen port (default 9999)
//   HOST               listen address (default 0.0.0.0)
//   SCRY_DATA_DIR      where ingested sessions land (default ~/.jsonl-sessions)
// Tokens are not configured here: each project gets its own, made in the
// browser when the project is created. Sessions are end-to-end encrypted with
// it; the server only stores ciphertext and a hash of a key derived from it.
//   SCRY_USER / SCRY_PASS  when set, the UI requires basic auth
const path = require('path');
const os = require('os');
const { createIngestServer } = require('./lib/core');
const { loadBuildInfo } = require('./lib/build-info');

const env = process.env;
const DATA_DIR = env.SCRY_DATA_DIR || path.join(os.homedir(), '.jsonl-sessions');

if (!env.SCRY_USER) {
  console.warn('scry: warning: SCRY_USER is not set, anyone can create projects (sessions stay encrypted)');
}

createIngestServer({
  dataDir: DATA_DIR,
  port: Number(env.PORT || 9999),
  host: env.HOST || '0.0.0.0',
  pluginDir: path.join(__dirname, 'claude-chat-logger'),
  uiFile: path.join(__dirname, 'public', 'app.html'),
  landingFile: path.join(__dirname, 'public', 'index.html'),
  publicDir: path.join(__dirname, 'public'),
  uiUser: env.SCRY_USER || '',
  uiPass: env.SCRY_PASS || '',
  buildInfo: { ...loadBuildInfo(), app: 'server' },
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
