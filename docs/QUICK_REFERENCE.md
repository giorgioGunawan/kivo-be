# Webhook-Driven Credit System - Quick Reference

## 🎯 TL;DR
Credits now refresh **when Apple sends renewal webhooks**, not on user actions or fixed schedules.

---

## 📊 Database Changes

| Table | Field | Type | Purpose |
|-------|-------|------|---------|
| `subscriptions` | `auto_renew_status` | BOOLEAN | Tracks if subscription will auto-renew |
| `credit_balances` | `last_weekly_refresh_at` | TIMESTAMP | Tracks last credit refresh time |

**Migration:** `migrations/002_webhook_driven_credits.sql` ✅ Applied

---

## 🔌 New Webhook Endpoint

**URL:** `POST /webhooks/apple`

| Event | Action |
|-------|--------|
| `DID_RENEW` | Refresh credits if 7+ days passed |
| `INITIAL_BUY` | Grant initial credits |
| `DID_FAIL_TO_RENEW` | Forfeit weekly credits |
| `EXPIRED` | Forfeit weekly credits |
| `DID_CHANGE_RENEWAL_STATUS` | Update auto-renew status |
| `REFUND` | Revoke subscription, forfeit credits |

---

## ⏰ Cron Job

**Schedule:** Daily at 00:00 UTC  
**Purpose:** Safety net for missed webhooks  
**Triggers:** Only if 8+ days since last refresh

---

## 🔍 How to Check Credit Status

```sql
-- Check user's credit status
SELECT 
  u.id,
  cb.weekly_remaining,
  cb.purchased_remaining,
  cb.last_weekly_refresh_at,
  s.status AS subscription_status,
  s.auto_renew_status,
  s.expires_at
FROM users u
JOIN credit_balances cb ON cb.user_id = u.id
LEFT JOIN subscriptions s ON s.user_id = u.id
WHERE u.id = <USER_ID>;
```

---

## 🐛 Common Issues

### Credits not refreshing?
```bash
# 1. Check webhook logs
grep "Apple Webhook" logs/app.log

# 2. Check subscription status
psql -d kivo_ai -c "SELECT * FROM subscriptions WHERE user_id = X"

# 3. Manually trigger refresh
curl -X POST http://localhost:3000/auth/subscription/verify \
  -H "Authorization: Bearer <token>" \
  -d '{"originalTransactionId": "..."}'
```

### Safety net triggering?
- Indicates webhook delivery issues
- Check Apple webhook URL in App Store Connect
- Verify webhook endpoint is publicly accessible

---

## 📝 Logging

| Log Message | Meaning |
|-------------|---------|
| `📱 Apple: Subscription renewed/purchased` | Successful renewal |
| `✅ Refreshed weekly credits for user X` | Credits refreshed |
| `⏭️  User X not yet eligible for refresh` | Less than 7 days passed |
| `⚠️  Found X users with missed refreshes` | Safety net triggered |
| `🗑️  Forfeited X weekly credits` | Subscription expired |

---

## 🚀 Next Steps

1. **Configure Apple Webhook URL** in App Store Connect
2. **Add JWT signature verification** for security
3. **Update frontend** to show "Renews with subscription"
4. **Monitor webhook delivery** success rate

---

## 📚 Full Documentation

- **Design:** `docs/credits-design.md`
- **Implementation:** `docs/webhook-credits-implementation.md`
- **Flows:** `docs/webhook-credits-flows.md`
- **Summary:** `IMPLEMENTATION_SUMMARY.md`
