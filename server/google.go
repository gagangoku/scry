package main

import (
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const googleCertsURL = "https://www.googleapis.com/oauth2/v3/certs"

// GoogleClaims are the ID token claims we use.
type GoogleClaims struct {
	Iss           string          `json:"iss"`
	Aud           json.RawMessage `json:"aud"`
	Exp           int64           `json:"exp"`
	Sub           string          `json:"sub"`
	Email         string          `json:"email"`
	EmailVerified any             `json:"email_verified"`
	Name          string          `json:"name"`
	Picture       string          `json:"picture"`
}

type authError struct{ msg string }

func (e authError) Error() string { return e.msg }

// GoogleVerifier checks Google ID tokens: RS256 signature against Google's
// published keys (cached per Cache-Control, refetched on an unknown key id),
// issuer, audience (one of our OAuth client ids: the web page's and the Mac
// app's), expiry, and a verified email.
type GoogleVerifier struct {
	CertsURL  string
	ClientIDs []string
	Client    *http.Client

	mu      sync.Mutex
	keys    map[string]*rsa.PublicKey
	expires time.Time
}

var maxAgeRe = regexp.MustCompile(`max-age=(\d+)`)

func (v *GoogleVerifier) fetchKeys() error {
	res, err := v.Client.Get(v.CertsURL)
	if err != nil {
		return fmt.Errorf("could not fetch Google signing keys: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("could not fetch Google signing keys: HTTP %d", res.StatusCode)
	}
	var body struct {
		Keys []struct {
			Kid string `json:"kid"`
			Kty string `json:"kty"`
			N   string `json:"n"`
			E   string `json:"e"`
		} `json:"keys"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return err
	}
	keys := map[string]*rsa.PublicKey{}
	for _, k := range body.Keys {
		if k.Kty != "RSA" {
			continue
		}
		n, err1 := base64.RawURLEncoding.DecodeString(k.N)
		e, err2 := base64.RawURLEncoding.DecodeString(k.E)
		if err1 != nil || err2 != nil {
			continue
		}
		keys[k.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
	}
	ttl := time.Hour
	if m := maxAgeRe.FindStringSubmatch(res.Header.Get("Cache-Control")); m != nil {
		if secs, err := strconv.Atoi(m[1]); err == nil {
			ttl = time.Duration(secs) * time.Second
		}
	}
	v.keys, v.expires = keys, time.Now().Add(ttl)
	return nil
}

func (v *GoogleVerifier) key(kid string) (*rsa.PublicKey, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.keys == nil || time.Now().After(v.expires) {
		if err := v.fetchKeys(); err != nil {
			return nil, err
		}
	}
	if k := v.keys[kid]; k != nil {
		return k, nil
	}
	// Google rotates keys: refetch once on an unknown kid.
	if err := v.fetchKeys(); err != nil {
		return nil, err
	}
	if k := v.keys[kid]; k != nil {
		return k, nil
	}
	return nil, authError{"Google credential signed with an unknown key"}
}

func (v *GoogleVerifier) Verify(token string) (*GoogleClaims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, authError{"malformed Google credential"}
	}
	hb, err1 := base64.RawURLEncoding.DecodeString(parts[0])
	pb, err2 := base64.RawURLEncoding.DecodeString(parts[1])
	sig, err3 := base64.RawURLEncoding.DecodeString(parts[2])
	if err1 != nil || err2 != nil || err3 != nil {
		return nil, authError{"malformed Google credential"}
	}
	var header struct{ Alg, Kid string }
	var c GoogleClaims
	if json.Unmarshal(hb, &header) != nil || json.Unmarshal(pb, &c) != nil {
		return nil, authError{"malformed Google credential"}
	}
	if header.Alg != "RS256" || header.Kid == "" {
		return nil, authError{"unsupported Google credential"}
	}
	key, err := v.key(header.Kid)
	if err != nil {
		var ae authError
		if errors.As(err, &ae) {
			return nil, ae
		}
		return nil, err
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], sig) != nil {
		return nil, authError{"invalid Google credential signature"}
	}
	if c.Iss != "accounts.google.com" && c.Iss != "https://accounts.google.com" {
		return nil, authError{"Google credential has the wrong issuer"}
	}
	var auds []string
	var one string
	if json.Unmarshal(c.Aud, &one) == nil {
		auds = []string{one}
	} else {
		_ = json.Unmarshal(c.Aud, &auds)
	}
	ok := false
	for _, a := range auds {
		for _, id := range v.ClientIDs {
			if a == id && id != "" {
				ok = true
			}
		}
	}
	if !ok {
		return nil, authError{"Google credential is for another app"}
	}
	if c.Exp*1000 < time.Now().Add(-time.Minute).UnixMilli() {
		return nil, authError{"Google credential has expired"}
	}
	if c.Sub == "" || !regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`).MatchString(c.Sub) {
		return nil, authError{"Google credential has no valid subject"}
	}
	if c.Email == "" || !(c.EmailVerified == true || c.EmailVerified == "true") {
		return nil, authError{"sign in with a Google account that has a verified email"}
	}
	return &c, nil
}
