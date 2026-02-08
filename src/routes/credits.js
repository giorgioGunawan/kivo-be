const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { verifyToken } = require('../middleware/auth');

router.use(verifyToken);

router.get('/balance', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT weekly_remaining, purchased_remaining, weekly_reset_at 
             FROM credit_balances WHERE user_id = $1`,
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

module.exports = router;
