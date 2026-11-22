const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const os = require('os');
const { createIngestServer } = require('./lib/core');

// All configuration lives here.
const CONFIG = {
  PORT: 9999,
  HOST: '127.0.0.1',
  DATA_DIR: path.join(os.homedir(), '.jsonl-sessions'),
  SEARCH_DIRS: [
    path.join(os.homedir(), '.jsonl-sessions'),
    path.join(os.homedir(), '.claude', 'projects'),
  ],
  MAX_RESULTS: 200,
  // Served as a tar.gz at GET /plugin.
  PLUGIN_DIR: path.join(__dirname, 'claude-chat-logger'),
};

// The window is a browser on the app's own server, so the desktop app and the
// headless server (server.js) run the same UI and the same API: everything in
// one is in the other, and http://127.0.0.1:9999/ works in any browser while
// the app runs. The server listens on localhost only, without basic auth.
const UI_URL = `http://${CONFIG.HOST}:${CONFIG.PORT}/`;

function createWindow() {
  const win = new BrowserWindow({ width: 1200, height: 800 });
  win.loadURL(UI_URL);
}

app.whenReady().then(async () => {
  try {
    await createIngestServer({
      dataDir: CONFIG.DATA_DIR,
      port: CONFIG.PORT,
      host: CONFIG.HOST,
      pluginDir: CONFIG.PLUGIN_DIR,
      uiFile: path.join(__dirname, 'index.html'),
      searchDirs: CONFIG.SEARCH_DIRS,
      maxResults: CONFIG.MAX_RESULTS,
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
