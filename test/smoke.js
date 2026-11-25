const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {
  createIngestServer, searchJsonl, listProjects, listSessions, readSession,
  createProject, rotateProjectToken, projectForToken, projectInfo,
} = require('../lib/core');

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

  // No token, or an unknown one: 401, nothing written
  let res = await post(port, '{"msg":"x"}\n', { 'x-session-id': 's0', 'x-project': 'work' });
  assert.strictEqual(res.status, 401);
  res = await post(port, '{"msg":"x"}\n', { 'x-session-id': 's0', 'x-project': 'work', authorization: 'Bearer nope' });
  assert.strictEqual(res.status, 401);
  assert.deepStrictEqual(fs.readdirSync(dataDir), []);

  // Projects and their tokens
  const work = createProject(dataDir, 'work');
  const personal = createProject(dataDir, 'personal');
  assert.match(work.token, /^scry_/);
  assert.notStrictEqual(work.token, personal.token);
  assert.throws(() => createProject(dataDir, 'work'), (e) => e.status === 409);
  assert.throws(() => createProject(dataDir, '../x'), (e) => e.status === 400);
  assert.throws(() => createProject(dataDir, '.scry'), (e) => e.status === 400);
  assert.throws(() => rotateProjectToken(dataDir, 'ghost'), (e) => e.status === 404);
  assert.strictEqual(projectForToken(dataDir, work.token), 'work');
  // Tokens are stored hashed, never in the clear
  assert.ok(!fs.readFileSync(path.join(dataDir, '.scry', 'projects.json'), 'utf8').includes(work.token));
  const W = { authorization: `Bearer ${work.token}` };
  const P = { authorization: `Bearer ${personal.token}` };

  // No project anywhere: rejected, nothing written
  res = await post(port, '{"msg":"orphan"}\n', { 'x-session-id': 's0', ...W });
  assert.strictEqual(res.status, 400);
  assert.match(res.error, /project/);
  // One line without a project rejects the whole request
  res = await post(port, '{"project":"work","msg":"ok"}\n{"msg":"orphan"}\n', { 'x-session-id': 's0', ...W });
  assert.strictEqual(res.status, 400);
  // A token only writes to its own project
  res = await post(port, '{"msg":"x"}\n', { 'x-session-id': 's0', 'x-project': 'personal', ...W });
  assert.strictEqual(res.status, 403);
  assert.deepStrictEqual(fs.readdirSync(path.join(dataDir, 'work')), []);
  assert.deepStrictEqual(fs.readdirSync(path.join(dataDir, 'personal')), []);

  // Session id and project from headers
  res = await post(port, '{"ts":"2026-01-02T03:04:05Z","kind":"prompt","prompt":"alpha one"}\n{"kind":"response","response":"alpha two"}\n',
    { 'x-session-id': 's1', 'x-project': 'work', ...W });
  assert.strictEqual(res.appended, 2);

  // Session id and project from the line itself
  res = await post(port, '{"sessionId":"s2","project":"personal","msg":"beta"}\n', P);
  assert.strictEqual(res.appended, 1);

  // Appending again to the same session
  res = await post(port, '{"msg":"alpha three"}\n', { 'x-session-id': 's1', 'x-project': 'work', ...W });
  assert.strictEqual(res.appended, 1);

  // Traversal in the project header cannot escape the token's project
  res = await post(port, '{"msg":"gamma"}\n', { 'x-session-id': 's1', 'x-project': '../personal', ...P });
  assert.strictEqual(res.status, 403);

  // Rotating a token retires the old one
  const work2 = rotateProjectToken(dataDir, 'work');
  res = await post(port, '{"msg":"x"}\n', { 'x-session-id': 's1', 'x-project': 'work', ...W });
  assert.strictEqual(res.status, 401);
  W.authorization = `Bearer ${work2.token}`;

  const s1 = fs.readFileSync(path.join(dataDir, 'work', 's1.jsonl'), 'utf8');
  assert.strictEqual(s1.trim().split('\n').length, 3);
  assert.ok(fs.existsSync(path.join(dataDir, 'personal', 's2.jsonl')));
  assert.ok(!fs.existsSync(path.join(dataDir, '__personal')));

  // A legacy file with no project, from before projects existed
  fs.writeFileSync(path.join(dataDir, 'legacy.jsonl'), '{"msg":"old alpha"}\n');

  // Projects and sessions
  assert.deepStrictEqual(listProjects(dataDir), ['personal', 'work', '']);
  // A folder from before tokens existed shows up without a token until one is issued
  fs.mkdirSync(path.join(dataDir, 'old'));
  // Filesystem folders that are not valid project names are not projects
  fs.mkdirSync(path.join(dataDir, 'lost+found'));
  assert.deepStrictEqual(projectInfo(dataDir).map((p) => [p.name, p.hasToken]),
    [['old', false], ['personal', true], ['work', true], ['', false]]);
  const old = rotateProjectToken(dataDir, 'old');
  assert.strictEqual(projectForToken(dataDir, old.token), 'old');
  fs.rmSync(path.join(dataDir, 'old'), { recursive: true });
  fs.rmSync(path.join(dataDir, 'lost+found'), { recursive: true });
  const reg = JSON.parse(fs.readFileSync(path.join(dataDir, '.scry', 'projects.json'), 'utf8'));
  delete reg.projects.old;
  fs.writeFileSync(path.join(dataDir, '.scry', 'projects.json'), JSON.stringify(reg));
  let list = listSessions({ dataDir });
  assert.strictEqual(list.length, 3);
  list = listSessions({ dataDir, project: 'work' });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, 's1');
  assert.strictEqual(list[0].title, 'alpha one');
  assert.strictEqual(list[0].createdAt, '2026-01-02T03:04:05.000Z');
  assert.ok(list[0].updatedAt);
  assert.strictEqual(listSessions({ dataDir, project: '' })[0].id, 'legacy');
  const sess = await readSession({ dataDir, project: 'work', id: 's1' });
  assert.strictEqual(sess.lines.length, 3);
  assert.strictEqual(sess.lines[1].data.response, 'alpha two');
  assert.strictEqual(await readSession({ dataDir, project: 'work', id: 'nope' }), null);
  assert.strictEqual(list[0].webUrl, null);

  // Cloud sessions carry their claude.ai web chat URL: from a session_01... id,
  // else from a line's remote_session_id
  const webDir = path.join(tmp, 'web-data');
  fs.mkdirSync(path.join(webDir, 'w'), { recursive: true });
  fs.writeFileSync(path.join(webDir, 'w', 'session_01Abc.jsonl'), '{"kind":"prompt","prompt":"hi"}\n');
  fs.writeFileSync(path.join(webDir, 'w', 'uuid-1.jsonl'), '{"kind":"prompt","prompt":"x","remote_session_id":"session_01Xyz"}\n');
  fs.writeFileSync(path.join(webDir, 'w', 'uuid-2.jsonl'), '{"kind":"prompt","prompt":"x","remote_session_id":"evil/../x"}\n');
  const web = Object.fromEntries(listSessions({ dataDir: webDir, project: 'w' }).map((x) => [x.id, x.webUrl]));
  assert.strictEqual(web['session_01Abc'], 'https://claude.ai/code/session_01Abc');
  assert.strictEqual(web['uuid-1'], 'https://claude.ai/code/session_01Xyz');
  assert.strictEqual(web['uuid-2'], null);

  // Image prompts: an image-only prompt titles as [Image], and a first line
  // longer than the head (a big pasted image) still yields title, time and URL
  const imgDir = path.join(tmp, 'img-data');
  fs.mkdirSync(path.join(imgDir, 'i'), { recursive: true });
  const img = (data) => JSON.stringify({ ts: '2026-11-22T10:00:00.000Z', remote_session_id: 'session_01Img',
    repos: [{ name: 'acme/app', url: 'https://github.com/acme/app', branch: 'b' }], kind: 'prompt', prompt: '',
    attachments: [{ type: 'image', mediaType: 'image/png', data }] });
  fs.writeFileSync(path.join(imgDir, 'i', 'small.jsonl'), img('iVBORw0KGgo=') + '\n');
  fs.writeFileSync(path.join(imgDir, 'i', 'big.jsonl'), img('A'.repeat(400 * 1024)) + '\n{"kind":"response","response":"ok"}\n');
  const imgs = Object.fromEntries(listSessions({ dataDir: imgDir, project: 'i' }).map((x) => [x.id, x]));
  assert.strictEqual(imgs.small.title, '[Image]');
  assert.strictEqual(imgs.big.title, '[Image]');
  assert.strictEqual(imgs.big.createdAt, '2026-11-22T10:00:00.000Z');
  assert.strictEqual(imgs.big.webUrl, 'https://claude.ai/code/session_01Img');
  assert.deepStrictEqual(imgs.big.repos, [{ name: 'acme/app', url: 'https://github.com/acme/app', branch: 'b' }]);
  const bigSess = await readSession({ dataDir: imgDir, project: 'i', id: 'big' });
  assert.strictEqual(bigSess.lines[0].data.attachments[0].data.length, 400 * 1024);

  // Git repos: from the plugin's `repos` field (validated), and for local
  // transcripts from <cwd>/.git/config's origin plus the line's gitBranch
  fs.writeFileSync(path.join(webDir, 'w', 'session_01Repo.jsonl'),
    '{"kind":"prompt","prompt":"r","repos":[{"name":"acme/app","url":"https://github.com/acme/app","branch":"claude/x"},'
    + '{"name":"../evil","url":"https://x"},{"name":"acme/lib","url":"javascript:alert(1)"}]}\n');
  const repos = Object.fromEntries(listSessions({ dataDir: webDir, project: 'w' }).map((x) => [x.id, x.repos]));
  assert.deepStrictEqual(repos['session_01Repo'], [
    { name: 'acme/app', url: 'https://github.com/acme/app', branch: 'claude/x' },
    { name: 'acme/lib', url: 'https://github.com/acme/lib' },
  ]);
  assert.deepStrictEqual(repos['session_01Abc'], []);
  const checkout = path.join(tmp, 'checkout');
  fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
  fs.writeFileSync(path.join(checkout, '.git', 'config'),
    '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:acme/tool.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
  const repoLocal = path.join(tmp, 'repo-local');
  fs.mkdirSync(path.join(repoLocal, 'p'), { recursive: true });
  fs.writeFileSync(path.join(repoLocal, 'p', 's1.jsonl'),
    JSON.stringify({ type: 'user', cwd: checkout, gitBranch: 'main', message: { role: 'user', content: 'hi' } }) + '\n');
  const rl = listSessions({ dataDir: webDir, project: 'loc', localProjects: { loc: repoLocal } });
  assert.deepStrictEqual(rl[0].repos, [{ name: 'acme/tool', url: 'https://github.com/acme/tool', branch: 'main' }]);
  const rs = await readSession({ dataDir: webDir, project: 'loc', id: 's1', localProjects: { loc: repoLocal } });
  assert.strictEqual(rs.repos[0].name, 'acme/tool');

  // Search across both the ingest dir and the claude projects dir
  let hits = await searchJsonl({ dirs: [dataDir, path.join(tmp, 'claude-projects')], query: 'alpha', dataDir });
  assert.strictEqual(hits.length, 4);
  const workHit = hits.find((h) => h.project === 'work');
  assert.strictEqual(workHit.session, 's1');
  hits = await searchJsonl({ dirs: [path.join(dataDir, 'work')], query: 'alpha' });
  assert.strictEqual(hits.length, 3);
  hits = await searchJsonl({ dirs: [dataDir], query: 'alpha', recursive: false, dataDir });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].project, '');

  hits = await searchJsonl({ dirs: [dataDir, path.join(tmp, 'claude-projects')], query: 'claude projects' });
  assert.strictEqual(hits.length, 1);
  assert.ok(hits[0].file.endsWith('old.jsonl'));

  // A local project over Claude Code's own transcripts (~/.claude/projects)
  const localRoot = path.join(tmp, 'local-claude');
  const localProjects = { 'claude-code-local': localRoot };
  fs.mkdirSync(path.join(localRoot, '-home-me-repo', 'abc', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(localRoot, '-home-me-repo', 'abc.jsonl'),
    '{"type":"summary"}\n{"type":"user","timestamp":"2026-03-04T05:06:07Z","message":{"role":"user","content":"local delta"}}\n');
  fs.writeFileSync(path.join(localRoot, '-home-me-repo', 'abc', 'subagents', 'agent-1.jsonl'), '{"msg":"delta sub"}\n');
  assert.deepStrictEqual(projectInfo(dataDir, localProjects).map((p) => [p.name, p.local]),
    [['personal', false], ['work', false], ['', false], ['claude-code-local', true]]);
  list = listSessions({ dataDir, project: 'claude-code-local', localProjects });
  assert.deepStrictEqual(list.map((s) => [s.project, s.id, s.title]), [['claude-code-local', 'abc', 'local delta']]);
  assert.strictEqual(list[0].createdAt, '2026-03-04T05:06:07.000Z');
  assert.strictEqual(listSessions({ dataDir, localProjects }).length, 4);
  assert.strictEqual(listSessions({ dataDir }).length, 3);
  const localSess = await readSession({ dataDir, project: 'claude-code-local', id: 'abc', localProjects });
  assert.strictEqual(localSess.lines.length, 2);
  assert.strictEqual(await readSession({ dataDir, project: 'claude-code-local', id: 'agent-1', localProjects }), null);
  hits = await searchJsonl({ dirs: [localRoot], query: 'delta', dataDir, localProjects });
  assert.strictEqual(hits.length, 2);
  const localHit = hits.find((h) => h.session === 'abc');
  assert.strictEqual(localHit.project, 'claude-code-local');
  assert.strictEqual(hits.find((h) => h !== localHit).session, undefined);
  assert.throws(() => createProject(dataDir, 'claude-code-local', localProjects), (e) => e.status === 409);
  assert.throws(() => rotateProjectToken(dataDir, 'claude-code-local', localProjects), (e) => e.status === 400);

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


  // Web UI, /search, /healthz and basic auth
  const uiFile = path.join(tmp, 'ui.html');
  fs.writeFileSync(uiFile, '<p>scry ui</p>');
  const landingFile = path.join(tmp, 'landing.html');
  fs.writeFileSync(landingFile, '<p>scry landing</p>');
  const publicDir = path.join(tmp, 'public');
  fs.mkdirSync(publicDir);
  fs.writeFileSync(path.join(publicDir, 'favicon.svg'), '<svg/>');
  const uiServer = await createIngestServer({
    dataDir, port: 0, uiFile, landingFile, publicDir, searchDirs: [dataDir], uiUser: 'u', uiPass: 'p', localProjects,
    buildInfo: { version: '9.9.9', build: '42' },
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
  // /version names the build, without auth
  let v = await get('/version');
  assert.strictEqual(v.status, 200);
  assert.deepStrictEqual(JSON.parse(v.data), { version: '9.9.9', build: '42' });
  // Build info: package.json version, "dev" without build-info.json
  const { loadBuildInfo } = require('../lib/build-info');
  const bi = loadBuildInfo();
  assert.strictEqual(bi.version, require('../package.json').version);
  assert.strictEqual(bi.build, fs.existsSync(path.join(__dirname, '..', 'build-info.json')) ? bi.build : 'dev');
  // The landing page and favicons are public; the sessions viewer at /app is not
  let r = await get('/');
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
  assert.strictEqual((await get('/search?q=alpha', basic('u', 'wrong'))).status, 401);
  r = await get('/app', basic('u', 'p'));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data, '<p>scry ui</p>');
  r = await get('/search?q=alpha', basic('u', 'p'));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(JSON.parse(r.data).length, 4);
  r = await get('/search?q=alpha&project=work', basic('u', 'p'));
  assert.strictEqual(JSON.parse(r.data).length, 3);
  r = await get('/search?q=alpha&project=', basic('u', 'p'));
  assert.strictEqual(JSON.parse(r.data).length, 1);
  assert.strictEqual((await get('/projects')).status, 401);
  r = await get('/projects', basic('u', 'p'));
  assert.deepStrictEqual(JSON.parse(r.data).map((x) => x.name), ['personal', 'work', '', 'claude-code-local']);
  r = await get('/sessions?project=claude-code-local', basic('u', 'p'));
  assert.deepStrictEqual(JSON.parse(r.data).map((x) => x.id), ['abc']);
  r = await get('/session?project=claude-code-local&id=abc', basic('u', 'p'));
  assert.strictEqual(JSON.parse(r.data).lines.length, 2);
  r = await get('/search?q=delta&project=claude-code-local', basic('u', 'p'));
  assert.strictEqual(JSON.parse(r.data).filter((h) => h.session === 'abc').length, 1);
  r = await get('/search?q=delta', basic('u', 'p'));
  assert.strictEqual(JSON.parse(r.data).length, 2);
  // Creating a project and rotating its token over HTTP
  const send = (p, body, headers = {}) => new Promise((resolve, reject) => {
    const q = http.request({ host: '127.0.0.1', port: uiPort, path: p, method: 'POST', headers }, (rr) => {
      let data = '';
      rr.on('data', (c) => (data += c));
      rr.on('end', () => resolve({ status: rr.statusCode, data }));
    });
    q.on('error', reject);
    q.end(body);
  });
  const json = { 'content-type': 'application/json' };
  assert.strictEqual((await send('/projects', '{"name":"team"}', json)).status, 401);
  assert.strictEqual((await send('/projects', 'name=team', { ...basic('u', 'p'), 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
  r = await send('/projects', '{"name":"team"}', { ...basic('u', 'p'), ...json });
  assert.strictEqual(r.status, 201);
  const team = JSON.parse(r.data);
  assert.strictEqual(team.name, 'team');
  assert.strictEqual(projectForToken(dataDir, team.token), 'team');
  assert.strictEqual((await send('/projects', '{"name":"team"}', { ...basic('u', 'p'), ...json })).status, 409);
  r = await send('/projects/token', '{"name":"team"}', { ...basic('u', 'p'), ...json });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(projectForToken(dataDir, team.token), null);
  assert.strictEqual(projectForToken(dataDir, JSON.parse(r.data).token), 'team');
  assert.strictEqual((await send('/projects/token', '{"name":"ghost"}', { ...basic('u', 'p'), ...json })).status, 404);
  r = await get('/sessions', basic('u', 'p'));
  assert.strictEqual(JSON.parse(r.data).length, 4);
  r = await get('/sessions?project=personal', basic('u', 'p'));
  assert.deepStrictEqual(JSON.parse(r.data).map((x) => x.id), ['s2']);
  r = await get('/session?project=work&id=s1', basic('u', 'p'));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(JSON.parse(r.data).lines.length, 3);
  assert.strictEqual((await get('/session?project=work&id=missing', basic('u', 'p'))).status, 404);
  assert.strictEqual((await get('/session?project=..&id=s1', basic('u', 'p'))).status, 404);
  uiServer.close();

  // Without a landing page, / sends you to the app
  const appOnly = await createIngestServer({ dataDir, port: 0, uiFile });
  const appRes = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: appOnly.address().port, path: '/' }, resolve).on('error', reject);
  });
  assert.strictEqual(appRes.statusCode, 302);
  assert.strictEqual(appRes.headers.location, '/app');
  appRes.resume();
  appOnly.close();

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('smoke test passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
