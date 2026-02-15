# Webhook-Driven Credit System - Flow Diagrams

## 1. Credit Refresh Flow (Happy Path)

```
┌─────────────┐
│   User      │
│ Subscribes  │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│                    Apple                                │
│  - Processes payment                                    │
│  - Sends INITIAL_BUY webhook                            │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│              Kivo Backend                               │
│  POST /webhooks/apple                                   │
│                                                          │
│  1. Receive webhook                                     │
│  2. Update subscription status (active)                 │
│  3. Set auto_renew_status = true                        │
│  4. Check: last_weekly_refresh_at < NOW() - 7 days?     │
│     ├─ YES → Refresh credits (500)                      │
│     └─ NO  → Skip (too soon)                            │
│  5. Update last_weekly_refresh_at = NOW()               │
│  6. Log to credit_ledger (reason='refresh')             │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│              Database                                   │
│  subscriptions:                                         │
│    - status = 'active'                                  │
│    - auto_renew_status = true                           │
│    - expires_at = NOW() + 7 days                        │
│                                                          │
│  credit_balances:                                       │
│    - weekly_remaining = 500                             │
│    - last_weekly_refresh_at = NOW()                     │
│                                                          │
│  credit_ledger:                                         │
│    - pool_type = 'weekly'                               │
│    - delta = +500                                       │
│    - reason = 'refresh'                                 │
└─────────────────────────────────────────────────────────┘
```

---

## 2. Subscription Renewal Flow (7 Days Later)

```
┌─────────────┐
│   7 Days    │
│    Pass     │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│                    Apple                                │
│  - Charges user for renewal                             │
│  - Sends DID_RENEW webhook                              │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│              Kivo Backend                               │
│  POST /webhooks/apple                                   │
│                                                          │
│  1. Receive DID_RENEW webhook                           │
│  2. Update subscription expires_at (NOW() + 7 days)     │
│  3. Check: last_weekly_refresh_at < NOW() - 7 days?     │
│     ├─ YES → Refresh credits                            │
│     │   - Current: 120 credits remaining                │
│     │   - Delta: 500 - 120 = +380                       │
│     │   - New: 500 credits                              │
│     └─ NO  → Skip (shouldn't happen)                    │
│  4. Update last_weekly_refresh_at = NOW()               │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│              Database                                   │
│  credit_balances:                                       │
│    - weekly_remaining = 500 (reset from 120)            │
│    - purchased_remaining = 20 (unchanged)               │
│    - last_weekly_refresh_at = NOW()                     │
│                                                          │
│  credit_ledger:                                         │
│    - delta = +380 (500 - 120)                           │
│    - reason = 'refresh'                                 │
└─────────────────────────────────────────────────────────┘
```

---

## 3. Subscription Cancellation Flow

```
┌─────────────┐
│    User     │
│   Cancels   │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│                    Apple                                │
│  - Sends DID_CHANGE_RENEWAL_STATUS webhook              │
│  - subtype = 'AUTO_RENEW_DISABLED'                      │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│              Kivo Backend                               │
│  POST /webhooks/apple                                   │
│                                                          │
│  1. Receive DID_CHANGE_RENEWAL_STATUS                   │
│  2. Update auto_renew_status = false                    │
│  3. Check: expires_at < NOW() + 24 hours?               │
│     ├─ YES → Forfeit weekly credits now                 │
│     └─ NO  → Keep credits until expiry                  │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│              Database                                   │
│  subscriptions:                                         │
│    - status = 'active' (still active until expires)     │
│    - auto_renew_status = false                          │
│    - expires_at = (unchanged)                           │
│                                                          │
│  credit_balances:                                       │
│    - weekly_remaining = 350 (still usable)              │
│    - purchased_remaining = 20                           │
└─────────────────────────────────────────────────────────┘
```

---

## 4. Subscription Expiry Flow

```
┌─────────────┐
│ Expires_at  │
│   Reached   │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│                    Apple                                │
│  - Subscription expires (no renewal)                    │
│  - Sends DID_FAIL_TO_RENEW or EXPIRED webhook           │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│              Kivo Backend                               │
│  POST /webhooks/apple                                   │
│                                                          │
│  1. Receive DID_FAIL_TO_RENEW webhook                   │
│  2. Update subscription status = 'expired'              │
│  3. Set auto_renew_status = false                       │
│  4. Forfeit all weekly credits                          │
│     - Current: 350 credits                              │
│     - Delta: -350                                       │
│     - New: 0 credits                                    │
│  5. Keep purchased credits (20)                         │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│              Database                                   │
│  subscriptions:                                         │
│    - status = 'expired'                                 │
│    - auto_renew_status = false                          │
│                                                          │
│  credit_balances:                                       │
│    - weekly_remaining = 0 (forfeited)                   │
│    - purchased_remaining = 20 (still usable!)           │
│                                                          │
│  credit_ledger:                                         │
│    - delta = -350                                       │
│    - reason = 'expiry'                                  │
└─────────────────────────────────────────────────────────┘
```

---

## 5. Safety Net Cron Flow (Missed Webhook)

```
┌─────────────┐
│  Daily Cron │
│  00:00 UTC  │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│              Kivo Backend                               │
│  Cron: Credit Refresh Safety Net                        │
│                                                          │
│  1. Query users with:                                   │
│     - status = 'active'                                 │
│     - auto_renew_status = true                          │
│     - expires_at > NOW()                                │
│     - last_weekly_refresh_at < NOW() - 8 days           │
│                                                          │
│  2. Found 0 users → ✅ No missed refreshes              │
│     OR                                                   │
│     Found 2 users → ⚠️  Webhook delivery failed         │
│                                                          │
│  3. For each missed user:                               │
│     - Log warning                                       │
│     - Trigger refreshWeeklyCredits()                    │
│     - Update last_weekly_refresh_at                     │
└─────────────────────────────────────────────────────────┘
```

---

## 6. Edge Case: User Resubscribes After Expiry

```
┌─────────────┐
│    User     │
│ Resubscribes│
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│                    Apple                                │
│  - Sends INITIAL_BUY webhook (new subscription)         │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│              Kivo Backend                               │
│  POST /webhooks/apple                                   │
│                                                          │
│  1. Receive INITIAL_BUY webhook                         │
│  2. Update subscription status = 'active'               │
│  3. Set auto_renew_status = true                        │
│  4. Check: last_weekly_refresh_at < NOW() - 7 days?     │
│     - Last refresh was 30 days ago (expired)            │
│     - YES → Refresh credits                             │
│  5. Grant 500 weekly credits                            │
│  6. User still has 20 purchased credits                 │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│              Database                                   │
│  credit_balances:                                       │
│    - weekly_remaining = 500 (refreshed)                 │
│    - purchased_remaining = 20 (preserved!)              │
│    - Total: 520 credits                                 │
└─────────────────────────────────────────────────────────┘
```

---

## Key Principles

1. **Webhooks are the source of truth** - Not user actions or cron jobs
2. **7-day eligibility check** - Prevents double refreshes
3. **Purchased credits never expire** - Even after subscription ends
4. **Safety net is lightweight** - Only catches webhook failures
5. **Auto-renew status matters** - Determines future refresh eligibility
