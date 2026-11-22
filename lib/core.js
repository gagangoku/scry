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

// Directory for a project.
function projectDir(dataDir, project) {
  return path.join(dataDir, sanitizeName(project));
}

// ---------- project registry ----------
// Projects live in <dataDir>/.scry/projects.json. scry is zero-trust: a
// project's token is made in the browser and never sent here (see
// lib/crypto.js). The registry holds, per project, the SHA-256 of the auth key
// derived from the token and the project's data key wrapped by a key only the
// token can derive. Nothing on disk lets the server, or anyone with the disk,
// decrypt a session.
// Project names never start with '.', so the registry dir is never a project.
const REGISTRY_DIR = '.scry';
const { hashAuthKey, parseEnvelope } = require('./crypto');

// An auth key is 32 bytes, a wrapped key 12 (iv) + 32 (key) + 16 (tag), both base64url.
const AUTH_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const WRAPPED_KEY_RE = /^[A-Za-z0-9_-]{80}$/;

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

function validKeys({ authKey, wrappedKey } = {}) {
  if (typeof authKey !== 'string' || !AUTH_KEY_RE.test(authKey)
    || typeof wrappedKey !== 'string' || !WRAPPED_KEY_RE.test(wrappedKey)) {
    throw new ProjectError(400, 'send the authKey and wrappedKey derived from a new token (the scry app does this)');
  }
  return { authHash: hashAuthKey(authKey), wrappedKey };
}

// An encrypted project's record has an authHash; older records (a SHA-256 of
// the token itself, from before encryption) and bare folders have none.
const isKeyed = (p) => Boolean(p && typeof p.authHash === 'string' && typeof p.wrappedKey === 'string');

// Creates a project from client-made keys and answers { name, createdAt }.
function createProject(dataDir, name, keys, localProjects = {}) {
  const clean = validProjectName(name);
  if (Object.hasOwn(localProjects, clean)) throw new ProjectError(409, `project "${clean}" already exists`);
  const { authHash, wrappedKey } = validKeys(keys);
  const reg = loadRegistry(dataDir);
  if (reg.projects[clean] || fs.existsSync(path.join(dataDir, clean))) {
    throw new ProjectError(409, `project "${clean}" already exists`);
  }
  const createdAt = new Date().toISOString();
  fs.mkdirSync(path.join(dataDir, clean), { recursive: true });
  reg.projects[clean] = { v: 2, authHash, wrappedKey, createdAt, tokenCreatedAt: createdAt };
  saveRegistry(dataDir, reg);
  return { name: clean, createdAt };
}

// Replaces a project's token with a new one made by the client. The new
// wrappedKey must wrap the same data key, so the caller has to hold the
// current token: `currentAuthKey` must match, unless the project has no key
// yet (a folder or registry entry from before encryption).
function rotateProjectToken(dataDir, name, keys, currentAuthKey, localProjects = {}) {
  const clean = validProjectName(name);
  if (Object.hasOwn(localProjects, clean)) {
    throw new ProjectError(400, `"${clean}" is read from local files and takes no token`);
  }
  const reg = loadRegistry(dataDir);
  const existing = reg.projects[clean];
  if (!existing && !fs.existsSync(path.join(dataDir, clean))) {
    throw new ProjectError(404, `no project "${clean}"`);
  }
  if (isKeyed(existing) && !(currentAuthKey && safeEqual(existing.authHash, hashAuthKey(currentAuthKey)))) {
    throw new ProjectError(403, `unlock "${clean}" with its current token to replace it`);
  }
  const { authHash, wrappedKey } = validKeys(keys);
  const now = new Date().toISOString();
  reg.projects[clean] = {
    v: 2,
    authHash,
    wrappedKey,
    createdAt: (existing && existing.createdAt) || now,
    tokenCreatedAt: now,
  };
  fs.mkdirSync(path.join(dataDir, clean), { recursive: true });
  saveRegistry(dataDir, reg);
  return { name: clean, createdAt: reg.projects[clean].createdAt };
}

