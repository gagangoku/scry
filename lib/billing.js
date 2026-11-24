// Paid plans through Stripe, without the Stripe SDK: Checkout for new
// subscriptions, the Billing Portal to change or cancel, and a webhook that
// moves users between plans. Enabled when STRIPE_SECRET_KEY is set.
//
//   STRIPE_SECRET_KEY        sk_live_... / sk_test_...
//   STRIPE_WEBHOOK_SECRET    whsec_... of the endpoint <public url>/billing/webhook
//   STRIPE_PRICE_PRO         price_... of the Pro subscription (one per paid plan id)
//   STRIPE_PRICE_MAX         price_... of the Max subscription
//
// The webhook needs these events: checkout.session.completed,
// customer.subscription.updated, customer.subscription.deleted.
const crypto = require('crypto');

class BillingError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Subscription states that keep the paid plan. past_due keeps it while
// Stripe retries the card; anything else drops to Free.
const PAID_STATUSES = new Set(['active', 'trialing', 'past_due']);

class Billing {
  constructor({ secretKey, webhookSecret, prices = {}, apiBase = 'https://api.stripe.com', toleranceSec = 300 }) {
    this.secretKey = secretKey;
    this.webhookSecret = webhookSecret;
    this.prices = prices; // { pro: 'price_...', max: 'price_...' }
    this.apiBase = apiBase;
    this.toleranceSec = toleranceSec;
  }

  get enabled() {
    return Boolean(this.secretKey);
  }

  purchasable(plan) {
    return Boolean(this.prices[plan]);
  }

  async stripe(pathname, params) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') body.append(k, String(v));
    const res = await fetch(this.apiBase + pathname, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.secretKey}`, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new BillingError(502, `Stripe: ${(data.error && data.error.message) || `HTTP ${res.status}`}`);
    return data;
  }

  // A Checkout page that subscribes `user` to `plan`; answers its URL.
  async checkout({ user, plan, returnUrl }) {
    if (!this.purchasable(plan)) throw new BillingError(400, `plan "${plan}" cannot be bought`);
    if (user.stripeSubscriptionId) throw new BillingError(409, 'you already have a subscription: use Manage billing to change plans');
    const s = await this.stripe('/v1/checkout/sessions', {
      mode: 'subscription',
      'line_items[0][price]': this.prices[plan],
      'line_items[0][quantity]': 1,
      client_reference_id: user.id,
      customer: user.stripeCustomerId,
      customer_email: user.stripeCustomerId ? undefined : user.email,
      'metadata[userId]': user.id,
      'metadata[plan]': plan,
      'subscription_data[metadata][userId]': user.id,
      'subscription_data[metadata][plan]': plan,
      allow_promotion_codes: 'true',
      success_url: `${returnUrl}?billing=success`,
      cancel_url: `${returnUrl}?billing=cancelled`,
    });
    return s.url;
  }

  // The Stripe Billing Portal for a paying user (change plan, card, cancel).
  async portal({ user, returnUrl }) {
    if (!user.stripeCustomerId) throw new BillingError(400, 'no billing account yet: upgrade first');
    const s = await this.stripe('/v1/billing_portal/sessions', { customer: user.stripeCustomerId, return_url: returnUrl });
    return s.url;
  }

  // Checks a webhook's Stripe-Signature (t=<ts>,v1=<hmac>) and answers the event.
  verifyWebhook(rawBody, signatureHeader, now = Date.now()) {
    if (!this.webhookSecret) throw new BillingError(500, 'STRIPE_WEBHOOK_SECRET is not set');
    const fields = {};
    for (const part of String(signatureHeader || '').split(',')) {
      const [k, v] = part.split('=');
      if (!k || !v) continue;
      (fields[k.trim()] ||= []).push(v.trim());
    }
    const t = Number(fields.t && fields.t[0]);
    if (!t || !fields.v1) throw new BillingError(400, 'bad Stripe-Signature header');
    if (Math.abs(now / 1000 - t) > this.toleranceSec) throw new BillingError(400, 'stale webhook');
    const expected = crypto.createHmac('sha256', this.webhookSecret).update(`${t}.${rawBody}`).digest();
    const match = fields.v1.some((sig) => {
      const b = Buffer.from(sig, 'hex');
      return b.length === expected.length && crypto.timingSafeEqual(b, expected);
    });
    if (!match) throw new BillingError(400, 'webhook signature mismatch');
    try {
      return JSON.parse(rawBody);
    } catch (_) {
      throw new BillingError(400, 'invalid webhook JSON');
    }
  }

  // Applies a Stripe event to the accounts; answers what changed (for logs/tests).
  applyEvent(event, accounts) {
    const obj = (event && event.data && event.data.object) || {};
    const meta = obj.metadata || {};
    switch (event.type) {
      case 'checkout.session.completed': {
        const user = accounts.findUser({ id: obj.client_reference_id || meta.userId });
        if (!user || !meta.plan) return null;
        accounts.setPlan(user.id, meta.plan, { stripeCustomerId: obj.customer || user.stripeCustomerId, stripeSubscriptionId: obj.subscription || null });
        return { userId: user.id, plan: meta.plan };
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const user = accounts.findUser({ id: meta.userId }) || accounts.findUser({ stripeCustomerId: obj.customer });
        if (!user) return null;
        // Ignore events for a subscription the user no longer has.
        if (user.stripeSubscriptionId && obj.id && obj.id !== user.stripeSubscriptionId && event.type !== 'customer.subscription.created') return null;
        const paid = event.type !== 'customer.subscription.deleted' && PAID_STATUSES.has(obj.status);
        // The plan follows the subscription's price when it changed in the portal.
        const priceId = obj.items && obj.items.data && obj.items.data[0] && obj.items.data[0].price && obj.items.data[0].price.id;
        const byPrice = Object.keys(this.prices).find((p) => this.prices[p] === priceId);
        const plan = paid ? (byPrice || meta.plan || user.plan) : 'free';
        accounts.setPlan(user.id, plan, {
          stripeCustomerId: obj.customer || user.stripeCustomerId,
          stripeSubscriptionId: paid ? obj.id : null,
        });
        return { userId: user.id, plan };
      }
      default:
        return null;
    }
  }
}

module.exports = { Billing, BillingError };
