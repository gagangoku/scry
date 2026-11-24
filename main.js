const { app, BrowserWindow, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const os = require('os');
const { createIngestServer } = require('./lib/core');
const { loadBuildInfo } = require('./lib/build-info');
const { SearchIndex } = require('./lib/index');
const { GoogleOAuth } = require('./lib/google-oauth');
const { Cloud } = require('./lib/cloud');

const BUILD_INFO = {
  ...loadBuildInfo(),
  app: 'mac',
  arch: process.arch,
  electron: process.versions.electron,
};

// All configuration lives here.
const CONFIG = {
  PORT: 9999,
  HOST: '127.0.0.1',
  DATA_DIR: path.join(os.homedir(), '.jsonl-sessions'),
  SEARCH_DIRS: [path.join(os.homedir(), '.jsonl-sessions')],
  // Read-only projects over local Claude Code transcripts: listed, opened and
  // searched like ingested projects, but nothing is ingested into them.
  LOCAL_PROJECTS: {
    'claude-code-local': path.join(os.homedir(), '.claude', 'projects'),
  },
  MAX_RESULTS: 200,
  // Served as a tar.gz at GET /plugin.
  PLUGIN_DIR: path.join(__dirname, 'claude-chat-logger'),
  // The scry server this app syncs from, and the Google OAuth client
  // ("Desktop app" type) used to sign in and back up to Drive. CI stamps the
  // client into build-info.json from repository secrets; env overrides for dev.
  SERVER_URL: process.env.SCRY_SERVER_URL || BUILD_INFO.serverUrl || 'https://scry.teltrix.ai',
  GOOGLE_CLIENT_ID: process.env.SCRY_GOOGLE_DESKTOP_CLIENT_ID || BUILD_INFO.googleClientId || '',
  GOOGLE_CLIENT_SECRET: process.env.SCRY_GOOGLE_DESKTOP_CLIENT_SECRET || BUILD_INFO.googleClientSecret || '',
};

// Device and Google tokens are encrypted with the macOS Keychain-backed
// safeStorage; where it is unavailable (unsigned dev builds on Linux) they
// are stored as-is, marked so.
const secrets = {
  encrypt: (s) => {
    if (!s) return s;
    return safeStorage.isEncryptionAvailable()
      ? 'safe:' + safeStorage.encryptString(s).toString('base64')
      : 'plain:' + s;
  },
  decrypt: (s) => {
    if (!s) return s;
    if (s.startsWith('safe:')) return safeStorage.decryptString(Buffer.from(s.slice(5), 'base64'));
    if (s.startsWith('plain:')) return s.slice(6);
    return null;
  },
};

let cloud = null;
let index = null;

// The window is a browser on the app's own local server (lib/core.js), so
// http://127.0.0.1:9999/app works in any browser while the app runs. It
// listens on localhost only, without basic auth. The hosted scry server
// (server/, Go) is separate: the app syncs from it.
const UI_URL = `http://${CONFIG.HOST}:${CONFIG.PORT}/app`;

function createWindow() {
  const win = new BrowserWindow({ width: 1200, height: 800 });
  // Links that open a new window (Open in Claude, links in messages) go to the
  // default browser, where the user is signed in to claude.ai.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL(UI_URL);
}

app.whenReady().then(async () => {
  const short = BUILD_INFO.commit ? BUILD_INFO.commit.slice(0, 7) : 'local';
  app.setAboutPanelOptions({
    applicationName: 'Scry',
    applicationVersion: BUILD_INFO.version,
    version: `build ${BUILD_INFO.build} · ${short} · ${BUILD_INFO.arch}`,
    credits: BUILD_INFO.builtAt ? `Built ${BUILD_INFO.builtAt}` : 'Development build',
  });
  const appDir = app.getPath('userData');
  // The search index covers synced sessions and Claude Code's own transcripts.
  index = new SearchIndex({
    file: path.join(appDir, 'search-index.json'),
    dirs: [CONFIG.DATA_DIR, ...Object.values(CONFIG.LOCAL_PROJECTS)],
  });
  cloud = new Cloud({
    serverUrl: CONFIG.SERVER_URL,
    dataDir: CONFIG.DATA_DIR,
    appDir,
    secrets,
    index,
    deviceName: os.hostname().replace(/\.local$/, ''),
    openUrl: (url) => shell.openExternal(url),
    oauth: new GoogleOAuth({
      clientId: CONFIG.GOOGLE_CLIENT_ID,
      clientSecret: CONFIG.GOOGLE_CLIENT_SECRET,
      openUrl: (url) => shell.openExternal(url),
    }),
    log: (msg) => console.log(`scry: ${msg}`),
    // Keep syncing after login, in the background.
    onSignIn: () => { if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true }); },
  });
  try {
    await createIngestServer({
      dataDir: CONFIG.DATA_DIR,
      port: CONFIG.PORT,
      host: CONFIG.HOST,
      pluginDir: CONFIG.PLUGIN_DIR,
      uiFile: path.join(__dirname, 'public', 'app.html'),
      publicDir: path.join(__dirname, 'public'),
      searchDirs: CONFIG.SEARCH_DIRS,
      localProjects: CONFIG.LOCAL_PROJECTS,
      maxResults: CONFIG.MAX_RESULTS,
      buildInfo: BUILD_INFO,
      index,
      cloud,
    });
  } catch (err) {
    dialog.showErrorBox(
      'Scry could not start',
      err.code === 'EADDRINUSE'
        ? `Port ${CONFIG.PORT} is already in use (is Scry already running?).`
        : err.message
    );
    app.quit();
    return;
  }

  createWindow();

  // Sync in the background from launch, and index what is already on disk.
  cloud.start();
  index.update().catch((err) => console.error('scry: indexing failed:', err.message));
  // Claude Code keeps writing ~/.claude/projects: keep the index current.
  setInterval(() => index.update().catch(() => {}), 60 * 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// On macOS the app keeps running (and syncing) with every window closed;
// clicking the Dock icon reopens the window.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (cloud) cloud.stop();
  try { if (index) index.save(); } catch (_) { /* best effort */ }
});
