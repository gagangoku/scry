package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	MB              = int64(1024 * 1024)
	GB              = 1024 * MB
	maxIngestBytes  = 50 * MB
	sessionCookie   = "scry_session"
	webSessionTTL   = 30 * 24 * time.Hour
	deviceTokenTTL  = 365 * 24 * time.Hour
	deviceTokenPfx  = "scryd_"
	projectTokenPfx = "scry_"
)

type Config struct {
	DataDir       string
	PublicDir     string // landing page, account page, favicons
	PluginDir     string // claude-chat-logger/, served as a tar.gz at /plugin
	WebClientID   string // Google OAuth client of the /app page
	ClientIDs     []string
	AdminEmails   map[string]bool
	PublicURL     string
	FreeBytes     int64 // metered allowance before paying (20 MB)
	SpoolBytes    int64 // unsynced data held per user (50 MB)
	PricePerGBUSD int
	LongPoll      time.Duration
	Build         map[string]any
	Stripe        *Stripe
	Google        *GoogleVerifier
}

type Server struct {
	cfg        Config
	store      *Store
	mux        *http.ServeMux
	spoolBytes map[string]int64
	waiters    map[string]chan struct{}
	pluginOnce sync.Once
	pluginTgz  []byte
	pluginErr  error
	stop       chan struct{}
	stopOnce   sync.Once
}

func NewServer(cfg Config) (*Server, error) {
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return nil, err
	}
	st, err := LoadStore(cfg.DataDir)
	if err != nil {
		return nil, fmt.Errorf("loading state: %w", err)
	}
	s := &Server{cfg: cfg, store: st, spoolBytes: map[string]int64{}, waiters: map[string]chan struct{}{}, stop: make(chan struct{})}
	for uid := range st.state.Users {
		s.spoolBytes[uid] = s.spoolBytesFromDisk(uid)
	}
	s.routes()
	go func() {
		t := time.NewTicker(2 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				if err := s.store.Flush(); err != nil {
					log.Printf("scry: saving state: %v", err)
				}
			case <-s.stop:
				return
			}
		}
	}()
	return s, nil
}

// Close stops the background saver and saves pending changes.
func (s *Server) Close() error {
	s.stopOnce.Do(func() { close(s.stop) })
	return s.store.Flush()
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

func (s *Server) routes() {
	m := http.NewServeMux()
	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "ok\n") })
	m.HandleFunc("GET /version", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, s.cfg.Build) })
	for _, f := range []string{"favicon.svg", "favicon.ico", "apple-touch-icon.png"} {
		f := f
		m.HandleFunc("GET /"+f, func(w http.ResponseWriter, r *http.Request) {
			s.sendFile(w, f, "public, max-age=86400")
		})
	}
	m.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) { s.sendFile(w, "index.html", "no-cache") })
	m.HandleFunc("GET /app", func(w http.ResponseWriter, r *http.Request) { s.sendFile(w, "account.html", "no-store") })
	m.HandleFunc("GET /app/", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/app", http.StatusMovedPermanently)
	})
	m.HandleFunc("GET /plugin", s.handlePlugin)

	m.HandleFunc("GET /auth/config", s.handleAuthConfig)
	m.HandleFunc("POST /auth/google", s.handleGoogle)
	m.HandleFunc("POST /auth/logout", s.handleLogout)
	m.HandleFunc("GET /me", s.withUser(s.handleMe))
	m.HandleFunc("GET /projects", s.withUser(s.handleProjects))
	m.HandleFunc("POST /projects", s.withUser(s.handleCreateProject))
	m.HandleFunc("POST /projects/token", s.withUser(s.handleRotateToken))

	m.HandleFunc("POST /sync/pull", s.withUser(s.handlePull))
	m.HandleFunc("GET /sync/segment", s.withUser(s.handleSegment))
	m.HandleFunc("POST /sync/ack", s.withUser(s.handleAck))

	m.HandleFunc("POST /billing/storage", s.withUser(s.handleStorage))
	m.HandleFunc("POST /billing/portal", s.withUser(s.handlePortal))
	m.HandleFunc("POST /billing/webhook", s.handleWebhook)

	m.HandleFunc("GET /admin/users", s.withUser(s.handleAdminUsers))
	m.HandleFunc("POST /admin/users/credit", s.withUser(s.handleAdminCredit))

	m.HandleFunc("POST /ingest", s.handleIngest)
	m.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not found", http.StatusNotFound)
	})
	s.mux = m
}

