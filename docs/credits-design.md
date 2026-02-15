# Final Credits Usage & Pricing Design Document

## 1. Credit Pools & Eligibility

### 1.1 Weekly Credits (Subscription Pool)
- **Granted automatically on subscription renewal** (webhook-driven).
- **Example allocation:**
  - Weekly plan: 500 credits / week.
  - Monthly plan: 1,500 credits / 28 days (treated as 3 × 500 weekly refreshes or a single 1,500 pool; see §4.3).
- **Credits do not roll over** across refreshes.
- **Entire weekly balance expires** at the moment of refresh.
- **Only available to active Pro subscribers** (Weekly or Monthly).

### 1.2 Purchased Credits (Top‑up Pool)
- **Bought via one‑off IAPs:**
  - Extra Small: 150 credits.
  - Extra Medium: 500 credits.
  - Extra Large: 1,000 credits.
- **Purchased credits never expire.**
- **Credits roll over indefinitely.**
- **Available only to Pro users for purchase**, but:
  - If Pro subscription later expires, remaining purchased credits remain usable.

---

## 2. Credit Consumption Rules

### 2.1 Strict Consumption Order
Credits are always consumed in this order:
1. **Weekly credits** (subscription pool).
2. **Purchased credits** (top‑up pool).

There is no configuration to invert this order.

### 2.2 Example Balance Flow
1. User receives 500 weekly credits.
2. Uses all 500 on generations.
3. Purchases 100 credits (top‑up).
   - Purchased balance now: 100.
4. Uses 80 credits on new generations:
   - Weekly: 0.
   - Purchased: 20.
5. **Subscription renews** (webhook triggers refresh):
   - Weekly resets to 500.
   - Purchased remains 20.
6. Subsequent usage:
   - Always consumes weekly first.
   - Purchased used only when weekly reaches 0.

---

## 3. Credit Costs & Pricing

### 3.1 Internal Cost Basis
- **Underlying infra cost per 10‑credit image:** ~USD 0.02 via Kie.ai (Nano Banana–equivalent tier).
- **Implied cost per 1 credit:** ~USD 0.002.
- **Higher‑cost media** (e.g. video) will use separate cost tiers and higher credit prices in future iterations.

### 3.2 User-Facing Credit Pricing
All prices in USD.

#### Subscriptions

**Weekly Plan – USD 8.99**
- Grants 500 credits per 7‑day cycle.
- Designed for ~50 images (10 credits / image).
- Infra max cost: 50 × 0.02 = USD 1.00.
- Minimum profit per week: USD 7.99.
- User effective cost per image: USD 0.18.

**Monthly Plan – USD 19.99**
- Grants 1,500 credits per 28–30 days (150 images at 10 credits / image).
- Infra max cost: 150 × 0.02 = USD 3.00.
- Minimum profit per month: USD 16.99.
- User effective cost per image: USD 0.133.

**One‑time Weekly Offer (Downsell) – USD 6.99**
- Triggered when user closes the main paywall.
- Grants 500 credits, same value as Weekly, single week.
- Infra max cost: USD 1.00.
- Minimum profit: USD 5.99.
- User effective cost per image: USD 0.14.

#### Top‑up Credits (IAP)

**Extra Small – USD 3**
- 150 credits (15 images at 10 credits / image).
- Infra max cost: 15 × 0.02 = USD 0.30.
- Minimum profit: USD 2.70.
- User cost per image: USD 0.20.

**Extra Medium – USD 7**
- 500 credits (50 images).
- Infra max cost: USD 1.00.
- Minimum profit: USD 6.00.
- User cost per image: USD 0.14.

**Extra Large – USD 12**
- 1,000 credits (100 images).
- Infra max cost: USD 2.00.
- Minimum profit: USD 10.00.
- User cost per image: USD 0.12.

### 3.3 Cost per Template
- **Each template has a fixed credit price** (flat pricing).
- **Example baseline:**
  - Image generation template: 10 credits per image.
- **Higher‑cost templates** (e.g. long‑form video) will:
  - Use higher credit prices (e.g. 40–400 credits).
  - Be priced to maintain similar or better gross margin vs. images.

