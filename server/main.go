// scry server: Google sign-in, per-user projects and ingest tokens, a 50 MB
// per-user spool that the Scry Mac app drains (and that is deleted once
// synced), metering against a 20 MB free allowance plus a monthly Stripe
// subscription at $10 per GB, and the public landing page and plugin. Sessions are
// searched only in the Mac app; the server has no search or session views.
//
// Environment:
//
//	PORT, HOST                     listen address (9999, 0.0.0.0)
//	SCRY_DATA_DIR                  state.json and the spool (/data)
//	SCRY_PUBLIC_DIR                landing/account pages, favicons (./public)
//	SCRY_PLUGIN_DIR                claude-chat-logger/ for GET /plugin
//	SCRY_GOOGLE_CLIENT_ID          OAuth client of the /app page (required)
//	SCRY_GOOGLE_DESKTOP_CLIENT_ID  OAuth client of the Mac app
//	SCRY_ADMIN_EMAILS              ','-separated admin Google emails
//	SCRY_PUBLIC_URL                e.g. https://scry.teltrix.ai
//	SCRY_FREE_MB (20), SCRY_SPOOL_MB (50), SCRY_PRICE_PER_GB_MONTH_USD (10)
//	STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_GB
package main

import (
	"context"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Set at build time: go build -ldflags "-X main.version=... -X main.build=...".
var (
	version = "dev"
	build   = "dev"
	commit  = ""
	builtAt = ""
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if n, err := strconv.Atoi(os.Getenv(k)); err == nil && n > 0 {
		return n
	}
	return def
}

func main() {
	httpClient := &http.Client{Timeout: 30 * time.Second}
	web := os.Getenv("SCRY_GOOGLE_CLIENT_ID")
	if web == "" {
		log.Fatal("scry: SCRY_GOOGLE_CLIENT_ID is required (Google sign-in is how people use scry)")
	}
	admins := map[string]bool{}
	for _, e := range strings.Split(os.Getenv("SCRY_ADMIN_EMAILS"), ",") {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" {
			admins[e] = true
		}
	}
	cfg := Config{
		DataDir:       env("SCRY_DATA_DIR", "/data"),
		PublicDir:     env("SCRY_PUBLIC_DIR", "public"),
		PluginDir:     env("SCRY_PLUGIN_DIR", "claude-chat-logger"),
		WebClientID:   web,
		ClientIDs:     []string{web, os.Getenv("SCRY_GOOGLE_DESKTOP_CLIENT_ID")},
		AdminEmails:   admins,
		PublicURL:     os.Getenv("SCRY_PUBLIC_URL"),
		FreeBytes:     int64(envInt("SCRY_FREE_MB", 20)) * MB,
		SpoolBytes:    int64(envInt("SCRY_SPOOL_MB", 50)) * MB,
		PricePerGBUSD: envInt("SCRY_PRICE_PER_GB_MONTH_USD", 10),
		LongPoll:      25 * time.Second,
		Build:         map[string]any{"version": version, "build": build, "commit": commit, "builtAt": builtAt, "app": "server"},
		Stripe: &Stripe{
			SecretKey: os.Getenv("STRIPE_SECRET_KEY"), WebhookSecret: os.Getenv("STRIPE_WEBHOOK_SECRET"),
			PriceGB: os.Getenv("STRIPE_PRICE_GB"), APIBase: "https://api.stripe.com", Client: httpClient,
		},
		// SCRY_GOOGLE_CERTS_URL is for tests (a fake key server).
		Google: &GoogleVerifier{CertsURL: env("SCRY_GOOGLE_CERTS_URL", googleCertsURL), Client: httpClient},
	}
	cfg.Google.ClientIDs = cfg.ClientIDs
	srv, err := NewServer(cfg)
	if err != nil {
		log.Fatalf("scry: %v", err)
	}
	addr := net.JoinHostPort(env("HOST", "0.0.0.0"), env("PORT", "9999"))
	hs := &http.Server{Addr: addr, Handler: srv, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 120 * time.Second}
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
		<-sig
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = hs.Shutdown(ctx)
	}()
	log.Printf("scry: listening on %s, data in %s, billing %v", addr, cfg.DataDir, cfg.Stripe.Enabled())
	if err := hs.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("scry: %v", err)
	}
	if err := srv.Close(); err != nil {
		log.Printf("scry: saving state: %v", err)
	}
}
