const { Worker } = require('bullmq');
const { getProvider } = require('../providers/index');
const db = require('../../config/db');
const { creditLedgerService } = require('../credits/ledger');

const processJob = async (job) => {
    const { jobId, userId, providerName, jobParams } = job.data;

    console.log(`Processing job ${jobId} for user ${userId}`);

    try {
        // 1. Check current job status to avoid duplicate work (e.g. from BullMQ retries)
        const currentJobRes = await db.query('SELECT status, provider_job_id FROM jobs WHERE id = $1', [jobId]);
        const currentJob = currentJobRes.rows[0];

        if (!currentJob) throw new Error('Job not found in database');

        if (currentJob.status === 'completed') {
            console.log(`Job ${jobId} already completed. Skipping.`);
            return { status: 'completed' };
        }

        const provider = getProvider(providerName);
        let providerJobId = currentJob.provider_job_id;

        if (!providerJobId) {
            // 2. Update status to processing (only if not already polling)
            await db.query(
                'UPDATE jobs SET status = $1, provider_attempt = provider_attempt + 1 WHERE id = $2',
                ['processing', jobId]
            );

            // 3. Submit to provider
            const submission = await provider.submit_job(jobParams);
            providerJobId = submission.provider_job_id;

            // Update provider job id
            await db.query(
                'UPDATE jobs SET provider_job_id = $1, provider = $2 WHERE id = $3',
                [providerJobId, providerName || 'mock', jobId]
            );
        } else {
            console.log(`Job ${jobId} already has providerJobId ${providerJobId}. Jumping to polling.`);
        }

        // 3. Helper to poll status (simplification for this task)
        // In production, use webhooks or a separate polling queue
        let result = null;
        let attempts = 0;
        while (!result && attempts < 30) { // Bumped to 30 attempts (60s total)
            // A: Check if webhook updated it already
            const dbCheck = await db.query('SELECT status, result_url FROM jobs WHERE id = $1', [jobId]);
            const dbStatus = dbCheck.rows[0].status;

            if (dbStatus === 'completed') {
                console.log(`Job ${jobId} finished via webhook during polling loop.`);
                return { status: 'completed', result_url: dbCheck.rows[0].result_url };
            }
            if (dbStatus === 'failed') {
                console.log(`Job ${jobId} marked as failed via webhook during polling loop.`);
                throw new Error('Job failed via webhook');
            }

            const check = await provider.get_status(providerJobId);
            if (check.status === 'completed') {
                result = check;
                break;
            } else if (check.status === 'failed') {
                throw new Error(check.error || 'Provider reported failure');
            }
            await new Promise(r => setTimeout(r, 2000)); // wait 2s
            attempts++;
        }

        if (!result) {
            throw new Error('Timeout waiting for provider');
        }

        // 4. Job Succeeded
        // Actual cost handling (mock logic: if provider returns cost, use it, else use estimate)
        // Here assuming estimate was accurate or provider gives no cost data yet.
        // If mismatch, reconcile.

        await db.query(
            'UPDATE jobs SET status = $1, result_url = $2, completed_at = NOW() WHERE id = $3',
            ['completed', result.result_url, jobId]
        );

        console.log(`Job ${jobId} completed successfully`);
        return result;

    } catch (error) {
        console.error(`Job ${jobId} failed:`, error);

        // Refund logic if failure
        // Spec: "If job fails before provider charges -> refund credits"
        // We assume provider charges only on success or we absorb cost if partial.
        // Spec: "Refunds always via ledger entries"

        await db.query(
            'UPDATE jobs SET status = $1 WHERE id = $2',
            ['failed', jobId]
        );

        // Trigger refund with a valid reason code from schema
        const refundReason = error.message.includes('Timeout') ? 'refund_timeout' : 'provider_error';
        await creditLedgerService.refundJob(userId, jobId, refundReason);

        throw error; // Fail job in BullMQ to trigger retries if configured
    }
};

module.exports = { processJob };
