// Local search index for the desktop app: which session files contain which
// words, so a search scans only the files that can match instead of every
// transcript on disk.
//
// Search stays a case-insensitive substring match over raw lines; the index
// only narrows the files. It is sound for that: every maximal run of word
// characters in the query lies inside one word of any line containing the
// query, so a file can match only if, for every query token, some indexed
// word of the file contains it. Files with a word too long to index are
// always scanned.
//
// It is incremental: each file's indexed byte offset is kept, and update()
// reads only bytes appended since (session files are append-only: sync and
// Claude Code only append). A file that shrank is re-indexed from scratch.
// Saved to `file` as JSON, so a restart does not re-read everything.
const fs = require('fs');
const path = require('path');

const VERSION = 1;
const MAX_WORD = 64;
const CHUNK = 1024 * 1024;
const WORD = /[\p{L}\p{N}_]+/gu;

function tokens(text) {
  return text.toLowerCase().match(WORD) || [];
}

// Inserts n into a sorted array of ids, unless present.
function addSorted(arr, n) {
  let lo = 0;
  let hi = arr.length;
  if (hi && arr[hi - 1] < n) { arr.push(n); return; }
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < n) lo = mid + 1; else hi = mid;
  }
  if (arr[lo] !== n) arr.splice(lo, 0, n);
}

// .jsonl files under dir (recursively).
function jsonlFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  }
  return out;
}

class SearchIndex {
  constructor({ file, dirs }) {
    this.file = file;
    this.dirs = dirs;
    this.reset();
    this.load();
    this.running = null;
    this.dirty = false;
  }

  reset() {
    this.files = new Map(); // path -> { id, offset, long }
    this.paths = []; // id -> path (null when dropped)
    this.words = new Map(); // word -> sorted file ids
  }

  load() {
    if (!this.file) return;
    let data;
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) { return; }
    if (!data || data.version !== VERSION) return;
    this.paths = data.paths;
    for (const [p, f] of Object.entries(data.files)) this.files.set(p, f);
    for (const [w, ids] of Object.entries(data.words)) this.words.set(w, ids);
  }

  save() {
    if (!this.file || !this.dirty) return;
    const data = {
      version: VERSION,
      paths: this.paths,
      files: Object.fromEntries(this.files),
      words: Object.fromEntries(this.words),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }

  // Forgets a file (it shrank or vanished): its id is retired, so stale
  // postings point nowhere and are ignored.
  drop(p) {
    const f = this.files.get(p);
    if (!f) return;
    this.paths[f.id] = null;
    this.files.delete(p);
    this.dirty = true;
  }

  // Indexes new bytes of every file under `dirs`. Concurrent calls share one run.
  update() {
    if (!this.running) {
      this.running = this.run().finally(() => { this.running = null; });
    }
    return this.running;
  }

  async run() {
    const seen = new Set();
    let indexed = 0;
    for (const dir of this.dirs) {
      for (const p of jsonlFiles(dir)) {
        seen.add(p);
        let size;
        try { size = fs.statSync(p).size; } catch (_) { continue; }
        let f = this.files.get(p);
        if (f && size < f.offset) { this.drop(p); f = null; }
        if (!f) {
          f = { id: this.paths.length, offset: 0, long: false };
          this.paths.push(p);
          this.files.set(p, f);
          this.dirty = true;
        }
        if (size > f.offset) indexed += await this.indexFile(p, f, size);
      }
    }
    for (const p of [...this.files.keys()]) if (!seen.has(p)) this.drop(p);
    // Compact when many ids are retired.
    const dead = this.paths.filter((x) => x === null).length;
    if (dead > 1000 && dead > this.paths.length / 2) this.compact();
    this.save();
    return indexed;
  }

  // Reads [offset, size) in chunks, indexing whole lines only.
  async indexFile(p, f, size) {
    let fh;
    try { fh = await fs.promises.open(p, 'r'); } catch (_) { return 0; }
    let pos = f.offset;
    let carry = '';
    let n = 0;
    try {
      const buf = Buffer.alloc(CHUNK);
      while (pos < size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - pos), pos);
        if (!bytesRead) break;
        pos += bytesRead;
        const text = carry + buf.toString('utf8', 0, bytesRead);
        const cut = text.lastIndexOf('\n');
        if (cut === -1) { carry = text; continue; }
        carry = text.slice(cut + 1);
        this.addText(f, text.slice(0, cut));
        // Offset after the last complete line; a partial line is re-read next time.
        f.offset = pos - Buffer.byteLength(carry);
        n++;
      }
    } finally {
      await fh.close();
    }
    this.dirty = true;
    return n;
  }

  addText(f, text) {
    const unique = new Set(tokens(text));
    for (const w of unique) {
      if (w.length > MAX_WORD) { f.long = true; continue; }
      let ids = this.words.get(w);
      if (!ids) { ids = []; this.words.set(w, ids); }
      addSorted(ids, f.id);
    }
  }

  compact() {
    const old = this.paths;
    const remap = new Map();
    this.paths = [];
    for (const [p, f] of this.files) {
      remap.set(f.id, this.paths.length);
      f.id = this.paths.length;
      this.paths.push(p);
    }
    for (const [w, ids] of this.words) {
      const next = ids.filter((id) => remap.has(id)).map((id) => remap.get(id)).sort((a, b) => a - b);
      if (next.length) this.words.set(w, next); else this.words.delete(w);
    }
    this.dirty = old.length !== this.paths.length;
  }

  // The files that can contain `query` as a substring (case-insensitive), or
  // null when the query has no word characters (scan everything).
  candidates(query) {
    const qt = [...new Set(tokens(query))];
    if (!qt.length) return null;
    let result = null;
    for (const t of qt) {
      const ids = new Set();
      for (const [w, list] of this.words) {
        if (w.includes(t)) for (const id of list) ids.add(id);
      }
      result = result === null ? ids : new Set([...result].filter((id) => ids.has(id)));
      if (!result.size) break;
    }
    const out = new Set();
    for (const id of result || []) if (this.paths[id]) out.add(this.paths[id]);
    for (const [p, f] of this.files) if (f.long) out.add(p);
    return out;
  }
}

module.exports = { SearchIndex, tokens };
