// scry's end-to-end encryption, as Node code. The same scheme is implemented
// with WebCrypto in public/app.html (the viewer) and
// claude-chat-logger/hooks/register.ts (the sender); keep the three in step.
//
// A project's token never reaches the server. From it a client derives, with
// HKDF-SHA256 (salt "scry"):
//   authKey = HKDF(token, info "scry/v1/auth")  sent to the server as the
//             credential; the server stores only SHA-256(authKey)
//   kek     = HKDF(token, info "scry/v1/kek")   never leaves the client
// The project's data key is 32 random bytes made by the client that created
// the project. The server stores it only wrapped by the kek:
//   wrappedKey = b64url(iv || AES-256-GCM(kek, dataKey, aad "scry/v1/key:<project>"))
// Every stored line is an envelope encrypted with the data key:
//   {"v":1,"iv":"<b64url 12 bytes>","ct":"<b64url ciphertext+tag>"}
//   aad "scry/v1/line:<project>"
// Replacing a token rewraps the same data key under the new token's kek, so
// existing sessions stay readable with the new token and no data is rewritten.
const crypto = require('crypto');

const SALT = Buffer.from('scry');
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

function hkdf(token, info) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(String(token), 'utf8'), SALT, Buffer.from(info), 32));
}

function newToken() {
  return 'scry_' + crypto.randomBytes(32).toString('base64url');
}

// What a client sends to authenticate as the token's holder.
const authKeyFor = (token) => b64u(hkdf(token, 'scry/v1/auth'));
const kekFor = (token) => hkdf(token, 'scry/v1/kek');
// What the server stores for an auth key.
const hashAuthKey = (authKey) => crypto.createHash('sha256').update(String(authKey)).digest('hex');

function seal(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
  return { iv, ct };
}

function open(key, iv, ct, aad) {
  if (ct.length < 16) throw new Error('ciphertext too short');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
}

function wrapKey(token, project, dataKey) {
  const { iv, ct } = seal(kekFor(token), dataKey, `scry/v1/key:${project}`);
  return b64u(Buffer.concat([iv, ct]));
}

function unwrapKey(token, project, wrappedKey) {
  const buf = unb64u(wrappedKey);
  return open(kekFor(token), buf.subarray(0, 12), buf.subarray(12), `scry/v1/key:${project}`);
}

// A new project's credentials: { token, authKey, wrappedKey, dataKey }.
function newProjectKeys(project) {
  const token = newToken();
  const dataKey = crypto.randomBytes(32);
  return { token, authKey: authKeyFor(token), wrappedKey: wrapKey(token, project, dataKey), dataKey };
}

// One plaintext line in, one envelope line (a JSON string) out.
function encryptLine(dataKey, project, line) {
  const { iv, ct } = seal(dataKey, Buffer.from(line, 'utf8'), `scry/v1/line:${project}`);
  return JSON.stringify({ v: 1, iv: b64u(iv), ct: b64u(ct) });
}

// The parsed envelope of a stored line, or null when it is not one.
function parseEnvelope(line) {
  let o;
  try { o = typeof line === 'string' ? JSON.parse(line) : line; } catch (_) { return null; }
  if (!o || typeof o !== 'object' || o.v !== 1) return null;
  if (typeof o.iv !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(o.iv)) return null;
  if (typeof o.ct !== 'string' || !/^[A-Za-z0-9_-]{22,}$/.test(o.ct)) return null;
  return { v: 1, iv: o.iv, ct: o.ct };
}

function decryptLine(dataKey, project, line) {
  const env = parseEnvelope(line);
  if (!env) throw new Error('not an encrypted line');
  return open(dataKey, unb64u(env.iv), unb64u(env.ct), `scry/v1/line:${project}`).toString('utf8');
}

module.exports = {
  newToken, authKeyFor, hashAuthKey, wrapKey, unwrapKey, newProjectKeys,
  encryptLine, decryptLine, parseEnvelope,
};
