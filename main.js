const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const {
  createIngestServer, searchJsonl, listProjects, listSessions, readSession, projectDir, sanitizeProject,
} = require('./lib/core');

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
  // When set, /ingest requires Authorization: Bearer <token>.
  INGEST_TOKEN: process.env.SCRY_INGEST_TOKEN || '',
  // Served as a tar.gz at GET /plugin.
  PLUGIN_DIR: path.join(__dirname, 'claude-chat-logger'),
};

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.loadFile('index.html');
}

app.whenReady().then(async () => {
  await createIngestServer({
    dataDir: CONFIG.DATA_DIR,
    port: CONFIG.PORT,
    host: CONFIG.HOST,
    token: CONFIG.INGEST_TOKEN,
    pluginDir: CONFIG.PLUGIN_DIR,
  });

  // `project` null/undefined means every project; '' means legacy files with no project.
  const proj = (p) => (p === null || p === undefined ? null : sanitizeProject(p));
  ipcMain.handle('search', (_event, query, project) => {
    const p = proj(project);
    return searchJsonl({
      dirs: p === null ? CONFIG.SEARCH_DIRS : [projectDir(CONFIG.DATA_DIR, p)],
      query,
      maxResults: CONFIG.MAX_RESULTS,
      dataDir: CONFIG.DATA_DIR,
      recursive: p !== '',
    });
  });
  ipcMain.handle('projects', () => listProjects(CONFIG.DATA_DIR));
  ipcMain.handle('sessions', (_event, project) => listSessions({ dataDir: CONFIG.DATA_DIR, project: proj(project) }));
  ipcMain.handle('session', (_event, project, id) =>
    readSession({ dataDir: CONFIG.DATA_DIR, project: proj(project) || '', id })
  );
  // The token stays out of the renderer.
  ipcMain.handle('config', () => ({ ...CONFIG, INGEST_TOKEN: undefined }));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
