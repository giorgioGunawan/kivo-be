const db = require('../../config/db');
const { jobQueue, addJob } = require('../queue');
const { creditLedgerService } = require('../credits/ledger');
const { getProvider, activeProvider } = require('../providers/index');

class JobManagerService {
    async createJob(userId, mediaType, userParams, templateId = null, idempotencyKey = null) {
        const client = await db.pool.connect();

        // 1. Estimate Cost
        const providerName = activeProvider; // Uses the environment variable or defaults to 'kie'
        const provider = getProvider(providerName);
        const estimatedCost = await provider.estimate_cost({ mediaType, ...userParams });

        let jobId = null;

        try {
            await client.query('BEGIN');

            // 2. Check & Deduct Credits (Atomically)
            // We pass jobId as NULL initially, then update ledger later or use a temp ID?
            // Actually consistent way: Insert Job first as 'created', then deduct with that ID.

            // Insert Job (Created State)
            const jobResult = await client.query(
                `INSERT INTO jobs (user_id, provider, media_type, status, estimated_cost, template_id, job_data)
         VALUES ($1, $2, $3, 'created', $4, $5, $6) RETURNING id`,
                [userId, providerName, mediaType, estimatedCost, templateId, userParams]
            );
            jobId = jobResult.rows[0].id;

            // Deduct Credits
            await creditLedgerService.deductCredits(userId, estimatedCost, jobId, 'generation', client);

            // 3. Enqueue Job
            // If redis is down, this throws.
            await addJob('process-job', {
                jobId,
                userId,
                providerName,
                jobParams: userParams
            });

            // Update status to 'queued'
            await client.query(
                `UPDATE jobs SET status = 'queued' WHERE id = $1`,
                [jobId]
            );

            // Save idempotency key inside the same transaction
            if (idempotencyKey) {
                await client.query(
                    `INSERT INTO idempotency_keys (key, user_id, endpoint, request_hash, job_id, expires_at)
                     VALUES ($1, $2, 'jobs', $3, $4, NOW() + INTERVAL '24 hours')
                     ON CONFLICT (key) DO NOTHING`,
                    [idempotencyKey, userId, JSON.stringify(userParams), jobId]
                );
            }

            await client.query('COMMIT');
            return { jobId, status: 'queued', estimatedCost };

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Job Creation Failed', error);
            // If we deducted credits but failed to enqueue (and rollback failed? Unlikely in transaction), 
            // but here we wrap everything in PG transaction.
            // However, Redis enqueue is outside PG transaction control.
            // If enqueue succeeds but commit fails? (Redis has job, DB has no record).
            // If enqueue fails, catch block rolls back DB. Correct.
            // If enqueue succeeds, but DB commit fails?
            // Job worker will pick it up, try to select job from DB -> not found -> fail.
            // This is acceptable for simple MVP.
            throw error;
        } finally {
            client.release();
        }
    }
}

module.exports = new JobManagerService();
