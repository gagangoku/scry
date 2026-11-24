// The desktop app's cloud side: the signed-in account, background sync from
// the scry server, Google Drive backups, and keeping the search index fresh.
// main.js creates one Cloud and hands it to the local server (lib/core.js),
// which exposes it to the UI as GET /cloud/status and POST /cloud/<action>.
//
// Account details live in <appDir>/account.json; the device token (for the
// scry server) and the Google refresh token (for Drive) are encrypted with
// `secrets` (Electron safeStorage, i.e. the macOS Keychain).
const fs = require('fs');
const path = require('path');
const { SyncClient } = require('./sync');
const { DriveBackup } = require('./backup');

class Cloud {
  constructor({
    serverUrl, dataDir, appDir, oauth, openUrl, secrets, deviceName, index = null,
    fetchImpl = fetch, log = () => {}, syncWaitSec = 25, onSignIn = () => {},
  }) {
    this.onSignIn = onSignIn;
    this.serverUrl = serverUrl.replace(/\/+$/, '');
    this.dataDir = dataDir;
    this.appDir = appDir;
    this.oauth = oauth;
    this.openUrl = openUrl;
    this.secrets = secrets;
    this.deviceName = deviceName;
    this.index = index;
    this.fetch = fetchImpl;
    this.log = log;
    this.accountFile = path.join(appDir, 'account.json');
    this.account = this.loadAccount();
    this.google = null; // { accessToken, expiresAt }
    this.me = null;
    this.meAt = 0;
    this.sync = new SyncClient({
      serverUrl: this.serverUrl,
      dataDir,
      stateFile: path.join(appDir, 'sync.json'),
      getToken: () => (this.account ? this.account.deviceToken : null),
      onApplied: async () => { if (this.index) await this.index.update(); },
      onStatus: (s) => {
        if (s.me) { this.me = s.me; this.meAt = Date.now(); }
        if (s.state === 'signed-out' && this.account) {
          this.log('the server no longer accepts this device: sign in again');
          this.account.needsSignIn = true;
        }
      },
      waitSec: syncWaitSec,
      fetchImpl,
      log,
    });
    this.backup = new DriveBackup({
      dataDir,
      tmpDir: path.join(appDir, 'tmp'),
      stateFile: path.join(appDir, 'backup.json'),
      getAccessToken: () => this.accessToken(),
      fetchImpl,
      log,
    });
  }

  loadAccount() {
    try {
      const a = JSON.parse(fs.readFileSync(this.accountFile, 'utf8'));
      return { ...a, deviceToken: this.secrets.decrypt(a.deviceToken), refreshToken: this.secrets.decrypt(a.refreshToken) };
    } catch (_) {
      return null;
    }
  }

  saveAccount() {
    fs.mkdirSync(this.appDir, { recursive: true });
    if (!this.account) {
      fs.rmSync(this.accountFile, { force: true });
      return;
    }
    const a = this.account;
    fs.writeFileSync(this.accountFile, JSON.stringify({
      userId: a.userId, email: a.email, name: a.name, picture: a.picture, signedInAt: a.signedInAt,
      deviceToken: this.secrets.encrypt(a.deviceToken), refreshToken: this.secrets.encrypt(a.refreshToken),
    }, null, 2), { mode: 0o600 });
  }

  get signedIn() {
    return Boolean(this.account && this.account.deviceToken && !this.account.needsSignIn);
  }

  start() {
    if (!this.signedIn) return;
    this.sync.start();
    this.backup.start();
  }

  stop() {
    this.sync.stop();
    this.backup.stop();
  }

