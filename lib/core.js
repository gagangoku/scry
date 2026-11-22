const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');
const crypto = require('crypto');
const { execFile } = require('child_process');

// Largest /ingest body accepted; bigger requests get a 413.
const MAX_BODY_BYTES = 50 * 1024 * 1024;
// Bytes read from the head of a session file to find its title and start time.
const HEAD_BYTES = 256 * 1024;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sendJson(res, status, obj, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(obj) + '\n');
}

function sanitizeName(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 128);
}

function sanitizeSessionId(id) {
  return sanitizeName(id) || 'default';
}

// Project names become directory names under dataDir. Empty after cleaning
// means "no project", which ingestion rejects.
function sanitizeProject(p) {
  if (p === undefined || p === null) return '';
  return sanitizeName(String(p).trim());
}

// Directory for a project. `project === ''` is dataDir itself, where files
// ingested before projects existed still live ("no project").
function projectDir(dataDir, project) {
  return project === '' ? dataDir : path.join(dataDir, sanitizeName(project));
}

// ---------- project registry ----------
// Projects and their ingest tokens live in <dataDir>/.scry/projects.json, so
// tokens are created from the app per project, never set in the deployment.
// Only a SHA-256 of each token is stored; the token itself is shown once.
// Project names never start with '.', so the registry dir is never a project.
const REGISTRY_DIR = '.scry';

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function registryFile(dataDir) {
  return path.join(dataDir, REGISTRY_DIR, 'projects.json');
}

function loadRegistry(dataDir) {
  try {
    const reg = JSON.parse(fs.readFileSync(registryFile(dataDir), 'utf8'));
    return reg && typeof reg.projects === 'object' ? reg : { projects: {} };
  } catch (_) {
    return { projects: {} };
  }
}

