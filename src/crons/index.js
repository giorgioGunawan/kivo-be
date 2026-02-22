const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
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

// Subscription Cleanup Task (Hourly)
// Checks for subscriptions that according to our DB should have expired but are still marked 'active'.
// This acts as a safety against missed 'EXPIRED' webhooks.
const runSubscriptionCleanup = async () => {
    console.log('Running Subscription Cleanup Task (Expired Active Subs Check)');
    const client = await db.pool.connect();

    // Log Start
    await client.query(`
        INSERT INTO system_logs (event_type, level, message, details) 
        VALUES ($1, $2, $3, $4)
    `, ['cron_subscription_cleanup', 'info', 'Started Expired Subscription Cleanup Check', { action: 'start' }]);

    try {
        // Find subscriptions that are 'active' locally but past their expiry time
        // Give a little buffer (e.g. 1 hour) to allow for slight skew or processing delays
        // Also ensure we have an original_transaction_id to check against Apple
        const expiredSubs = await client.query(`
            SELECT user_id, original_transaction_id, expires_at 
            FROM subscriptions 
            WHERE status = 'active' 
              AND expires_at < NOW() - INTERVAL '1 hour'
              AND original_transaction_id IS NOT NULL
        `);

        if (expiredSubs.rows.length === 0) {
            console.log('✅ No lingering expired subscriptions found.');
            await client.query(`
                INSERT INTO system_logs (event_type, level, message, details) 
                VALUES ($1, $2, 'No expired subscriptions found', $3)
            `, ['cron_subscription_cleanup', 'info', { count: 0 }]);
            return;
        }

        console.log(`🔎 Found ${expiredSubs.rows.length} potentially expired subscriptions. Verifying...`);

        await client.query(`
            INSERT INTO system_logs (event_type, level, message, details) 
            VALUES ($1, $2, $3, $4)
        `, ['cron_subscription_cleanup', 'warn', `Found ${expiredSubs.rows.length} potentially expired subscriptions`, { count: expiredSubs.rows.length, userIds: expiredSubs.rows.map(s => s.user_id) }]);

        const { verifySubscription } = require('../services/auth/apple');
        const { creditRefreshService } = require('../services/credits/refresh');

        // We release the list-fetching client early or just use it for the loop logic if we weren't doing per-user filtering.
        // Actually, let's keep 'client' for the outer scope (listing) and use a fresh one for updates to be safe/isolated.
        // Or just iterate sequentially.

        for (const sub of expiredSubs.rows) {
            // Use a separate client/transaction for each user so one failure doesn't abort the whole batch
            const userClient = await db.pool.connect();
            try {
                await userClient.query('BEGIN');

                let checkResult = null;
                try {
                    // Try Production first (most likely for real apps)
                    checkResult = await verifySubscription(sub.original_transaction_id, 'Production');
                } catch (e) {
                    // Fallback to Sandbox
                    console.log(`Production verification failed for ${sub.user_id}, trying Sandbox...`);
                    try {
                        checkResult = await verifySubscription(sub.original_transaction_id, 'Sandbox');
                    } catch (sandboxErr) {
                        console.error(`Sandbox verification also failed for ${sub.user_id}: ${sandboxErr.message}`);
                        // Keep evaluating execution flow
                        await userClient.query(`
                            INSERT INTO system_logs (event_type, level, message, details) 
                            VALUES ($1, $2, $3, $4)
                         `, ['cron_subscription_cleanup', 'error', `Verification failed for user ${sub.user_id}`, { userId: sub.user_id, error: sandboxErr.message }]);
                    }
                }

                let actionLog = null;

                if (checkResult && checkResult.status === 'active') {
                    // RENEWED
                    console.log(`🔄 Subscription for user ${sub.user_id} was actually renewed! Updating DB.`);

                    await userClient.query(
                        `UPDATE subscriptions 
                         SET status = 'active', expires_at = to_timestamp($1 / 1000.0), last_verified_at = NOW() 
                         WHERE user_id = $2`,
                        [checkResult.expiresDate, sub.user_id]
                    );

                    const isEligible = await creditRefreshService.isEligibleForRefresh(sub.user_id, userClient);
                    if (isEligible) {
                        await creditRefreshService.refreshWeeklyCredits(sub.user_id, 'refresh', userClient);
                    }

                    actionLog = {
                        level: 'info',
                        msg: `Corrected status for user ${sub.user_id} -> ACTIVE (Renewed)`,
                        details: { userId: sub.user_id, oldStatus: 'expired_check', newStatus: 'active', expiresAt: checkResult.expiresDate }
                    };

                } else {
                    // EXPIRED (or check failed/revoked)
                    // If check failed completely, do we expire? 
                    // VerifySubscription (Real) throws if API fails.
                    // If we caught the error above and checkResult is null, we shouldn't expire yet (network flakiness?).
                    // But if verifySubscription returned params with status='expired', then yes.

                    if (checkResult && (checkResult.status === 'expired' || checkResult.status === 'revoked')) {
                        console.log(`🛑 Subscription for user ${sub.user_id} confirmed expired. Cleaning up.`);

                        await userClient.query(
                            `UPDATE subscriptions 
                             SET status = 'expired', last_verified_at = NOW() 
                             WHERE user_id = $1`,
                            [sub.user_id]
                        );

                        // Forfeit credits (this call expects an open transaction client)
                        await creditRefreshService.forfeitWeeklyCredits(sub.user_id, 'expiry', userClient);

                        actionLog = {
                            level: 'info',
                            msg: `Cleanup user ${sub.user_id} -> EXPIRED (Credits Forfeited)`,
                            details: { userId: sub.user_id, oldStatus: 'active', newStatus: 'expired' }
                        };
                    } else if (!checkResult) {
                        console.warn(`⚠️ Could not verify status for user ${sub.user_id}. Skipping cleanup to be safe.`);
                        actionLog = {
                            level: 'warn',
                            msg: `Skipped cleanup for user ${sub.user_id} due to verification failure`,
                            details: { userId: sub.user_id, issue: 'verify_failed' }
                        };
                    }
                }

                if (actionLog) {
                    await userClient.query(`
                        INSERT INTO system_logs (event_type, level, message, details) 
                        VALUES ($1, $2, $3, $4)
                    `, ['cron_subscription_cleanup', actionLog.level, actionLog.msg, actionLog.details]);
                }

                await userClient.query('COMMIT');

            } catch (err) {
                await userClient.query('ROLLBACK');
                console.error(`Error verifying/cleaning up user ${sub.user_id}:`, err.message);
                // Log failure to main table via main client (since userClient rolled back)
                await client.query(`
                    INSERT INTO system_logs (event_type, level, message, details) 
                    VALUES ($1, $2, $3, $4)
                `, ['cron_subscription_cleanup', 'error', `Failed to process user ${sub.user_id}`, { error: err.message, userId: sub.user_id }]);
            } finally {
                userClient.release();
            }
        }

    } catch (e) {
        console.error('❌ Subscription Cleanup Task Error:', e);
        await client.query(`
            INSERT INTO system_logs (event_type, level, message, details) 
            VALUES ($1, $2, $3, $4)
        `, ['cron_subscription_cleanup', 'error', 'Fatal Cron Error', { error: e.message }]);
    } finally {
        client.release();
    }
};

cron.schedule('0 * * * *', runSubscriptionCleanup);

// Upload Cleanup: Delete temp files older than 1 hour
cron.schedule('30 * * * *', async () => {
    const uploadsDir = path.join(process.cwd(), 'public/uploads');
    if (!fs.existsSync(uploadsDir)) return;

    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;
    let cleaned = 0;

    try {
        const files = fs.readdirSync(uploadsDir);
        for (const file of files) {
            const filePath = path.join(uploadsDir, file);
            const stat = fs.statSync(filePath);
            if (now - stat.mtimeMs > ONE_HOUR) {
                fs.unlinkSync(filePath);
                cleaned++;
            }
        }
        if (cleaned > 0) {
            console.log(`[UploadCleanup] Deleted ${cleaned} expired upload(s)`);
        }
    } catch (e) {
        console.error('[UploadCleanup] Error:', e.message);
    }
});

module.exports = { runSubscriptionCleanup };
