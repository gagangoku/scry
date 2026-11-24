package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Stripe, without the SDK. Storage is sold in 1 GB packs, paid once through
// Stripe Checkout (mode=payment) at STRIPE_PRICE_GB (a one-time price, $10);
// the quantity is the number of GB. A signed webhook credits the user.
type Stripe struct {
	SecretKey     string
	WebhookSecret string
	PriceGB       string
	APIBase       string
	Client        *http.Client
}

func (s *Stripe) Enabled() bool { return s != nil && s.SecretKey != "" && s.PriceGB != "" }

func (s *Stripe) post(path string, form url.Values) (map[string]any, error) {
	req, _ := http.NewRequest("POST", s.APIBase+path, strings.NewReader(form.Encode()))
	req.Header.Set("Authorization", "Bearer "+s.SecretKey)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := s.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Stripe: %w", err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	if res.StatusCode >= 300 {
		msg := fmt.Sprintf("HTTP %d", res.StatusCode)
		if e, ok := out["error"].(map[string]any); ok {
			if m, ok := e["message"].(string); ok {
				msg = m
			}
		}
		return nil, fmt.Errorf("Stripe: %s", msg)
	}
	return out, nil
}

// Checkout answers the URL of a Checkout page buying `gb` GB for `u`.
func (s *Stripe) Checkout(u *User, gb int64, returnURL string) (string, error) {
	form := url.Values{}
	form.Set("mode", "payment")
	form.Set("line_items[0][price]", s.PriceGB)
	form.Set("line_items[0][quantity]", strconv.FormatInt(gb, 10))
	form.Set("client_reference_id", u.ID)
	form.Set("customer_email", u.Email)
	form.Set("metadata[userId]", u.ID)
	form.Set("metadata[gb]", strconv.FormatInt(gb, 10))
	form.Set("allow_promotion_codes", "true")
	form.Set("success_url", returnURL+"?billing=success")
	form.Set("cancel_url", returnURL+"?billing=cancelled")
	out, err := s.post("/v1/checkout/sessions", form)
	if err != nil {
		return "", err
	}
	link, _ := out["url"].(string)
	return link, nil
}

// VerifyWebhook checks Stripe-Signature (t=<unix>,v1=<hex hmac>) over the raw
// body, within 5 minutes.
func (s *Stripe) VerifyWebhook(raw []byte, header string, now time.Time) error {
	if s.WebhookSecret == "" {
		return fmt.Errorf("STRIPE_WEBHOOK_SECRET is not set")
	}
	var ts int64
	var sigs []string
	for _, part := range strings.Split(header, ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch k {
		case "t":
			ts, _ = strconv.ParseInt(v, 10, 64)
		case "v1":
			sigs = append(sigs, v)
		}
	}
	if ts == 0 || len(sigs) == 0 {
		return fmt.Errorf("bad Stripe-Signature header")
	}
	if math.Abs(float64(now.Unix()-ts)) > 300 {
		return fmt.Errorf("stale webhook")
	}
	mac := hmac.New(sha256.New, []byte(s.WebhookSecret))
	fmt.Fprintf(mac, "%d.", ts)
	mac.Write(raw)
	want := mac.Sum(nil)
	for _, sig := range sigs {
		if got, err := hex.DecodeString(sig); err == nil && hmac.Equal(got, want) {
			return nil
		}
	}
	return fmt.Errorf("webhook signature mismatch")
}

type stripeEvent struct {
	ID   string `json:"id"`
	Type string `json:"type"`
	Data struct {
		Object struct {
			ID                string            `json:"id"`
			ClientReferenceID string            `json:"client_reference_id"`
			PaymentStatus     string            `json:"payment_status"`
			Metadata          map[string]string `json:"metadata"`
		} `json:"object"`
	} `json:"data"`
}
