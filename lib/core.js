const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');
const crypto = require('crypto');
const { execFile } = require('child_process');

// Largest /ingest body accepted; bigger requests get a 413.
const MAX_BODY_BYTES = 50 * 1024 * 1024;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sendJson(res, status, obj, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(obj) + '\n');
}

function sanitizeSessionId(id) {
  const clean = String(id).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
  return clean || 'default';
}

// HTTP server: POST /ingest with a body of JSONL lines.
// Session id comes from the X-Session-Id header, else a `sessionId`
// field in each line, else "default". Lines are appended to
// <dataDir>/<sessionId>.jsonl.
// When `token` is set, requests must carry `Authorization: Bearer <token>`.
// When `pluginDir` is set, GET /plugin answers a tar.gz of that directory
// (no auth: cloud setup scripts cannot read secrets, and the plugin is code,
// not data).
// When `uiFile` is set, GET / serves it and GET /search?q= answers search hits
// over `searchDirs` as JSON (the browser UI; the Electron app uses IPC instead).
// When `uiUser` is set, those two routes require HTTP basic auth.
// GET /healthz always answers 200, unauthenticated, for probes.
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

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;
    if (req.method === 'GET' && route === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok\n');
      return;
    }
    if (req.method === 'GET' && uiFile && (route === '/' || route === '/search')) {
      if (!uiAuthorized(req)) {
        res.writeHead(401, { 'content-type': 'text/plain', 'www-authenticate': 'Basic realm="scry"' });
        res.end('authentication required\n');
        return;
      }
      if (route === '/') {
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
      }
      searchJsonl({ dirs: searchDirs, query: url.searchParams.get('q') || '', maxResults })
        .then((hits) => sendJson(res, 200, hits))
        .catch(() => sendJson(res, 500, { error: 'search failed' }));
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
      let appended = 0;
      for (const rawLine of body.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        let session = headerSession;
        if (!session) {
          try { session = JSON.parse(line).sessionId; } catch (_) { /* keep default */ }
        }
        const file = path.join(dataDir, sanitizeSessionId(session || 'default') + '.jsonl');
        fs.appendFileSync(file, line + '\n');
        appended++;
      }
      sendJson(res, 200, { appended });
    });
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

// Case-insensitive substring search across every .jsonl file under `dirs`.
async function searchJsonl({ dirs, query, maxResults = 200 }) {
  const q = query.toLowerCase();
  const results = [];
  if (!q) return results;

  for (const dir of dirs) {
    for (const file of listJsonlFiles(dir)) {
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

module.exports = { createIngestServer, searchJsonl, sanitizeSessionId };