// The project an auth key belongs to, or null.
function projectForAuthKey(dataDir, authKey) {
  if (!authKey) return null;
  const h = hashAuthKey(authKey);
  for (const [name, p] of Object.entries(loadRegistry(dataDir).projects)) {
    if (isKeyed(p) && safeEqual(p.authHash, h)) return name;
  }
  return null;
}

// The wrapped data key of a project, for a client holding its auth key.
function wrappedKeyFor(dataDir, project) {
  const p = loadRegistry(dataDir).projects[project];
  return isKeyed(p) ? p.wrappedKey : null;
}

// Project names on disk or in the registry.
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
  return [...names].sort();
}

// ---------- local projects ----------
// A local project is a read-only view of Claude Code's own transcripts on this
// machine: `localProjects` maps a project name (e.g. "claude-code-local") to a
// dir like ~/.claude/projects, whose sessions are <dir>/<cwd-folder>/<id>.jsonl.
// Those files are Claude Code's, already plaintext on the machine serving
// them (only the desktop app configures one), not scry's encrypted store: they
// need no token and are served and searched as they are. Nothing is ingested
// into a local project. Its name shadows a data dir folder of the same name.
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

// listProjects with registry details: [{ name, hasKey, createdAt, tokenCreatedAt, local }].
// hasKey false means the project has no token yet and cannot be read or
// written; local projects need none.
function projectInfo(dataDir, localProjects = {}) {
  const reg = loadRegistry(dataDir).projects;
  const local = Object.keys(localProjects).sort();
  return [
    ...listProjects(dataDir).filter((name) => !local.includes(name)).map((name) => {
      const p = reg[name];
      return {
        name,
        hasKey: isKeyed(p),
        createdAt: (p && p.createdAt) || null,
        tokenCreatedAt: (isKeyed(p) && p.tokenCreatedAt) || null,
        local: false,
      };
    }),
    ...local.map((name) => ({ name, hasKey: false, createdAt: null, tokenCreatedAt: null, local: true })),
  ];
}

// The first lines of a session, enough for the client to find its title and
// start time once decrypted: complete lines from the first HEAD_BYTES, at most
// HEAD_LINES of them, stopping once HEAD_SOFT_BYTES are collected.
const HEAD_LINES = 3;
const HEAD_SOFT_BYTES = 16 * 1024;
function readHeadLines(file, size, maxLines = HEAD_LINES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(HEAD_BYTES, size));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const parts = buf.subarray(0, n).toString('utf8').split('\n');
    if (n < size) parts.pop(); // last piece may be cut off
    const out = [];
    let bytes = 0;
    for (const l of parts) {
      if (!l.trim()) continue;
      out.push(l);
      bytes += l.length;
      if (out.length >= maxLines || (maxLines === HEAD_LINES && bytes >= HEAD_SOFT_BYTES)) break;
    }
    return out;
  } catch (_) {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Text of a user prompt in either the chat-logger format or a raw Claude Code
// transcript line; '' when the line is not a user prompt. Used for local
// projects only: everything else is encrypted, and the client does this.
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
// remote_session_id. For encrypted sessions only the id is visible here; the
// client finds remote_session_id once it has decrypted the lines.
function webUrlFor(id, remoteId) {
  const sid = WEB_SESSION_ID.test(id) ? id : (typeof remoteId === 'string' && WEB_SESSION_ID.test(remoteId) ? remoteId : null);
  return sid ? `https://claude.ai/code/${sid}` : null;
}

// Metadata of a session file. With `plaintext` (local projects), also its
// title, first timestamp and web chat URL, read from its first lines.
function sessionMeta(file, project, plaintext = false) {
  const stat = fs.statSync(file);
  const id = path.basename(file, '.jsonl');
  const meta = {
    project,
    id,
    webUrl: webUrlFor(id),
    createdAt: (stat.birthtimeMs ? stat.birthtime : stat.ctime).toISOString(),
    updatedAt: stat.mtime.toISOString(),
    size: stat.size,
  };
  if (!plaintext) return meta;
  let title = '';
  let createdAt = null;
  for (const line of readHeadLines(file, stat.size, Infinity)) {
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }
    if (!meta.webUrl && obj) meta.webUrl = webUrlFor(id, obj.remote_session_id);
    if (!createdAt) {
      const ts = obj && (obj.ts || obj.timestamp);
      if (ts && !Number.isNaN(Date.parse(ts))) createdAt = new Date(ts).toISOString();
    }
    if (!title) title = promptText(obj).trim().replace(/\s+/g, ' ').slice(0, 160);
    if (createdAt && title && meta.webUrl) break;
  }
  return { ...meta, title, createdAt: createdAt || meta.createdAt };
}

