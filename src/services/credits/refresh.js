const db = require('../../config/db');
const { creditLedgerService } = require('./ledger');

class CreditRefreshService {
    /**
     * Refresh weekly credits for a user
     * Called by Apple webhook handler or safety net cron
     */
    async refreshWeeklyCredits(userId, reason = 'refresh', client = null) {
        const dbClient = client || await db.pool.connect();
        const shouldManageTransaction = !client;

        try {
            if (shouldManageTransaction) await dbClient.query('BEGIN');

            // Get weekly allocation from config (default 500)
            const configRes = await dbClient.query(
                "SELECT value FROM admin_config WHERE key = 'weekly_allocation'"
            );
            const allocation = configRes.rows.length ? parseInt(configRes.rows[0].value) : 500;

            // Get current weekly balance
            const balanceRes = await dbClient.query(
                'SELECT weekly_remaining FROM credit_balances WHERE user_id = $1 FOR UPDATE',
                [userId]
            );

            if (balanceRes.rows.length === 0) {
                throw new Error(`User ${userId} has no credit balance record`);
            }

            const currentWeekly = balanceRes.rows[0].weekly_remaining || 0;

            // Calculate delta to reset to allocation
            // If user has 20 credits left and allocation is 500, delta = 480
            // If user somehow has 600 credits (error case), delta = -100 to reset to 500
            const delta = allocation - currentWeekly;

            if (delta !== 0) {
                // Create ledger entry and update balance
                await creditLedgerService.createEntry(
                    {
                        userId,
                        poolType: 'weekly',
                        delta,
                        reason
                    },
                    dbClient
                );
            }

            // Update last refresh timestamp
            await dbClient.query(
                'UPDATE credit_balances SET last_weekly_refresh_at = NOW() WHERE user_id = $1',
                [userId]
            );

            if (shouldManageTransaction) await dbClient.query('COMMIT');

            console.log(`✅ Refreshed weekly credits for user ${userId}: ${currentWeekly} → ${allocation} (delta: ${delta})`);

            return { success: true, delta, newBalance: allocation };
        } catch (error) {
            if (shouldManageTransaction) await dbClient.query('ROLLBACK');
            console.error(`❌ Failed to refresh credits for user ${userId}:`, error);
            throw error;
        } finally {
            if (shouldManageTransaction) dbClient.release();
        }
    }

    /**
     * Forfeit weekly credits when subscription expires or is cancelled
     */
    async forfeitWeeklyCredits(userId, reason = 'expiry', client = null) {
        const dbClient = client || await db.pool.connect();
        const shouldManageTransaction = !client;

        try {
            if (shouldManageTransaction) await dbClient.query('BEGIN');

            // Get current weekly balance
            const balanceRes = await dbClient.query(
                'SELECT weekly_remaining FROM credit_balances WHERE user_id = $1 FOR UPDATE',
                [userId]
            );

            if (balanceRes.rows.length === 0) {
                throw new Error(`User ${userId} has no credit balance record`);
            }

            const currentWeekly = balanceRes.rows[0].weekly_remaining || 0;

            if (currentWeekly > 0) {
                // Deduct all weekly credits
                await creditLedgerService.createEntry(
                    {
                        userId,
                        poolType: 'weekly',
                        delta: -currentWeekly,
                        reason
                    },
                    dbClient
                );

                console.log(`🗑️  Forfeited ${currentWeekly} weekly credits for user ${userId} (reason: ${reason})`);
            }

            if (shouldManageTransaction) await dbClient.query('COMMIT');

            return { success: true, forfeited: currentWeekly };
        } catch (error) {
            if (shouldManageTransaction) await dbClient.query('ROLLBACK');
            console.error(`❌ Failed to forfeit credits for user ${userId}:`, error);
            throw error;
        } finally {
            if (shouldManageTransaction) dbClient.release();
        }
    }

    /**
     * Check if user is eligible for weekly refresh
     * Returns true if 7+ days have passed since last refresh
     */
    async isEligibleForRefresh(userId, client = null) {
        const dbClient = client || db;

        const result = await dbClient.query(
            `SELECT last_weekly_refresh_at 
             FROM credit_balances 
             WHERE user_id = $1
             AND (
               last_weekly_refresh_at IS NULL 
               OR last_weekly_refresh_at < NOW() - INTERVAL '7 days'
             )`,
            [userId]
        );

        return result.rows.length > 0;
    }
}

module.exports = { creditRefreshService: new CreditRefreshService() };