// ---------- helpers ----------

type httpError struct {
	status int
	msg    string
}

func (e httpError) Error() string { return e.msg }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// readJSON decodes a JSON body of at most 64 KB. It insists on
// application/json, so a cross-site HTML form cannot post to cookie routes.
func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mt != "application/json" {
		writeErr(w, http.StatusUnsupportedMediaType, "send application/json")
		return false
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 64*1024+1))
	if err != nil || len(body) > 64*1024 {
		writeErr(w, http.StatusBadRequest, "body too large")
		return false
	}
	if len(bytes.TrimSpace(body)) == 0 {
		body = []byte("{}")
	}
	if err := json.Unmarshal(body, v); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return false
	}
	return true
}

func (s *Server) sendFile(w http.ResponseWriter, name, cache string) {
	b, err := os.ReadFile(filepath.Join(s.cfg.PublicDir, name))
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	ct := mime.TypeByExtension(filepath.Ext(name))
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", cache)
	w.Write(b)
}

func (s *Server) isSecure(r *http.Request) bool {
	return strings.HasPrefix(s.cfg.PublicURL, "https:") || r.Header.Get("X-Forwarded-Proto") == "https" || r.TLS != nil
}

func (s *Server) baseURL(r *http.Request) string {
	if s.cfg.PublicURL != "" {
		return strings.TrimRight(s.cfg.PublicURL, "/")
	}
	scheme := "http"
	if s.isSecure(r) {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

func (s *Server) isAdmin(u *User) bool { return u != nil && s.cfg.AdminEmails[u.Email] }

// allowance is what a user may have synced in total: the free bytes, admin
// grants, and the GB of a subscription in good standing.
func (s *Server) allowance(u *User) int64 {
	return s.cfg.FreeBytes + u.GrantedBytes + u.Subscription.ActiveGB()*GB
}

// viewer finds the signed-in user from the session cookie (browser) or a
// device token (Authorization: Bearer scryd_..., the Mac app). Call with the
// store lock held.
func (s *Server) viewerLocked(r *http.Request) *User {
	token := ""
	if a := r.Header.Get("Authorization"); strings.HasPrefix(a, "Bearer "+deviceTokenPfx) {
		token = strings.TrimPrefix(a, "Bearer ")
	} else if c, err := r.Cookie(sessionCookie); err == nil {
		token = c.Value
	}
	if token == "" {
		return nil
	}
	sess := s.store.state.Sessions[hashToken(token)]
	if sess == nil || sess.ExpiresAt.Before(time.Now()) {
		return nil
	}
	return s.store.state.Users[sess.UserID]
}

type userHandler func(w http.ResponseWriter, r *http.Request, u *User)

// withUser answers 401 without a signed-in user. Handlers get the user
// without the store lock held and take it themselves.
func (s *Server) withUser(h userHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s.store.mu.Lock()
		u := s.viewerLocked(r)
		s.store.mu.Unlock()
		if u == nil {
			writeErr(w, http.StatusUnauthorized, "sign in to scry")
			return
		}
		h(w, r, u)
	}
}

func fmtBytes(n int64) string {
	trim := func(f float64, unit string) string {
		s := strconv.FormatFloat(f, 'f', 1, 64)
		if f >= 10 {
			s = strconv.FormatFloat(f, 'f', 0, 64)
		}
		return strings.TrimSuffix(s, ".0") + " " + unit
	}
	switch {
	case n >= GB:
		return trim(float64(n)/float64(GB), "GB")
	case n >= MB:
		return trim(float64(n)/float64(MB), "MB")
	default:
		return strconv.FormatInt((n+1023)/1024, 10) + " KB"
	}
}

// ---------- auth ----------

func (s *Server) handleAuthConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{
		"google":  s.cfg.WebClientID,
		"billing": s.cfg.Stripe.Enabled(),
		"pricing": s.pricing(),
	})
}