  async server(method, p, body) {
    const res = await this.fetch(this.serverUrl + p, {
      method,
      headers: {
        ...(this.account ? { authorization: `Bearer ${this.account.deviceToken}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status === 401 ? 401 : 502 });
    return data;
  }

  // A Drive access token, refreshed when it is about to expire.
  async accessToken() {
    if (!this.account || !this.account.refreshToken) return null;
    if (this.google && this.google.expiresAt > Date.now() + 60 * 1000) return this.google.accessToken;
    try {
      this.google = await this.oauth.refresh(this.account.refreshToken);
    } catch (err) {
      if (err.code === 'invalid_grant') {
        // Revoked or expired: the user has to sign in again for backups.
        this.account.needsSignIn = true;
      }
      throw err;
    }
    return this.google.accessToken;
  }

  async signIn() {
    const g = await this.oauth.signIn();
    const r = await this.server('POST', '/auth/google', { credential: g.idToken, device: this.deviceName });
    if (!r.deviceToken) throw new Error('the server did not issue a device token');
    const switched = this.account && this.account.userId && this.account.userId !== r.id;
    this.stop();
    if (switched || !this.account) this.sync.resetState();
    this.account = {
      userId: r.id, email: r.email, name: r.name, picture: r.picture, signedInAt: new Date().toISOString(),
      deviceToken: r.deviceToken, refreshToken: g.refreshToken,
    };
    this.google = { accessToken: g.accessToken, expiresAt: g.expiresAt };
    delete r.deviceToken;
    this.me = r;
    this.meAt = Date.now();
    this.saveAccount();
    this.start();
    this.onSignIn();
    return this.status();
  }

  async signOut() {
    this.stop();
    if (this.account) {
      try { await this.server('POST', '/auth/logout', {}); } catch (_) { /* offline: forget locally anyway */ }
    }
    this.account = null;
    this.google = null;
    this.me = null;
    this.saveAccount();
    return this.status();
  }

  async status() {
    if (this.signedIn && Date.now() - this.meAt > 30 * 1000) {
      try { this.me = await this.server('GET', '/me'); this.meAt = Date.now(); } catch (_) { /* offline: keep the last */ }
    }
    return {
      configured: this.oauth.configured,
      serverUrl: this.serverUrl,
      signedIn: this.signedIn,
      needsSignIn: Boolean(this.account && this.account.needsSignIn),
      account: this.account ? { email: this.account.email, name: this.account.name, picture: this.account.picture } : null,
      me: this.signedIn ? this.me : null,
      sync: { state: this.sync.status.state, lastSyncAt: this.sync.status.lastSyncAt, error: this.sync.status.error },
      backup: this.backup.status(),
    };
  }

  requireSignIn() {
    if (!this.signedIn) throw Object.assign(new Error('sign in to Scry first'), { status: 401 });
  }

  // POST /cloud/<name> from the UI.
  async action(name, body = {}) {
    switch (name) {
      case 'signin': return this.signIn();
      case 'signout': return this.signOut();
      case 'sync':
        this.requireSignIn();
        if (this.sync.running) await this.sync.syncNow();
        else await this.sync.syncOnce();
        return this.status();
      case 'backup':
        this.requireSignIn();
        return { result: await this.backup.backup({ force: true }), status: await this.status() };
      case 'restore': {
        this.requireSignIn();
        const result = await this.backup.restore();
        if (this.index) await this.index.update();
        return { result, status: await this.status() };
      }
      case 'settings':
        if (body.backupFrequency) this.backup.setFrequency(String(body.backupFrequency));
        return this.status();
      case 'projects':
        this.requireSignIn();
        return this.server('GET', '/projects');
      case 'create-project':
        this.requireSignIn();
        return this.server('POST', '/projects', { name: String(body.name || '') });
      case 'token':
        this.requireSignIn();
        return this.server('POST', '/projects/token', { name: String(body.name || '') });
      case 'checkout': {
        this.requireSignIn();
        const { url } = await this.server('POST', '/billing/checkout', { gb: Number(body.gb) || 1 });
        await this.openUrl(url);
        return { url };
      }
      case 'open-account':
        await this.openUrl(`${this.serverUrl}/app`);
        return {};
      default:
        throw Object.assign(new Error(`unknown action ${name}`), { status: 404 });
    }
  }
}

module.exports = { Cloud };