// Sessions in one project, newest activity first. Each carries `head`, its
// first few stored (encrypted) lines; titles exist only once a client decrypts them.
function listSessions({ dataDir, project, localProjects = {} }) {
  if (isLocal(localProjects, project)) {
    const out = [];
    for (const file of localSessionFiles(localProjects[project])) {
      try { out.push(sessionMeta(file, project, true)); } catch (_) { /* vanished mid-listing */ }
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }
  const dir = projectDir(dataDir, project);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    try {
      const file = path.join(dir, e.name);
      const meta = sessionMeta(file, project);
      out.push({ ...meta, head: readHeadLines(file, meta.size) });
    } catch (_) { /* vanished mid-listing */ }
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return out;
}

// Every stored line of one session as { line, raw }; the client decrypts
// (lines of a local project are plaintext). Answers null when the session does
// not exist.
async function readSession({ dataDir, project, id, localProjects = {} }) {
  const name = sanitizeSessionId(id) + '.jsonl';
  const local = isLocal(localProjects, project);
  const file = local
    ? localSessionFiles(localProjects[project]).find((f) => path.basename(f) === name)
    : path.join(projectDir(dataDir, project), name);
  if (!file || !fs.existsSync(file)) return null;
  const meta = sessionMeta(file, project, local);
  const lines = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (line.trim()) lines.push({ line: lineNo, raw: line });
  }
  return { ...meta, lines };
}

// HTTP server.
//
// Project credentials: a client proves it holds a project's token by sending
// the auth key derived from it (lib/crypto.js), as `Authorization: Bearer
// <authKey>` or `X-Scry-Key: <authKey>`. The UI routes use X-Scry-Key, since
// Authorization carries basic auth there.
//
// POST /ingest takes JSONL lines that are already encrypted envelopes
// ({"v":1,"iv","ct"}), authenticated with a project's auth key (401
// otherwise). Plaintext lines are refused with 400, so nothing readable ever
// reaches the disk. The project is the auth key's; an X-Project header naming
// another gets 403. Session id comes from the X-Session-Id header, else a
// `sessionId` field next to the envelope, else "default". Any bad line rejects
// the whole request. Lines are appended to <dataDir>/<project>/<sessionId>.jsonl.
// GET /ingest/key answers { project, wrappedKey } for the auth key's project:
// a sender unwraps the data key with its token, then encrypts.
// When `pluginDir` is set, GET /plugin answers a tar.gz of that directory
// (no auth: cloud setup scripts cannot read secrets, and the plugin is code,
// not data).
// When `landingFile` is set, GET / serves it, unauthenticated (the public
// landing page); otherwise GET / redirects to /app. When `publicDir` is set,
// the files in PUBLIC_FILES (favicons) are served from it, unauthenticated.
// When `uiFile` is set, GET /app serves it (the sessions viewer), and these
// answer JSON for it:
//   GET /projects                   [{ name, hasKey, createdAt, tokenCreatedAt }]
//   POST /projects {name, authKey, wrappedKey}
//                                   create a project from keys the client made
//   POST /projects/token {name, authKey, wrappedKey}
//                                   replace its token; X-Scry-Key must carry the
//                                   current auth key once the project has one
//   GET /sessions?project=          that project's sessions, newest first,
//                                   each with its first encrypted lines (`head`)
//   GET /session?project=&id=       one session's encrypted lines
//   GET /search?q=[&project=]       search hits in local projects (all of them,
//                                   or one); encrypted projects are searched
//                                   by the client
// /sessions and /session need the project's auth key in X-Scry-Key (401/403),
// except for local projects (`localProjects`: Claude Code's own plaintext
// transcripts on this machine, read-only, in the desktop app).
// When `uiUser` is set, these routes also require HTTP basic auth. The POST
// routes only take application/json, so a cross-site form cannot drive them.
// GET /healthz always answers 200, unauthenticated, for probes.
// GET /version answers `buildInfo` (version, build, commit, builtAt, ...) as
// JSON, unauthenticated: it names the build, not any data.
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

