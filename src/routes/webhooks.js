const express = require('express');
const router = express.Router();
const db = require('../config/db');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

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

/**
 * SECURITY: Verify Apple JWS signature using Apple's public keys.
 * Fetches Apple's JWKS and verifies the signedPayload/signedTransactionInfo.
 */
let applePublicKeysCache = null;
let applePublicKeysCacheTime = 0;
const APPLE_KEYS_CACHE_TTL = 3600000; // 1 hour

async function getApplePublicKeys() {
    const now = Date.now();
    if (applePublicKeysCache && (now - applePublicKeysCacheTime) < APPLE_KEYS_CACHE_TTL) {
        return applePublicKeysCache;
    }
    const axios = require('axios');
    const response = await axios.get('https://appleid.apple.com/auth/keys');
    applePublicKeysCache = response.data.keys;
    applePublicKeysCacheTime = now;
    return applePublicKeysCache;
}

function buildPublicKey(jwk) {
    // Convert JWK to PEM using Node.js crypto
    const keyObject = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    return keyObject.export({ type: 'spki', format: 'pem' });
}

async function verifyAppleJWS(token) {
    // Decode header to get kid
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    const keys = await getApplePublicKeys();
    const matchingKey = keys.find(k => k.kid === header.kid);

    if (!matchingKey) {
        throw new Error(`No matching Apple public key found for kid: ${header.kid}`);
    }

    const publicKey = buildPublicKey(matchingKey);
    return jwt.verify(token, publicKey, { algorithms: ['ES256'] });
}

// Apple App Store Server Notifications (Subscription Webhooks)
router.post('/apple', async (req, res) => {
    console.log('Received Apple Webhook');

    try {
        let notificationType, subtype, data;
        let transactionInfo;
        let renewalInfo;

        // Handle App Store Server Notifications V2 (JWS)
        if (req.body.signedPayload) {
            try {
                // SECURITY: Verify JWS signature against Apple's public keys
                const payload = await verifyAppleJWS(req.body.signedPayload);
                if (!payload) throw new Error('Failed to verify signedPayload');

                notificationType = payload.notificationType;
                subtype = payload.subtype;
                data = payload.data;

                console.log(`Apple Notification V2: ${notificationType} (${subtype || 'No Subtype'})`);

                if (data) {
                    // Decode nested JWS tokens with verification
                    if (data.signedTransactionInfo) {
                        transactionInfo = await verifyAppleJWS(data.signedTransactionInfo);
                    }
                    if (data.signedRenewalInfo) {
                        renewalInfo = await verifyAppleJWS(data.signedRenewalInfo);
                    }
                }
            } catch (e) {
                console.error('Failed to verify Apple JWS signature:', e.message);
                // SECURITY: Reject unverified webhooks instead of silently accepting
                return res.status(403).send('Invalid signature');
            }
        } else {
            // SECURITY: Reject non-JWS payloads — V1 format should not be accepted
            console.warn('Apple webhook received without signedPayload — rejecting');
            return res.status(400).send('Only V2 signed payloads accepted');
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

        // SECURITY: Deduplicate webhook events to prevent replay attacks
        const eventId = req.body.signedPayload
            ? crypto.createHash('sha256').update(req.body.signedPayload).digest('hex')
            : null;

        if (eventId) {
            const existingEvent = await db.query(
                'SELECT id FROM webhook_events WHERE event_hash = $1',
                [eventId]
            );
            if (existingEvent.rows.length > 0) {
                console.log(`Duplicate Apple webhook event — already processed (hash: ${eventId.substring(0, 16)}...)`);
                return res.status(200).send('OK');
            }
        }

        const { creditRefreshService } = require('../services/credits/refresh');

        // SECURITY: Only look up user by original_transaction_id (removed risky product_id fallback)
        const userResult = await db.query(
            'SELECT user_id FROM subscriptions WHERE original_transaction_id = $1',
            [originalTransactionId]
        );

        if (userResult.rows.length === 0) {
            console.warn(`No user found for Apple transaction ${originalTransactionId}`);
            return res.status(200).send('OK');
        }

        const userId = userResult.rows[0].user_id;
        const client = await db.pool.connect();

        try {
            await client.query('BEGIN');

            // Record this webhook event to prevent replay
            if (eventId) {
                await client.query(
                    `INSERT INTO webhook_events (event_hash, source, notification_type, user_id)
                     VALUES ($1, 'apple', $2, $3)
                     ON CONFLICT (event_hash) DO NOTHING`,
                    [eventId, notificationType, userId]
                );
            }

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
                    if (subtype === 'AUTO_RENEW_ENABLED') statusUpdate.autoRenew = true;
                    if (subtype === 'AUTO_RENEW_DISABLED') statusUpdate.autoRenew = false;
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

            console.log(`Apple Webhook: User ${userId} | Type: ${notificationType} | Status: ${statusUpdate.status}`);

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
                if (productId) {
                    updateQuery += `, product_id = $${paramCount++}`;
                    params.push(productId);
                }
                updateQuery += `, original_transaction_id = $${paramCount++}`;
                params.push(originalTransactionId);

                updateQuery += ` WHERE user_id = $${paramCount}`;
                params.push(userId);

                await client.query(updateQuery, params);
            }

            // 2. Handle Credits
            if (['DID_RENEW', 'SUBSCRIBED', 'INITIAL_BUY', 'INTERACTIVE_RENEWAL'].includes(notificationType)) {
                const isSandbox = (data && data.environment === 'Sandbox');

                const isEligible = await creditRefreshService.isEligibleForRefresh(userId, client, isSandbox);

                if (isEligible) {
                    await creditRefreshService.refreshWeeklyCredits(userId, 'refresh', client);
                    console.log(`Credits refreshed for User ${userId} (Sandbox: ${isSandbox})`);
                } else {
                    console.log(`User ${userId} not eligible for refresh yet (Sandbox: ${isSandbox})`);
                }
            } else if (['EXPIRED', 'DID_FAIL_TO_RENEW', 'REFUND', 'REVOKE'].includes(notificationType)) {
                await creditRefreshService.forfeitWeeklyCredits(userId, 'expiry', client);
                console.log(`Credits forfeited for User ${userId}`);
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
