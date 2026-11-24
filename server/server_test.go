package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const testClient = "web.apps.googleusercontent.com"
const testDesktop = "desktop.apps.googleusercontent.com"

type fixture struct {
	t       *testing.T
	srv     *Server
	ts      *httptest.Server
	key     *rsa.PrivateKey
	stripeM sync.Mutex
	stripe  []url.Values
	dataDir string
}

func b64(v any) string {
	b, _ := json.Marshal(v)
	return base64.RawURLEncoding.EncodeToString(b)
}

func (f *fixture) idToken(claims map[string]any, key *rsa.PrivateKey, kid string) string {
	c := map[string]any{"iss": "https://accounts.google.com", "aud": testClient, "exp": time.Now().Add(10 * time.Minute).Unix(), "email_verified": true}
	for k, v := range claims {
		c[k] = v
	}
	h := b64(map[string]string{"alg": "RS256", "kid": kid, "typ": "JWT"})
	p := b64(c)
	d := sha256.Sum256([]byte(h + "." + p))
	sig, _ := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, d[:])
	return h + "." + p + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func newFixture(t *testing.T, mutate func(*Config)) *fixture {
	t.Helper()
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	f := &fixture{t: t, key: key, dataDir: t.TempDir()}
	google := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=3600")
		json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
			"kid": "k1", "kty": "RSA", "alg": "RS256",
			"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
		}}})
	}))
	t.Cleanup(google.Close)
	stripe := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		v, _ := url.ParseQuery(string(b))
		v.Set("_path", r.URL.Path)
		v.Set("_auth", r.Header.Get("Authorization"))
		f.stripeM.Lock()
		f.stripe = append(f.stripe, v)
		f.stripeM.Unlock()
		json.NewEncoder(w).Encode(map[string]string{"url": "https://stripe.test/c/1"})
	}))
	t.Cleanup(stripe.Close)
	pluginDir := filepath.Join(t.TempDir(), "claude-chat-logger")
	os.MkdirAll(filepath.Join(pluginDir, "hooks"), 0o755)
	os.WriteFile(filepath.Join(pluginDir, "hooks", "register.ts"), []byte("export {}\n"), 0o644)
	publicDir := t.TempDir()
	os.WriteFile(filepath.Join(publicDir, "account.html"), []byte("<title>account</title>"), 0o644)
	os.WriteFile(filepath.Join(publicDir, "index.html"), []byte("<title>landing</title>"), 0o644)
	cfg := Config{
		DataDir: f.dataDir, PublicDir: publicDir, PluginDir: pluginDir,
		WebClientID: testClient, ClientIDs: []string{testClient, testDesktop},
		AdminEmails: map[string]bool{"admin@example.com": true}, PublicURL: "https://scry.example",
		FreeBytes: 2000, SpoolBytes: 5000, PricePerGBUSD: 10, LongPoll: 2 * time.Second,
		Build:  map[string]any{"version": "test"},
		Stripe: &Stripe{SecretKey: "sk_test", WebhookSecret: "whsec", PriceGB: "price_gb", APIBase: stripe.URL, Client: http.DefaultClient},
		Google: &GoogleVerifier{CertsURL: google.URL, ClientIDs: []string{testClient, testDesktop}, Client: http.DefaultClient},
	}
	if mutate != nil {
		mutate(&cfg)
	}
	srv, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	f.srv = srv
	f.ts = httptest.NewServer(srv)
	t.Cleanup(func() { f.ts.Close(); srv.Close() })
	return f
}

type resp struct {
	status int
	header http.Header
	body   []byte
	json   map[string]any
	list   []any
}

