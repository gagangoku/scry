// Background sync for the desktop app: drains the user's spool on the scry
// server into local session files, <dataDir>/<project>/<session>.jsonl.
//
// Loop: POST /sync/pull?wait=25 (the server holds the request until new lines
// arrive, so sync is near real time without busy polling), GET each segment,
// append its lines locally, record the segment as applied, then POST
// /sync/ack so the server deletes it. A segment applied but not yet acked
// (the app quit in between) is downloaded again and skipped by id, so lines
// are never appended twice. Errors back off from 5s up to 5 minutes.
const fs = require('fs');
const path = require('path');

function sanitizeName(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 128);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class SyncClient {
  // getToken() answers the device token (Authorization: Bearer scryd_...), or
  // null when signed out. onApplied({ lines, files }) runs after new lines land.
  constructor({ serverUrl, dataDir, stateFile, getToken, onApplied = () => {}, onStatus = () => {}, waitSec = 25, fetchImpl = fetch, log = () => {} }) {
    this.serverUrl = serverUrl.replace(/\/+$/, '');
    this.dataDir = dataDir;
    this.stateFile = stateFile;
    this.getToken = getToken;
    this.onApplied = onApplied;
    this.onStatus = onStatus;
    this.waitSec = waitSec;
    this.fetch = fetchImpl;
    this.log = log;
    this.state = this.loadState();
    this.status = { state: 'idle', lastSyncAt: this.state.lastSyncAt || null, error: null, me: null };
    this.running = false;
    this.abort = null;
    this.timer = null;
    this.backoff = 0;
  }

  loadState() {
    try {
      return { lastApplied: 0, ...JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) };
    } catch (_) {
      return { lastApplied: 0 };
    }
  }

  saveState() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.stateFile);
  }

  // Forget progress (another account signed in: its segment ids start over).
  resetState() {
    this.state = { lastApplied: 0 };
    this.saveState();
  }

  setStatus(patch) {
    Object.assign(this.status, patch);
    this.onStatus(this.status);
  }

  async api(method, p, body, signal) {
    const token = await this.getToken();
    if (!token) throw new HttpError(401, 'signed out');
    const res = await this.fetch(this.serverUrl + p, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch (_) { /* no body */ }
      throw new HttpError(res.status, msg);
    }
    return res;
  }

  // Appends one segment's records; answers the number of lines and the files touched.
  applySegment(text) {
    const byFile = new Map();
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      let rec;
      try { rec = JSON.parse(raw); } catch (_) { continue; }
      if (!rec || typeof rec.line !== 'string') continue;
      const project = sanitizeName(rec.project || '');
      if (!project) continue;
      const file = path.join(this.dataDir, project, (sanitizeName(rec.session || '') || 'default') + '.jsonl');
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push(rec.line);
    }
    let lines = 0;
    for (const [file, list] of byFile) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(file, 'a');
      try {
        fs.writeSync(fd, list.join('\n') + '\n');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      lines += list.length;
    }
    return { lines, files: [...byFile.keys()] };
  }

  // One round: pull (long-polling up to `wait` seconds), apply, ack.
  async syncOnce({ wait = 0, signal } = {}) {
    const res = await this.api('POST', `/sync/pull${wait ? `?wait=${wait}` : ''}`, {}, signal);
    const { segments, me } = await res.json();
    let lines = 0;
    const files = new Set();
    const ack = [];
    for (const seg of segments) {
      if (seg.id > this.state.lastApplied) {
        const text = await (await this.api('GET', `/sync/segment?id=${seg.id}`, null, signal)).text();
        const r = this.applySegment(text);
        lines += r.lines;
        r.files.forEach((f) => files.add(f));
        this.state.lastApplied = seg.id;
        this.saveState();
      }
      ack.push(seg.id);
    }
    if (ack.length) await this.api('POST', '/sync/ack', { ids: ack }, signal);
    this.state.lastSyncAt = new Date().toISOString();
    this.saveState();
    this.setStatus({ state: 'idle', lastSyncAt: this.state.lastSyncAt, error: null, me: me || this.status.me });
    if (lines) await this.onApplied({ lines, files: [...files] });
    return { lines, segments: ack.length };
  }

  // Runs the loop until stop(). Safe to call repeatedly.
  start() {
    if (this.running) return;
    this.running = true;
    this.loop();
  }

  stop() {
    this.running = false;
    if (this.abort) this.abort.abort();
    clearTimeout(this.timer);
  }

  // Interrupts a long poll so the next round starts now (Sync now).
  async syncNow() {
    if (this.abort) this.abort.abort();
    if (!this.running) return this.syncOnce();
    return null;
  }

  async loop() {
    while (this.running) {
      this.abort = new AbortController();
      try {
        this.setStatus({ state: 'syncing' });
        // First round returns at once (catch up); later ones long-poll.
        await this.syncOnce({ wait: this.backoff === 0 && this.status.lastSyncAt ? this.waitSec : 0, signal: this.abort.signal });
        this.backoff = 0;
      } catch (err) {
        if (!this.running) break;
        if (err.name === 'AbortError') continue; // Sync now
        if (err.status === 401) {
          this.setStatus({ state: 'signed-out', error: null });
          this.running = false;
          break;
        }
        this.backoff = Math.min(this.backoff ? this.backoff * 2 : 5000, 5 * 60 * 1000);
        this.setStatus({ state: 'error', error: err.message });
        this.log(`sync failed, retrying in ${this.backoff / 1000}s: ${err.message}`);
        await new Promise((r) => { this.timer = setTimeout(r, this.backoff); });
      } finally {
        this.abort = null;
      }
    }
  }
}

module.exports = { SyncClient, HttpError, sanitizeName };
