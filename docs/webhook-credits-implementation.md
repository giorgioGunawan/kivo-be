# Webhook-Driven Credit System Implementation

## Overview
This implementation replaces the user-action-based credit refresh system with a **webhook-driven** approach that refreshes credits when Apple sends subscription renewal notifications.

## Key Changes

### 1. Database Schema
**New Fields:**
- `subscriptions.auto_renew_status` (BOOLEAN) - Tracks whether subscription will auto-renew
- `credit_balances.last_weekly_refresh_at` (TIMESTAMP) - Tracks last credit refresh timestamp

**Removed Fields:**
- `credit_balances.weekly_reset_at` - Replaced by `last_weekly_refresh_at`

### 2. New Services
**`src/services/credits/refresh.js`**
- `refreshWeeklyCredits(userId, reason, client)` - Refresh weekly credits to allocation
- `forfeitWeeklyCredits(userId, reason, client)` - Forfeit all weekly credits on expiry
- `isEligibleForRefresh(userId, client)` - Check if 7+ days passed since last refresh

### 3. Webhook Handler
**`src/routes/webhooks.js` - POST `/webhooks/apple`**

Handles Apple App Store Server Notifications:
- `DID_RENEW` / `INITIAL_BUY` / `SUBSCRIBED` → Refresh credits if eligible (7+ days)
- `DID_FAIL_TO_RENEW` / `EXPIRED` → Forfeit weekly credits
- `DID_CHANGE_RENEWAL_STATUS` → Update auto_renew_status
- `REFUND` → Revoke subscription and forfeit credits

### 4. Safety Net Cron
**`src/crons/index.js`**

Runs daily at 00:00 UTC to catch missed webhook deliveries:
- Only triggers for users with active subscriptions
- Only if 8+ days passed since last refresh (7 days + 1 day buffer)
- Logs warnings for any recovered refreshes

### 5. Updated Endpoints

**`GET /credits/balance`**
Now returns:
```json
{
  "weekly_remaining": 500,
  "purchased_remaining": 20,
  "last_weekly_refresh_at": "2026-02-15T05:00:00.000Z",
  "is_pro_subscriber": true,
  "subscription_expires_at": "2026-02-22T05:00:00.000Z"
}
```

**`POST /auth/subscription/verify`**
Now triggers credit refresh if eligible when manually verifying subscription.

## How It Works

### Credit Refresh Flow
```
1. User subscribes → Apple sends INITIAL_BUY webhook
2. Backend receives webhook → Updates subscription status
3. Check if eligible (7+ days since last refresh OR first time)
4. If eligible → Reset weekly_credits to 500, update last_weekly_refresh_at
5. Log to credit_ledger with reason='refresh'
```

### Subscription Renewal Flow
```
1. 7 days pass → Apple charges user → Sends DID_RENEW webhook
2. Backend receives webhook → Updates subscription status
3. Check if eligible (7+ days since last refresh)
4. If eligible → Refresh credits
5. If not eligible → Log skip (prevents double refresh)
```

### Subscription Expiry Flow
```
1. User cancels → Apple sends DID_CHANGE_RENEWAL_STATUS (auto_renew=false)
2. Backend updates auto_renew_status = false
3. Subscription expires → Apple sends DID_FAIL_TO_RENEW or EXPIRED
4. Backend forfeits all weekly credits
5. Purchased credits remain usable
```

## Edge Case Handling

### Problem: User cancels but subscription still active
**Solution:** 
- `auto_renew_status = false` prevents future refreshes
- Weekly credits remain usable until expiry
- On expiry webhook, credits are forfeited

### Problem: Webhook delivery fails
**Solution:**
- Daily safety net cron catches users who should have been refreshed
- Only triggers if 8+ days passed (7 + 1 day buffer)
- Logs warnings for monitoring

### Problem: User resubscribes after cancellation
**Solution:**
- INITIAL_BUY webhook triggers
- Checks eligibility (7+ days since last refresh)
- Refreshes credits if eligible

