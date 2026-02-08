const express = require('express');
const router = express.Router();
const db = require('../config/db'); // Needed for idempotency key insert?
// Ideally jobManager handles idempotency too?
// Or controller handles idempotency insert.
const jobManager = require('../services/jobs/manager');
const { verifyToken } = require('../middleware/auth');
const idempotency = require('../middleware/idempotency');

router.use(verifyToken);

// Create Job
router.post('/', idempotency, async (req, res) => {
    const { media_type, template_id, ...params } = req.body;
    const key = req.headers['idempotency-key']; // Should be present due to middleware, or ignored if middleware didn't error.

    try {
        // 1. Create Job with Manager
        // We should pass key to Manager to store it? Or store it here?
        // If we store it here after job creation, we risk partial failure (job created, key not stored).
        // Better: Pass key to manager and let it handle transactionally.

        // Updated Manager call (need to update manager.js first?)
        // Let's modify manager to accept idempotency key.

        // For now, doing it separately but immediately after creation is risky but acceptable for MVP.
        // If jobManager returns job, we insert key.

        const result = await jobManager.createJob(req.user.id, media_type, params, template_id);

        // Save Idempotency Key (Ideally inside manager transaction)
        if (key) {
            await db.query(
                `INSERT INTO idempotency_keys (key, user_id, endpoint, request_hash, job_id, expires_at)
             VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '24 hours')
             ON CONFLICT (key) DO NOTHING`,
                [key, req.user.id, req.originalUrl, JSON.stringify(req.body), result.jobId]
            );
        }

        res.status(201).json(result);
    } catch (error) {
        console.error('Job Creation Error', error);
        if (error.message === 'Insufficient credits') {
            return res.status(402).json({ error: 'Insufficient credits' });
        }
        res.status(500).json({ error: 'Job creation failed' });
    }
});

// Get Job Status
router.get('/:id', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT * FROM jobs WHERE id = $1 AND user_id = $2`,
            [req.params.id, req.user.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json(result.rows[0]);
    } catch (e) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

module.exports = router;