func (f *fixture) do(method, path string, body any, headers map[string]string) resp {
	f.t.Helper()
	var rd io.Reader
	ct := ""
	switch b := body.(type) {
	case nil:
	case string:
		rd = strings.NewReader(b)
	default:
		j, _ := json.Marshal(b)
		rd = bytes.NewReader(j)
		ct = "application/json"
	}
	req, _ := http.NewRequest(method, f.ts.URL+path, rd)
	if ct != "" {
		req.Header.Set("Content-Type", ct)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	r := resp{status: res.StatusCode, header: res.Header, body: b}
	_ = json.Unmarshal(b, &r.json)
	_ = json.Unmarshal(b, &r.list)
	return r
}

func expect(t *testing.T, got, want any, what string) {
	t.Helper()
	norm := func(v any) string {
		if f, ok := v.(float64); ok && f == float64(int64(f)) {
			return fmt.Sprint(int64(f))
		}
		return fmt.Sprint(v)
	}
	if norm(got) != norm(want) {
		t.Fatalf("%s: got %v, want %v", what, got, want)
	}
}

// signIn answers the cookie header for a browser session.
func (f *fixture) signIn(sub, email string) map[string]string {
	f.t.Helper()
	r := f.do("POST", "/auth/google", map[string]string{"credential": f.idToken(map[string]any{"sub": sub, "email": email, "name": "N"}, f.key, "k1")}, nil)
	expect(f.t, r.status, 200, "sign in "+string(r.body))
	c := r.header.Get("Set-Cookie")
	if !strings.Contains(c, "HttpOnly") || !strings.Contains(c, "Secure") || !strings.Contains(c, "SameSite=Lax") {
		f.t.Fatalf("cookie flags: %s", c)
	}
	return map[string]string{"Cookie": strings.Split(c, ";")[0]}
}

// device signs the Mac app in (desktop client id) and answers its bearer header.
func (f *fixture) device(sub, email string) map[string]string {
	f.t.Helper()
	r := f.do("POST", "/auth/google", map[string]string{
		"credential": f.idToken(map[string]any{"sub": sub, "email": email, "aud": testDesktop}, f.key, "k1"),
		"device":     "Test Mac",
	}, nil)
	expect(f.t, r.status, 200, "device sign in "+string(r.body))
	if r.header.Get("Set-Cookie") != "" {
		f.t.Fatal("device sign-in must not set a cookie")
	}
	tok, _ := r.json["deviceToken"].(string)
	if !strings.HasPrefix(tok, deviceTokenPfx) {
		f.t.Fatalf("device token %q", tok)
	}
	return map[string]string{"Authorization": "Bearer " + tok}
}

func (f *fixture) ingest(token, project, session string, lines ...string) resp {
	return f.do("POST", "/ingest", strings.Join(lines, "\n")+"\n", map[string]string{
		"Authorization": "Bearer " + token, "X-Project": project, "X-Session-Id": session, "Content-Type": "application/x-ndjson",
	})
}

func TestPublicRoutes(t *testing.T) {
	f := newFixture(t, nil)
	expect(t, f.do("GET", "/healthz", nil, nil).status, 200, "healthz")
	expect(t, string(f.do("GET", "/", nil, nil).body), "<title>landing</title>", "landing")
	expect(t, string(f.do("GET", "/app", nil, nil).body), "<title>account</title>", "account page")
	r := f.do("GET", "/auth/config", nil, nil)
	expect(t, r.json["google"], testClient, "client id")
	expect(t, r.json["billing"], true, "billing")
	// No search or session views on the server
	for _, p := range []string{"/search?q=x", "/sessions", "/session?id=x"} {
		expect(t, f.do("GET", p, nil, nil).status, 404, p)
	}
	for _, p := range []string{"/me", "/projects"} {
		r := f.do("GET", p, nil, nil)
		expect(t, r.status, 401, p)
		expect(t, r.header.Get("WWW-Authenticate"), "", "no basic prompt")
	}
	// The plugin tarball
	r = f.do("GET", "/plugin", nil, nil)
	expect(t, r.status, 200, "plugin")
	gz, err := gzip.NewReader(bytes.NewReader(r.body))
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	names := []string{}
	for {
		h, err := tr.Next()
		if err != nil {
			break
		}
		names = append(names, h.Name)
	}
	expect(t, strings.Join(names, ","), "claude-chat-logger/,claude-chat-logger/hooks/,claude-chat-logger/hooks/register.ts", "plugin files")
}

func TestGoogleSignIn(t *testing.T) {
	f := newFixture(t, nil)
	other, _ := rsa.GenerateKey(rand.Reader, 2048)
	bad := []string{
		f.idToken(map[string]any{"sub": "1", "email": "a@x.com", "aud": "someone-else"}, f.key, "k1"),
		f.idToken(map[string]any{"sub": "1", "email": "a@x.com", "email_verified": false}, f.key, "k1"),
		f.idToken(map[string]any{"sub": "1", "email": "a@x.com", "exp": time.Now().Add(-time.Hour).Unix()}, f.key, "k1"),
		f.idToken(map[string]any{"sub": "1", "email": "a@x.com", "iss": "https://evil"}, f.key, "k1"),
		f.idToken(map[string]any{"sub": "../x", "email": "a@x.com"}, f.key, "k1"),
		f.idToken(map[string]any{"sub": "1", "email": "a@x.com"}, other, "k1"),
		f.idToken(map[string]any{"sub": "1", "email": "a@x.com"}, f.key, "nope"),
		"not.a.jwt",
	}
	for i, cred := range bad {
		r := f.do("POST", "/auth/google", map[string]string{"credential": cred}, nil)
		expect(t, r.status, 401, fmt.Sprintf("bad credential %d (%s)", i, r.body))
	}
	// JSON only, so a cross-site form cannot post
	expect(t, f.do("POST", "/auth/google", "credential=x", map[string]string{"Content-Type": "application/x-www-form-urlencoded"}).status, 415, "form post")

	a := f.signIn("111", "Alice@Gmail.com")
	r := f.do("GET", "/me", nil, a)
	expect(t, r.json["email"], "alice@gmail.com", "email lowercased")
	expect(t, r.json["usedBytes"], 0, "used")
	expect(t, r.json["allowanceBytes"], 2000, "free allowance")
	// Tokens are stored hashed
	state, _ := os.ReadFile(filepath.Join(f.dataDir, "state.json"))
	if strings.Contains(string(state), strings.TrimPrefix(a["Cookie"], sessionCookie+"=")) {
		t.Fatal("session token stored in the clear")
	}
	// The Mac app signs in with its own client id and gets a bearer token
	d := f.device("111", "alice@gmail.com")
	expect(t, f.do("GET", "/me", nil, d).json["devices"], 1, "devices")
	// Sign out ends that session only
	expect(t, f.do("POST", "/auth/logout", map[string]any{}, a).status, 204, "logout")
	expect(t, f.do("GET", "/me", nil, a).status, 401, "after logout")
	expect(t, f.do("GET", "/me", nil, d).status, 200, "device still signed in")
}

func TestProjectsArePerUser(t *testing.T) {
	f := newFixture(t, nil)
	a, b := f.signIn("1", "a@x.com"), f.signIn("2", "b@x.com")
	r := f.do("POST", "/projects", map[string]string{"name": "work"}, a)
	expect(t, r.status, 201, "create")
	aTok := r.json["token"].(string)
	// Names are per user: Bob can also have "work"
	r = f.do("POST", "/projects", map[string]string{"name": "work"}, b)
	expect(t, r.status, 201, "same name for another user")
	bTok := r.json["token"].(string)
	expect(t, f.do("POST", "/projects", map[string]string{"name": "work"}, a).status, 409, "duplicate")
	expect(t, f.do("POST", "/projects", map[string]string{"name": "../x"}, a).status, 400, "bad name")
	expect(t, len(f.do("GET", "/projects", nil, a).list), 1, "list")
	// Tokens write only to their owner's project
	expect(t, f.ingest(aTok, "work", "s1", `{"kind":"prompt","prompt":"alice"}`).status, 200, "ingest a")
	expect(t, f.ingest(bTok, "work", "s1", `{"kind":"prompt","prompt":"bob"}`).status, 200, "ingest b")
	expect(t, f.ingest(aTok, "other", "s1", `{"x":1}`).status, 403, "wrong project")
	expect(t, f.ingest(aTok, "", "s1", `{"x":1}`).status, 400, "no project")
	expect(t, f.ingest("scry_nope", "work", "s1", `{"x":1}`).status, 401, "bad token")
	// Rotating retires the old token
	r = f.do("POST", "/projects/token", map[string]string{"name": "work"}, a)
	expect(t, r.status, 200, "rotate")
	expect(t, f.ingest(aTok, "work", "s1", `{"x":1}`).status, 401, "old token")
	expect(t, f.ingest(r.json["token"].(string), "work", "s1", `{"x":1}`).status, 200, "new token")
	expect(t, f.do("POST", "/projects/token", map[string]string{"name": "ghost"}, a).status, 404, "rotate missing")

	// Each user's Mac only ever sees their own data
	da, db := f.device("1", "a@x.com"), f.device("2", "b@x.com")
	for _, c := range []struct {
		h    map[string]string
		want string
	}{{da, "alice"}, {db, "bob"}} {
		r := f.do("POST", "/sync/pull", map[string]any{}, c.h)
		segs := r.json["segments"].([]any)
		id := int64(segs[0].(map[string]any)["id"].(float64))
		body := string(f.do("GET", fmt.Sprintf("/sync/segment?id=%d", id), nil, c.h).body)
		if !strings.Contains(body, c.want) || strings.Contains(body, map[string]string{"alice": "bob", "bob": "alice"}[c.want]) {
			t.Fatalf("segment for %s: %s", c.want, body)
		}
	}
}

func TestSyncDrainsTheSpool(t *testing.T) {
	f := newFixture(t, nil)
	web := f.signIn("1", "a@x.com")
	tok := f.do("POST", "/projects", map[string]string{"name": "work"}, web).json["token"].(string)
	dev := f.device("1", "a@x.com")

	// Lines as sent, including ones that are not JSON, survive byte for byte
	lines := []string{`{"ts":"2026-01-02T03:04:05Z","kind":"prompt","prompt":"hi <b> & é"}`, `not json`}
	expect(t, f.ingest(tok, "work", "sess-1", lines...).status, 200, "ingest")
	r := f.do("POST", "/sync/pull", map[string]any{}, dev)
	segs := r.json["segments"].([]any)
	expect(t, len(segs), 1, "one segment")
	id := int64(segs[0].(map[string]any)["id"].(float64))
	body := f.do("GET", fmt.Sprintf("/sync/segment?id=%d", id), nil, dev).body
	var got []spoolRecord
	for _, l := range strings.Split(strings.TrimSpace(string(body)), "\n") {
		var rec spoolRecord
		if err := json.Unmarshal([]byte(l), &rec); err != nil {
			t.Fatal(err)
		}
		got = append(got, rec)
	}
	expect(t, len(got), 2, "records")
	expect(t, got[0].Line, lines[0], "raw line 0")
	expect(t, got[1].Line, lines[1], "raw line 1")
	expect(t, got[0].Project+"/"+got[0].Session, "work/sess-1", "where")
	pending := f.do("GET", "/me", nil, web).json["pendingBytes"].(float64)
	if pending <= 0 {
		t.Fatal("pending bytes should count the spool")
	}
	// Acked segments are deleted from the server
	r = f.do("POST", "/sync/ack", map[string]any{"ids": []int64{id}}, dev)
	expect(t, r.json["deleted"], 1, "deleted")
	expect(t, r.json["pendingBytes"], 0, "pending after ack")
	expect(t, f.do("GET", fmt.Sprintf("/sync/segment?id=%d", id), nil, dev).status, 404, "gone")
	files, _ := os.ReadDir(filepath.Join(f.dataDir, "spool", "g_1"))
	expect(t, len(files), 0, "spool dir empty")
	// ... but still count toward the metered usage
	expect(t, f.do("GET", "/me", nil, web).json["usedBytes"], len(lines[0])+len(lines[1])+2, "used bytes")

	// Long poll: a waiting pull returns as soon as a line arrives
	done := make(chan resp, 1)
	start := time.Now()
	go func() { done <- f.do("POST", "/sync/pull?wait=10", map[string]any{}, dev) }()
	time.Sleep(200 * time.Millisecond)
	expect(t, f.ingest(tok, "work", "sess-1", `{"n":2}`).status, 200, "ingest while polling")
	r = <-done
	if time.Since(start) > 1500*time.Millisecond {
		t.Fatalf("long poll took %v", time.Since(start))
	}
	expect(t, len(r.json["segments"].([]any)), 1, "woken with a segment")
	// With nothing to send, the wait ends at the server's limit (2s here)
	f.do("POST", "/sync/ack", map[string]any{"ids": []int64{int64(r.json["segments"].([]any)[0].(map[string]any)["id"].(float64))}}, dev)
	start = time.Now()
	r = f.do("POST", "/sync/pull?wait=60", map[string]any{}, dev)
	if d := time.Since(start); d < 1500*time.Millisecond || d > 4*time.Second {
		t.Fatalf("idle long poll took %v", d)
	}
	expect(t, len(r.json["segments"].([]any)), 0, "nothing new")
	// Pulls record when the Mac last synced
	if f.do("GET", "/me", nil, web).json["lastSyncAt"] == nil {
		t.Fatal("lastSyncAt not set")
	}
}

func TestQuotasAndSpoolCap(t *testing.T) {
	f := newFixture(t, nil) // free 2000 bytes, spool 5000 bytes
	web := f.signIn("1", "a@x.com")
	tok := f.do("POST", "/projects", map[string]string{"name": "work"}, web).json["token"].(string)
	line := `{"x":"` + strings.Repeat("a", 590) + `"}` // 598 bytes + newline
	for i := 0; i < 3; i++ {
		expect(t, f.ingest(tok, "work", "s", line).status, 200, "under the free allowance")
	}
	r := f.ingest(tok, "work", "s", line, line)
	expect(t, r.status, 402, "over the allowance")
	if !strings.Contains(r.json["error"].(string), "add storage at $10 per GB at https://scry.example/app#billing") {
		t.Fatalf("402 message: %s", r.json["error"])
	}
	expect(t, f.do("GET", "/me", nil, web).json["usedBytes"], 1797, "nothing counted on 402")

	// Buying 1 GB lifts the cap; Checkout carries the quantity and user
	expect(t, f.do("POST", "/billing/checkout", map[string]any{"gb": 0}, web).status, 400, "0 GB")
	r = f.do("POST", "/billing/checkout", map[string]any{"gb": 3}, web)
	expect(t, r.json["url"], "https://stripe.test/c/1", "checkout url")
	co := f.stripe[len(f.stripe)-1]
	expect(t, co.Get("_path"), "/v1/checkout/sessions", "stripe path")
	expect(t, co.Get("_auth"), "Bearer sk_test", "stripe auth")
	expect(t, co.Get("mode"), "payment", "one-time payment")
	expect(t, co.Get("line_items[0][price]"), "price_gb", "price")
	expect(t, co.Get("line_items[0][quantity]"), "3", "quantity")
	expect(t, co.Get("client_reference_id"), "g_1", "user")
	expect(t, co.Get("success_url"), "https://scry.example/app?billing=success", "return")

	hook := func(ev map[string]any, secret string, ts int64) resp {
		raw, _ := json.Marshal(ev)
		mac := hmac.New(sha256.New, []byte(secret))
		fmt.Fprintf(mac, "%d.%s", ts, raw)
		return f.do("POST", "/billing/webhook", string(raw), map[string]string{
			"Content-Type": "application/json", "Stripe-Signature": fmt.Sprintf("t=%d,v1=%s", ts, hex.EncodeToString(mac.Sum(nil))),
		})
	}
	paid := map[string]any{"id": "evt_1", "type": "checkout.session.completed", "data": map[string]any{"object": map[string]any{
		"id": "cs_1", "client_reference_id": "g_1", "payment_status": "paid", "metadata": map[string]string{"gb": "3", "userId": "g_1"},
	}}}
	now := time.Now().Unix()
	expect(t, hook(paid, "wrong", now).status, 400, "bad signature")
	expect(t, hook(paid, "whsec", now-3600).status, 400, "stale")
	unpaid := map[string]any{"type": "checkout.session.completed", "data": map[string]any{"object": map[string]any{
		"id": "cs_0", "client_reference_id": "g_1", "payment_status": "unpaid", "metadata": map[string]string{"gb": "3"},
	}}}
	expect(t, hook(unpaid, "whsec", now).status, 200, "unpaid event")
	expect(t, f.do("GET", "/me", nil, web).json["purchasedBytes"], 0, "unpaid credits nothing")
	expect(t, hook(paid, "whsec", now).status, 200, "paid")
	expect(t, hook(paid, "whsec", now).status, 200, "retried")
	me := f.do("GET", "/me", nil, web).json
	expect(t, me["purchasedBytes"], 3*GB, "credited once")
	expect(t, me["allowanceBytes"], 3*GB+2000, "allowance")

	// The spool cap: unsynced data beyond 5000 bytes is refused with 507
	var last resp
	for i := 0; i < 10; i++ {
		if last = f.ingest(tok, "work", "s", line); last.status != 200 {
			break
		}
	}
	expect(t, last.status, 507, "spool full")
	if !strings.Contains(last.json["error"].(string), "open Scry on your Mac to sync") {
		t.Fatalf("507 message: %s", last.json["error"])
	}
	// Syncing frees it
	dev := f.device("1", "a@x.com")
	ids := []int64{}
	for _, s := range f.do("POST", "/sync/pull", map[string]any{}, dev).json["segments"].([]any) {
		ids = append(ids, int64(s.(map[string]any)["id"].(float64)))
	}
	f.do("POST", "/sync/ack", map[string]any{"ids": ids}, dev)
	expect(t, f.ingest(tok, "work", "s", line).status, 200, "after sync")
}

func TestAdminAndPersistence(t *testing.T) {
	f := newFixture(t, nil)
	a := f.signIn("1", "a@x.com")
	admin := f.signIn("9", "admin@example.com")
	me := f.do("GET", "/me", nil, admin).json
	expect(t, me["admin"], true, "admin")
	expect(t, me["allowanceBytes"], nil, "admins are unmetered")
	expect(t, f.do("GET", "/admin/users", nil, a).status, 403, "users list for non-admin")
	expect(t, len(f.do("GET", "/admin/users", nil, admin).list), 2, "users list")
	expect(t, f.do("POST", "/admin/users/credit", map[string]any{"email": "a@x.com", "gb": 2}, a).status, 403, "credit by non-admin")
	r := f.do("POST", "/admin/users/credit", map[string]any{"email": "A@x.com", "gb": 2}, admin)
	expect(t, r.json["purchasedBytes"], 2*GB, "credited")

	tok := f.do("POST", "/projects", map[string]string{"name": "p"}, a).json["token"].(string)
	expect(t, f.ingest(tok, "p", "s", `{"a":1}`).status, 200, "ingest")
	// Everything survives a restart: users, tokens, usage, the spool
	f.srv.Close()
	srv2, err := NewServer(f.srv.cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer srv2.Close()
	ts2 := httptest.NewServer(srv2)
	defer ts2.Close()
	f.ts.Close()
	f.ts = ts2
	me = f.do("GET", "/me", nil, a).json
	expect(t, me["usedBytes"], 8, "usage persisted")
	expect(t, me["purchasedBytes"], 2*GB, "credit persisted")
	if me["pendingBytes"].(float64) <= 0 {
		t.Fatal("spool size recomputed")
	}
	expect(t, f.ingest(tok, "p", "s", `{"a":2}`).status, 200, "token persisted")
}

// Segment ids never repeat, even when the id counter was lost (a crash
// before state.json was saved): a reused id would be skipped by the Mac as
// already applied and deleted unread.
func TestSegmentIDsOnlyGrow(t *testing.T) {
	f := newFixture(t, nil)
	web := f.signIn("1", "a@x.com")
	tok := f.do("POST", "/projects", map[string]string{"name": "p"}, web).json["token"].(string)
	dev := f.device("1", "a@x.com")
	pull := func() []int64 {
		ids := []int64{}
		for _, s := range f.do("POST", "/sync/pull", map[string]any{}, dev).json["segments"].([]any) {
			ids = append(ids, int64(s.(map[string]any)["id"].(float64)))
		}
		return ids
	}
	f.ingest(tok, "p", "s", `{"n":1}`)
	expect(t, pull(), []int64{1}, "first segment")
	// The counter is on disk as soon as the segment exists
	b, _ := os.ReadFile(filepath.Join(f.dataDir, "state.json"))
	var st State
	json.Unmarshal(b, &st)
	expect(t, st.Users["g_1"].NextSegment, 1, "saved before the rename")
	// Lose the counter; unacked segment 1 is still on disk
	f.srv.store.mu.Lock()
	f.srv.store.state.Users["g_1"].NextSegment = 0
	f.srv.store.mu.Unlock()
	f.ingest(tok, "p", "s", `{"n":2}`)
	expect(t, pull(), []int64{1, 2}, "no id reused")
	body := string(f.do("GET", "/sync/segment?id=1", nil, dev).body)
	if !strings.Contains(body, `\"n\":1`) {
		t.Fatalf("segment 1 overwritten: %s", body)
	}
}
