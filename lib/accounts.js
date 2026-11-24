// User accounts for the hosted server: Google sign-in, browser sessions,
// plans and per-user storage metering. The desktop app and a server without
// SCRY_GOOGLE_CLIENT_ID never create an Accounts, and behave as before.
//
// Everything lives in <dataDir>/.scry/accounts.json:
//   users:    { [userId]: { id, email, name, picture, plan, createdAt, lastLoginAt,
//                           stripeCustomerId?, stripeSubscriptionId?, planUpdatedAt? } }
//   sessions: { [sha256(cookie token)]: { userId, expiresAt } }
// Only hashes of session tokens are stored, like project tokens.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MB = 1024 * 1024;
const GB = 1024 * MB;

// Plans are storage tiers: a plan caps the bytes of session files across all
// of a user's projects. Prices are what the UI and landing page show; the
// amount charged is whatever the Stripe price (STRIPE_PRICE_<PLAN>) says.
const DEFAULT_PLANS = {
  free: { id: 'free', name: 'Free', limitBytes: 20 * MB, monthlyUsd: 0, yearlyUsd: 0 },
  pro: { id: 'pro', name: 'Pro', limitBytes: 2 * GB, monthlyUsd: 5, yearlyUsd: 48 },
  max: { id: 'max', name: 'Max', limitBytes: 25 * GB, monthlyUsd: 15, yearlyUsd: 144 },
};

const SESSION_COOKIE = 'scry_session';
const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ---------- Google ID tokens ----------
// The browser signs in with Google Identity Services and posts the ID token
// (a JWT) here; we check its RS256 signature against Google's published keys
// and its issuer, audience (our client id), expiry and verified email.
const certCache = new Map(); // url -> { keys, expires }

async function googleKeys(url, force = false) {
  const hit = certCache.get(url);
  if (hit && !force && Date.now() < hit.expires) return hit.keys;
  const res = await fetch(url);
  if (!res.ok) throw new AuthError(`could not fetch Google signing keys (HTTP ${res.status})`, 502);
  const { keys } = await res.json();
  const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  certCache.set(url, { keys: Array.isArray(keys) ? keys : [], expires: Date.now() + (maxAge ? Number(maxAge[1]) * 1000 : 3600 * 1000) });
  return certCache.get(url).keys;
}

async function verifyGoogleIdToken(idToken, { clientId, certsUrl = GOOGLE_CERTS_URL, now = Date.now() }) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new AuthError('malformed Google credential');
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (_) {
    throw new AuthError('malformed Google credential');
  }
  if (header.alg !== 'RS256' || !header.kid) throw new AuthError('unsupported Google credential');
  let jwk = (await googleKeys(certsUrl)).find((k) => k.kid === header.kid);
  // Google rotates keys: on an unknown kid, refetch once.
  if (!jwk) jwk = (await googleKeys(certsUrl, true)).find((k) => k.kid === header.kid);
  if (!jwk) throw new AuthError('Google credential signed with an unknown key');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new AuthError('invalid Google credential signature');
  if (!GOOGLE_ISSUERS.has(payload.iss)) throw new AuthError('Google credential has the wrong issuer');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(clientId)) throw new AuthError('Google credential is for another app');
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < now - 60 * 1000) throw new AuthError('Google credential has expired');
  if (typeof payload.sub !== 'string' || !payload.sub) throw new AuthError('Google credential has no subject');
  if (typeof payload.email !== 'string' || !(payload.email_verified === true || payload.email_verified === 'true')) {
    throw new AuthError('sign in with a Google account that has a verified email');
  }
  return payload;
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Bytes of .jsonl files under dir (recursively).
function dirBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try { total += fs.statSync(full).size; } catch (_) { /* vanished */ }
      }
    }
  }
  return total;
}

class Accounts {
  // projectDirsOf(userId) answers the directories of the projects a user owns;
  // the server supplies it from the project registry.
  constructor({
    dataDir, googleClientId, adminEmails = [], plans = {}, freeLimitBytes,
    googleCertsUrl = GOOGLE_CERTS_URL, sessionDays = 30, projectDirsOf = () => [],
  }) {
    if (!googleClientId) throw new Error('Accounts needs a Google client id');
    this.dataDir = dataDir;
    this.googleClientId = googleClientId;
    this.googleCertsUrl = googleCertsUrl;
    this.adminEmails = new Set(adminEmails.map((e) => String(e).trim().toLowerCase()).filter(Boolean));
    this.sessionMs = sessionDays * 24 * 3600 * 1000;
    this.projectDirsOf = projectDirsOf;
    this.plans = {};
    for (const [id, p] of Object.entries({ ...DEFAULT_PLANS, ...plans })) this.plans[id] = { ...p, id };
    if (freeLimitBytes) this.plans.free = { ...this.plans.free, limitBytes: freeLimitBytes };
    this.usageCache = new Map();
    this.state = this.load();
  }

  get file() {
    return path.join(this.dataDir, '.scry', 'accounts.json');
  }

