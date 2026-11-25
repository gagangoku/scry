// Google Drive backup for the desktop app, the way WhatsApp does it: one
// archive of all synced sessions in the app's hidden appDataFolder in the
// user's own Drive (scope drive.appdata: the app sees only its own files,
// and they do not show in the user's Drive file list; they count against
// the user's Drive quota). Each backup replaces the previous archive.
//
// It runs on a schedule (daily by default, or weekly, or off), skips when
// nothing changed since the last backup, and can run on demand. Restore
// downloads the archive and merges it into the data dir: a session file is
// taken from the backup only when it is missing locally or the local copy is
// shorter (files are append-only, so the longer copy is the newer one).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const run = promisify(execFile);
const NAME = 'scry-backup.tar.gz';
const PERIODS = { daily: 24 * 3600 * 1000, weekly: 7 * 24 * 3600 * 1000 };

function jsonlFiles(dir, base = dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // .scry (local registry), temp files
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsonlFiles(full, base));
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path.relative(base, full));
  }
  return out;
}

class DriveBackup {
  // getAccessToken() answers a Drive access token (drive.appdata), or null when signed out.
  constructor({ dataDir, tmpDir, stateFile, getAccessToken, api = 'https://www.googleapis.com', fetchImpl = fetch, log = () => {} }) {
    this.dataDir = dataDir;
    this.tmpDir = tmpDir;
    this.stateFile = stateFile;
    this.getAccessToken = getAccessToken;
    this.api = api;
    this.fetch = fetchImpl;
    this.log = log;
    this.state = this.loadState();
    this.busy = null;
    this.timer = null;
  }