func (s *Server) pricing() map[string]any {
	return map[string]any{
		"freeBytes":          s.cfg.FreeBytes,
		"packBytes":          GB,
		"pricePerGbMonthUsd": s.cfg.PricePerGBUSD,
		"spoolBytes":         s.cfg.SpoolBytes,
	}
}

// POST /auth/google {credential, device?}: a browser gets a cookie; with
// `device` (the Mac app's name for itself) the answer carries a device token
// for Authorization: Bearer instead.
func (s *Server) handleGoogle(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Credential string `json:"credential"`
		Device     string `json:"device"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	c, err := s.cfg.Google.Verify(body.Credential)
	if err != nil {
		var ae authError
		if errors.As(err, &ae) {
			writeErr(w, http.StatusUnauthorized, ae.msg)
		} else {
			writeErr(w, http.StatusBadGateway, err.Error())
		}
		return
	}
	now := time.Now().UTC()
	uid := "g_" + c.Sub
	s.store.mu.Lock()
	u := s.store.state.Users[uid]
	if u == nil {
		u = &User{ID: uid, CreatedAt: now, Projects: map[string]*Project{}}
		s.store.state.Users[uid] = u
	}
	u.Email = strings.ToLower(c.Email)
	u.Name = c.Name
	if len(u.Name) > 200 {
		u.Name = u.Name[:200]
	}
	if strings.HasPrefix(c.Picture, "https://") {
		u.Picture = c.Picture
	}
	u.LastLoginAt = now
	device := strings.TrimSpace(body.Device)
	var token string
	if device != "" {
		if len(device) > 100 {
			device = device[:100]
		}
		token = newToken(deviceTokenPfx)
		s.store.state.Sessions[hashToken(token)] = &Session{UserID: uid, ExpiresAt: now.Add(deviceTokenTTL), Device: device}
	} else {
		token = newToken("")
		s.store.state.Sessions[hashToken(token)] = &Session{UserID: uid, ExpiresAt: now.Add(webSessionTTL)}
	}
	err = s.store.saveLocked()
	me := s.describeLocked(u)
	s.store.mu.Unlock()
	if err != nil {
		writeErr(w, 500, "could not save the account")
		return
	}
	if device != "" {
		me["deviceToken"] = token
	} else {
		http.SetCookie(w, &http.Cookie{
			Name: sessionCookie, Value: token, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode,
			MaxAge: int(webSessionTTL.Seconds()), Secure: s.isSecure(r),
		})
	}
	writeJSON(w, 200, me)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	token := ""
	if a := r.Header.Get("Authorization"); strings.HasPrefix(a, "Bearer "+deviceTokenPfx) {
		token = strings.TrimPrefix(a, "Bearer ")
	} else if c, err := r.Cookie(sessionCookie); err == nil {
		token = c.Value
	}
	if token != "" {
		s.store.mu.Lock()
		if _, ok := s.store.state.Sessions[hashToken(token)]; ok {
			delete(s.store.state.Sessions, hashToken(token))
			_ = s.store.saveLocked()
		}
		s.store.mu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: -1, Secure: s.isSecure(r)})
	w.WriteHeader(http.StatusNoContent)
}

// describeLocked is what /me answers. Call with the store lock held.
func (s *Server) describeLocked(u *User) map[string]any {
	admin := s.isAdmin(u)
	var allowance any = s.allowance(u)
	if admin {
		allowance = nil
	}
	devices := 0
	for _, sess := range s.store.state.Sessions {
		if sess.UserID == u.ID && sess.Device != "" && sess.ExpiresAt.After(time.Now()) {
			devices++
		}
	}
	return map[string]any{
		"id":                u.ID,
		"email":             u.Email,
		"name":              u.Name,
		"picture":           u.Picture,
		"admin":             admin,
		"usedBytes":         u.IngestedBytes,
		"allowanceBytes":    allowance,
		"freeBytes":         s.cfg.FreeBytes,
		"grantedBytes":      u.GrantedBytes,
		"subscribedGB":      u.Subscription.ActiveGB(),
		"subscription":      u.Subscription,
		"pendingBytes":      s.spoolBytes[u.ID],
		"pendingLimitBytes": s.cfg.SpoolBytes,
		"lastSyncAt":        u.LastSyncAt,
		"devices":           devices,
		"createdAt":         u.CreatedAt,
		"lastLoginAt":       u.LastLoginAt,
		"billing":           s.cfg.Stripe.Enabled(),
		"pricing":           s.pricing(),
	}
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request, u *User) {
	s.store.mu.Lock()
	me := s.describeLocked(u)
	s.store.mu.Unlock()
	writeJSON(w, 200, me)
}

// ---------- projects ----------

type projectInfo struct {
	Name           string    `json:"name"`
	HasToken       bool      `json:"hasToken"`
	CreatedAt      time.Time `json:"createdAt"`
	TokenCreatedAt time.Time `json:"tokenCreatedAt"`
}

func (s *Server) handleProjects(w http.ResponseWriter, r *http.Request, u *User) {
	s.store.mu.Lock()
	out := []projectInfo{}
	for name, p := range u.Projects {
		out = append(out, projectInfo{name, p.TokenHash != "", p.CreatedAt, p.TokenCreatedAt})
	}
	s.store.mu.Unlock()
	sortProjects(out)
	writeJSON(w, 200, out)
}

func sortProjects(p []projectInfo) {
	for i := 1; i < len(p); i++ {
		for j := i; j > 0 && p[j].Name < p[j-1].Name; j-- {
			p[j], p[j-1] = p[j-1], p[j]
		}
	}
}

func validProjectName(name string) (string, error) {
	clean := sanitizeName(name)
	if clean == "" || clean != strings.TrimSpace(name) {
		return "", httpError{400, `project names use only letters, digits, ".", "_" and "-", and cannot start with "."`}
	}
	return clean, nil
}

// Project names are per user: two users can both have "work".
func (s *Server) handleCreateProject(w http.ResponseWriter, r *http.Request, u *User) {
	var body struct{ Name string }
	if !readJSON(w, r, &body) {
		return
	}
	name, err := validProjectName(body.Name)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	s.store.mu.Lock()
	defer s.store.mu.Unlock()
	if u.Projects[name] != nil {
		writeErr(w, 409, fmt.Sprintf("project %q already exists", name))
		return
	}
	if len(u.Projects) >= 100 {
		writeErr(w, 400, "at most 100 projects")
		return
	}
	token := newToken(projectTokenPfx)
	now := time.Now().UTC()
	u.Projects[name] = &Project{TokenHash: hashToken(token), CreatedAt: now, TokenCreatedAt: now}
	s.store.tokens[hashToken(token)] = projectRef{u.ID, name}
	if err := s.store.saveLocked(); err != nil {
		writeErr(w, 500, "could not save the project")
		return
	}
	writeJSON(w, 201, map[string]any{"name": name, "token": token, "createdAt": now})
}

func (s *Server) handleRotateToken(w http.ResponseWriter, r *http.Request, u *User) {
	var body struct{ Name string }
	if !readJSON(w, r, &body) {
		return
	}
	s.store.mu.Lock()
	defer s.store.mu.Unlock()
	p := u.Projects[body.Name]
	if p == nil {
		writeErr(w, 404, fmt.Sprintf("no project %q", body.Name))
		return
	}
	delete(s.store.tokens, p.TokenHash)
	token := newToken(projectTokenPfx)
	p.TokenHash = hashToken(token)
	p.TokenCreatedAt = time.Now().UTC()
	s.store.tokens[p.TokenHash] = projectRef{u.ID, body.Name}
	if err := s.store.saveLocked(); err != nil {
		writeErr(w, 500, "could not save the token")
		return
	}
	writeJSON(w, 200, map[string]any{"name": body.Name, "token": token, "createdAt": p.CreatedAt})
}

// ---------- ingest ----------

type spoolRecord struct {
	Project string `json:"project"`
	Session string `json:"session"`
	Line    string `json:"line"`
}

// POST /ingest: JSONL lines with Authorization: Bearer <project token>.
// Every line needs a project (X-Project header, else a "project" field) that
// is the token's project (400 / 403 otherwise); the session is X-Session-Id,
// else a "sessionId" field, else "default". A request is all or nothing.
// 402: the user's allowance (free 20 MB + packs bought) is used up.
// 507: the server already holds 50 MB the user's Mac has not synced.
func (s *Server) handleIngest(w http.ResponseWriter, r *http.Request) {
	bearer := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	s.store.mu.Lock()
	ref, ok := s.store.tokens[hashToken(strings.TrimSpace(bearer))]
	s.store.mu.Unlock()
	if bearer == "" || !ok {
		writeErr(w, 401, "missing or invalid bearer token: create a project in scry to get one")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxIngestBytes+1))
	if err != nil {
		writeErr(w, 400, "could not read the body")
		return
	}
	if int64(len(body)) > maxIngestBytes {
		w.Header().Set("Connection", "close")
		writeErr(w, 413, "body too large")
		return
	}
	headerProject := sanitizeName(r.Header.Get("X-Project"))
	headerSession := r.Header.Get("X-Session-Id")
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	var raw int64
	lines := 0
	for i, rawLine := range strings.Split(string(body), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" {
			continue
		}
		var fields struct {
			Project   any `json:"project"`
			SessionID any `json:"sessionId"`
		}
		_ = json.Unmarshal([]byte(line), &fields)
		project := headerProject
		if project == "" {
			if p, ok := fields.Project.(string); ok {
				project = sanitizeName(p)
			}
		}
		if project == "" {
			writeErr(w, 400, fmt.Sprintf(`line %d has no project: send an X-Project header or a "project" field in each line`, i+1))
			return
		}
		if project != ref.project {
			writeErr(w, 403, fmt.Sprintf("line %d is for project %q, but the token is for %q", i+1, project, ref.project))
			return
		}
		session := headerSession
		if session == "" {
			if sid, ok := fields.SessionID.(string); ok {
				session = sid
			}
		}
		session = sanitizeName(session)
		if session == "" {
			session = "default"
		}
		_ = enc.Encode(spoolRecord{project, session, line})
		raw += int64(len(line)) + 1
		lines++
	}
	if lines == 0 {
		writeJSON(w, 200, map[string]int{"appended": 0})
		return
	}

	s.store.mu.Lock()
	defer s.store.mu.Unlock()
	u := s.store.state.Users[ref.userID]
	if u == nil {
		writeErr(w, 401, "the project's owner no longer exists")
		return
	}
	if allowance := s.allowance(u); !s.isAdmin(u) && u.IngestedBytes+raw > allowance {
		writeJSON(w, http.StatusPaymentRequired, map[string]any{
			"error": fmt.Sprintf("storage limit reached: %s of %s used; add storage ($%d per GB per month) at %s/app#billing",
				fmtBytes(u.IngestedBytes), fmtBytes(allowance), s.cfg.PricePerGBUSD, s.baseURL(r)),
			"usedBytes":      u.IngestedBytes,
			"allowanceBytes": allowance,
		})
		return
	}
	if s.spoolBytes[u.ID]+int64(buf.Len()) > s.cfg.SpoolBytes {
		writeJSON(w, http.StatusInsufficientStorage, map[string]any{
			"error": fmt.Sprintf("the server already holds %s for you that has not synced to the Scry Mac app (limit %s): open Scry on your Mac to sync",
				fmtBytes(s.spoolBytes[u.ID]), fmtBytes(s.cfg.SpoolBytes)),
			"pendingBytes":      s.spoolBytes[u.ID],
			"pendingLimitBytes": s.cfg.SpoolBytes,
		})
		return
	}
	if err := s.spoolAppend(u.ID, buf.Bytes()); err != nil {
		writeErr(w, 500, "write failed")
		return
	}
	s.spoolBytes[u.ID] += int64(buf.Len())
	u.IngestedBytes += raw
	s.store.dirty = true
	s.notify(u.ID)
	writeJSON(w, 200, map[string]int{"appended": lines})
}

// ---------- sync (the Mac app) ----------

// POST /sync/pull[?wait=<seconds>]: seals what has arrived and lists the
// segments waiting for this user. With wait, holds the request (long poll)
// until something arrives or the wait ends, so the app syncs within moments.
func (s *Server) handlePull(w http.ResponseWriter, r *http.Request, u *User) {
	wait, _ := strconv.Atoi(r.URL.Query().Get("wait"))
	maxWait := s.cfg.LongPoll
	if d := time.Duration(wait) * time.Second; d < maxWait {
		maxWait = d
	}
	deadline := time.Now().Add(maxWait)
	for {
		s.store.mu.Lock()
		err := s.spoolSeal(u)
		segs := s.spoolSegments(u.ID)
		now := time.Now().UTC()
		u.LastSyncAt = &now
		s.store.dirty = true
		var ch chan struct{}
		if len(segs) == 0 && err == nil && time.Now().Before(deadline) {
			ch = s.waitChan(u.ID)
		}
		me := s.describeLocked(u)
		s.store.mu.Unlock()
		if err != nil {
			writeErr(w, 500, "could not seal the spool")
			return
		}
		if ch == nil {
			writeJSON(w, 200, map[string]any{"segments": segs, "me": me})
			return
		}
		t := time.NewTimer(time.Until(deadline))
		select {
		case <-ch:
			t.Stop()
		case <-t.C:
		case <-r.Context().Done():
			t.Stop()
			return
		}
	}
}

// GET /sync/segment?id=<n>: one sealed segment's records.
func (s *Server) handleSegment(w http.ResponseWriter, r *http.Request, u *User) {
	id, err := strconv.ParseInt(r.URL.Query().Get("id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, 400, "id is required")
		return
	}
	f, err := os.Open(s.segmentPath(u.ID, id))
	if err != nil {
		writeErr(w, 404, "no such segment (already synced?)")
		return
	}
	defer f.Close()
	if info, err := f.Stat(); err == nil {
		w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	io.Copy(w, f)
}

// POST /sync/ack {ids}: the Mac has these segments; delete them here.
func (s *Server) handleAck(w http.ResponseWriter, r *http.Request, u *User) {
	var body struct {
		IDs []int64 `json:"ids"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	s.store.mu.Lock()
	defer s.store.mu.Unlock()
	deleted := 0
	for _, id := range body.IDs {
		if id <= 0 {
			continue
		}
		p := s.segmentPath(u.ID, id)
		if info, err := os.Stat(p); err == nil {
			if os.Remove(p) == nil {
				s.spoolBytes[u.ID] -= info.Size()
				deleted++
			}
		}
	}
	if s.spoolBytes[u.ID] < 0 {
		s.spoolBytes[u.ID] = s.spoolBytesFromDisk(u.ID)
	}
	writeJSON(w, 200, map[string]any{"deleted": deleted, "pendingBytes": s.spoolBytes[u.ID]})
}