## Testing

### Test Webhook Locally
```bash
curl -X POST http://localhost:3000/webhooks/apple \
  -H "Content-Type: application/json" \
  -d '{
    "notificationType": "DID_RENEW",
    "data": {
      "signedTransactionInfo": {
        "productId": "com.kivo.weekly"
      },
      "expiresDate": 1739577600000
    }
  }'
```

### Test Safety Net Cron
```bash
# Manually trigger the cron (add this temporarily to crons/index.js)
# Or wait for daily execution at 00:00 UTC
```

### Verify Database Changes
```sql
-- Check new columns exist
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'subscriptions' AND column_name = 'auto_renew_status';

SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'credit_balances' AND column_name = 'last_weekly_refresh_at';

-- Check user data
SELECT u.id, cb.weekly_remaining, cb.last_weekly_refresh_at, s.auto_renew_status, s.expires_at
FROM users u
JOIN credit_balances cb ON cb.user_id = u.id
LEFT JOIN subscriptions s ON s.user_id = u.id;
```

## Production Deployment

### 1. Apply Migration
```bash
node scripts/migrate-webhook-credits.js
```

### 2. Configure Apple Webhook URL
In App Store Connect:
1. Go to your app → App Store Server Notifications
2. Set Production Server URL: `https://your-domain.com/webhooks/apple`
3. Set Sandbox Server URL: `https://your-domain.com/webhooks/apple`
4. Version: Version 2 (recommended)

### 3. Verify Webhook Signature (TODO)
For production, add JWT signature verification:
```javascript
// In src/routes/webhooks.js
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

// Verify Apple's JWT signature
// See: https://developer.apple.com/documentation/appstoreservernotifications/responding_to_app_store_server_notifications
```

### 4. Monitor Logs
Watch for:
- `📱 Apple: Subscription renewed/purchased` - Successful renewals
- `⚠️  Found X users with missed refreshes` - Safety net triggers
- `❌ Failed to refresh credits` - Errors requiring investigation

## Migration from Old System

### What Changed
| Old System | New System |
|------------|------------|
| `weekly_reset_at` | `last_weekly_refresh_at` |
| Cron-based refresh at fixed time | Webhook-driven refresh on renewal |
| "Resets in 4d 7h 23m" | "Renews with subscription" |
| No auto-renew tracking | `auto_renew_status` field |

### Backward Compatibility
- Existing users: `last_weekly_refresh_at` set to NOW() to prevent immediate refresh
- Old cron replaced with safety net
- Credit ledger remains unchanged (same structure)

## Troubleshooting

### Credits not refreshing
1. Check if webhook is being received: `grep "Apple Webhook" logs`
2. Check subscription status: `SELECT * FROM subscriptions WHERE user_id = X`
3. Check last refresh: `SELECT last_weekly_refresh_at FROM credit_balances WHERE user_id = X`
4. Manually trigger: Call `/auth/subscription/verify` endpoint

### Safety net triggering frequently
- Indicates webhook delivery issues
- Check Apple webhook configuration in App Store Connect
- Verify webhook URL is publicly accessible
- Check for 500 errors in webhook handler

### Credits forfeited unexpectedly
- Check subscription status: Should be 'expired' or 'revoked'
- Check credit ledger: `SELECT * FROM credit_ledger WHERE user_id = X ORDER BY created_at DESC`
- Look for `reason = 'expiry'` entries

## Next Steps

1. **Add JWT Signature Verification** - Verify Apple webhook authenticity
2. **Add Webhook Retry Logic** - Handle transient failures
3. **Add Monitoring/Alerts** - Track webhook delivery success rate
4. **Update Frontend** - Change "Resets in X days" to "Renews with subscription"
5. **Test Edge Cases** - Refunds, subscription upgrades/downgrades

## References
- [Apple App Store Server Notifications](https://developer.apple.com/documentation/appstoreservernotifications)
- [Credit System Design Doc](../docs/credits-design.md)
