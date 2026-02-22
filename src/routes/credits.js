const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { verifyToken } = require('../middleware/auth');

router.use(verifyToken);

router.get('/balance', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT cb.weekly_remaining, cb.purchased_remaining, cb.last_weekly_refresh_at,
                    COALESCE(s.status = 'active' AND s.expires_at > NOW(), false) AS is_pro_subscriber,
                    s.expires_at AS subscription_expires_at
             FROM credit_balances cb
             LEFT JOIN subscriptions s ON s.user_id = cb.user_id
             WHERE cb.user_id = $1`,
            [req.user.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        res.json(result.rows[0]);
    } catch (e) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/ledger', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT * FROM credit_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
            [req.user.id]
        );
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

const MAX_PURCHASED_CREDITS = 500;

// Purchase extra credits — subscribers only, capped at 500
router.post('/purchase', async (req, res) => {
    const { amount } = req.body;
    if (!amount || !Number.isInteger(amount) || amount <= 0) {
        return res.status(400).json({ error: 'Invalid amount' });
    }

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // Lock the balance row and check subscription in one atomic query
        const result = await client.query(
            `SELECT cb.purchased_remaining,
                    COALESCE(s.status = 'active' AND s.expires_at > NOW(), false) AS is_pro_subscriber
             FROM credit_balances cb
             LEFT JOIN subscriptions s ON s.user_id = cb.user_id
             WHERE cb.user_id = $1
             FOR UPDATE OF cb`,
            [req.user.id]
        );

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found' });
        }

        const { purchased_remaining, is_pro_subscriber } = result.rows[0];

        if (!is_pro_subscriber) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'An active subscription is required to purchase extra credits' });
        }

        if (purchased_remaining + amount > MAX_PURCHASED_CREDITS) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: `Purchased credits cannot exceed ${MAX_PURCHASED_CREDITS}` });
        }

        const { creditLedgerService } = require('../services/credits/ledger');
        await creditLedgerService.createEntry(
            { userId: req.user.id, poolType: 'purchased', delta: amount, reason: 'purchase' },
            client
        );

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) {
        await client.query('ROLLBACK');
        console.error(e);
        res.status(500).json({ error: 'Failed to purchase credits' });
    } finally {
        client.release();
    }
});

module.exports = router;