  loadState() {
    try {
      return { frequency: 'daily', ...JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) };
    } catch (_) {
      return { frequency: 'daily' };
    }
  }

  saveState() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  status() {
    const { frequency, lastBackupAt = null, lastBackupBytes = null, lastFiles = null, error = null } = this.state;
    return { frequency, lastBackupAt, lastBackupBytes, lastFiles, error, running: this.busy ? this.busy.kind : null };
  }

  setFrequency(f) {
    if (f !== 'off' && !PERIODS[f]) throw Object.assign(new Error('frequency is daily, weekly or off'), { status: 400 });
    this.state.frequency = f;
    this.saveState();
  }

  // Changes when any session file grows, appears or disappears.
  fingerprint() {
    let n = 0;
    let bytes = 0;
    let latest = 0;
    for (const rel of jsonlFiles(this.dataDir)) {
      try {
        const st = fs.statSync(path.join(this.dataDir, rel));
        n++;
        bytes += st.size;
        latest = Math.max(latest, st.mtimeMs);
      } catch (_) { /* vanished */ }
    }
    return { key: `${n}:${bytes}:${Math.floor(latest)}`, files: n, bytes };
  }

  async drive(method, url, { headers = {}, body, json } = {}) {
    const token = await this.getAccessToken();
    if (!token) throw Object.assign(new Error('sign in with Google to back up'), { status: 401 });
    const res = await this.fetch(url.startsWith('http') ? url : this.api + url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(json ? { 'content-type': 'application/json; charset=UTF-8' } : {}), ...headers },
      body: json ? JSON.stringify(json) : body,
      ...(body && typeof body.pipe === 'function' ? { duplex: 'half' } : {}),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const d = await res.json(); msg = (d.error && d.error.message) || msg; } catch (_) { /* none */ }
      throw Object.assign(new Error(`Google Drive: ${msg}`), { status: res.status });
    }
    return res;
  }

  // The backup file in appDataFolder, or null.
  async find() {
    const q = new URLSearchParams({
      spaces: 'appDataFolder',
      q: `name = '${NAME}' and trashed = false`,
      fields: 'files(id,name,size,modifiedTime,appProperties)',
      orderBy: 'modifiedTime desc',
    });
    const { files = [] } = await (await this.drive('GET', `/drive/v3/files?${q}`)).json();
    return files[0] || null;
  }

  exclusive(kind, fn) {
    if (this.busy) return this.busy.promise;
    const promise = fn().finally(() => { this.busy = null; });
    this.busy = { kind, promise };
    return promise;
  }

  // Archives every session file and uploads it, replacing the last backup.
  // Answers { skipped } when nothing changed (unless force).
  backup({ force = false } = {}) {
    return this.exclusive('backup', async () => {
      const fp = this.fingerprint();
      if (!force && fp.key === this.state.lastFingerprint) return { skipped: true };
      if (!fp.files) return { skipped: true, empty: true };
      fs.mkdirSync(this.tmpDir, { recursive: true });
      const archive = path.join(this.tmpDir, `backup-${Date.now()}.tar.gz`);
      try {
        // Only session files (no local registry or temp files), relative paths.
        const list = path.join(this.tmpDir, `backup-${Date.now()}.list`);
        fs.writeFileSync(list, jsonlFiles(this.dataDir).join('\n') + '\n');
        try {
          await run('tar', ['-czf', archive, '-C', this.dataDir, '-T', list]);
        } finally {
          fs.rmSync(list, { force: true });
        }
        const size = fs.statSync(archive).size;
        const existing = await this.find();
        const meta = { name: NAME, appProperties: { files: String(fp.files), bytes: String(fp.bytes), createdBy: 'scry' } };
        // Resumable upload: one session URL, then the bytes streamed from disk.
        const init = await this.drive(
          existing ? 'PATCH' : 'POST',
          existing ? `/upload/drive/v3/files/${existing.id}?uploadType=resumable` : '/upload/drive/v3/files?uploadType=resumable',
          {
            json: existing ? meta : { ...meta, parents: ['appDataFolder'] },
            headers: { 'x-upload-content-type': 'application/gzip', 'x-upload-content-length': String(size) },
          },
        );
        const location = init.headers.get('location');
        if (!location) throw new Error('Google Drive: no upload URL');
        await this.drive('PUT', location, {
          headers: { 'content-type': 'application/gzip', 'content-length': String(size) },
          body: fs.createReadStream(archive),
        });
        Object.assign(this.state, {
          lastBackupAt: new Date().toISOString(), lastBackupBytes: size, lastFiles: fp.files,
          lastFingerprint: fp.key, error: null,
        });
        this.saveState();
        return { skipped: false, bytes: size, files: fp.files };
      } catch (err) {
        this.state.error = err.message;
        this.saveState();
        throw err;
      } finally {
        fs.rmSync(archive, { force: true });
      }
    });
  }

  // Downloads the backup and merges it in; answers { restored, kept }.
  restore() {
    return this.exclusive('restore', async () => {
      const file = await this.find();
      if (!file) throw Object.assign(new Error('no backup found in your Google Drive'), { status: 404 });
      fs.mkdirSync(this.tmpDir, { recursive: true });
      const archive = path.join(this.tmpDir, `restore-${Date.now()}.tar.gz`);
      const out = path.join(this.tmpDir, `restore-${Date.now()}`);
      try {
        const res = await this.drive('GET', `/drive/v3/files/${file.id}?alt=media`);
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(archive));
        fs.mkdirSync(out, { recursive: true });
        await run('tar', ['-xzf', archive, '-C', out]);
        let restored = 0;
        let kept = 0;
        for (const rel of jsonlFiles(out)) {
          // Archive paths come from our own backups; refuse anything escaping the data dir.
          const dest = path.resolve(this.dataDir, rel);
          if (!dest.startsWith(path.resolve(this.dataDir) + path.sep)) continue;
          const src = path.join(out, rel);
          let local = -1;
          try { local = fs.statSync(dest).size; } catch (_) { /* missing */ }
          if (local >= fs.statSync(src).size) { kept++; continue; }
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
          restored++;
        }
        return { restored, kept, backupAt: file.modifiedTime };
      } finally {
        fs.rmSync(archive, { force: true });
        fs.rmSync(out, { recursive: true, force: true });
      }
    });
  }

  // Whether a scheduled backup is due: a period after the last backup, or
  // after the last check that found nothing new to back up.
  due(now = Date.now()) {
    const period = PERIODS[this.state.frequency];
    if (!period) return false;
    const last = Math.max(Date.parse(this.state.lastBackupAt || 0) || 0, Date.parse(this.state.lastCheckedAt || 0) || 0);
    return now - last >= period;
  }

  // Checks hourly (and once shortly after start) whether a backup is due.
  start({ checkEveryMs = 3600 * 1000, firstCheckMs = 60 * 1000 } = {}) {
    const tick = async () => {
      try {
        if (!this.due() || !(await this.getAccessToken())) return;
        const r = await this.backup();
        if (r.skipped) {
          this.state.lastCheckedAt = new Date().toISOString();
          this.saveState();
        } else {
          this.log(`backed up ${r.files} sessions (${r.bytes} bytes) to Google Drive`);
        }
      } catch (err) {
        this.log(`backup failed: ${err.message}`);
      }
    };
    this.stop();
    const loop = async () => {
      await tick();
      if (this.timer !== null) this.timer = setTimeout(loop, checkEveryMs);
    };
    this.timer = setTimeout(loop, firstCheckMs);
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }
}

module.exports = { DriveBackup, BACKUP_NAME: NAME };
