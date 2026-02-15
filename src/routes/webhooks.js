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

// Apple App Store Server Notifications (Subscription Webhooks)
router.post('/apple', async (req, res) => {
    console.log('Received Apple Webhook:', JSON.stringify(req.body, null, 2));

    try {
        const { notificationType, subtype, data } = req.body;

        if (!data || !data.signedTransactionInfo) {
            console.warn('Apple webhook missing required data');
            return res.status(200).send('OK'); // Still return 200 to prevent retries
        }

        // TODO: Verify JWT signature from Apple for production
        // For now, we'll process the notification assuming it's valid

        const { creditRefreshService } = require('../services/credits/refresh');

        // Extract transaction info (in production, decode the JWT)
        // For now, assume data contains decoded info or we decode it here
        const transactionInfo = data.signedTransactionInfo;

        // Map Apple's original transaction ID to our user
        // This requires storing original_transaction_id in subscriptions table
        const userResult = await db.query(
            'SELECT user_id FROM subscriptions WHERE product_id = $1',
            [transactionInfo.productId || data.bundleId]
        );

        if (userResult.rows.length === 0) {
            console.warn(`No user found for Apple transaction`);
            return res.status(200).send('OK');
        }

        const userId = userResult.rows[0].user_id;
        const client = await db.pool.connect();

        try {
            await client.query('BEGIN');

            // Handle different notification types
            switch (notificationType) {
                case 'DID_RENEW':
                case 'INITIAL_BUY':
                case 'SUBSCRIBED':
                    console.log(`📱 Apple: Subscription renewed/purchased for user ${userId}`);

                    // Update subscription status
                    await client.query(
                        `UPDATE subscriptions 
                         SET status = 'active', 
                             auto_renew_status = true,
                             expires_at = $1,
                             last_verified_at = NOW()
                         WHERE user_id = $2`,
                        [new Date(data.expiresDate || Date.now() + 7 * 24 * 60 * 60 * 1000), userId]
                    );

                    // Check if eligible for credit refresh (7+ days since last refresh)
                    const isEligible = await creditRefreshService.isEligibleForRefresh(userId, client);

                    if (isEligible) {
                        await creditRefreshService.refreshWeeklyCredits(userId, 'refresh', client);
                    } else {
                        console.log(`⏭️  User ${userId} not yet eligible for refresh (less than 7 days)`);
                    }
                    break;

                case 'DID_FAIL_TO_RENEW':
                case 'EXPIRED':
                    console.log(`⚠️  Apple: Subscription expired/failed for user ${userId}`);

                    // Update subscription status
                    await client.query(
                        `UPDATE subscriptions 
                         SET status = 'expired', 
                             auto_renew_status = false,
                             last_verified_at = NOW()
                         WHERE user_id = $1`,
                        [userId]
                    );

                    // Forfeit weekly credits
                    await creditRefreshService.forfeitWeeklyCredits(userId, 'expiry', client);
                    break;

                case 'DID_CHANGE_RENEWAL_STATUS':
                    // User turned auto-renew on/off
                    const willRenew = subtype === 'AUTO_RENEW_ENABLED';
                    console.log(`🔄 Apple: Auto-renew ${willRenew ? 'enabled' : 'disabled'} for user ${userId}`);

                    await client.query(
                        `UPDATE subscriptions 
                         SET auto_renew_status = $1,
                             last_verified_at = NOW()
                         WHERE user_id = $2`,
                        [willRenew, userId]
                    );

                    // If disabled and subscription will expire, forfeit credits
                    if (!willRenew) {
                        const subInfo = await client.query(
                            'SELECT expires_at FROM subscriptions WHERE user_id = $1',
                            [userId]
                        );

                        if (subInfo.rows.length > 0) {
                            const expiresAt = new Date(subInfo.rows[0].expires_at);
                            const now = new Date();

                            // If expiring within 24 hours, forfeit now
                            if (expiresAt - now < 24 * 60 * 60 * 1000) {
                                await creditRefreshService.forfeitWeeklyCredits(userId, 'expiry', client);
                            }
                        }
                    }
                    break;

                case 'REFUND':
                    console.log(`💸 Apple: Refund issued for user ${userId}`);

                    // Update subscription status
                    await client.query(
                        `UPDATE subscriptions 
                         SET status = 'revoked', 
                             auto_renew_status = false,
                             last_verified_at = NOW()
                         WHERE user_id = $1`,
                        [userId]
                    );

                    // Forfeit weekly credits
                    await creditRefreshService.forfeitWeeklyCredits(userId, 'expiry', client);
                    break;

                default:
                    console.log(`ℹ️  Apple: Unhandled notification type: ${notificationType}`);
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
