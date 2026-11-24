package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// State is everything the server keeps besides the spooled session data:
// users (with their projects and payments) and sign-in sessions. It lives in
// <dataDir>/state.json, rewritten atomically. Tokens (project ingest tokens,
// browser cookies, device tokens) are stored only as SHA-256 hashes.
type State struct {
	Users    map[string]*User    `json:"users"`
	Sessions map[string]*Session `json:"sessions"`
}

type User struct {
	ID          string    `json:"id"`
	Email       string    `json:"email"`
	Name        string    `json:"name"`
	Picture     string    `json:"picture,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
	LastLoginAt time.Time `json:"lastLoginAt"`
	// Bytes of session lines ever accepted for this user: what is metered.
	IngestedBytes int64 `json:"ingestedBytes"`
	// Bytes bought on top of the free allowance (1 GB packs).
	PurchasedBytes int64               `json:"purchasedBytes"`
	Payments       []Payment           `json:"payments,omitempty"`
	Projects       map[string]*Project `json:"projects"`
	// Next spool segment number; segments are numbered per user.
	NextSegment int64      `json:"nextSegment"`
	LastSyncAt  *time.Time `json:"lastSyncAt,omitempty"`
}

type Project struct {
	TokenHash      string    `json:"tokenHash"`
	CreatedAt      time.Time `json:"createdAt"`
	TokenCreatedAt time.Time `json:"tokenCreatedAt"`
}

type Payment struct {
	ID     string    `json:"id"` // Stripe Checkout session id, or admin-<time>
	GB     int64     `json:"gb"`
	At     time.Time `json:"at"`
	Source string    `json:"source"` // stripe | admin
}

// A signed-in browser (cookie) or Mac app (device token).
type Session struct {
	UserID    string    `json:"userId"`
	ExpiresAt time.Time `json:"expiresAt"`
	Device    string    `json:"device,omitempty"`
}

type projectRef struct {
	userID  string
	project string
}

type Store struct {
	mu     sync.Mutex
	path   string
	state  State
	tokens map[string]projectRef // project token hash -> project
	dirty  bool
}

func hashToken(t string) string {
	h := sha256.Sum256([]byte(t))
	return hex.EncodeToString(h[:])
}

func newToken(prefix string) string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return prefix + base64.RawURLEncoding.EncodeToString(b)
}

func LoadStore(dataDir string) (*Store, error) {
	s := &Store{path: filepath.Join(dataDir, "state.json")}
	b, err := os.ReadFile(s.path)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if len(b) > 0 {
		if err := json.Unmarshal(b, &s.state); err != nil {
			return nil, err
		}
	}
	if s.state.Users == nil {
		s.state.Users = map[string]*User{}
	}
	if s.state.Sessions == nil {
		s.state.Sessions = map[string]*Session{}
	}
	s.tokens = map[string]projectRef{}
	for _, u := range s.state.Users {
		if u.Projects == nil {
			u.Projects = map[string]*Project{}
		}
		for name, p := range u.Projects {
			s.tokens[p.TokenHash] = projectRef{u.ID, name}
		}
	}
	return s, nil
}

// saveLocked writes state.json; call with mu held.
func (s *Store) saveLocked() error {
	now := time.Now()
	for h, sess := range s.state.Sessions {
		if sess.ExpiresAt.Before(now) {
			delete(s.state.Sessions, h)
		}
	}
	b, err := json.MarshalIndent(s.state, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return err
	}
	s.dirty = false
	return nil
}

// Flush saves if anything changed since the last save (usage counters are
// saved this way, not on every ingest).
func (s *Store) Flush() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.dirty {
		return nil
	}
	return s.saveLocked()
}

var (
	unsafeName = regexp.MustCompile(`[^a-zA-Z0-9._-]`)
	leadDots   = regexp.MustCompile(`^\.+`)
)

// sanitizeName mirrors lib/core.js: names become directory and file names on
// the Mac, so only [a-zA-Z0-9._-], never a leading dot, at most 128 chars.
func sanitizeName(s string) string {
	s = unsafeName.ReplaceAllString(strings.TrimSpace(s), "_")
	s = leadDots.ReplaceAllString(s, "_")
	if len(s) > 128 {
		s = s[:128]
	}
	return s
}
