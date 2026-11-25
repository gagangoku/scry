// End to end: the Go server (built and run here) with the desktop app's
// cloud side (lib/cloud.js) — Google sign-in through a fake OAuth endpoint,
// a project and ingest, background sync into the data dir (and deletion on
// the server), the search index, and backup/restore through a fake Drive.
// Skipped when Go is not installed.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { Cloud } = require('../lib/cloud');
const { GoogleOAuth } = require('../lib/google-oauth');
const { SearchIndex } = require('../lib/index');
const { createIngestServer } = require('../lib/core');

const ROOT = path.join(__dirname, '..');
const WEB_ID = 'web.test';
const DESKTOP_ID = 'desktop.test';

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const urlOf = (s) => `http://127.0.0.1:${s.address().port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

(async () => {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
  } catch (_) {
    console.log('cloud test skipped: Go is not installed');
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scry-cloud-'));
  const bin = path.join(tmp, 'scry-server');
  execFileSync('go', ['build', '-o', bin, '.'], { cwd: path.join(ROOT, 'server'), stdio: 'inherit' });

  // Fake Google: signing keys, and the OAuth token endpoint.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const idToken = (claims) => {
    const h = b64({ alg: 'RS256', kid: 'k1' });
    const p = b64({ iss: 'https://accounts.google.com', aud: DESKTOP_ID, exp: Math.floor(Date.now() / 1000) + 600, email_verified: true, ...claims });
    return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`;
  };
  let challenge = null;
  let refreshes = 0;
  const google = await listen((req, res) => {
    if (req.url === '/certs') {
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = new URLSearchParams(body);
      res.setHeader('content-type', 'application/json');
      if (p.get('client_id') !== DESKTOP_ID || p.get('client_secret') !== 'not-secret') {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'invalid_client' }));
        return;
      }
      if (p.get('grant_type') === 'authorization_code') {
        // PKCE: the verifier must hash to the challenge sent to the browser.
        const ok = p.get('code') === 'the-code'
          && crypto.createHash('sha256').update(p.get('code_verifier')).digest('base64url') === challenge;
        if (!ok) { res.statusCode = 400; res.end(JSON.stringify({ error: 'invalid_grant' })); return; }
        res.end(JSON.stringify({
          id_token: idToken({ sub: '42', email: 'Mac@Example.com', name: 'Mac User' }),
          access_token: 'drive-access-1', refresh_token: 'refresh-1', expires_in: 3600,
        }));
        return;
      }
      refreshes++;
      assert.strictEqual(p.get('refresh_token'), 'refresh-1');
      res.end(JSON.stringify({ access_token: `drive-access-r${refreshes}`, expires_in: 3600 }));
    });
  });

  // Fake Drive: list, resumable upload (create and update), download.
  const files = new Map(); // id -> { meta, content }
  const sessions = new Map(); // upload session -> { id, meta }
  let uploads = 0;
  const drive = await listen((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (!/^Bearer drive-access/.test(req.headers.authorization || '')) { res.statusCode = 401; res.end('{}'); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && u.pathname === '/drive/v3/files') {
        assert.strictEqual(u.searchParams.get('spaces'), 'appDataFolder');
        res.end(JSON.stringify({ files: [...files.entries()].map(([id, f]) => ({ id, name: f.meta.name, size: String(f.content.length), modifiedTime: f.modifiedTime })) }));
      } else if (req.method === 'GET' && u.pathname.startsWith('/drive/v3/files/') && u.searchParams.get('alt') === 'media') {
        res.setHeader('content-type', 'application/gzip');
        res.end(files.get(u.pathname.split('/').pop()).content);
      } else if ((req.method === 'POST' || req.method === 'PATCH') && u.pathname.startsWith('/upload/drive/v3/files')) {
        assert.strictEqual(u.searchParams.get('uploadType'), 'resumable');
        const meta = JSON.parse(body.toString());
        const id = req.method === 'POST' ? `file${files.size + 1}` : u.pathname.split('/').pop();
        if (req.method === 'POST') assert.deepStrictEqual(meta.parents, ['appDataFolder']);
        const sid = `s${sessions.size + 1}`;
        sessions.set(sid, { id, meta });
        res.setHeader('location', `${urlOf(drive)}/upload-session/${sid}`);
        res.end('{}');
      } else if (req.method === 'PUT' && u.pathname.startsWith('/upload-session/')) {
        const s = sessions.get(u.pathname.split('/').pop());
        files.set(s.id, { meta: { ...(files.get(s.id) || {}).meta, ...s.meta }, content: body, modifiedTime: new Date().toISOString() });
        uploads++;
        res.end(JSON.stringify({ id: s.id }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });

  // The Go server.
  const serverData = path.join(tmp, 'server-data');
  const port = await new Promise((resolve) => { const s = http.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const proc = spawn(bin, [], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', SCRY_DATA_DIR: serverData,
      SCRY_PUBLIC_DIR: path.join(ROOT, 'public'), SCRY_PLUGIN_DIR: path.join(ROOT, 'claude-chat-logger'),
      SCRY_GOOGLE_CLIENT_ID: WEB_ID, SCRY_GOOGLE_DESKTOP_CLIENT_ID: DESKTOP_ID,
      SCRY_GOOGLE_CERTS_URL: `${urlOf(google)}/certs`, SCRY_FREE_MB: '1',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const serverUrl = `http://127.0.0.1:${port}`;
  await until(async () => (await fetch(`${serverUrl}/healthz`).catch(() => null))?.ok, 'the server');

  // The desktop side.
  const dataDir = path.join(tmp, 'mac', 'sessions');
  const appDir = path.join(tmp, 'mac', 'app');
  const secrets = { encrypt: (s) => (s ? `enc:${Buffer.from(s).toString('base64')}` : s), decrypt: (s) => (s ? Buffer.from(s.slice(4), 'base64').toString() : s) };
  const opened = [];
  const oauth = new GoogleOAuth({
    clientId: DESKTOP_ID, clientSecret: 'not-secret', tokenUrl: `${urlOf(google)}/token`,
    // Plays the browser: Google redirects back to the app's loopback with a code.
    openUrl: async (u) => {
      const q = new URL(u).searchParams;
      assert.strictEqual(q.get('code_challenge_method'), 'S256');
      assert.match(q.get('scope'), /drive\.appdata/);
      assert.strictEqual(q.get('access_type'), 'offline');
      challenge = q.get('code_challenge');
      const back = await fetch(`${q.get('redirect_uri')}/?code=the-code&state=${q.get('state')}`);
      assert.match(await back.text(), /Signed in to Scry/);
    },
  });
  const index = new SearchIndex({ file: path.join(appDir, 'index.json'), dirs: [dataDir] });
  const driveFetch = (u, opts) => fetch(String(u).replace('https://www.googleapis.com', urlOf(drive)), opts);
  const makeCloud = () => new Cloud({
    serverUrl, dataDir, appDir, oauth, secrets, index, deviceName: 'Test Mac', syncWaitSec: 2,
    openUrl: async (u) => { if (u.startsWith('http://127.0.0.1') && u.includes('/app')) opened.push(u); else return oauth.openUrl(u); },
    fetchImpl: driveFetch,
  });
  let cloud = makeCloud();
  cloud.backup.api = urlOf(drive);

  let st = await cloud.status();
  assert.strictEqual(st.signedIn, false);
  await assert.rejects(cloud.action('create-project', { name: 'x' }), /sign in/);

  // Sign in: Google consent, then a device token from the scry server
  st = await cloud.action('signin');
  assert.strictEqual(st.signedIn, true);
  assert.strictEqual(st.account.email, 'mac@example.com');
  assert.strictEqual(st.me.allowanceBytes, 1024 * 1024);
  const saved = fs.readFileSync(path.join(appDir, 'account.json'), 'utf8');
  assert.ok(!saved.includes('scryd_') && !saved.includes('refresh-1'), 'tokens are stored encrypted');

  // A project and its token, created from the app
  const proj = await cloud.action('create-project', { name: 'work' });
  assert.match(proj.token, /^scry_/);
  assert.deepStrictEqual((await cloud.action('projects')).map((p) => p.name), ['work']);

  // Claude Code sends lines; background sync lands them on the Mac within moments
  const ingest = (lines, session = 'sess-1') => fetch(`${serverUrl}/ingest`, {
    method: 'POST',
    headers: { authorization: `Bearer ${proj.token}`, 'x-project': 'work', 'x-session-id': session },
    body: lines.join('\n') + '\n',
  });
  const l1 = JSON.stringify({ ts: '2026-01-01T00:00:00Z', kind: 'prompt', prompt: 'migrate the flamingo database' });
  const l2 = JSON.stringify({ kind: 'response', response: 'Done: flamingo tables moved.' });
  assert.strictEqual((await ingest([l1, l2])).status, 200);
  const local = path.join(dataDir, 'work', 'sess-1.jsonl');
  await until(() => fs.existsSync(local) && fs.readFileSync(local, 'utf8') === `${l1}\n${l2}\n`, 'first sync');
  // ... and the server deletes what the Mac has
  await until(async () => (await cloud.server('GET', '/me')).pendingBytes === 0, 'server spool drained');
  assert.deepStrictEqual(fs.readdirSync(path.join(serverData, 'spool', 'g_42')), []);

  // Later lines arrive through the long poll, appended in order
  const l3 = JSON.stringify({ kind: 'prompt', prompt: 'now the pelican service' });
  assert.strictEqual((await ingest([l3])).status, 200);
  await until(() => fs.readFileSync(local, 'utf8').endsWith(`${l3}\n`), 'second sync');
  assert.strictEqual(fs.readFileSync(local, 'utf8'), `${l1}\n${l2}\n${l3}\n`);

  // Search runs locally, through the index
  await index.update();
  const ui = await createIngestServer({ dataDir, port: 0, uiFile: path.join(ROOT, 'public', 'app.html'), index, cloud });
  const uiUrl = `http://127.0.0.1:${ui.address().port}`;
  let hits = await (await fetch(`${uiUrl}/search?q=PELICAN`)).json();
  assert.deepStrictEqual(hits.map((h) => [h.project, h.session, h.line]), [['work', 'sess-1', 3]]);
  hits = await (await fetch(`${uiUrl}/search?q=${encodeURIComponent('flamingo d')}`)).json();
  assert.deepStrictEqual(hits.map((h) => h.line), [1]);
  // The UI reaches the account through /cloud
  const cs = await (await fetch(`${uiUrl}/cloud/status`)).json();
  assert.strictEqual(cs.signedIn, true);
  assert.strictEqual(cs.sync.state === 'idle' || cs.sync.state === 'syncing', true);
  const bad = await fetch(`${uiUrl}/cloud/nope`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.strictEqual(bad.status, 404);

  // Backup to Drive; an unchanged scheduled backup is skipped
  let r = await (await fetch(`${uiUrl}/cloud/backup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  assert.strictEqual(r.result.files, 1);
  assert.strictEqual(uploads, 1);
  assert.strictEqual((await cloud.backup.backup()).skipped, true);
  assert.strictEqual(r.status.backup.lastFiles, 1);
  // A second session; the next backup replaces the same Drive file
  assert.strictEqual((await ingest([JSON.stringify({ kind: 'prompt', prompt: 'other' })], 'sess-2')).status, 200);
  await until(() => fs.existsSync(path.join(dataDir, 'work', 'sess-2.jsonl')), 'sess-2 synced');
  await cloud.backup.backup();
  assert.strictEqual(files.size, 1);
  assert.strictEqual(uploads, 2);
  assert.strictEqual(cloud.backup.due(), false);
  await cloud.action('settings', { backupFrequency: 'off' });
  assert.strictEqual(cloud.backup.due(), false);
  await assert.rejects(cloud.action('settings', { backupFrequency: 'hourly' }), /daily, weekly or off/);

  // Restore merges: missing files come back, a longer local copy is kept
  fs.rmSync(path.join(dataDir, 'work', 'sess-2.jsonl'));
  fs.appendFileSync(local, '{"local":"newer line"}\n');
  r = await cloud.action('restore');
  assert.deepStrictEqual([r.result.restored, r.result.kept], [1, 1]);
  assert.ok(fs.existsSync(path.join(dataDir, 'work', 'sess-2.jsonl')));
  assert.ok(fs.readFileSync(local, 'utf8').endsWith('{"local":"newer line"}\n'));

  // The app restarts: still signed in, sync resumes where it left off
  cloud.stop();
  cloud = makeCloud();
  cloud.backup.api = urlOf(drive);
  assert.strictEqual(cloud.signedIn, true);
  cloud.start();
  const l4 = JSON.stringify({ kind: 'prompt', prompt: 'after restart' });
  assert.strictEqual((await ingest([l4])).status, 200);
  await until(() => fs.readFileSync(local, 'utf8').endsWith(`${l4}\n`), 'sync after restart');
  // An expired access token is refreshed with the stored refresh token
  cloud.google = null;
  assert.match(await cloud.accessToken(), /^drive-access-r/);

  // Subscribing opens Checkout in the browser (billing is off here: a clear error)
  await assert.rejects(cloud.action('storage', { gb: 1 }), /billing is not set up/);
  await assert.rejects(cloud.action('portal'), /billing is not set up/);
  await cloud.action('open-account');
  assert.deepStrictEqual(opened, [`${serverUrl}/app`]);

  // Sign out: the device token stops working on the server
  const token = cloud.account.deviceToken;
  await cloud.action('signout');
  assert.strictEqual((await fetch(`${serverUrl}/me`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
  assert.ok(!fs.existsSync(path.join(appDir, 'account.json')));

  cloud.stop();
  for (const s of [ui, google, drive]) s.close();
  proc.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('cloud test passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