function saveRegistry(dataDir, reg) {
  const file = registryFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function newToken() {
  return 'scry_' + crypto.randomBytes(32).toString('base64url');
}

class ProjectError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validProjectName(name) {
  const clean = sanitizeProject(name);
  if (!clean || clean !== String(name).trim()) {
    throw new ProjectError(400, 'project names use only letters, digits, ".", "_" and "-", and cannot start with "."');
  }
  return clean;
}

// Creates a project and answers { name, token, createdAt }. The token is only
// ever returned here and by rotateProjectToken.
function createProject(dataDir, name, localProjects = {}) {
  const clean = validProjectName(name);
  if (Object.hasOwn(localProjects, clean)) throw new ProjectError(409, `project "${clean}" already exists`);
  const reg = loadRegistry(dataDir);
  if (reg.projects[clean] || fs.existsSync(path.join(dataDir, clean))) {
    throw new ProjectError(409, `project "${clean}" already exists`);
  }
  const token = newToken();
  const createdAt = new Date().toISOString();
  fs.mkdirSync(path.join(dataDir, clean), { recursive: true });
  reg.projects[clean] = { tokenHash: hashToken(token), createdAt, tokenCreatedAt: createdAt };
  saveRegistry(dataDir, reg);
  return { name: clean, token, createdAt };
}

// Issues a new token for an existing project (one created in the app, or a
// folder of sessions from before tokens existed); the old token stops working.
function rotateProjectToken(dataDir, name, localProjects = {}) {
  const clean = validProjectName(name);
  if (Object.hasOwn(localProjects, clean)) {
    throw new ProjectError(400, `"${clean}" is read from local files and takes no ingest token`);
  }
  const reg = loadRegistry(dataDir);
  if (!reg.projects[clean] && !fs.existsSync(path.join(dataDir, clean))) {
    throw new ProjectError(404, `no project "${clean}"`);
  }
  const token = newToken();
  const now = new Date().toISOString();
  reg.projects[clean] = {
    createdAt: now,
    ...reg.projects[clean],
    tokenHash: hashToken(token),
    tokenCreatedAt: now,
  };
  fs.mkdirSync(path.join(dataDir, clean), { recursive: true });
  saveRegistry(dataDir, reg);
  return { name: clean, token, createdAt: reg.projects[clean].createdAt };
}

// The project a bearer token belongs to, or null.
function projectForToken(dataDir, token) {
  if (!token) return null;
  const h = hashToken(token);
  for (const [name, p] of Object.entries(loadRegistry(dataDir).projects)) {
    if (p && typeof p.tokenHash === 'string' && safeEqual(p.tokenHash, h)) return name;
  }
  return null;
}

// Project names on disk or in the registry, plus '' when legacy session files
// sit directly in dataDir.
function listProjects(dataDir) {
  let entries;
  try {
    entries = fs.readdirSync(dataDir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  // Only folders whose names are valid project names: a data dir on its own
  // volume also holds things like ext4's lost+found, which are not projects.
  const names = new Set(entries
    .filter((e) => e.isDirectory() && e.name && sanitizeProject(e.name) === e.name)
    .map((e) => e.name));
  for (const name of Object.keys(loadRegistry(dataDir).projects)) names.add(name);
  const projects = [...names].sort();
  if (entries.some((e) => e.isFile() && e.name.endsWith('.jsonl'))) projects.push('');
  return projects;
}

// ---------- local projects ----------
// A local project is a read-only view of Claude Code's own transcripts on this
// machine: `localProjects` maps a project name (e.g. "claude-code-local") to a
// dir like ~/.claude/projects, whose sessions are <dir>/<cwd-folder>/<id>.jsonl.
// Nothing is ingested into it and it has no token. Its name shadows a data dir
// folder of the same name.
const isLocal = (localProjects, project) =>
  typeof project === 'string' && Object.hasOwn(localProjects, project);

// Session files of a local project: .jsonl files in its dir and one level of
// folders below it (deeper files, such as subagent transcripts, are skipped).
function localSessionFiles(root) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    else if (e.isDirectory()) {
      let sub;
      try { sub = fs.readdirSync(full, { withFileTypes: true }); } catch (_) { continue; }
      for (const f of sub) if (f.isFile() && f.name.endsWith('.jsonl')) out.push(path.join(full, f.name));
    }
  }
  return out;
}

// listProjects with registry details: [{ name, hasToken, createdAt, tokenCreatedAt, local }].
function projectInfo(dataDir, localProjects = {}) {
  const reg = loadRegistry(dataDir).projects;
  const local = Object.keys(localProjects).sort();
  return [
    ...listProjects(dataDir).filter((name) => !local.includes(name)).map((name) => {
      const p = reg[name];
      return {
        name,
        hasToken: Boolean(p && p.tokenHash),
        createdAt: (p && p.createdAt) || null,
        tokenCreatedAt: (p && p.tokenCreatedAt) || null,
        local: false,
      };
    }),
    ...local.map((name) => ({ name, hasToken: false, createdAt: null, tokenCreatedAt: null, local: true })),
  ];
}

function readHead(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch (_) {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Text of a user prompt in either the chat-logger format or a raw Claude Code
// transcript line; '' when the line is not a user prompt.
function promptText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (obj.kind === 'prompt' && typeof obj.prompt === 'string') return obj.prompt;
  if (obj.type === 'user' && obj.message) {
    const c = obj.message.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      const t = c.find((b) => b && b.type === 'text' && typeof b.text === 'string');
      if (t) return t.text;
    }
  }
  return '';
}

// claude.ai/code session ids (session_01...): the chat-logger plugin keys
// cloud sessions by them, so such a session has a web chat to open.
const WEB_SESSION_ID = /^session_01[A-Za-z0-9]+$/;

// The claude.ai web chat URL for a session, or null when it is not a cloud
// (claude.ai/code) session: from the session id itself, else from a line's
// remote_session_id.
function webUrlFor(id, remoteId) {
  const sid = WEB_SESSION_ID.test(id) ? id : (typeof remoteId === 'string' && WEB_SESSION_ID.test(remoteId) ? remoteId : null);
  return sid ? `https://claude.ai/code/${sid}` : null;
}

function sessionMeta(file, project) {
  const stat = fs.statSync(file);
  const head = readHead(file);
  const id = path.basename(file, '.jsonl');
  let createdAt = null;
  let title = '';
  let webUrl = webUrlFor(id);
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }
    if (!webUrl && obj) webUrl = webUrlFor(id, obj.remote_session_id);
    if (!createdAt) {
      const ts = obj && (obj.ts || obj.timestamp);
      if (ts && !Number.isNaN(Date.parse(ts))) createdAt = new Date(ts).toISOString();
    }
    if (!title) title = promptText(obj).trim().replace(/\s+/g, ' ').slice(0, 160);
    if (createdAt && title && webUrl) break;
  }
  return {
    project,
    id,
    title,
    webUrl,
    createdAt: createdAt || (stat.birthtimeMs ? stat.birthtime : stat.ctime).toISOString(),
    updatedAt: stat.mtime.toISOString(),
    size: stat.size,
  };
}

