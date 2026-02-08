const db = require('../../config/db');

class CreditLedgerService {

    // Single Authoritative Transaction to modify credits
    async createEntry({ userId, poolType, delta, reason, jobId = null }, client = null) {
        const dbClient = client || db;
        // Determine which balance column to update
        const balanceColumn = poolType === 'weekly' ? 'weekly_remaining' : 'purchased_remaining';

        // Update Ledger
        const ledgerResult = await dbClient.query(
            `INSERT INTO credit_ledger (user_id, pool_type, delta, reason, job_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [userId, poolType, delta, reason, jobId]
        );

        // Update Balance Cache (This assumes the cache row already exists, ensuring it does on user creation)
        // Using atomic update
        await dbClient.query(
            `UPDATE credit_balances SET ${balanceColumn} = ${balanceColumn} + $1 WHERE user_id = $2`,
            [delta, userId]
        );

        return ledgerResult.rows[0];
    }

    // Cost Deduction Logic (The "Consumption Order")
    // 1. Weekly credits
    // 2. Purchased credits
    async deductCredits(userId, amount, jobId, reason = 'generation', externalClient = null) {
        const client = externalClient || await db.pool.connect();
        const shouldManageTransaction = !externalClient;

        try {
            if (shouldManageTransaction) await client.query('BEGIN');

            // Get current balances (Lock row for update)
            const res = await client.query(
                'SELECT weekly_remaining, purchased_remaining FROM credit_balances WHERE user_id = $1 FOR UPDATE',
                [userId]
            );

            if (res.rows.length === 0) {
                throw new Error('User balance record not found');
            }

            const { weekly_remaining, purchased_remaining } = res.rows[0];
            let remainingCost = amount;
            let weeklyDeduction = 0;
            let purchasedDeduction = 0;

            // 1. Use Weekly First
            if (weekly_remaining > 0) {
                weeklyDeduction = Math.min(weekly_remaining, remainingCost);
                remainingCost -= weeklyDeduction;
            }

            // 2. Use Purchased Second
            if (remainingCost > 0) {
                if (purchased_remaining >= remainingCost) {
                    purchasedDeduction = remainingCost;
                    remainingCost = 0;
                } else {
                    // Insufficient funds
                    throw new Error('Insufficient credits');
                }
            }

            // Apply deductions if any
            if (weeklyDeduction > 0) {
                await this.createEntry({
                    userId,
                    poolType: 'weekly',
                    delta: -weeklyDeduction,
                    reason,
                    jobId
                }, client);
            }

            if (purchasedDeduction > 0) {
                await this.createEntry({
                    userId,
                    poolType: 'purchased',
                    delta: -purchasedDeduction,
                    reason,
                    jobId
                }, client);
            }

            if (shouldManageTransaction) await client.query('COMMIT');
            return { weeklyDeducted: weeklyDeduction, purchasedDeducted: purchasedDeduction };
        } catch (e) {
            if (shouldManageTransaction) await client.query('ROLLBACK');
            throw e;
        } finally {
            if (shouldManageTransaction) client.release();
        }
    }

    // Refund Logic
    async refundJob(userId, jobId, reason = 'refund_failure') {
        // Check ledger for what was deducted for this job
        const res = await db.query(
            `SELECT pool_type, ABS(delta) as amount FROM credit_ledger WHERE job_id = $1 AND delta < 0`,
            [jobId]
        );

        // Reverse entries (Simple implementation: creating positive entries)
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            for (const row of res.rows) {
                // Truncate reason to 50 chars for DB constraint
                const safeReason = (reason || 'refund').substring(0, 50);

                // Use existing createEntry method signature: object first, then client
                await this.createEntry({
                    userId: userId,
                    poolType: row.pool_type,
                    delta: parseInt(row.amount), // Ensure number
                    reason: safeReason,
                    jobId: jobId
                }, client);
            }
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            console.error('Refund failed', e);
        } finally {
            client.release();
        }
    }
}

module.exports = { creditLedgerService: new CreditLedgerService() };
