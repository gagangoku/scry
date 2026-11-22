const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');
const { execFile } = require('child_process');

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
function createIngestServer({ dataDir, port, host = '127.0.0.1', token, pluginDir }) {
  fs.mkdirSync(dataDir, { recursive: true });

  const server = http.createServer((req, res) => {
    const route = req.url.split('?')[0];
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
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing or invalid bearer token' }) + '\n');
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
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
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ appended }) + '\n');
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
