const cron = require('node-cron');
const db = require('../config/db');
const { creditLedgerService } = require('../services/credits/ledger');

// Weekly Credit Refresh Task
cron.schedule('0 0 * * *', async () => {
    console.log('Running Weekly Credit Refresh Task');
    const client = await db.pool.connect();
    try {
        // Determine Weekly Allocation (default 500)
        const configRes = await client.query("SELECT value FROM admin_config WHERE key = 'weekly_allocation'");
        const allocation = configRes.rows.length ? configRes.rows[0].value : 500;

        // Find eligible users: Active subscription AND reset time passed
        const q = `
      SELECT cb.user_id, cb.weekly_reset_at 
      FROM credit_balances cb
      JOIN subscriptions s ON s.user_id = cb.user_id
      WHERE s.status = 'active'
        AND cb.weekly_reset_at <= NOW()
    `;
        const users = await client.query(q);

        console.log(`Found ${users.rows.length} users for credit refresh`);

        for (const user of users.rows) {
            try {
                await client.query('BEGIN');

                // Reset balance to allocation (not add, reset!)
                // Spec: "weekly_remaining = WEEKLY_ALLOCATION".
                // But need ledger history.
                // Current balance?
                const currentRes = await client.query('SELECT weekly_remaining FROM credit_balances WHERE user_id = $1', [user.user_id]);
                const current = currentRes.rows[0]?.weekly_remaining || 0;

                const delta = allocation - current;

                if (delta !== 0) {
                    await creditLedgerService.createEntry({
                        userId: user.user_id,
                        poolType: 'weekly',
                        delta, // Can be positive or negative (if current > allocation? unlikely unless error, but resets to cap)
                        reason: 'refresh'
                    }, client);
                }

                // Update reset time + 7 days
                await client.query(
                    `UPDATE credit_balances SET weekly_reset_at = weekly_reset_at + INTERVAL '7 days' WHERE user_id = $1`,
                    [user.user_id]
                );

                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                console.error(`Failed to refresh user ${user.user_id}`, err);
            }
        }
    } catch (e) {
        console.error('Cron Error', e);
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