// Sessions in one project, or in every project when `project` is null or
// undefined. Newest activity first.
function listSessions({ dataDir, project, localProjects = {} }) {
  const all = project === undefined || project === null;
  const projects = all
    ? [...listProjects(dataDir), ...Object.keys(localProjects)].filter((p, i, a) => a.indexOf(p) === i)
    : [project];
  const out = [];
  for (const p of projects) {
    if (isLocal(localProjects, p)) {
      for (const file of localSessionFiles(localProjects[p])) {
        try { out.push(sessionMeta(file, p)); } catch (_) { /* vanished mid-listing */ }
      }
      continue;
    }
    const dir = projectDir(dataDir, p);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      try {
        out.push(sessionMeta(path.join(dir, e.name), p));
      } catch (_) { /* vanished mid-listing */ }
    }
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return out;
}

// Every line of one session, parsed where possible ({ line, raw } otherwise).
// Answers null when the session does not exist.
async function readSession({ dataDir, project, id, localProjects = {} }) {
  const name = sanitizeSessionId(id) + '.jsonl';
  const file = isLocal(localProjects, project)
    ? localSessionFiles(localProjects[project]).find((f) => path.basename(f) === name)
    : path.join(projectDir(dataDir, project), name);
  if (!file || !fs.existsSync(file)) return null;
  const meta = sessionMeta(file, project);
  const lines = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;
    let data;
    try { data = JSON.parse(line); } catch (_) { data = undefined; }
    lines.push(data === undefined ? { line: lineNo, raw: line } : { line: lineNo, data });
  }
  return { ...meta, lines };
}

// HTTP server: POST /ingest with a body of JSONL lines.
// Requests must carry `Authorization: Bearer <token>`, a token created for a
// project in the app (see createProject); without a known token, 401.
// Every line needs a project: the X-Project header, else a `project` field in
// the line. A line lacking one gets 400, a line for a project other than the
// token's gets 403, and either way nothing in the request is written. Session id comes from the X-Session-Id header, else a
// `sessionId` field in each line, else "default". Lines are appended to
// <dataDir>/<project>/<sessionId>.jsonl.
// When `pluginDir` is set, GET /plugin answers a tar.gz of that directory
// (no auth: cloud setup scripts cannot read secrets, and the plugin is code,
// not data).
// When `landingFile` is set, GET / serves it, unauthenticated (the public
// landing page); otherwise GET / redirects to /app. When `publicDir` is set,
// the files in PUBLIC_FILES (favicons) are served from it, unauthenticated.
// When `uiFile` is set, GET /app serves it (the sessions viewer), and these
// answer JSON for it:
//   GET /search?q=[&project=]       search hits over `searchDirs`, or one project
//   GET /projects                   [{ name, hasToken, createdAt, tokenCreatedAt }]
//                                   (name '' = legacy files with no project)
//   POST /projects {name}           create a project; answers { name, token, createdAt }
//   POST /projects/token {name}     replace a project's token; answers the same
//   GET /sessions[?project=]        session metadata, newest first
//   GET /session?project=&id=       one session's lines
// `project` absent means every project; present and empty means no project.
// When `uiUser` is set, those routes require HTTP basic auth. The POST routes
// only take application/json, so a cross-site form cannot drive them.
// GET /healthz always answers 200, unauthenticated, for probes.
const UI_ROUTES = new Set(['/app', '/search', '/projects', '/sessions', '/session']);
const PUBLIC_FILES = {
  '/favicon.svg': 'image/svg+xml',
  '/favicon.ico': 'image/x-icon',
  '/apple-touch-icon.png': 'image/png',
};

function sendFile(res, file, type, cacheControl) {
  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found\n');
      return;
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': cacheControl });
    res.end(body);
  });
}
const UI_POST_ROUTES = new Set(['/projects', '/projects/token']);

