// Google sign-in for the desktop app: OAuth 2.0 for installed apps, with a
// loopback redirect (http://127.0.0.1:<random port>) and PKCE.
// https://developers.google.com/identity/protocols/oauth2/native-app
//
// One consent covers both uses: the ID token signs the app in to the scry
// server, and the refresh token (scope drive.appdata: only the app's own
// hidden folder in the user's Drive, like WhatsApp's backups) lets it back up.
const http = require('http');
const crypto = require('crypto');

const SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive.appdata'];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const b64url = (buf) => buf.toString('base64url');

const PAGE = (title, text) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:15px -apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:90vh;background:#0f1115;color:#e6e8ee">
<div style="text-align:center"><h2>${title}</h2><p style="color:#8a91a3">${text}</p></div>`;

class GoogleOAuth {
  // openUrl(url) opens the system browser (shell.openExternal in Electron).
  constructor({ clientId, clientSecret, openUrl, authUrl = AUTH_URL, tokenUrl = TOKEN_URL, fetchImpl = fetch, timeoutMs = 5 * 60 * 1000 }) {
    this.clientId = clientId;
    // Google issues "Desktop app" clients a secret that is not confidential
    // (it ships inside the app); PKCE is what protects the code.
    this.clientSecret = clientSecret;
    this.openUrl = openUrl;
    this.authUrl = authUrl;
    this.tokenUrl = tokenUrl;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  get configured() {
    return Boolean(this.clientId);
  }

  // Runs the browser flow; answers { idToken, accessToken, refreshToken, expiresAt }.
  async signIn() {
    if (!this.configured) throw new Error('Google sign-in is not configured in this build');
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));

    const { code, redirectUri } = await new Promise((resolve, reject) => {
      let timer;
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname !== '/') { res.writeHead(404); res.end(); return; }
        const done = (err, value) => {
          clearTimeout(timer);
          server.close();
          if (err) reject(err); else resolve(value);
        };
        if (url.searchParams.get('state') !== state) {
          res.writeHead(400, { 'content-type': 'text/html' });
          res.end(PAGE('Sign-in failed', 'The response did not match this sign-in. Try again from Scry.'));
          done(new Error('OAuth state mismatch'));
          return;
        }
        if (url.searchParams.get('error')) {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(PAGE('Sign-in cancelled', 'You can close this tab and return to Scry.'));
          done(new Error(`Google sign-in: ${url.searchParams.get('error')}`));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(PAGE('Signed in to Scry', 'You can close this tab and return to the app.'));
        done(null, { code: url.searchParams.get('code'), redirectUri: `http://127.0.0.1:${server.address().port}` });
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const redirect = `http://127.0.0.1:${server.address().port}`;
        const q = new URLSearchParams({
          client_id: this.clientId,
          redirect_uri: redirect,
          response_type: 'code',
          scope: SCOPES.join(' '),
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
          access_type: 'offline',
          prompt: 'consent',
        });
        timer = setTimeout(() => { server.close(); reject(new Error('Google sign-in timed out')); }, this.timeoutMs);
        Promise.resolve(this.openUrl(`${this.authUrl}?${q}`)).catch(reject);
      });
    });

    const t = await this.token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    if (!t.id_token) throw new Error('Google did not return an ID token');
    if (!t.refresh_token) throw new Error('Google did not return a refresh token');
    return {
      idToken: t.id_token,
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: Date.now() + (t.expires_in || 3600) * 1000,
    };
  }

  // A fresh access token from a refresh token: { accessToken, expiresAt }.
  async refresh(refreshToken) {
    const t = await this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
    return { accessToken: t.access_token, expiresAt: Date.now() + (t.expires_in || 3600) * 1000 };
  }

  async token(params) {
    const body = new URLSearchParams({ client_id: this.clientId, ...(this.clientSecret ? { client_secret: this.clientSecret } : {}), ...params });
    const res = await this.fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`Google token request failed: ${data.error_description || data.error || res.status}`);
      err.status = res.status;
      err.code = data.error;
      throw err;
    }
    return data;
  }
}

module.exports = { GoogleOAuth, SCOPES };
