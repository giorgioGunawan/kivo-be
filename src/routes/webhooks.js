const express = require('express');
const router = express.Router();
const db = require('../config/db');
const jwt = require('jsonwebtoken');

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

// Apple App Store Server Notifications (Subscription Webhooks)
router.post('/apple', async (req, res) => {
    console.log('Received Apple Webhook:', JSON.stringify(req.body, null, 2));

    try {
        let notificationType, subtype, data;
        let transactionInfo;
        let renewalInfo;

        // Handle App Store Server Notifications V2 (JWS)
        if (req.body.signedPayload) {
            try {
                // Decode top-level JWS
                const payload = jwt.decode(req.body.signedPayload);
                if (!payload) throw new Error('Failed to decode signedPayload');

                notificationType = payload.notificationType;
                subtype = payload.subtype;
                data = payload.data; // This data contains signedTransactionInfo/signedRenewalInfo

                console.log(`Apple Notification V2: ${notificationType} (${subtype || 'No Subtype'})`);

                if (data) {
                    // Decode transaction info
                    if (data.signedTransactionInfo) {
                        transactionInfo = jwt.decode(data.signedTransactionInfo);
                    }
                    // Decode renewal info
                    if (data.signedRenewalInfo) {
                        renewalInfo = jwt.decode(data.signedRenewalInfo);
                    }
                }
            } catch (e) {
                console.error('Failed to decode Apple JWS:', e);
                return res.status(200).send('OK (Decode Failed)');
            }
        } else {
            // Fallback for older V1 or direct JSON (if any)
            notificationType = req.body.notificationType;
            subtype = req.body.subtype;
            data = req.body.data;
            // Assume data is already unwrapped in V1 or test payload
            transactionInfo = data;
        }

        if (!transactionInfo) {
            console.warn('Apple webhook missing transaction info');
            return res.status(200).send('OK');
        }

        const originalTransactionId = transactionInfo.originalTransactionId;
        const productId = transactionInfo.productId;
        const expiresDateMs = transactionInfo.expiresDate || (data && data.expiresDate);

        if (!originalTransactionId) {
            console.warn('Missing originalTransactionId in webhook');
            return res.status(200).send('OK');
        }

        const { creditRefreshService } = require('../services/credits/refresh');

        // Look up user by original_transaction_id (Best) or product_id (Fallback/Risky)
        let userResult = await db.query(
            'SELECT user_id FROM subscriptions WHERE original_transaction_id = $1',
            [originalTransactionId]
        );

        if (userResult.rows.length === 0) {
            console.log(`User not found by original_transaction_id: ${originalTransactionId}. Trying product_id fallback...`);
            // Fallback: This is risky as multiple users might have same product, 
            // but might be necessary if we haven't stored original_transaction_id yet.
            // In a real app, we should probably log this as an error or valid orphaned event.
            userResult = await db.query(
                'SELECT user_id FROM subscriptions WHERE product_id = $1',
                [productId || data.bundleId]
            );
        }

        if (userResult.rows.length === 0) {
            console.warn(`No user found for Apple transaction ${originalTransactionId}`);
            return res.status(200).send('OK');
        }

        const userId = userResult.rows[0].user_id;
        const client = await db.pool.connect();

        try {
            await client.query('BEGIN');

            // Only update if we have meaningful data
            const statusUpdate = {
                status: null,
                autoRenew: null,
                expiresAt: expiresDateMs ? new Date(Number(expiresDateMs)) : null
            };

            // Detect Status based on notification type
            switch (notificationType) {
                case 'DID_RENEW':
                case 'INITIAL_BUY':
                case 'SUBSCRIBED':
                case 'INTERACTIVE_RENEWAL':
                    statusUpdate.status = 'active';
                    statusUpdate.autoRenew = true;
                    // If we have renewal info, check auto renew status from there
                    if (renewalInfo && renewalInfo.autoRenewStatus !== undefined) {
                        statusUpdate.autoRenew = renewalInfo.autoRenewStatus === 1;
                    }
                    break;

                case 'DID_FAIL_TO_RENEW':
                case 'EXPIRED':
                    statusUpdate.status = 'expired';
                    statusUpdate.autoRenew = false;
                    break;

                case 'DID_CHANGE_RENEWAL_STATUS':
                    // Just update auto renew preference
                    // subtype: AUTO_RENEW_ENABLED / AUTO_RENEW_DISABLED
                    if (subtype === 'AUTO_RENEW_ENABLED') statusUpdate.autoRenew = true;
                    if (subtype === 'AUTO_RENEW_DISABLED') statusUpdate.autoRenew = false;

                    // Also check renewalInfo if available
                    if (renewalInfo && renewalInfo.autoRenewStatus !== undefined) {
                        statusUpdate.autoRenew = renewalInfo.autoRenewStatus === 1;
                    }
                    break;

                case 'REFUND':
                case 'REVOKE':
                    statusUpdate.status = 'revoked';
                    statusUpdate.autoRenew = false;
                    break;
            }

            console.log(`📱 Apple Webhook: User ${userId} | Type: ${notificationType} | Status: ${statusUpdate.status}`);

            // 1. Update Subscription
            if (statusUpdate.status || statusUpdate.autoRenew !== null) {
                let updateQuery = 'UPDATE subscriptions SET last_verified_at = NOW()';
                const params = [];
                let paramCount = 1;

                if (statusUpdate.status) {
                    updateQuery += `, status = $${paramCount++}`;
                    params.push(statusUpdate.status);
                }
                if (statusUpdate.autoRenew !== null) {
                    updateQuery += `, auto_renew_status = $${paramCount++}`;
                    params.push(statusUpdate.autoRenew);
                }
                if (statusUpdate.expiresAt) {
                    updateQuery += `, expires_at = $${paramCount++}`;
                    params.push(statusUpdate.expiresAt);
                }
                // Also backfill original_transaction_id if missing
                updateQuery += `, original_transaction_id = $${paramCount++}`;
                params.push(originalTransactionId);

                updateQuery += ` WHERE user_id = $${paramCount}`;
                params.push(userId);

                await client.query(updateQuery, params);
            }

            // 2. Handle Credits
            if (['DID_RENEW', 'SUBSCRIBED', 'INITIAL_BUY', 'INTERACTIVE_RENEWAL'].includes(notificationType)) {
                const isSandbox = (data && data.environment === 'Sandbox');

                // Check eligibility and refresh
                const isEligible = await creditRefreshService.isEligibleForRefresh(userId, client, isSandbox);

                if (isEligible) {
                    await creditRefreshService.refreshWeeklyCredits(userId, 'refresh', client);
                    console.log(`✅ Credits refreshed for User ${userId} (Sandbox: ${isSandbox})`);
                } else {
                    console.log(`⏳ User ${userId} not eligible for refresh yet (Sandbox: ${isSandbox})`);
                }
            } else if (['EXPIRED', 'DID_FAIL_TO_RENEW', 'REFUND', 'REVOKE'].includes(notificationType)) {
                // Forfeit credits
                await creditRefreshService.forfeitWeeklyCredits(userId, 'expiry', client);
                console.log(`🛑 Credits forfeited for User ${userId}`);
            }

            await client.query('COMMIT');
            res.status(200).send('OK');

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Apple webhook processing error:', error);
            res.status(500).send('Error');
        } finally {
            client.release();
        }

    } catch (error) {
        console.error('Apple Webhook Error:', error);
        res.status(500).send('Error');
    }
});

module.exports = router;