function createIngestServer({
  dataDir, port, host = '127.0.0.1', pluginDir,
  uiFile, landingFile, publicDir, searchDirs = [dataDir], maxResults = 200, uiUser, uiPass,
  localProjects = {},
}) {
  fs.mkdirSync(dataDir, { recursive: true });

  const uiAuthorized = (req) => {
    if (!uiUser) return true;
    const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
    if (!m) return false;
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep === -1) return false;
    // Evaluate both so a wrong user takes as long as a wrong password.
    const userOk = safeEqual(decoded.slice(0, sep), uiUser);
    const passOk = safeEqual(decoded.slice(sep + 1), uiPass || '');
    return userOk && passOk;
  };

  const handleUi = (req, res, url) => {
    const route = url.pathname;
    const params = url.searchParams;
    const project = params.has('project') ? sanitizeProject(params.get('project')) : null;
    const fail = () => sendJson(res, 500, { error: `${route.slice(1)} failed` });
    switch (route) {
      case '/app':
        sendFile(res, uiFile, 'text/html; charset=utf-8', 'no-store');
        return;
      case '/search':
        searchJsonl({
          dirs: project === null
            ? [...searchDirs, ...Object.values(localProjects)]
            : isLocal(localProjects, project) ? [localProjects[project]] : [projectDir(dataDir, project)],
          query: params.get('q') || '',
          maxResults,
          dataDir,
          localProjects,
          recursive: project !== '',
        })
          .then((hits) => sendJson(res, 200, hits))
          .catch(fail);
        return;
      case '/projects':
        sendJson(res, 200, projectInfo(dataDir, localProjects));
        return;
      case '/sessions':
        try {
          sendJson(res, 200, listSessions({ dataDir, project, localProjects }));
        } catch (_) {
          fail();
        }
        return;
      case '/session':
        if (!params.get('id')) {
          sendJson(res, 400, { error: 'id is required' });
          return;
        }
        readSession({ dataDir, project: project || '', id: params.get('id'), localProjects })
          .then((s) => (s ? sendJson(res, 200, s) : sendJson(res, 404, { error: 'no such session' })))
          .catch(fail);
        return;
      default:
        fail();
    }
  };

  // Reads a JSON request body (capped at 64KB) and answers it, or null after
  // having sent an error.
  const readJsonBody = (req, res) => new Promise((resolve) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      sendJson(res, 415, { error: 'send application/json' });
      resolve(null);
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (_) {
        sendJson(res, 400, { error: 'invalid JSON' });
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });

  const handleUiPost = async (req, res, route) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      const fn = route === '/projects' ? createProject : rotateProjectToken;
      sendJson(res, route === '/projects' ? 201 : 200, fn(dataDir, String(body.name || ''), localProjects));
    } catch (err) {
      if (err instanceof ProjectError) sendJson(res, err.status, { error: err.message });
      else sendJson(res, 500, { error: 'project update failed' });
    }
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;
    if (req.method === 'GET' && route === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok\n');
      return;
    }
    if (req.method === 'GET' && publicDir && PUBLIC_FILES[route]) {
      sendFile(res, path.join(publicDir, route.slice(1)), PUBLIC_FILES[route], 'public, max-age=86400');
      return;
    }
    if (req.method === 'GET' && route === '/' && (landingFile || uiFile)) {
      if (landingFile) {
        sendFile(res, landingFile, 'text/html; charset=utf-8', 'no-cache');
      } else {
        res.writeHead(302, { location: '/app' });
        res.end();
      }
      return;
    }
    if (req.method === 'GET' && route === '/app/' && uiFile) {
      res.writeHead(301, { location: '/app' + url.search });
      res.end();
      return;
    }
    if (req.method === 'GET' && uiFile && UI_ROUTES.has(route)) {
      if (!uiAuthorized(req)) {
        res.writeHead(401, { 'content-type': 'text/plain', 'www-authenticate': 'Basic realm="scry"' });
        res.end('authentication required\n');
        return;
      }
      handleUi(req, res, url);
      return;
    }
    if (req.method === 'POST' && uiFile && UI_POST_ROUTES.has(route)) {
      if (!uiAuthorized(req)) {
        res.writeHead(401, { 'content-type': 'text/plain', 'www-authenticate': 'Basic realm="scry"' });
        res.end('authentication required\n');
        return;
      }
      handleUiPost(req, res, route);
      return;
    }
    if (req.method === 'GET' && route === '/plugin' && pluginDir) {
      execFile(
        'tar',
        ['-czf', '-', '-C', path.dirname(pluginDir), path.basename(pluginDir)],
        { encoding: 'buffer', maxBuffer: 50 * 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end('tar failed\n');
            return;
          }
          res.writeHead(200, { 'content-type': 'application/gzip' });
          res.end(stdout);
        }
      );
      return;
    }
    if (req.method !== 'POST' || route !== '/ingest') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('POST JSONL lines to /ingest\n');
      return;
    }
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const tokenProject = bearer ? projectForToken(dataDir, bearer[1].trim()) : null;
    if (!tokenProject) {
      sendJson(res, 401, { error: 'missing or invalid bearer token: create a project in scry to get one' });
      return;
    }
    let body = '';
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        sendJson(res, 413, { error: 'body too large' }, { connection: 'close' });
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (tooBig) return;
      const headerSession = req.headers['x-session-id'];
      const headerProject = sanitizeProject(req.headers['x-project']);
      // Resolve every line's destination first, so a request with one bad line
      // writes nothing.
      const writes = [];
      let lineNo = 0;
      for (const rawLine of body.split('\n')) {
        lineNo++;
        const line = rawLine.trim();
        if (!line) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch (_) { /* not JSON: header values only */ }
        const fields = parsed && typeof parsed === 'object' ? parsed : {};
        const project = headerProject || sanitizeProject(fields.project);
        if (!project) {
          sendJson(res, 400, {
            error: `line ${lineNo} has no project: send an X-Project header or a "project" field in each line`,
          });
          return;
        }
        if (project !== tokenProject) {
          sendJson(res, 403, { error: `line ${lineNo} is for project "${project}", but the token is for "${tokenProject}"` });
          return;
        }
        const session = sanitizeSessionId(headerSession || fields.sessionId || 'default');
        writes.push({ dir: path.join(dataDir, project), file: session + '.jsonl', line });
      }
      try {
        for (const w of writes) {
          fs.mkdirSync(w.dir, { recursive: true });
          fs.appendFileSync(path.join(w.dir, w.file), w.line + '\n');
        }
      } catch (_) {
        sendJson(res, 500, { error: 'write failed' });
        return;
      }
      sendJson(res, 200, { appended: writes.length });
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

