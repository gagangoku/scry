const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createIngestServer, searchJsonl } = require('../lib/core');

function post(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/ingest', method: 'POST', headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(data) }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-logger-'));
  const dataDir = path.join(tmp, 'sessions');
  const claudeDir = path.join(tmp, 'claude-projects', 'proj-a');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'old.jsonl'), '{"msg":"hello from claude projects"}\n');

  const server = await createIngestServer({ dataDir, port: 0 });
  const port = server.address().port;

  // Session id from header
  let res = await post(port, '{"msg":"alpha one"}\n{"msg":"alpha two"}\n', { 'x-session-id': 's1' });
  assert.strictEqual(res.appended, 2);

  // Session id from the line itself
  res = await post(port, '{"sessionId":"s2","msg":"beta"}\n');
  assert.strictEqual(res.appended, 1);

  // Appending again to the same session
  res = await post(port, '{"msg":"alpha three"}\n', { 'x-session-id': 's1' });
  assert.strictEqual(res.appended, 1);

  const s1 = fs.readFileSync(path.join(dataDir, 's1.jsonl'), 'utf8');
  assert.strictEqual(s1.trim().split('\n').length, 3);
  assert.ok(fs.existsSync(path.join(dataDir, 's2.jsonl')));

  // Search across both the ingest dir and the claude projects dir
  let hits = await searchJsonl({ dirs: [dataDir, path.join(tmp, 'claude-projects')], query: 'alpha' });
  assert.strictEqual(hits.length, 3);

  hits = await searchJsonl({ dirs: [dataDir, path.join(tmp, 'claude-projects')], query: 'claude projects' });
  assert.strictEqual(hits.length, 1);
  assert.ok(hits[0].file.endsWith('old.jsonl'));

  // GET /plugin answers a tar.gz of pluginDir
  const pluginDir = path.join(tmp, 'fake-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'marker.txt'), 'plugin payload\n');
  const pluginServer = await createIngestServer({ dataDir, port: 0, pluginDir });
  const pluginPort = pluginServer.address().port;
  const tgz = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: pluginPort, path: '/plugin' }, (res) => {
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'application/gzip');
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
  const extractDir = path.join(tmp, 'extracted');
  fs.mkdirSync(extractDir, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'plugin.tgz'), tgz);
  const { execFileSync } = require('child_process');
  execFileSync('tar', ['-xzf', path.join(tmp, 'plugin.tgz'), '-C', extractDir]);
  assert.strictEqual(
    fs.readFileSync(path.join(extractDir, 'fake-plugin', 'marker.txt'), 'utf8'),
    'plugin payload\n'
  );
  pluginServer.close();

  // Bearer token auth
  const authDir = path.join(tmp, 'auth-sessions');
  const authServer = await createIngestServer({ dataDir: authDir, port: 0, token: 'sekret' });
  const authPort = authServer.address().port;

  res = await post(authPort, '{"msg":"locked"}\n', { 'x-session-id': 's3' });
  assert.strictEqual(res.status, 401);

  res = await post(authPort, '{"msg":"locked"}\n', { 'x-session-id': 's3', authorization: 'Bearer wrong' });
  assert.strictEqual(res.status, 401);
  assert.ok(!fs.existsSync(path.join(authDir, 's3.jsonl')));

  res = await post(authPort, '{"msg":"unlocked"}\n', { 'x-session-id': 's3', authorization: 'Bearer sekret' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.appended, 1);
  assert.ok(fs.existsSync(path.join(authDir, 's3.jsonl')));

  authServer.close();

  // Web UI, /search, /healthz and basic auth
  const uiFile = path.join(tmp, 'ui.html');
  fs.writeFileSync(uiFile, '<p>scry ui</p>');
  const uiServer = await createIngestServer({
    dataDir, port: 0, uiFile, searchDirs: [dataDir], uiUser: 'u', uiPass: 'p',
  });
  const uiPort = uiServer.address().port;
  const get = (p, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: uiPort, path: p, headers }, (r) => {
      let data = '';
      r.on('data', (c) => (data += c));
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, data }));
    }).on('error', reject);
  });
  const basic = (u, p) => ({ authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') });

  assert.strictEqual((await get('/healthz')).status, 200);
  let r = await get('/');
  assert.strictEqual(r.status, 401);
  assert.match(r.headers['www-authenticate'], /^Basic/);
  assert.strictEqual((await get('/search?q=alpha', basic('u', 'wrong'))).status, 401);
  r = await get('/', basic('u', 'p'));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data, '<p>scry ui</p>');
  r = await get('/search?q=alpha', basic('u', 'p'));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(JSON.parse(r.data).length, 3);
  uiServer.close();

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('smoke test passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
