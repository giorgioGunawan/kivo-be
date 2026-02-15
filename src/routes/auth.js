const express = require('express');
const router = express.Router();
const db = require('../config/db');
const jwt = require('jsonwebtoken');
const { verifyAppleIdToken, verifySubscription } = require('../services/auth/apple');

// Sign In with Apple
router.post('/apple', async (req, res) => {
    const { identityToken } = req.body;
    if (!identityToken) return res.status(400).json({ error: 'Missing identityToken' });

    try {
        const applePayload = await verifyAppleIdToken(identityToken);
        const appleUserId = applePayload.sub; // unique user identifier from Apple

        let userId;

        // Check if user exists
        const userRes = await db.query('SELECT id FROM users WHERE apple_user_id = $1', [appleUserId]);

        if (userRes.rows.length === 0) {
            // Create User
            const newUser = await db.query(
                'INSERT INTO users (apple_user_id) VALUES ($1) RETURNING id',
                [appleUserId]
            );
            userId = newUser.rows[0].id;

            // Initialize Balance Cache
            await db.query(`INSERT INTO credit_balances (user_id) VALUES ($1)`, [userId]);
        } else {
            userId = userRes.rows[0].id;
        }

        // Generate Kivo JWT
        if (!process.env.JWT_SECRET) {
            console.error('CRITICAL: JWT_SECRET environment variable is missing!');
            throw new Error('Server Configuration Error (JWT_SECRET)');
        }
        const token = jwt.sign({ id: userId, appleId: appleUserId }, process.env.JWT_SECRET, { expiresIn: '7d' });

        res.json({ token, user: { id: userId, appleUserId } });
    } catch (error) {
        console.error('Apple Auth Error (Full Context):', error.message);
        res.status(500).json({ error: `Authentication Failed: ${error.message}` });
    }
});

// Update Subscription Status (Client calls this after purchase or periodically)
router.post('/subscription/verify', async (req, res) => {
    // Requires User Token
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).send();
    // Simply verify token manually or use middleware
    const token = authHeader.split(' ')[1];
    let userId;
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        userId = decoded.id;
    } catch { return res.status(401).send(); }

    const { originalTransactionId } = req.body;

    try {
        const result = await verifySubscription(originalTransactionId);
        const { creditRefreshService } = require('../services/credits/refresh');

        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');

            // Update subscription status
            await client.query(
                `INSERT INTO subscriptions (user_id, product_id, status, expires_at, auto_renew_status, last_verified_at, original_transaction_id)
                 VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), true, NOW(), $5)
                 ON CONFLICT (user_id) 
                 DO UPDATE SET 
                    status = EXCLUDED.status, 
                    expires_at = EXCLUDED.expires_at, 
                    auto_renew_status = true,
                    last_verified_at = NOW(),
                    original_transaction_id = EXCLUDED.original_transaction_id`,
                [userId, result.productId, result.status, result.expiresDate, originalTransactionId]
            );

            // If subscription is active, check if eligible for credit refresh
            if (result.status === 'active') {
                const isEligible = await creditRefreshService.isEligibleForRefresh(userId, client);

                if (isEligible) {
                    await creditRefreshService.refreshWeeklyCredits(userId, 'refresh', client);
                    console.log(`✅ Refreshed credits for user ${userId} via manual verification`);
                }
            } else if (result.status === 'expired') {
                // Forfeit weekly credits if subscription expired
                await creditRefreshService.forfeitWeeklyCredits(userId, 'expiry', client);
            }

            await client.query('COMMIT');
            res.json({ success: true, status: result.status });
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Verification failed' });
    }
});

module.exports = router;