---

## 4. Subscription & Refresh Logic

### 4.1 Refresh Trigger (Webhook-Driven)
- **Weekly refresh is triggered by Apple/Google subscription renewal webhooks**, not by a cron job or user action.
- **Anchor is the subscription renewal event:**
  - When Apple/Google sends a `DID_RENEW` or `INITIAL_BUY` notification, the backend checks if 7+ days have passed since the last refresh.
  - If eligible, weekly credits are refreshed immediately.
- **No calendar-based or user-action-based refresh.**

### 4.2 Refresh Behavior
On weekly refresh (triggered by webhook):
- **Weekly credit balance resets** to full plan allocation (e.g. 500).
- **Unused weekly credits are forfeited** and do not carry over.
- **Purchased credit balance is untouched.**

### 4.3 Monthly Plan Handling
Two implementation options (pick one and keep it consistent):

**Option A (Simpler UX):**
- Treat monthly as one large pool: 1,500 credits that refresh every 30 days.

**Option B (More granular):**
- Implement 500 credits per 7‑day period × 3 (1,500 total per 21 days) with some buffer; each interval behaves like weekly.

In all cases, the user experience is: **"1,500 credits per month,"** with the same consumption order and no rollover beyond renewal.

### 4.4 Subscription Expiry
If a subscription expires (no renewal webhook received):
- **Weekly credit pool is immediately disabled.**
- **Any remaining weekly credits are forfeited.**
- **Purchased credits remain fully usable.**
- **User is treated as non‑Pro**, even with purchased credits:
  - No new weekly allocations.
  - Only top‑up credits can be consumed.

### 4.5 Webhook-Driven Implementation Details
- **On `DID_RENEW` or `INITIAL_BUY` webhook:**
  1. Update `subscription_expires_at` and `auto_renew_status = true`.
  2. Check if `last_weekly_refresh_at` is NULL or older than 7 days.
  3. If eligible, reset `weekly_credits` to plan allocation and update `last_weekly_refresh_at = NOW()`.
  4. Log refresh event to credit ledger.

- **On `DID_FAIL_TO_RENEW` or `CANCEL` webhook:**
  1. Set `auto_renew_status = false`.
  2. Forfeit remaining weekly credits (set `weekly_credits = 0`).
  3. Log expiry event to credit ledger.

- **No daily cron job required** for credit refresh. Optional safety net cron can run to catch missed webhooks (see §5.4).

---

## 5. Backend Enforcement & Ledger

### 5.1 Job Validation
For every generation request:
- **Backend estimates the total required credits** based on:
  - Template type, resolution, model, and duration (for future video/audio).
- **If required > available total credits (weekly + purchased):**
  - Reject the job.
- **No partial credit usage:**
  - Job either fully authorized and debited, or rejected with no change in balance.

### 5.2 Rate Limiting & Safety Caps
Enforce at least one of:
- **Max concurrent jobs per user** (e.g. up to 5 in‑flight jobs).
- **Optional:** daily or hourly caps per user for abuse mitigation.

### 5.3 Ledger Model (Server‑Authoritative)
All credit changes are recorded as immutable ledger entries.

**Required fields per entry:**
- `user_id` or `device_id`.
- `pool_type`: `weekly` | `purchased` | `anonymous`.
- `delta`: signed integer representing credit change (+/‑).
- `reason`: `refresh`, `generation`, `purchase`, `expiry`, `grant`, etc.
- `timestamp` (server‑side).

**The client is never trusted** for balance updates; all balances are computed server‑side from authoritative state.

### 5.4 Optional Safety Net (Webhook Failure Recovery)
A lightweight daily cron can run to catch missed webhook deliveries:

```javascript
// Safety net: runs once daily to catch any missed webhooks
async function creditRefreshSafetyNet() {
  const missedRefreshes = await db.query(`
    SELECT user_id 
    FROM users 
    WHERE subscription_expires_at > NOW()
    AND auto_renew_status = true
    AND last_weekly_refresh_at < NOW() - INTERVAL '8 days'
  `);
  
  for (const user of missedRefreshes.rows) {
    console.warn(`Missed refresh for user ${user.user_id}, triggering now`);
    await refreshWeeklyCredits(user.user_id);
  }
}
```

