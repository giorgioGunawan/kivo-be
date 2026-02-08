const express = require('express');
const router = express.Router();
const db = require('../config/db');

// Kie.ai Webhook
router.post('/kie', async (req, res) => {
    console.log('Received Kie.ai Webhook:', JSON.stringify(req.body, null, 2));
    const { code, data, msg } = req.body;

    if (!data || !data.taskId) {
        return res.status(400).send('Missing taskId');
    }

    const providerJobId = data.taskId;

    try {
        if (code === 200) {
            // Success
            let resultUrl = data.result || data.url;

            // Handle resultJson structure seen in logs
            if (!resultUrl && data.resultJson) {
                try {
                    const resultJson = typeof data.resultJson === 'string' ? JSON.parse(data.resultJson) : data.resultJson;
                    if (resultJson.resultUrls && resultJson.resultUrls.length > 0) {
                        resultUrl = resultJson.resultUrls[0];
                    }
                } catch (e) {
                    console.error('Failed to parse resultJson in webhook:', e);
                }
            }

            if (resultUrl) {
                await db.query(
                    "UPDATE jobs SET status = 'completed', result_url = $1, completed_at = NOW() WHERE provider_job_id = $2 AND status != 'completed'",
                    [resultUrl, providerJobId]
                );
                console.log(`Job ${providerJobId} completed via webhook with URL: ${resultUrl}`);
            } else {
                console.log(`Job ${providerJobId} reported success but missing result_url in webhook payload`, JSON.stringify(data));
            }
        } else if (code === 501 || code === 500) {
            // Failed
            await db.query(
                "UPDATE jobs SET status = 'failed' WHERE provider_job_id = $1 AND status != 'failed'",
                [providerJobId]
            );
            console.log(`Job ${providerJobId} failed via webhook: ${msg}`);
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('Kie Webhook Processing Error:', error);
        res.status(500).send('Internal Server Error');
    }
});

// Fal.ai Webhook
router.post('/fal', async (req, res) => {
    console.log('Received Fal.ai Webhook:', JSON.stringify(req.body, null, 2));
    // Implementation for Fal webhook if needed
    res.status(200).send('OK');
});

module.exports = router;