function listJsonlFiles(dir, recursive = true) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (recursive) stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
    }
  }
  return out;
}

// For a file stored by ingestion, or a session of a local project, its
// { project, session }; null otherwise.
function locateSession(dataDir, file, localProjects = {}) {
  for (const [name, root] of Object.entries(localProjects)) {
    const rel = path.relative(root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    return rel.split(path.sep).length <= 2 ? { project: name, session: path.basename(file, '.jsonl') } : null;
  }
  if (!dataDir) return null;
  const rel = path.relative(dataDir, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.length === 1) return { project: '', session: path.basename(parts[0], '.jsonl') };
  if (parts.length === 2) return { project: parts[0], session: path.basename(parts[1], '.jsonl') };
  return null;
}

// Case-insensitive substring search across every .jsonl file under `dirs`.
// With `dataDir`, hits in ingested sessions also carry `project` and `session`.
// `recursive: false` searches only the files directly in each dir.
async function searchJsonl({ dirs, query, maxResults = 200, dataDir, localProjects = {}, recursive = true }) {
  const q = query.toLowerCase();
  const results = [];
  if (!q) return results;

  const seen = new Set();
  for (const dir of dirs) {
    for (const file of listJsonlFiles(dir, recursive)) {
      if (seen.has(file)) continue;
      seen.add(file);
      const where = locateSession(dataDir, file, localProjects);
      const rl = readline.createInterface({
        input: fs.createReadStream(file),
        crlfDelay: Infinity,
      });
      let lineNo = 0;
      for await (const line of rl) {
        lineNo++;
        const idx = line.toLowerCase().indexOf(q);
        if (idx === -1) continue;
        const start = Math.max(0, idx - 60);
        results.push({
          file,
          line: lineNo,
          ...(where || {}),
          snippet: (start > 0 ? '…' : '') + line.slice(start, start + 200) + (line.length > start + 200 ? '…' : ''),
        });
        if (results.length >= maxResults) {
          rl.close();
          return results;
        }
      }
    }
  }
  return results;
}

module.exports = {
  createIngestServer, searchJsonl, sanitizeSessionId, sanitizeProject,
  listProjects, projectInfo, createProject, rotateProjectToken, projectForToken, ProjectError, listSessions, readSession, projectDir,
};
