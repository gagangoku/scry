const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const {
  createIngestServer, listProjects, listSessions, readSession,
  createProject, rotateProjectToken, projectForAuthKey, projectInfo, wrappedKeyFor,
} = require('../lib/core');
const sc = require('../lib/crypto');

function request(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch (_) { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, data, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
const post = async (port, body, headers) => {
  const r = await request(port, 'POST', '/ingest', body, headers);
  return { status: r.status, ...r.json };
};
// Every byte under dir, so tests can check no plaintext reached the disk.
const allBytes = (dir) => fs.readdirSync(dir, { recursive: true })
  .map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile())
  .map((f) => fs.readFileSync(f, 'utf8')).join('\n');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-logger-'));
  const dataDir = path.join(tmp, 'sessions');

  // ---------- crypto ----------
  const work = sc.newProjectKeys('work');
  const personal = sc.newProjectKeys('personal');
  assert.match(work.token, /^scry_/);
  assert.strictEqual(sc.authKeyFor(work.token), work.authKey);
  assert.ok(sc.unwrapKey(work.token, 'work', work.wrappedKey).equals(work.dataKey));
  // The wrapped key is bound to its project, and only the token unwraps it
  assert.throws(() => sc.unwrapKey(work.token, 'personal', work.wrappedKey));
  assert.throws(() => sc.unwrapKey(personal.token, 'work', work.wrappedKey));
  const encLine = sc.encryptLine(work.dataKey, 'work', '{"msg":"secret"}');
  assert.ok(!encLine.includes('secret'));
  assert.strictEqual(sc.decryptLine(work.dataKey, 'work', encLine), '{"msg":"secret"}');
  assert.throws(() => sc.decryptLine(work.dataKey, 'personal', encLine));
  assert.throws(() => sc.decryptLine(personal.dataKey, 'work', encLine));
  assert.strictEqual(sc.parseEnvelope('{"msg":"plain"}'), null);

  const server = await createIngestServer({ dataDir, port: 0 });
  const port = server.address().port;

  // No key, or an unknown one: 401, nothing written
  let res = await post(port, encLine + '\n', { 'x-session-id': 's0' });
  assert.strictEqual(res.status, 401);
  res = await post(port, encLine + '\n', { 'x-session-id': 's0', authorization: 'Bearer nope' });
  assert.strictEqual(res.status, 401);
  assert.deepStrictEqual(fs.readdirSync(dataDir), []);

  // ---------- projects ----------
  createProject(dataDir, 'work', work);
  createProject(dataDir, 'personal', personal);
  assert.throws(() => createProject(dataDir, 'work', work), (e) => e.status === 409);
  assert.throws(() => createProject(dataDir, '../x', work), (e) => e.status === 400);
  assert.throws(() => createProject(dataDir, '.scry', work), (e) => e.status === 400);
  assert.throws(() => createProject(dataDir, 'nokeys', {}), (e) => e.status === 400);
  assert.throws(() => rotateProjectToken(dataDir, 'ghost', work), (e) => e.status === 404);
  assert.strictEqual(projectForAuthKey(dataDir, work.authKey), 'work');
  // The token itself is not a credential: only the derived auth key is
  assert.strictEqual(projectForAuthKey(dataDir, work.token), null);
  // Neither the token, the auth key nor the data key is stored
  const regText = fs.readFileSync(path.join(dataDir, '.scry', 'projects.json'), 'utf8');
  for (const secret of [work.token, work.authKey, work.dataKey.toString('base64url'), work.dataKey.toString('hex')]) {
    assert.ok(!regText.includes(secret));
  }
  const W = { authorization: `Bearer ${work.authKey}` };
  const P = { authorization: `Bearer ${personal.authKey}` };

  // GET /ingest/key answers the wrapped key, which only the token unwraps
  let r = await request(port, 'GET', '/ingest/key', undefined, W);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json, { project: 'work', wrappedKey: work.wrappedKey });
  assert.strictEqual((await request(port, 'GET', '/ingest/key')).status, 401);

  // ---------- ingest ----------
  // Plaintext is refused, and one plaintext line rejects the whole request
  res = await post(port, '{"msg":"plain"}\n', { 'x-session-id': 's0', ...W });
  assert.strictEqual(res.status, 400);
  assert.match(res.error, /not encrypted/);
  res = await post(port, `${encLine}\n{"msg":"plain"}\n`, { 'x-session-id': 's0', ...W });
  assert.strictEqual(res.status, 400);
  // A key only writes to its own project
  res = await post(port, encLine + '\n', { 'x-session-id': 's0', 'x-project': 'personal', ...W });
  assert.strictEqual(res.status, 403);
  assert.deepStrictEqual(fs.readdirSync(path.join(dataDir, 'work')), []);

  const E = (key, project, obj) => sc.encryptLine(key, project, JSON.stringify(obj));
  res = await post(port, [
    E(work.dataKey, 'work', { ts: '2026-01-02T03:04:05Z', kind: 'prompt', prompt: 'alpha one' }),
    E(work.dataKey, 'work', { kind: 'response', response: 'alpha two' }),
  ].join('\n') + '\n', { 'x-session-id': 's1', 'x-project': 'work', ...W });
  assert.strictEqual(res.appended, 2);
  // Session id next to the envelope; the project comes from the key alone
  const withSid = JSON.stringify({ ...JSON.parse(E(personal.dataKey, 'personal', { msg: 'beta' })), sessionId: 's2', extra: 'dropped' });
  res = await post(port, withSid + '\n', P);
  assert.strictEqual(res.appended, 1);
  assert.ok(!fs.readFileSync(path.join(dataDir, 'personal', 's2.jsonl'), 'utf8').includes('dropped'));
  // X-Scry-Key works as well as Bearer
  res = await post(port, E(work.dataKey, 'work', { msg: 'alpha three' }) + '\n', { 'x-session-id': 's1', 'x-scry-key': work.authKey });
  assert.strictEqual(res.appended, 1);

  // Nothing readable on disk
  const disk = allBytes(dataDir);
  for (const word of ['alpha', 'beta', 'prompt', work.token, personal.token]) assert.ok(!disk.includes(word), word);
  const s1 = fs.readFileSync(path.join(dataDir, 'work', 's1.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(s1.length, 3);
  assert.strictEqual(JSON.parse(sc.decryptLine(work.dataKey, 'work', s1[0])).prompt, 'alpha one');

  // ---------- token rotation ----------
  // Needs the current key, and keeps the data key: old sessions stay readable
  const work2Token = sc.newToken();
  const work2 = { authKey: sc.authKeyFor(work2Token), wrappedKey: sc.wrapKey(work2Token, 'work', work.dataKey) };
  assert.throws(() => rotateProjectToken(dataDir, 'work', work2), (e) => e.status === 403);
  assert.throws(() => rotateProjectToken(dataDir, 'work', work2, personal.authKey), (e) => e.status === 403);
  rotateProjectToken(dataDir, 'work', work2, work.authKey);
  res = await post(port, encLine + '\n', { 'x-session-id': 's1', ...W });
  assert.strictEqual(res.status, 401);
  W.authorization = `Bearer ${work2.authKey}`;
  assert.ok(sc.unwrapKey(work2Token, 'work', wrappedKeyFor(dataDir, 'work')).equals(work.dataKey));

  // ---------- projects and sessions ----------
  assert.deepStrictEqual(listProjects(dataDir), ['personal', 'work']);
  // A folder from before encryption shows up without a key until one is issued,
  // and can be claimed without a current key
  fs.mkdirSync(path.join(dataDir, 'old'));
  fs.writeFileSync(path.join(dataDir, 'old', 'legacy.jsonl'), '{"msg":"old alpha"}\n{"msg":"old beta"}\n');
  fs.mkdirSync(path.join(dataDir, 'lost+found'));
  assert.deepStrictEqual(projectInfo(dataDir).map((p) => [p.name, p.hasKey]),
    [['old', false], ['personal', true], ['work', true]]);
  const old = sc.newProjectKeys('old');
  rotateProjectToken(dataDir, 'old', old);
  assert.strictEqual(projectForAuthKey(dataDir, old.authKey), 'old');

  // scry-crypt migrate encrypts the plaintext lines in place
  const cli = path.join(__dirname, '..', 'scripts', 'scry-crypt.js');
  execFileSync('node', [cli, 'migrate', '--data-dir', dataDir, '--project', 'old'],
    { env: { ...process.env, SCRY_INGEST_TOKEN: old.token }, stdio: 'pipe' });
  const migrated = fs.readFileSync(path.join(dataDir, 'old', 'legacy.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(migrated.length, 2);
  assert.ok(!migrated.join('').includes('alpha'));
  assert.strictEqual(sc.decryptLine(old.dataKey, 'old', migrated[0]), '{"msg":"old alpha"}');
  // ... and refuses a token for another project
  assert.throws(() => execFileSync('node', [cli, 'migrate', '--data-dir', dataDir, '--project', 'old'],
    { env: { ...process.env, SCRY_INGEST_TOKEN: work2Token }, stdio: 'pipe' }));
  fs.rmSync(path.join(dataDir, 'old'), { recursive: true });
  fs.rmSync(path.join(dataDir, 'lost+found'), { recursive: true });
  const reg = JSON.parse(fs.readFileSync(path.join(dataDir, '.scry', 'projects.json'), 'utf8'));
  delete reg.projects.old;
  fs.writeFileSync(path.join(dataDir, '.scry', 'projects.json'), JSON.stringify(reg));

  let list = listSessions({ dataDir, project: 'work' });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, 's1');
  assert.strictEqual(list[0].head.length, 3);
  assert.strictEqual(JSON.parse(sc.decryptLine(work.dataKey, 'work', list[0].head[0])).prompt, 'alpha one');
  assert.ok(list[0].updatedAt);
  const sess = await readSession({ dataDir, project: 'work', id: 's1' });
  assert.strictEqual(sess.lines.length, 3);
  assert.strictEqual(JSON.parse(sc.decryptLine(work.dataKey, 'work', sess.lines[1].raw)).response, 'alpha two');
  assert.strictEqual(await readSession({ dataDir, project: 'work', id: 'nope' }), null);

  // scry-crypt encrypt / decrypt / auth-key against the server
  const cliEnv = { ...process.env, SCRY_INGEST_TOKEN: work2Token, SCRY_INGEST_URL: `http://127.0.0.1:${port}/ingest` };
  const run = (args, input) => new Promise((resolve, reject) => {
    const cp = require('child_process').execFile('node', [cli, ...args], { env: cliEnv }, (err, out) => (err ? reject(err) : resolve(out)));
    cp.stdin.end(input);
  });
  assert.strictEqual((await run(['auth-key'], '')).trim(), work2.authKey);
  const cliEnc = await run(['encrypt'], '{"msg":"from curl"}\n');
  assert.ok(!cliEnc.includes('curl'));
  res = await post(port, cliEnc, { 'x-session-id': 's3', ...W });
  assert.strictEqual(res.appended, 1);
  assert.strictEqual((await run(['decrypt'], fs.readFileSync(path.join(dataDir, 'work', 's3.jsonl')))).trim(), '{"msg":"from curl"}');
  fs.rmSync(path.join(dataDir, 'work', 's3.jsonl'));

  // ---------- GET /plugin ----------
  const pluginDir = path.join(tmp, 'fake-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'marker.txt'), 'plugin payload\n');
  const pluginServer = await createIngestServer({ dataDir, port: 0, pluginDir });
  const tgz = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: pluginServer.address().port, path: '/plugin' }, (rr) => {
      assert.strictEqual(rr.statusCode, 200);
      assert.strictEqual(rr.headers['content-type'], 'application/gzip');
      const chunks = [];
      rr.on('data', (c) => chunks.push(c));
      rr.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
  const extractDir = path.join(tmp, 'extracted');
  fs.mkdirSync(extractDir, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'plugin.tgz'), tgz);
  execFileSync('tar', ['-xzf', path.join(tmp, 'plugin.tgz'), '-C', extractDir]);
  assert.strictEqual(fs.readFileSync(path.join(extractDir, 'fake-plugin', 'marker.txt'), 'utf8'), 'plugin payload\n');
  pluginServer.close();

  // ---------- web UI routes, /healthz and basic auth ----------
  const uiFile = path.join(tmp, 'ui.html');
  fs.writeFileSync(uiFile, '<p>scry ui</p>');
  const landingFile = path.join(tmp, 'landing.html');
  fs.writeFileSync(landingFile, '<p>scry landing</p>');
  const publicDir = path.join(tmp, 'public');
  fs.mkdirSync(publicDir);
  fs.writeFileSync(path.join(publicDir, 'favicon.svg'), '<svg/>');
  const uiServer = await createIngestServer({ dataDir, port: 0, uiFile, landingFile, publicDir, uiUser: 'u', uiPass: 'p' });
  const uiPort = uiServer.address().port;
  const get = (p, headers = {}) => request(uiPort, 'GET', p, undefined, headers);
  const send = (p, body, headers = {}) => request(uiPort, 'POST', p, body, headers);
  const basic = (u, p) => ({ authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') });
  const B = basic('u', 'p');

  assert.strictEqual((await get('/healthz')).status, 200);
  r = await get('/');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data, '<p>scry landing</p>');
  r = await get('/favicon.svg');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['content-type'], 'image/svg+xml');
  assert.strictEqual((await get('/favicon.ico')).status, 404);
  assert.strictEqual((await get('/app/')).headers.location, '/app');
  r = await get('/app');
  assert.strictEqual(r.status, 401);
  assert.match(r.headers['www-authenticate'], /^Basic/);
  r = await get('/app', B);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data, '<p>scry ui</p>');
  // Server-side search is gone: the server cannot read what it would search
  assert.strictEqual((await get('/search?q=alpha', B)).status, 404);
  assert.strictEqual((await get('/projects')).status, 401);
  r = await get('/projects', B);
  assert.deepStrictEqual(r.json.map((x) => [x.name, x.hasKey]), [['personal', true], ['work', true]]);

  // Reading sessions needs both basic auth and the project's key
  assert.strictEqual((await get('/sessions?project=work', { 'x-scry-key': work2.authKey })).status, 401);
  assert.strictEqual((await get('/sessions?project=work', B)).status, 401);
  assert.strictEqual((await get('/sessions?project=work', { ...B, 'x-scry-key': personal.authKey })).status, 403);
  assert.strictEqual((await get('/sessions?project=work', { ...B, 'x-scry-key': work.authKey })).status, 403); // retired
  assert.strictEqual((await get('/sessions', { ...B, 'x-scry-key': work2.authKey })).status, 400);
  r = await get('/sessions?project=work', { ...B, 'x-scry-key': work2.authKey });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.map((x) => x.id), ['s1']);
  assert.strictEqual(r.json[0].title, undefined); // titles are only known to clients
  r = await get('/session?project=work&id=s1', { ...B, 'x-scry-key': work2.authKey });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.lines.length, 3);
  assert.ok(sc.parseEnvelope(r.json.lines[0].raw));
  assert.strictEqual((await get('/session?project=work&id=s1', { ...B, 'x-scry-key': personal.authKey })).status, 403);
  assert.strictEqual((await get('/session?project=work&id=missing', { ...B, 'x-scry-key': work2.authKey })).status, 404);
  assert.strictEqual((await get('/session?project=..&id=s1', { ...B, 'x-scry-key': work2.authKey })).status, 403);

  // Creating a project and replacing its token over HTTP
  const json = { 'content-type': 'application/json' };
  const team = sc.newProjectKeys('team');
  const teamBody = JSON.stringify({ name: 'team', authKey: team.authKey, wrappedKey: team.wrappedKey });
  assert.strictEqual((await send('/projects', teamBody, json)).status, 401);
  assert.strictEqual((await send('/projects', 'name=team', { ...B, 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.strictEqual((await send('/projects', '{"name":"team"}', { ...B, ...json })).status, 400);
  r = await send('/projects', teamBody, { ...B, ...json });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(JSON.parse(r.data).name, 'team');
  assert.strictEqual(JSON.parse(r.data).token, undefined);
  assert.strictEqual(projectForAuthKey(dataDir, team.authKey), 'team');
  assert.strictEqual((await send('/projects', teamBody, { ...B, ...json })).status, 409);
  const team2Token = sc.newToken();
  const team2Body = JSON.stringify({ name: 'team', authKey: sc.authKeyFor(team2Token), wrappedKey: sc.wrapKey(team2Token, 'team', team.dataKey) });
  assert.strictEqual((await send('/projects/token', team2Body, { ...B, ...json })).status, 403);
  r = await send('/projects/token', team2Body, { ...B, ...json, 'x-scry-key': team.authKey });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(projectForAuthKey(dataDir, team.authKey), null);
  assert.strictEqual(projectForAuthKey(dataDir, sc.authKeyFor(team2Token)), 'team');
  assert.strictEqual((await send('/projects/token', JSON.stringify({ name: 'ghost', ...team }), { ...B, ...json })).status, 404);
  uiServer.close();

  // Without a landing page, / sends you to the app
  const appOnly = await createIngestServer({ dataDir, port: 0, uiFile });
  r = await request(appOnly.address().port, 'GET', '/');
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.location, '/app');
  appOnly.close();

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('smoke test passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
