const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { verifyAdmin } = require('../middleware/auth');
const { creditLedgerService } = require('../services/credits/ledger'); // Moved up for consistency

// Fetch System Logs
router.get('/logs', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const result = await db.query(
            'SELECT * FROM system_logs ORDER BY created_at DESC LIMIT $1',
            [limit]
        );
        res.json(result.rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to fetch logs' });
    }
});

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

// Check User Subscription & Credits
router.get('/user/:id/subscription', async (req, res) => {
    const { id } = req.params;
    try {
        const subRes = await db.query('SELECT * FROM subscriptions WHERE user_id = $1', [id]);
        const balanceRes = await db.query('SELECT * FROM credit_balances WHERE user_id = $1', [id]);
        const userRes = await db.query('SELECT * FROM users WHERE id = $1', [id]);

        if (subRes.rows.length === 0 && balanceRes.rows.length === 0) {
            return res.status(404).json({ error: 'User not found or has no data' });
        }

        res.json({
            user: userRes.rows[0],
            subscription: subRes.rows[0] || null,
            credits: balanceRes.rows[0] || null,
            serverTime: new Date()
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to fetch user data' });
    }
});

// Admin override to add credits
router.post('/credits/add', async (req, res) => {
    const { userId, delta, poolType, reason } = req.body;
    try {
        const { creditLedgerService } = require('../services/credits/ledger');
        // Pass null so createEntry uses the pool directly — no leaked connection
        await creditLedgerService.createEntry(
            { userId, poolType, delta: parseInt(delta), reason: reason || 'admin_adjust' },
            null
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

const { jobQueue } = require('../services/queue');

// Queue Status API
router.get('/queue', async (req, res) => {
    try {
        const counts = await jobQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');

        // Fetch active, waiting, failed and completed jobs (limit 50 each) for detailed view
        const activeJobs = await jobQueue.getJobs(['active'], 0, 49, true);
        const waitingJobs = await jobQueue.getJobs(['waiting'], 0, 49, true);
        const failedJobs = await jobQueue.getJobs(['failed'], 0, 49, true);
        const completedJobs = await jobQueue.getJobs(['completed'], 0, 49, true);

        const formatJob = async (job) => ({
            id: job.id,
            userId: job.data ? job.data.userId : 'unknown',
            state: await job.getState(),
            failedReason: job.failedReason,
            timestamp: job.timestamp,
            processedOn: job.processedOn,
            finishedOn: job.finishedOn,
            attempts: job.attemptsMade,
            data: job.data
        });

        let jobs = [
            ...(await Promise.all(activeJobs.map(formatJob))),
            ...(await Promise.all(waitingJobs.map(formatJob))),
            ...(await Promise.all(failedJobs.map(formatJob))),
            ...(await Promise.all(completedJobs.map(formatJob)))
        ];

        // Sort by timestamp DESC so newest always at top
        jobs.sort((a, b) => b.timestamp - a.timestamp);

        res.json({
            counts,
            jobs: jobs.slice(0, 100)
        });
    } catch (e) {
        console.error('Queue Fetch Error:', e);
        res.status(500).json({ error: 'Failed to fetch queue status' });
    }
});

// Clear Failed Jobs API
router.post('/queue/clear-failed', async (req, res) => {
    try {
        // clean(gracePeriod, limit, state)
        await jobQueue.clean(0, 1000, 'failed');
        res.json({ success: true });
    } catch (e) {
        console.error('Clear Failed Error:', e);
        res.status(500).json({ error: 'Failed to clear failed jobs' });
    }
});

// Cleanup Failed Jobs in Database
router.post('/db/cleanup-failed-jobs', async (req, res) => {
    try {
        const result = await db.query("DELETE FROM jobs WHERE status = 'failed'");
        res.json({ success: true, count: result.rowCount });
    } catch (e) {
        console.error('DB Cleanup Error:', e);
        res.status(500).json({ error: 'Failed to cleanup jobs table' });
    }
});

// Manual Cron Trigger
router.post('/cron/run-cleanup', async (req, res) => {
    try {
        const { runSubscriptionCleanup } = require('../crons/index');
        // Run in background so we don't timeout the request, or await if fast enough. 
        // Better to await to give feedback.
        await runSubscriptionCleanup();
        res.json({ success: true, message: 'Cleanup task executed' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Task failed' });
    }
});

module.exports = router;
