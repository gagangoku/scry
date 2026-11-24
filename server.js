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
//
// Accounts (Google sign-in, per-user projects and storage plans) turn on with:
//   SCRY_GOOGLE_CLIENT_ID  OAuth client id (Web application) from Google Cloud
//   SCRY_ADMIN_EMAILS      ','-separated Google emails that are admins
//   SCRY_PUBLIC_URL        e.g. https://scry.teltrix.ai (cookies, billing redirects)
//   SCRY_FREE_LIMIT_MB     Free plan storage (default 20)
// and paid plans through Stripe with STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
// STRIPE_PRICE_PRO and STRIPE_PRICE_MAX (see lib/billing.js).
const path = require('path');
const os = require('os');
const { createIngestServer, projectDirsOf } = require('./lib/core');
const { Accounts, MB } = require('./lib/accounts');
const { Billing } = require('./lib/billing');
const { loadBuildInfo } = require('./lib/build-info');

const env = process.env;
const DATA_DIR = env.SCRY_DATA_DIR || path.join(os.homedir(), '.jsonl-sessions');
const SEARCH_DIRS = [DATA_DIR, ...(env.SCRY_SEARCH_DIRS || '').split(':').filter(Boolean)];

const accounts = env.SCRY_GOOGLE_CLIENT_ID
  ? new Accounts({
    dataDir: DATA_DIR,
    googleClientId: env.SCRY_GOOGLE_CLIENT_ID,
    adminEmails: (env.SCRY_ADMIN_EMAILS || '').split(','),
    freeLimitBytes: env.SCRY_FREE_LIMIT_MB ? Number(env.SCRY_FREE_LIMIT_MB) * MB : undefined,
    projectDirsOf: (userId) => projectDirsOf(DATA_DIR, userId),
  })
  : null;
const billing = accounts && env.STRIPE_SECRET_KEY
  ? new Billing({
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    prices: Object.fromEntries(Object.keys(accounts.plans)
      .map((id) => [id, env[`STRIPE_PRICE_${id.toUpperCase()}`]])
      .filter(([, price]) => price)),
  })
  : null;

if (!env.SCRY_USER && !accounts) {
  console.warn('scry: warning: SCRY_USER is not set, the search UI is open to anyone');
}
if (env.STRIPE_SECRET_KEY && !accounts) {
  console.warn('scry: warning: STRIPE_SECRET_KEY is set but SCRY_GOOGLE_CLIENT_ID is not, so billing is off');
}

createIngestServer({
  dataDir: DATA_DIR,
  port: Number(env.PORT || 9999),
  host: env.HOST || '0.0.0.0',
  pluginDir: path.join(__dirname, 'claude-chat-logger'),
  uiFile: path.join(__dirname, 'public', 'app.html'),
  landingFile: path.join(__dirname, 'public', 'index.html'),
  publicDir: path.join(__dirname, 'public'),
  searchDirs: SEARCH_DIRS,
  uiUser: env.SCRY_USER || '',
  uiPass: env.SCRY_PASS || '',
  buildInfo: { ...loadBuildInfo(), app: 'server' },
  accounts,
  billing,
  publicUrl: env.SCRY_PUBLIC_URL || '',
}).then((server) => {
  const { address, port } = server.address();
  console.log(`scry: listening on ${address}:${port}, data in ${DATA_DIR}`);
  if (accounts) console.log(`scry: Google sign-in on, billing ${billing ? 'on' : 'off'}`);
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}).catch((err) => {
  console.error('scry:', err.message);
  process.exit(1);
});