// ---------- billing ----------

// POST /billing/storage {gb}: the monthly subscription to `gb` GB. Without a
// subscription it answers {url} of a Stripe Checkout page; with one it
// changes the quantity in place (prorated) and answers the new state. It
// refuses to go below what is already synced (that would block ingest).
func (s *Server) handleStorage(w http.ResponseWriter, r *http.Request, u *User) {
	if !s.cfg.Stripe.Enabled() {
		writeErr(w, 404, "billing is not set up on this server")
		return
	}
	var body struct {
		GB int64 `json:"gb"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.GB < 1 || body.GB > 1000 {
		writeErr(w, 400, "choose between 1 and 1000 GB")
		return
	}
	s.store.mu.Lock()
	snapshot := *u
	sub := u.Subscription
	if sub != nil {
		c := *sub
		sub = &c
	}
	need := u.IngestedBytes - s.cfg.FreeBytes - u.GrantedBytes
	s.store.mu.Unlock()

	if sub == nil || sub.ActiveGB() == 0 {
		link, err := s.cfg.Stripe.Checkout(&snapshot, body.GB, s.baseURL(r)+"/app")
		if err != nil {
			writeErr(w, 502, err.Error())
			return
		}
		writeJSON(w, 200, map[string]string{"url": link})
		return
	}
	if need > 0 && body.GB*GB < need {
		writeErr(w, 400, fmt.Sprintf("you have synced %s: keep at least %d GB", fmtBytes(snapshot.IngestedBytes), (need+GB-1)/GB))
		return
	}
	if body.GB == sub.GB {
		s.handleMe(w, r, u)
		return
	}
	out, err := s.cfg.Stripe.SetQuantity(sub.ID, body.GB)
	if err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	s.store.mu.Lock()
	u.Subscription = out.toSubscription(time.Now().Unix())
	err = s.store.saveLocked()
	me := s.describeLocked(u)
	s.store.mu.Unlock()
	if err != nil {
		writeErr(w, 500, "could not save the subscription")
		return
	}
	log.Printf("scry: billing: %s now subscribes to %d GB", u.ID, body.GB)
	writeJSON(w, 200, me)
}

// POST /billing/portal: the Stripe Billing Portal (cancel, card, invoices).
func (s *Server) handlePortal(w http.ResponseWriter, r *http.Request, u *User) {
	if !s.cfg.Stripe.Enabled() {
		writeErr(w, 404, "billing is not set up on this server")
		return
	}
	s.store.mu.Lock()
	customer := u.StripeCustomerID
	s.store.mu.Unlock()
	if customer == "" {
		writeErr(w, 400, "no subscription yet")
		return
	}
	link, err := s.cfg.Stripe.Portal(customer, s.baseURL(r)+"/app")
	if err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	writeJSON(w, 200, map[string]string{"url": link})
}

// POST /billing/webhook: keeps subscriptions current. Events are applied
// as absolute state, so retries are harmless, and an event older than the
// data a user already has is ignored (Stripe does not guarantee order).
func (s *Server) handleWebhook(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.Stripe.Enabled() {
		http.NotFound(w, r)
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeErr(w, 400, "could not read the body")
		return
	}
	if err := s.cfg.Stripe.VerifyWebhook(raw, r.Header.Get("Stripe-Signature"), time.Now()); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	var ev stripeEvent
	if err := json.Unmarshal(raw, &ev); err != nil {
		writeErr(w, 400, "invalid webhook JSON")
		return
	}
	s.store.mu.Lock()
	defer s.store.mu.Unlock()
	switch ev.Type {
	case "checkout.session.completed":
		var cs stripeCheckoutSession
		if json.Unmarshal(ev.Data.Object, &cs) == nil {
			uid := cs.ClientReferenceID
			if uid == "" {
				uid = cs.Metadata["userId"]
			}
			if u := s.store.state.Users[uid]; u != nil && cs.Customer != "" {
				u.StripeCustomerID = cs.Customer
				_ = s.store.saveLocked()
			}
		}
	case "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted":
		var o stripeSubscription
		if json.Unmarshal(ev.Data.Object, &o) != nil {
			break
		}
		u := s.store.state.Users[o.Metadata["userId"]]
		if u == nil && o.Customer != "" {
			for _, x := range s.store.state.Users {
				if x.StripeCustomerID == o.Customer {
					u = x
				}
			}
		}
		if u == nil {
			log.Printf("scry: billing: %s for unknown user (subscription %s)", ev.Type, o.ID)
			break
		}
		if ev.Type == "customer.subscription.deleted" {
			o.Status = "canceled"
		}
		cur := u.Subscription
		if cur != nil && cur.ID == o.ID && ev.Created < cur.UpdatedAt {
			break // older than what we have
		}
		next := o.toSubscription(ev.Created)
		// An event about another subscription only replaces the current one
		// when it is live (a new subscription after a cancelled one).
		if cur != nil && cur.ID != o.ID && cur.ActiveGB() > 0 && next.ActiveGB() == 0 {
			break
		}
		u.Subscription = next
		if o.Customer != "" {
			u.StripeCustomerID = o.Customer
		}
		_ = s.store.saveLocked()
		log.Printf("scry: billing: %s: %s %s %d GB", ev.Type, u.ID, next.Status, next.GB)
	}
	writeJSON(w, 200, map[string]bool{"received": true})
}

// ---------- admin ----------

func (s *Server) handleAdminUsers(w http.ResponseWriter, r *http.Request, u *User) {
	if !s.isAdmin(u) {
		writeErr(w, 403, "admins only")
		return
	}
	s.store.mu.Lock()
	out := []map[string]any{}
	for _, x := range s.store.state.Users {
		out = append(out, s.describeLocked(x))
	}
	s.store.mu.Unlock()
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j]["usedBytes"].(int64) > out[j-1]["usedBytes"].(int64); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	writeJSON(w, 200, out)
}

// POST /admin/users/credit {email, gb}: grant storage by hand (comps,
// invoiced customers); it does not expire. Negative gb takes it back.
func (s *Server) handleAdminCredit(w http.ResponseWriter, r *http.Request, u *User) {
	if !s.isAdmin(u) {
		writeErr(w, 403, "admins only")
		return
	}
	var body struct {
		Email string `json:"email"`
		GB    int64  `json:"gb"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.GB == 0 || body.GB > 10000 || body.GB < -10000 {
		writeErr(w, 400, "gb must be a non-zero number of GB")
		return
	}
	s.store.mu.Lock()
	defer s.store.mu.Unlock()
	var target *User
	for _, x := range s.store.state.Users {
		if x.Email == strings.ToLower(strings.TrimSpace(body.Email)) {
			target = x
		}
	}
	if target == nil {
		writeErr(w, 404, "no such user")
		return
	}
	target.GrantedBytes += body.GB * GB
	if target.GrantedBytes < 0 {
		target.GrantedBytes = 0
	}
	if err := s.store.saveLocked(); err != nil {
		writeErr(w, 500, "could not save")
		return
	}
	writeJSON(w, 200, s.describeLocked(target))
}

// ---------- plugin ----------

// GET /plugin: claude-chat-logger/ as a tar.gz, built once. Public: cloud
// setup scripts cannot read secrets, and the tarball is only the plugin code.
func (s *Server) handlePlugin(w http.ResponseWriter, r *http.Request) {
	s.pluginOnce.Do(func() { s.pluginTgz, s.pluginErr = tarGz(s.cfg.PluginDir) })
	if s.pluginErr != nil || s.cfg.PluginDir == "" {
		http.Error(w, "plugin unavailable", 500)
		return
	}
	w.Header().Set("Content-Type", "application/gzip")
	w.Write(s.pluginTgz)
}

func tarGz(dir string) ([]byte, error) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	base := filepath.Base(dir)
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		name := filepath.ToSlash(filepath.Join(base, rel))
		info, err := d.Info()
		if err != nil {
			return err
		}
		hdr, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		hdr.Name = name
		if d.IsDir() {
			hdr.Name += "/"
		}
		hdr.Uid, hdr.Gid, hdr.Uname, hdr.Gname = 0, 0, "", ""
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if d.Type().IsRegular() {
			f, err := os.Open(p)
			if err != nil {
				return err
			}
			defer f.Close()
			_, err = io.Copy(tw, f)
			return err
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := gz.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
