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

// Projects present on disk: one per subdirectory of dataDir, plus '' when
// legacy session files sit directly in dataDir.
function listProjects(dataDir) {
  let entries;
  try {
    entries = fs.readdirSync(dataDir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const projects = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  if (entries.some((e) => e.isFile() && e.name.endsWith('.jsonl'))) projects.push('');
  return projects;
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

function sessionMeta(file, project) {
  const stat = fs.statSync(file);
  const head = readHead(file);
  let createdAt = null;
  let title = '';
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }
    if (!createdAt) {
      const ts = obj && (obj.ts || obj.timestamp);
      if (ts && !Number.isNaN(Date.parse(ts))) createdAt = new Date(ts).toISOString();
    }
    if (!title) title = promptText(obj).trim().replace(/\s+/g, ' ').slice(0, 160);
    if (createdAt && title) break;
  }
  return {
    project,
    id: path.basename(file, '.jsonl'),
    title,
    createdAt: createdAt || (stat.birthtimeMs ? stat.birthtime : stat.ctime).toISOString(),
    updatedAt: stat.mtime.toISOString(),
    size: stat.size,
  };
}

// Sessions in one project, or in every project when `project` is null or
// undefined. Newest activity first.
function listSessions({ dataDir, project }) {
  const projects = project === undefined || project === null ? listProjects(dataDir) : [project];
  const out = [];
  for (const p of projects) {
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
async function readSession({ dataDir, project, id }) {
  const file = path.join(projectDir(dataDir, project), sanitizeSessionId(id) + '.jsonl');
  if (!fs.existsSync(file)) return null;
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
// Every line needs a project: the X-Project header, else a `project` field in
// the line. A request with any line lacking one is rejected with 400 and
// nothing is written. Session id comes from the X-Session-Id header, else a
// `sessionId` field in each line, else "default". Lines are appended to
// <dataDir>/<project>/<sessionId>.jsonl.
// When `token` is set, requests must carry `Authorization: Bearer <token>`.
// When `pluginDir` is set, GET /plugin answers a tar.gz of that directory
// (no auth: cloud setup scripts cannot read secrets, and the plugin is code,
// not data).
// When `uiFile` is set, GET / serves it, and these answer JSON for it (the
// Electron app uses IPC instead):
//   GET /search?q=[&project=]       search hits over `searchDirs`, or one project
//   GET /projects                   project names ('' = legacy files with no project)
//   GET /sessions[?project=]        session metadata, newest first
//   GET /session?project=&id=       one session's lines
// `project` absent means every project; present and empty means no project.
// When `uiUser` is set, those routes require HTTP basic auth.
// GET /healthz always answers 200, unauthenticated, for probes.
const UI_ROUTES = new Set(['/', '/search', '/projects', '/sessions', '/session']);

function createIngestServer({
  dataDir, port, host = '127.0.0.1', token, pluginDir,
  uiFile, searchDirs = [dataDir], maxResults = 200, uiUser, uiPass,
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
      case '/':
        fs.readFile(uiFile, (err, html) => {
          if (err) {
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end('ui missing\n');
            return;
          }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(html);
        });
        return;
      case '/search':
        searchJsonl({
          dirs: project === null ? searchDirs : [projectDir(dataDir, project)],
          query: params.get('q') || '',
          maxResults,
          dataDir,
          recursive: project !== '',
        })
          .then((hits) => sendJson(res, 200, hits))
          .catch(fail);
        return;
      case '/projects':
        sendJson(res, 200, listProjects(dataDir));
        return;
      case '/sessions':
        try {
          sendJson(res, 200, listSessions({ dataDir, project }));
        } catch (_) {
          fail();
        }
        return;
      case '/session':
        if (!params.get('id')) {
          sendJson(res, 400, { error: 'id is required' });
          return;
        }
        readSession({ dataDir, project: project || '', id: params.get('id') })
          .then((s) => (s ? sendJson(res, 200, s) : sendJson(res, 404, { error: 'no such session' })))
          .catch(fail);
        return;
      default:
        fail();
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
    if (req.method === 'GET' && uiFile && UI_ROUTES.has(route)) {
      if (!uiAuthorized(req)) {
        res.writeHead(401, { 'content-type': 'text/plain', 'www-authenticate': 'Basic realm="scry"' });
        res.end('authentication required\n');
        return;
      }
      handleUi(req, res, url);
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
    if (token && !safeEqual(req.headers.authorization || '', `Bearer ${token}`)) {
      sendJson(res, 401, { error: 'missing or invalid bearer token' });
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

// For a file stored by ingestion, its { project, session }; null otherwise.
function locateSession(dataDir, file) {
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
async function searchJsonl({ dirs, query, maxResults = 200, dataDir, recursive = true }) {
  const q = query.toLowerCase();
  const results = [];
  if (!q) return results;

  const seen = new Set();
  for (const dir of dirs) {
    for (const file of listJsonlFiles(dir, recursive)) {
      if (seen.has(file)) continue;
      seen.add(file);
      const where = locateSession(dataDir, file);
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
  listProjects, listSessions, readSession, projectDir,
};