// The auth key a request carries in X-Scry-Key, or (when `bearer`) as a
// bearer token; '' when none.
function presentedAuthKey(req, bearer) {
  const h = req.headers['x-scry-key'];
  if (typeof h === 'string' && h.trim()) return h.trim();
  if (bearer) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (m) return m[1].trim();
  }
  return '';
}

function createIngestServer({
  dataDir, port, host = '127.0.0.1', pluginDir,
  uiFile, landingFile, publicDir, uiUser, uiPass, localProjects = {}, maxResults = 200, buildInfo = {},
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

  // Whether the request holds `project`'s key; sends 400/401/403 when not.
  const projectAuthorized = (req, res, project) => {
    if (!project) {
      sendJson(res, 400, { error: 'project is required' });
      return false;
    }
    if (isLocal(localProjects, project)) return true;
    const authKey = presentedAuthKey(req, false);
    if (!authKey) {
      sendJson(res, 401, { error: `unlock "${project}" with its token` });
      return false;
    }
    if (projectForAuthKey(dataDir, authKey) !== project) {
      sendJson(res, 403, { error: `that token does not unlock "${project}"` });
      return false;
    }
    return true;
  };

  const handleUi = (req, res, url) => {
    const route = url.pathname;
    const params = url.searchParams;
    const project = sanitizeProject(params.get('project'));
    const fail = () => sendJson(res, 500, { error: `${route.slice(1)} failed` });
    switch (route) {
      case '/app':
        sendFile(res, uiFile, 'text/html; charset=utf-8', 'no-store');
        return;
      case '/projects':
        sendJson(res, 200, projectInfo(dataDir, localProjects));
        return;
      case '/search': {
        const names = project ? [project] : Object.keys(localProjects);
        if (names.some((n) => !isLocal(localProjects, n))) {
          sendJson(res, 400, { error: 'only local projects are searched here; encrypted ones are searched in the browser' });
          return;
        }
        searchJsonl({ localProjects, names, query: params.get('q') || '', maxResults })
          .then((hits) => sendJson(res, 200, hits))
          .catch(fail);
        return;
      }
      case '/sessions':
        if (!projectAuthorized(req, res, project)) return;
        try {
          sendJson(res, 200, listSessions({ dataDir, project, localProjects }));
        } catch (_) {
          fail();
        }
        return;
      case '/session':
        if (!projectAuthorized(req, res, project)) return;
        if (!params.get('id')) {
          sendJson(res, 400, { error: 'id is required' });
          return;
        }
        readSession({ dataDir, project, id: params.get('id'), localProjects })
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
    const name = String(body.name || '');
    const keys = { authKey: body.authKey, wrappedKey: body.wrappedKey };
    try {
      if (route === '/projects') sendJson(res, 201, createProject(dataDir, name, keys, localProjects));
      else sendJson(res, 200, rotateProjectToken(dataDir, name, keys, presentedAuthKey(req, false), localProjects));
    } catch (err) {
      if (err instanceof ProjectError) sendJson(res, err.status, { error: err.message });
      else sendJson(res, 500, { error: 'project update failed' });
    }
  };

  const ingest = (req, res, tokenProject) => {
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
      if (headerProject && headerProject !== tokenProject) {
        sendJson(res, 403, { error: `X-Project is "${headerProject}", but the token is for "${tokenProject}"` });
        return;
      }
      // Resolve every line first, so a request with one bad line writes nothing.
      const writes = [];
      let lineNo = 0;
      for (const rawLine of body.split('\n')) {
        lineNo++;
        const line = rawLine.trim();
        if (!line) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch (_) { parsed = null; }
        const env = parseEnvelope(parsed);
        if (!env) {
          sendJson(res, 400, {
            error: `line ${lineNo} is not encrypted: scry only stores lines encrypted with the project's key (see lib/crypto.js)`,
          });
          return;
        }
        const session = sanitizeSessionId(headerSession || (typeof parsed.sessionId === 'string' && parsed.sessionId) || 'default');
        // Store the envelope alone, so nothing sent alongside it lands on disk.
        writes.push({ file: session + '.jsonl', line: JSON.stringify(env) });
      }
      const dir = path.join(dataDir, tokenProject);
      try {
        fs.mkdirSync(dir, { recursive: true });
        for (const w of writes) fs.appendFileSync(path.join(dir, w.file), w.line + '\n');
      } catch (_) {
        sendJson(res, 500, { error: 'write failed' });
        return;
      }
      sendJson(res, 200, { appended: writes.length });
    });
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;
    if (req.method === 'GET' && route === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok\n');
      return;
    }
    if (req.method === 'GET' && route === '/version') {
      sendJson(res, 200, buildInfo);
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
    const isKeyRoute = req.method === 'GET' && route === '/ingest/key';
    if (!isKeyRoute && (req.method !== 'POST' || route !== '/ingest')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('POST encrypted JSONL lines to /ingest\n');
      return;
    }
    const tokenProject = projectForAuthKey(dataDir, presentedAuthKey(req, true));
    if (!tokenProject) {
      sendJson(res, 401, { error: 'missing or invalid project key: create a project in scry and send the auth key derived from its token' });
      return;
    }
    if (isKeyRoute) {
      sendJson(res, 200, { project: tokenProject, wrappedKey: wrappedKeyFor(dataDir, tokenProject) }, { 'cache-control': 'no-store' });
      return;
    }
    ingest(req, res, tokenProject);
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

function listJsonlFiles(dir) {
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
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
    }
  }
  return out;
}

// Case-insensitive substring search across every .jsonl file of the local
// projects `names`, subagent transcripts included. Hits in a listed session
// (<dir>/<folder>/<id>.jsonl) carry `project` and `session`; deeper ones only
// `file`. Encrypted projects cannot be searched here: the client does that.
async function searchJsonl({ localProjects, names, query, maxResults = 200 }) {
  const q = query.toLowerCase();
  const results = [];
  if (!q) return results;
  for (const name of names) {
    const root = localProjects[name];
    for (const file of listJsonlFiles(root)) {
      const depth = path.relative(root, file).split(path.sep).length;
      const where = depth <= 2 ? { project: name, session: path.basename(file, '.jsonl') } : {};
      const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
      let lineNo = 0;
      for await (const line of rl) {
        lineNo++;
        const idx = line.toLowerCase().indexOf(q);
        if (idx === -1) continue;
        const start = Math.max(0, idx - 60);
        results.push({
          file,
          line: lineNo,
          ...where,
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
  searchJsonl,
  createIngestServer, sanitizeSessionId, sanitizeProject,
  listProjects, projectInfo, createProject, rotateProjectToken, projectForAuthKey, wrappedKeyFor,
  ProjectError, listSessions, readSession, projectDir, registryFile, loadRegistry,
};
