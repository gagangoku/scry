#!/usr/bin/env node
// Client-side helpers for scry's end-to-end encryption (lib/crypto.js).
// The token is read from the SCRY_INGEST_TOKEN environment variable, never
// from the command line, so it does not show up in `ps` or shell history.
//
//   scry-crypt auth-key
//       Prints the auth key to send as `Authorization: Bearer <authKey>`.
//
//   scry-crypt encrypt
//       Encrypts JSONL lines from stdin to stdout, for POSTing to /ingest.
//       Needs SCRY_INGEST_URL (…/ingest) to fetch the project's wrapped key.
//
//   scry-crypt decrypt
//       Decrypts stored lines (a session file) from stdin to stdout. Needs
//       SCRY_INGEST_URL, or --data-dir to read the wrapped key from disk.
//
//   scry-crypt migrate --data-dir <dir> --project <name>
//       Encrypts, in place, the plaintext lines of every session file in a
//       project (files written before scry was end-to-end encrypted). Run it on
//       the server's disk once the project has a token from the app. Lines
//       already encrypted are left as they are.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const sc = require('../lib/crypto');
const { registryFile } = require('../lib/core');

function usage(msg) {
  if (msg) console.error(`scry-crypt: ${msg}`);
  console.error('usage: scry-crypt auth-key | encrypt | decrypt [--data-dir D] | migrate --data-dir D --project P');
  console.error('       (token in SCRY_INGEST_TOKEN; encrypt/decrypt also use SCRY_INGEST_URL)');
  process.exit(2);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] || usage(`${name} needs a value`);
}

const token = (process.env.SCRY_INGEST_TOKEN || '').trim();

// { project, dataKey } from the registry on disk, or from the server.
async function projectKey() {
  const dataDir = arg('--data-dir');
  const authKey = sc.authKeyFor(token);
  let project;
  let wrappedKey;
  if (dataDir) {
    const reg = JSON.parse(fs.readFileSync(registryFile(dataDir), 'utf8')).projects || {};
    const want = sc.hashAuthKey(authKey);
    project = Object.keys(reg).find((p) => reg[p] && reg[p].authHash === want);
    if (!project) throw new Error('no project in that data dir has this token');
    if (arg('--project') && arg('--project') !== project) {
      throw new Error(`this token belongs to "${project}", not "${arg('--project')}"`);
    }
    wrappedKey = reg[project].wrappedKey;
  } else {
    const url = process.env.SCRY_INGEST_URL;
    if (!url) usage('set SCRY_INGEST_URL, or pass --data-dir');
    const res = await fetch(url.replace(/\/+$/, '') + '/key', { headers: { authorization: `Bearer ${authKey}` } });
    if (!res.ok) throw new Error(`GET ${url}/key: HTTP ${res.status}`);
    ({ project, wrappedKey } = await res.json());
  }
  return { project, dataKey: sc.unwrapKey(token, project, wrappedKey) };
}

async function eachStdinLine(fn) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) process.stdout.write(fn(line.trim()) + '\n');
}

async function migrate() {
  const dataDir = arg('--data-dir') || usage('migrate needs --data-dir');
  if (!arg('--project')) usage('migrate needs --project');
  const { project, dataKey } = await projectKey();
  const dir = path.join(dataDir, project);
  let files = 0;
  let encrypted = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let changed = 0;
    const out = lines.map((l) => {
      if (!l.trim() || sc.parseEnvelope(l)) return l;
      changed++;
      return sc.encryptLine(dataKey, project, l.trim());
    });
    if (!changed) continue;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, out.join('\n'));
    fs.renameSync(tmp, file);
    files++;
    encrypted += changed;
  }
  console.error(`scry-crypt: encrypted ${encrypted} line(s) in ${files} file(s) of "${project}"`);
}

(async () => {
  const cmd = process.argv[2];
  if (!['auth-key', 'encrypt', 'decrypt', 'migrate'].includes(cmd)) usage();
  if (!token) usage('set SCRY_INGEST_TOKEN to the project\'s token');
  if (cmd === 'auth-key') {
    console.log(sc.authKeyFor(token));
  } else if (cmd === 'encrypt') {
    const { project, dataKey } = await projectKey();
    await eachStdinLine((l) => sc.encryptLine(dataKey, project, l));
  } else if (cmd === 'decrypt') {
    const { project, dataKey } = await projectKey();
    await eachStdinLine((l) => (sc.parseEnvelope(l) ? sc.decryptLine(dataKey, project, l) : l));
  } else {
    await migrate();
  }
})().catch((err) => {
  console.error('scry-crypt:', err.message);
  process.exit(1);
});