  load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { users: s.users || {}, sessions: s.sessions || {} };
    } catch (_) {
      return { users: {}, sessions: {} };
    }
  }

  save() {
    const now = Date.now();
    for (const [h, s] of Object.entries(this.state.sessions)) if (s.expiresAt < now) delete this.state.sessions[h];
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // Verifies a Google ID token, creates the user on first sign-in (on the
  // Free plan), and answers { user, token }: token is the session cookie value.
  async signInWithGoogle(credential) {
    const g = await verifyGoogleIdToken(credential, { clientId: this.googleClientId, certsUrl: this.googleCertsUrl });
    const id = 'g_' + g.sub;
    const now = new Date().toISOString();
    const prev = this.state.users[id];
    const user = {
      plan: 'free',
      createdAt: now,
      ...prev,
      id,
      email: g.email.toLowerCase(),
      name: typeof g.name === 'string' ? g.name.slice(0, 200) : '',
      picture: typeof g.picture === 'string' && /^https:\/\//.test(g.picture) ? g.picture : '',
      lastLoginAt: now,
    };
    this.state.users[id] = user;
    const token = crypto.randomBytes(32).toString('base64url');
    this.state.sessions[sha256(token)] = { userId: id, expiresAt: Date.now() + this.sessionMs };
    this.save();
    return { user, token };
  }

  sessionCookie(token, { secure }) {
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(this.sessionMs / 1000)}${secure ? '; Secure' : ''}`;
  }

  clearCookie({ secure }) {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
  }

  // The signed-in user for a request, from its session cookie, or null.
  userForRequest(req) {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token) return null;
    const s = this.state.sessions[sha256(token)];
    if (!s || s.expiresAt < Date.now()) return null;
    return this.state.users[s.userId] || null;
  }

  signOut(req) {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token && this.state.sessions[sha256(token)]) {
      delete this.state.sessions[sha256(token)];
      this.save();
    }
  }

  isAdmin(user) {
    return Boolean(user && this.adminEmails.has(user.email));
  }

  getUser(id) {
    return (id && this.state.users[id]) || null;
  }

  findUser({ id, email, stripeCustomerId }) {
    if (id && this.state.users[id]) return this.state.users[id];
    const users = Object.values(this.state.users);
    if (email) return users.find((u) => u.email === String(email).toLowerCase()) || null;
    if (stripeCustomerId) return users.find((u) => u.stripeCustomerId === stripeCustomerId) || null;
    return null;
  }

  planOf(user) {
    return this.plans[user && user.plan] || this.plans.free;
  }

  // Changes a user's plan (and any billing fields, e.g. Stripe ids). Data
  // over the new limit is kept; only further ingestion is refused.
  setPlan(userId, plan, fields = {}) {
    const user = this.state.users[userId];
    if (!user) throw new AuthError('no such user', 404);
    if (!this.plans[plan]) throw new AuthError(`no plan "${plan}"`, 400);
    Object.assign(user, fields, { plan, planUpdatedAt: new Date().toISOString() });
    this.save();
    return user;
  }

  updateUser(userId, fields) {
    const user = this.state.users[userId];
    if (!user) return null;
    Object.assign(user, fields);
    this.save();
    return user;
  }

  // Bytes of session files across a user's projects. Computed from disk once,
  // then kept current by addUsage on every ingest (one process writes).
  usage(userId) {
    if (!this.usageCache.has(userId)) {
      this.usageCache.set(userId, this.projectDirsOf(userId).reduce((n, d) => n + dirBytes(d), 0));
    }
    return this.usageCache.get(userId);
  }

  addUsage(userId, bytes) {
    this.usageCache.set(userId, this.usage(userId) + bytes);
  }

  invalidateUsage(userId) {
    if (userId) this.usageCache.delete(userId);
    else this.usageCache.clear();
  }

  // { ok, usedBytes, limitBytes, plan } for writing `bytes` more. Admins are
  // not metered.
  checkQuota(user, bytes) {
    const plan = this.planOf(user);
    const usedBytes = this.usage(user.id);
    const unlimited = this.isAdmin(user);
    return { ok: unlimited || usedBytes + bytes <= plan.limitBytes, usedBytes, limitBytes: unlimited ? null : plan.limitBytes, plan: plan.id };
  }

  publicPlans() {
    return Object.values(this.plans).map(({ id, name, limitBytes, monthlyUsd, yearlyUsd }) => ({ id, name, limitBytes, monthlyUsd, yearlyUsd }));
  }

  // What GET /me answers for a user.
  describe(user) {
    const plan = this.planOf(user);
    const admin = this.isAdmin(user);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
      admin,
      plan: plan.id,
      planName: plan.name,
      usedBytes: this.usage(user.id),
      limitBytes: admin ? null : plan.limitBytes,
      subscribed: Boolean(user.stripeSubscriptionId),
      createdAt: user.createdAt,
    };
  }

  // Every user with their usage, biggest first (GET /admin/users).
  list() {
    return Object.values(this.state.users)
      .map((u) => ({ ...this.describe(u), lastLoginAt: u.lastLoginAt || null }))
      .sort((a, b) => b.usedBytes - a.usedBytes);
  }
}

module.exports = { Accounts, AuthError, verifyGoogleIdToken, DEFAULT_PLANS, SESSION_COOKIE, MB, GB };
