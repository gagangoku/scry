const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const { createIngestServer } = require('./lib/core');
const { loadBuildInfo } = require('./lib/build-info');

const BUILD_INFO = {
  ...loadBuildInfo(),
  app: 'mac',
  arch: process.arch,
  electron: process.versions.electron,
};

// All configuration lives here.
const CONFIG = {
  PORT: 9999,
  // Every network address, so Claude running elsewhere (e.g. a cloud session)
  // can reach /ingest at this machine's public IP.
  HOST: '0.0.0.0',
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
};

// The window is a browser on the app's own server, so the desktop app and the
// headless server (server.js) run the same UI and the same API: everything in
// one is in the other, and http://127.0.0.1:9999/app works in any browser while
// the app runs. The server listens on every network address, without basic
// auth: /ingest needs a project's bearer token, but the UI routes are open to
// anyone who can reach the port. The window itself always uses loopback.
const UI_URL = `http://127.0.0.1:${CONFIG.PORT}/app`;

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
    });
  } catch (err) {
    dialog.showErrorBox(
      'Scry could not start',
      err.code === 'EADDRINUSE'
        ? `Port ${CONFIG.PORT} is already in use (is scry, or npm run serve, already running?).`
        : err.message
    );
    app.quit();
    return;
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
