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

// Stripe, without the SDK. Storage is a monthly subscription: one recurring
// price, STRIPE_PRICE_GB ($10 per GB per month), with the quantity as the
// number of GB. New subscriptions go through Checkout; changing the GB
// updates the subscription in place (prorated); cancelling and cards go
// through the Billing Portal. Webhooks keep each user's subscription current.
type Stripe struct {
	SecretKey     string
	WebhookSecret string
	PriceGB       string
	APIBase       string
	Client        *http.Client
}

func (s *Stripe) Enabled() bool { return s != nil && s.SecretKey != "" && s.PriceGB != "" }

// call sends a form-encoded request and decodes the answer into out.
func (s *Stripe) call(method, path string, form url.Values, out any) error {
	var body *strings.Reader
	if form != nil {
		body = strings.NewReader(form.Encode())
	} else {
		body = strings.NewReader("")
	}
	req, _ := http.NewRequest(method, s.APIBase+path, body)
	req.Header.Set("Authorization", "Bearer "+s.SecretKey)
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	res, err := s.Client.Do(req)
	if err != nil {
		return fmt.Errorf("Stripe: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		var e struct {
			Error struct{ Message string } `json:"error"`
		}
		_ = json.NewDecoder(res.Body).Decode(&e)
		if e.Error.Message == "" {
			e.Error.Message = fmt.Sprintf("HTTP %d", res.StatusCode)
		}
		return fmt.Errorf("Stripe: %s", e.Error.Message)
	}
	if out != nil {
		return json.NewDecoder(res.Body).Decode(out)
	}
	return nil
}

// Checkout answers the URL of a Checkout page subscribing `u` to `gb` GB a month.
func (s *Stripe) Checkout(u *User, gb int64, returnURL string) (string, error) {
	form := url.Values{}
	form.Set("mode", "subscription")
	form.Set("line_items[0][price]", s.PriceGB)
	form.Set("line_items[0][quantity]", strconv.FormatInt(gb, 10))
	form.Set("client_reference_id", u.ID)
	if u.StripeCustomerID != "" {
		form.Set("customer", u.StripeCustomerID)
	} else {
		form.Set("customer_email", u.Email)
	}
	form.Set("metadata[userId]", u.ID)
	form.Set("subscription_data[metadata][userId]", u.ID)
	form.Set("allow_promotion_codes", "true")
	form.Set("success_url", returnURL+"?billing=success")
	form.Set("cancel_url", returnURL+"?billing=cancelled")
	var out struct{ URL string }
	if err := s.call("POST", "/v1/checkout/sessions", form, &out); err != nil {
		return "", err
	}
	return out.URL, nil
}

// SetQuantity changes a subscription to `gb` GB (prorated) and answers it.
func (s *Stripe) SetQuantity(subID string, gb int64) (*stripeSubscription, error) {
	var cur stripeSubscription
	if err := s.call("GET", "/v1/subscriptions/"+url.PathEscape(subID), nil, &cur); err != nil {
		return nil, err
	}
	if len(cur.Items.Data) == 0 {
		return nil, fmt.Errorf("Stripe: subscription %s has no items", subID)
	}
	form := url.Values{}
	form.Set("items[0][id]", cur.Items.Data[0].ID)
	form.Set("items[0][quantity]", strconv.FormatInt(gb, 10))
	form.Set("proration_behavior", "create_prorations")
	var out stripeSubscription
	if err := s.call("POST", "/v1/subscriptions/"+url.PathEscape(subID), form, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Portal answers a Billing Portal URL (cancel, change card, invoices).
func (s *Stripe) Portal(customer, returnURL string) (string, error) {
	form := url.Values{}
	form.Set("customer", customer)
	form.Set("return_url", returnURL)
	var out struct{ URL string }
	if err := s.call("POST", "/v1/billing_portal/sessions", form, &out); err != nil {
		return "", err
	}
	return out.URL, nil
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
	ID      string `json:"id"`
	Type    string `json:"type"`
	Created int64  `json:"created"`
	Data    struct {
		Object json.RawMessage `json:"object"`
	} `json:"data"`
}

type stripeCheckoutSession struct {
	ID                string            `json:"id"`
	ClientReferenceID string            `json:"client_reference_id"`
	Customer          string            `json:"customer"`
	Metadata          map[string]string `json:"metadata"`
}

type stripeSubscription struct {
	ID                string            `json:"id"`
	Customer          string            `json:"customer"`
	Status            string            `json:"status"`
	CancelAtPeriodEnd bool              `json:"cancel_at_period_end"`
	CurrentPeriodEnd  int64             `json:"current_period_end"`
	Metadata          map[string]string `json:"metadata"`
	Items             struct {
		Data []struct {
			ID       string `json:"id"`
			Quantity int64  `json:"quantity"`
			// Newer API versions keep the period on the item.
			CurrentPeriodEnd int64 `json:"current_period_end"`
		} `json:"data"`
	} `json:"items"`
}

// toSubscription is what a user record keeps of a Stripe subscription.
func (o *stripeSubscription) toSubscription(updatedAt int64) *Subscription {
	sub := &Subscription{ID: o.ID, Status: o.Status, CancelAtPeriodEnd: o.CancelAtPeriodEnd, UpdatedAt: updatedAt}
	end := o.CurrentPeriodEnd
	if len(o.Items.Data) > 0 {
		sub.GB = o.Items.Data[0].Quantity
		if end == 0 {
			end = o.Items.Data[0].CurrentPeriodEnd
		}
	}
	if end > 0 {
		t := time.Unix(end, 0).UTC()
		sub.CurrentPeriodEnd = &t
	}
	return sub
}