This only catches:
- Webhook delivery failures.
- Race conditions.
- Database inconsistencies.

---

## 6. Frontend Behavior

### 6.1 Credit Display
**In the detailed credit sheet:**
- Show both pools explicitly:
  - "Pro Weekly: 500 credits (renews with subscription)"
  - "Extra credits: 20 (never expire)"

**In compact UI (e.g. pill near CTA):**
- Show combined available credits:
  - "520 credits" or "520 credits left".

### 6.2 Insufficient Credits UX
**If weekly = 0 and purchased > 0:**
- Allow generation using purchased credits.
- No hard paywall; show subtle upsell to renew/upgrade Pro.

**If both weekly and purchased = 0:**
- Reject the generation request.
- Show paywall with:
  - Option to subscribe to Weekly or Monthly.
  - If user is already Pro: offer top‑up purchases (Small/Medium/Large).

**If generation cost > available credits:**
- Reject request.
- Surface:
  - "You need X more credits to run this."
  - CTA: "Top up credits" and/or "Upgrade plan".

### 6.3 Non‑Subscribed User with Purchased Credits
- User can generate as long as purchased credits are sufficient.
- **UI clearly shows:**
  - "Purchased credits: X (usable)."
  - "Pro weekly credits: Inactive."
- **Pro upsell remains visible but optional:**
  - "Get 500 weekly credits for 8.99" etc.

### 6.4 Anonymous Users (No Account)
- **Maintain a device‑scoped credit pool:**
  - Small, non‑refreshing free balance (e.g. 20–30 credits).
  - No weekly refresh.
- **Once exhausted:**
  - Show conversion funnel:
    - "Create an account to keep your work."
    - Upsell to Pro or to top‑up packs after signup.

---

## 7. Economic Guardrails

### 7.1 Margins by Product
Maintain the following minimum gross margin assumptions (given infra cost 0.02 / image):
- **Weekly plan:** profit ≥ 7.99 / week.
- **Monthly plan:** profit ≥ 16.99 / month.
- **One‑time weekly offer:** profit ≥ 5.99.
- **Extra Small:** profit ≥ 2.70.
- **Extra Medium:** profit ≥ 6.00.
- **Extra Large:** profit ≥ 10.00.

### 7.2 Future Price Adjustments
If upstream costs change (Kie.ai / model pricing), adjust:
- Credits per image, or
- Credits per plan, or
- Retail price.

**Keep UX invariant where possible:**
- "~10 credits per standard image."
- "500 credits / week" headline for Pro.

---

## 8. Summary of Key Changes (Webhook-Driven Model)

| Aspect | Old Design | New Design (Webhook-Driven) |
|--------|------------|------------------------------|
| **Refresh Trigger** | User's first generation timestamp | Apple/Google subscription renewal webhook |
| **Refresh Timing** | 7 days from first generation | Immediately on subscription renewal |
| **Infrastructure** | Daily cron job required | No cron required (optional safety net) |
| **UX Messaging** | "Resets in 4d 7h 23m" | "Renews with subscription" |
| **Edge Case Handling** | Complex grace period logic | Handled by webhook delivery timing |
| **Subscription Expiry** | Manual check on refresh | Automatic via `DID_FAIL_TO_RENEW` webhook |

---

## 9. Implementation Checklist

- [ ] Update database schema to include `auto_renew_status` boolean field.
- [ ] Implement webhook handlers for `DID_RENEW`, `INITIAL_BUY`, `DID_FAIL_TO_RENEW`, `CANCEL`.
- [ ] Add credit refresh logic to renewal webhook handler.
- [ ] Update credit ledger to log `refresh`, `expiry` events.
- [ ] (Optional) Implement safety net cron for missed webhooks.
- [ ] Update frontend to display "Renews with subscription" instead of countdown timer.
- [ ] Test edge cases: cancellation, renewal failure, webhook delays.
