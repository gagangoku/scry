// The local search index: candidates must never miss a file containing the
// query (substring, case-insensitive); updates are incremental.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SearchIndex } = require('../lib/index');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scry-index-'));
  const dir = path.join(tmp, 'data');
  fs.mkdirSync(path.join(dir, 'p'), { recursive: true });
  const file = path.join(tmp, 'index.json');
  const a = path.join(dir, 'p', 'a.jsonl');
  const b = path.join(dir, 'p', 'b.jsonl');
  fs.writeFileSync(a, '{"prompt":"Migrate the Flamingo database"}\n');
  fs.writeFileSync(b, '{"prompt":"pelican service"}\n{"partial":"no newline yet');

  let idx = new SearchIndex({ file, dirs: [dir] });
  await idx.update();
  const has = (q, p) => idx.candidates(q).has(p);
  assert.ok(has('flamingo', a) && !has('flamingo', b));
  assert.ok(has('LAMIN', a), 'infix, case-insensitive');
  assert.ok(has('the flam', a), 'across words');
  assert.ok(has('pelican serv', b) && !has('pelican', a));
  assert.strictEqual(idx.candidates('...'), null, 'no word characters: scan all');
  // A partial last line is not indexed until it is complete
  assert.ok(!has('newline', b));
  fs.appendFileSync(b, '"}\n');
  await idx.update();
  assert.ok(has('newline', b), 'completed line indexed');

  // Appends are indexed incrementally, and survive a reload from disk
  fs.appendFileSync(a, '{"response":"zebra crossing"}\n');
  await idx.update();
  idx = new SearchIndex({ file, dirs: [dir] });
  assert.ok(has('zebra', a) && has('flamingo', a), 'reloaded');
  // A file that shrank is re-indexed from scratch
  fs.writeFileSync(a, '{"prompt":"only giraffes now"}\n');
  await idx.update();
  assert.ok(has('giraffe', a) && !has('flamingo', a));
  // Deleted files drop out
  fs.rmSync(b);
  await idx.update();
  assert.strictEqual(idx.candidates('pelican').size, 0);
  // Words too long to index keep their file a candidate for everything
  const c = path.join(dir, 'p', 'c.jsonl');
  fs.writeFileSync(c, `{"blob":"${'x'.repeat(100)}yz"}\n`);
  await idx.update();
  assert.ok(has('xyz', c));

  // Never a false negative, on random text and random substrings
  const words = ['alpha', 'beta', 'gamma', 'Δelta', 'eps_ilon', '42', 'zeta-eta', 'Θήτα', 'iota.kappa'];
  const rnd = (n) => Math.floor(Math.random() * n);
  for (let i = 0; i < 30; i++) {
    const line = Array.from({ length: 6 }, () => words[rnd(words.length)]).join(rnd(2) ? ' ' : '/');
    fs.writeFileSync(path.join(dir, 'p', `r${i}.jsonl`), JSON.stringify({ t: line }) + '\n');
  }
  await idx.update();
  for (let i = 0; i < 300; i++) {
    const f = path.join(dir, 'p', `r${rnd(30)}.jsonl`);
    const text = fs.readFileSync(f, 'utf8').trim();
    const start = rnd(text.length - 1);
    const q = text.slice(start, start + 1 + rnd(12));
    const cand = idx.candidates(q);
    assert.ok(cand === null || cand.has(f), `missed ${JSON.stringify(q)} in ${text}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('index test passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
