// Accounts: Google sign-in, per-user projects, storage quotas, admin views
// and Stripe billing, against a fake Google key server and a fake Stripe.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { createIngestServer, projectDirsOf } = require('../lib/core');
const { Accounts } = require('../lib/accounts');
const { Billing } = require('../lib/billing');

const CLIENT_ID = 'test-client.apps.googleusercontent.com';

function request(port, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch (_) { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, json, text: data });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
const postJson = (port, p, obj, headers = {}) =>
  request(port, 'POST', p, { body: JSON.stringify(obj), headers: { 'content-type': 'application/json', ...headers } });

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scry-accounts-'));
  const dataDir = path.join(tmp, 'data');
  const uiFile = path.join(tmp, 'app.html');
  fs.writeFileSync(uiFile, '<!doctype html><title>app</title>');

  // Fake Google: a JWKS with one RSA key, and a signer for ID tokens.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const google = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  const certsUrl = `http://127.0.0.1:${google.address().port}/certs`;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  function idToken(claims, { key = privateKey, kid = 'k1' } = {}) {
    const head = b64({ alg: 'RS256', kid, typ: 'JWT' });
    const body = b64({
      iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 600,
      email_verified: true, ...claims,
    });
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
    return `${head}.${body}.${sig}`;
  }

  // Fake Stripe: records form posts, answers a URL.
  const stripeCalls = [];
  const stripe = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      stripeCalls.push({ path: req.url, auth: req.headers.authorization, params: new URLSearchParams(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: `https://stripe.test${req.url}` }));
    });
  });

  const LIMIT = 2000; // bytes on Free, so tests stay small
  const makeAccounts = () => new Accounts({
    dataDir, googleClientId: CLIENT_ID, googleCertsUrl: certsUrl, adminEmails: ['Admin@Example.com'],
    freeLimitBytes: LIMIT, projectDirsOf: (id) => projectDirsOf(dataDir, id),
  });
  const accounts = makeAccounts();
  const WHSEC = 'whsec_test';
  const billing = new Billing({
    secretKey: 'sk_test_x', webhookSecret: WHSEC, prices: { pro: 'price_pro', max: 'price_max' },
    apiBase: `http://127.0.0.1:${stripe.address().port}`,
  });
  const server = await createIngestServer({
    dataDir, port: 0, uiFile, uiUser: 'root', uiPass: 'pw', accounts, billing, publicUrl: 'https://scry.example',
  });
  const port = server.address().port;
  const ADMIN_BASIC = { authorization: 'Basic ' + Buffer.from('root:pw').toString('base64') };

  // The page is public (it shows the sign-in); the API needs a session, and
  // says so without a basic-auth prompt.
  let r = await request(port, 'GET', '/app');
  assert.strictEqual(r.status, 200);
  r = await request(port, 'GET', '/projects');
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.headers['www-authenticate'], undefined);
  r = await request(port, 'GET', '/auth/config');
  assert.strictEqual(r.json.google, CLIENT_ID);
  assert.strictEqual(r.json.billing, true);
  assert.deepStrictEqual(r.json.purchasable, ['pro', 'max']);
  assert.strictEqual(r.json.plans.find((p) => p.id === 'free').limitBytes, LIMIT);
  r = await request(port, 'GET', '/plans');
  assert.deepStrictEqual(r.json.map((p) => p.id), ['free', 'pro', 'max']);

  // Bad credentials are refused
  const bad = [
    idToken({ sub: '1', email: 'a@x.com', aud: 'someone-else' }),
    idToken({ sub: '1', email: 'a@x.com', email_verified: false }),
    idToken({ sub: '1', email: 'a@x.com', exp: Math.floor(Date.now() / 1000) - 3600 }),
    idToken({ sub: '1', email: 'a@x.com', iss: 'https://evil.example' }),
    idToken({ sub: '1', email: 'a@x.com' }, { key: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }),
    idToken({ sub: '1', email: 'a@x.com' }, { kid: 'nope' }),
    'not.a.jwt',
  ];
  for (const credential of bad) {
    r = await postJson(port, '/auth/google', { credential });
    assert.strictEqual(r.status, 401, `should refuse: ${r.json && r.json.error}`);
    assert.strictEqual(r.headers['set-cookie'], undefined);
  }

  // Sign in: a cookie session, on the Free plan
  async function signIn(sub, email, name) {
    const res = await postJson(port, '/auth/google', { credential: idToken({ sub, email, name, picture: 'https://p.example/a.png' }) });
    assert.strictEqual(res.status, 200, res.text);
    const cookie = res.headers['set-cookie'][0];
    assert.match(cookie, /^scry_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
    return { cookie: cookie.split(';')[0], me: res.json };
  }
  const alice = await signIn('111', 'Alice@Gmail.com', 'Alice');
  assert.strictEqual(alice.me.email, 'alice@gmail.com');
  assert.strictEqual(alice.me.plan, 'free');
  assert.strictEqual(alice.me.usedBytes, 0);
  assert.strictEqual(alice.me.limitBytes, LIMIT);
  assert.strictEqual(alice.me.admin, false);
  const bob = await signIn('222', 'bob@gmail.com', 'Bob');
  const A = { cookie: alice.cookie };
  const B = { cookie: bob.cookie };
  // Session tokens are stored hashed
  const stored = fs.readFileSync(path.join(dataDir, '.scry', 'accounts.json'), 'utf8');
  assert.ok(!stored.includes(alice.cookie.split('=')[1]));

  r = await request(port, 'GET', '/me', { headers: A });
  assert.strictEqual(r.json.email, 'alice@gmail.com');

  // Each user's projects are their own
  r = await postJson(port, '/projects', { name: 'alice-work' }, A);
  assert.strictEqual(r.status, 201);
  const aliceToken = r.json.token;
  r = await postJson(port, '/projects', { name: 'bob-work' }, B);
  const bobToken = r.json.token;
  r = await postJson(port, '/projects', { name: 'alice-work' }, B);
  assert.strictEqual(r.status, 409);
  r = await request(port, 'GET', '/projects', { headers: A });
  assert.deepStrictEqual(r.json.map((p) => p.name), ['alice-work']);
  r = await request(port, 'GET', '/projects', { headers: B });
  assert.deepStrictEqual(r.json.map((p) => p.name), ['bob-work']);

  const ingest = (token, project, session, lines) => request(port, 'POST', '/ingest', {
    body: lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    headers: { authorization: `Bearer ${token}`, 'x-project': project, 'x-session-id': session },
  });
  r = await ingest(aliceToken, 'alice-work', 's1', [{ kind: 'prompt', prompt: 'alice secret zebra' }]);
  assert.strictEqual(r.status, 200);
  r = await ingest(bobToken, 'bob-work', 's1', [{ kind: 'prompt', prompt: 'bob zebra' }]);
  assert.strictEqual(r.status, 200);

  // Bob cannot reach Alice's sessions by any route
  r = await request(port, 'GET', '/sessions', { headers: B });
  assert.deepStrictEqual(r.json.map((s) => s.project), ['bob-work']);
  r = await request(port, 'GET', '/sessions?project=alice-work', { headers: B });
  assert.strictEqual(r.status, 404);
  r = await request(port, 'GET', '/session?project=alice-work&id=s1', { headers: B });
  assert.strictEqual(r.status, 404);
  r = await request(port, 'GET', '/session?id=s1', { headers: B });
  assert.strictEqual(r.status, 404);
  r = await request(port, 'GET', '/search?q=zebra', { headers: B });
  assert.deepStrictEqual(r.json.map((h) => h.project), ['bob-work']);
  r = await request(port, 'GET', '/search?q=zebra&project=alice-work', { headers: B });
  assert.strictEqual(r.status, 404);
  r = await postJson(port, '/projects/token', { name: 'alice-work' }, B);
  assert.strictEqual(r.status, 404);
  r = await request(port, 'GET', '/session?project=alice-work&id=s1', { headers: A });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.lines[0].data.prompt, 'alice secret zebra');

  // Storage is metered per user, and capped at the plan's limit
  const used1 = (await request(port, 'GET', '/me', { headers: A })).json.usedBytes;
  assert.strictEqual(used1, fs.statSync(path.join(dataDir, 'alice-work', 's1.jsonl')).size);
  const big = { kind: 'response', response: 'x'.repeat(600) };
  for (let i = 0; i < 2; i++) assert.strictEqual((await ingest(aliceToken, 'alice-work', 's2', [big])).status, 200);
  const before = fs.statSync(path.join(dataDir, 'alice-work', 's2.jsonl')).size;
  r = await ingest(aliceToken, 'alice-work', 's2', [big, big]);
  assert.strictEqual(r.status, 402);
  assert.strictEqual(r.json.plan, 'free');
  assert.strictEqual(r.json.limitBytes, LIMIT);
  assert.match(r.json.error, /storage limit reached: .* on the Free plan; upgrade at https:\/\/scry\.example\/app#billing/);
  assert.strictEqual(fs.statSync(path.join(dataDir, 'alice-work', 's2.jsonl')).size, before, 'nothing written over the limit');
  // Bob's quota is separate
  r = await ingest(bobToken, 'bob-work', 's1', [big]);
  assert.strictEqual(r.status, 200);
  const aliceUsed = (await request(port, 'GET', '/me', { headers: A })).json.usedBytes;
  assert.strictEqual(aliceUsed, before + used1);
  // ... and recomputed from disk after a restart
  assert.strictEqual(makeAccounts().usage('g_111'), aliceUsed);

  // Admins: basic auth or an admin email. They see the deployment's projects
  // (legacy, unowned) but not users' sessions, and every user's usage.
  fs.mkdirSync(path.join(dataDir, 'legacy'));
  fs.writeFileSync(path.join(dataDir, 'legacy', 'old.jsonl'), '{"msg":"legacy zebra"}\n');
  r = await request(port, 'GET', '/projects', { headers: ADMIN_BASIC });
  assert.deepStrictEqual(r.json.map((p) => p.name), ['legacy']);
  r = await request(port, 'GET', '/search?q=zebra', { headers: ADMIN_BASIC });
  assert.deepStrictEqual(r.json.map((h) => h.project), ['legacy']);
  r = await request(port, 'GET', '/admin/users', { headers: A });
  assert.strictEqual(r.status, 403);
  r = await request(port, 'GET', '/admin/users', { headers: ADMIN_BASIC });
  assert.deepStrictEqual(r.json.map((u) => [u.email, u.usedBytes]), [
    ['alice@gmail.com', aliceUsed],
    ['bob@gmail.com', (await request(port, 'GET', '/me', { headers: B })).json.usedBytes],
  ]);
  const admin = await signIn('999', 'admin@example.com', 'Admin');
  assert.strictEqual(admin.me.admin, true);
  assert.strictEqual(admin.me.limitBytes, null);
  r = await request(port, 'GET', '/admin/users', { headers: { cookie: admin.cookie } });
  assert.strictEqual(r.json.length, 3);

  // An admin can move a user to a plan by hand; the new limit applies at once
  r = await postJson(port, '/admin/users/plan', { email: 'alice@gmail.com', plan: 'gold' }, ADMIN_BASIC);
  assert.strictEqual(r.status, 400);
  r = await postJson(port, '/admin/users/plan', { email: 'alice@gmail.com', plan: 'pro' }, B);
  assert.strictEqual(r.status, 403);
  r = await postJson(port, '/admin/users/plan', { email: 'alice@gmail.com', plan: 'pro' }, ADMIN_BASIC);
  assert.strictEqual(r.json.plan, 'pro');
  r = await ingest(aliceToken, 'alice-work', 's2', [big, big]);
  assert.strictEqual(r.status, 200);
  await postJson(port, '/admin/users/plan', { email: 'alice@gmail.com', plan: 'free' }, ADMIN_BASIC);

  // Billing: Checkout for Bob, then the webhook moves him to Pro
  r = await postJson(port, '/billing/checkout', { plan: 'free' }, B);
  assert.strictEqual(r.status, 400);
  r = await postJson(port, '/billing/checkout', { plan: 'pro' }, B);
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.url, 'https://stripe.test/v1/checkout/sessions');
  const co = stripeCalls.at(-1);
  assert.strictEqual(co.auth, 'Bearer sk_test_x');
  assert.strictEqual(co.params.get('mode'), 'subscription');
  assert.strictEqual(co.params.get('line_items[0][price]'), 'price_pro');
  assert.strictEqual(co.params.get('client_reference_id'), 'g_222');
  assert.strictEqual(co.params.get('customer_email'), 'bob@gmail.com');
  assert.strictEqual(co.params.get('success_url'), 'https://scry.example/app?billing=success');

  const webhook = (event, { secret = WHSEC, t = Math.floor(Date.now() / 1000) } = {}) => {
    const raw = JSON.stringify(event);
    const sig = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
    return request(port, 'POST', '/billing/webhook', {
      body: raw, headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` },
    });
  };
  const completed = {
    type: 'checkout.session.completed',
    data: { object: { client_reference_id: 'g_222', customer: 'cus_1', subscription: 'sub_1', metadata: { plan: 'pro', userId: 'g_222' } } },
  };
  r = await webhook(completed, { secret: 'whsec_wrong' });
  assert.strictEqual(r.status, 400);
  r = await webhook(completed, { t: Math.floor(Date.now() / 1000) - 3600 });
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await request(port, 'GET', '/me', { headers: B })).json.plan, 'free');
  r = await webhook(completed);
  assert.strictEqual(r.status, 200);
  let bobMe = (await request(port, 'GET', '/me', { headers: B })).json;
  assert.strictEqual(bobMe.plan, 'pro');
  assert.strictEqual(bobMe.subscribed, true);
  // Already subscribed: changes go through the portal
  r = await postJson(port, '/billing/checkout', { plan: 'max' }, B);
  assert.strictEqual(r.status, 409);
  r = await postJson(port, '/billing/portal', {}, B);
  assert.strictEqual(r.json.url, 'https://stripe.test/v1/billing_portal/sessions');
  assert.strictEqual(stripeCalls.at(-1).params.get('customer'), 'cus_1');
  // Plan change in the portal follows the price
  r = await webhook({ type: 'customer.subscription.updated', data: { object: {
    id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { userId: 'g_222', plan: 'pro' },
    items: { data: [{ price: { id: 'price_max' } }] },
  } } });
  assert.strictEqual((await request(port, 'GET', '/me', { headers: B })).json.plan, 'max');
  // A stale subscription's events are ignored; cancelling drops to Free
  r = await webhook({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_old', customer: 'cus_1', status: 'canceled', metadata: {} } } });
  assert.strictEqual((await request(port, 'GET', '/me', { headers: B })).json.plan, 'max');
  r = await webhook({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled', metadata: {} } } });
  bobMe = (await request(port, 'GET', '/me', { headers: B })).json;
  assert.strictEqual(bobMe.plan, 'free');
  assert.strictEqual(bobMe.subscribed, false);

  // Sign out ends the session
  r = await postJson(port, '/auth/logout', {}, A);
  assert.strictEqual(r.status, 204);
  assert.match(r.headers['set-cookie'][0], /Max-Age=0/);
  r = await request(port, 'GET', '/me', { headers: A });
  assert.strictEqual(r.status, 401);

  // Without accounts nothing changes: /me says so, billing routes are absent
  const plain = await createIngestServer({ dataDir: path.join(tmp, 'plain'), port: 0, uiFile });
  const pp = plain.address().port;
  r = await request(pp, 'GET', '/me');
  assert.deepStrictEqual(r.json, { accounts: false });
  r = await request(pp, 'GET', '/auth/config');
  assert.strictEqual(r.json.google, null);
  r = await postJson(pp, '/auth/google', { credential: 'x' });
  assert.strictEqual(r.status, 404);
  r = await postJson(pp, '/billing/checkout', { plan: 'pro' });
  assert.strictEqual(r.status, 404);

  for (const s of [server, plain, google, stripe]) s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('accounts test passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
