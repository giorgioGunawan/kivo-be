const cron = require('node-cron');
const db = require('../config/db');
const { creditRefreshService } = require('../services/credits/refresh');

// Safety Net: Catch Missed Webhook Deliveries
// Runs daily to ensure no users are missed due to webhook failures
cron.schedule('0 0 * * *', async () => {
    console.log('🔍 Running Credit Refresh Safety Net (Webhook Failure Recovery)');
    const client = await db.pool.connect();
    try {
        // Find users who should have been refreshed but weren't
        // Criteria:
        // 1. Active subscription
        // 2. Auto-renew enabled
        // 3. Last refresh was 8+ days ago (7 days + 1 day buffer for webhook delays)
        const missedRefreshes = await client.query(`
            SELECT cb.user_id, cb.last_weekly_refresh_at, s.expires_at
            FROM credit_balances cb
            JOIN subscriptions s ON s.user_id = cb.user_id
            WHERE s.status = 'active'
              AND s.expires_at > NOW()
              AND s.auto_renew_status = true
              AND cb.last_weekly_refresh_at < NOW() - INTERVAL '8 days'
        `);

        if (missedRefreshes.rows.length === 0) {
            console.log('✅ No missed refreshes detected');
        } else {
            console.warn(`⚠️  Found ${missedRefreshes.rows.length} users with missed refreshes`);

            for (const user of missedRefreshes.rows) {
                try {
                    console.warn(`🔧 Recovering missed refresh for user ${user.user_id} (last refresh: ${user.last_weekly_refresh_at})`);
                    await creditRefreshService.refreshWeeklyCredits(user.user_id, 'refresh');
                } catch (err) {
                    console.error(`❌ Failed to recover refresh for user ${user.user_id}:`, err);
                }
            }
        }
    } catch (e) {
        console.error('❌ Safety Net Cron Error:', e);
    } finally {
        client.release();
    }
});

// Subscription Verification Task (Poll expired subs)
cron.schedule('0 12 * * *', async () => {
    // Check subscriptions expiring soon or expired, verify with Apple stub
    console.log('Running Subscription Verification Task (Stub)');
    // Implementation would query DB for expiring subs, call verifySubscription, update status.
    // If status changes to expired -> trigger forfeit of weekly credits?
    // "Weekly credits ... Forfeited immediately on subscription expiry"
});
