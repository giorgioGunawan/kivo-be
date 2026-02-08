const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { verifyAdmin } = require('../middleware/auth');

router.use(verifyAdmin);

router.post('/config', async (req, res) => {
    const { key, value } = req.body;
    try {
        await db.query(
            `INSERT INTO admin_config (key, value, updated_by) VALUES ($1, $2, $3)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [key, value, 'admin']
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Update Failed' });
    }
});

router.get('/config', async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM admin_config');
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: 'Fetch Failed' });
    }
});

// Admin override to add credits
router.post('/credits/add', async (req, res) => {
    const { userId, delta, poolType } = req.body;
    try {
        const { creditLedgerService } = require('../services/credits/ledger');
        await creditLedgerService.createEntry(
            { userId, poolType, delta: parseInt(delta), reason: 'purchase' },
            await db.pool.connect() // Assuming admin requests are occasional
        );
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to add credits' });
    }
});

// Generic Table Viewer (For convenient admin UI)
router.get('/db/:table', async (req, res) => {
    const { table } = req.params;
    const allowedTables = ['users', 'subscriptions', 'credit_ledger', 'credit_balances', 'jobs', 'idempotency_keys', 'admin_config']; // Whitelist for safety

    if (!allowedTables.includes(table)) {
        return res.status(403).json({ error: 'Table access denied or invalid' });
    }

    try {
        // Simple query limit 50 desc
        const query = table === 'credit_ledger' || table === 'jobs'
            ? `SELECT * FROM ${table} ORDER BY created_at DESC LIMIT 50`
            : `SELECT * FROM ${table} LIMIT 50`;

        const result = await db.query(query);
        res.json(result.rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Query Failed' });
    }
});

module.exports = router;
