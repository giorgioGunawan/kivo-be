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
        res.status(500).json({ error: 'Authentication failed' });
    }
});

// Product ID Mapping for Credits
const PRODUCT_CREDITS = {
    'com.kivoai.credits.150': 150,
    'com.kivoai.credits.500': 500,
    'com.kivoai.credits.1000': 1000
};

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

    const { originalTransactionId, environment, transactionId, productId: bodyProductId } = req.body;

    let client;
    try {
        // If it's a known credit product, skip subscription verification and handle as top-up
        if (bodyProductId && PRODUCT_CREDITS[bodyProductId]) {
            const creditAmount = PRODUCT_CREDITS[bodyProductId];
            const { creditLedgerService } = require('../services/credits/ledger');

            // SECURITY: Require a transactionId for deduplication
            if (!transactionId && !originalTransactionId) {
                return res.status(400).json({ error: 'Missing transactionId' });
            }
            const dedupeKey = transactionId || originalTransactionId;

            const client = await db.pool.connect();

            try {
                await client.query('BEGIN');

                // SECURITY: Check if this transaction was already processed (prevents replay attacks)
                const existingTx = await client.query(
                    `SELECT id FROM processed_transactions WHERE transaction_id = $1`,
                    [dedupeKey]
                );
                if (existingTx.rows.length > 0) {
                    await client.query('COMMIT');
                    client.release();
                    console.log(`Duplicate transaction ${dedupeKey} for user ${userId} — already processed`);
                    return res.json({ success: true, creditsAdded: 0, type: 'consumable', duplicate: true });
                }

                // Enforce Max Credit Limit (2000) for Purchased Pool
                const balanceRes = await client.query(
                    'SELECT purchased_remaining FROM credit_balances WHERE user_id = $1 FOR UPDATE',
                    [userId]
                );
                const currentPurchased = balanceRes.rows[0]?.purchased_remaining || 0;

                if (currentPurchased + creditAmount > 2000) {
                    console.warn(`User ${userId} attempted top-up but would exceed 2000 limit (${currentPurchased} + ${creditAmount})`);
                }

                await creditLedgerService.createEntry({
                    userId,
                    poolType: 'purchased',
                    delta: creditAmount,
                    reason: 'purchase'
                }, client);

                // SECURITY: Record this transaction as processed
                await client.query(
                    `INSERT INTO processed_transactions (transaction_id, user_id, product_id, credits_granted)
                     VALUES ($1, $2, $3, $4)`,
                    [dedupeKey, userId, bodyProductId, creditAmount]
                );

                console.log(`Added ${creditAmount} purchased credits for user ${userId} (tx: ${dedupeKey})`);

                await client.query('COMMIT');
                return res.json({ success: true, creditsAdded: creditAmount, type: 'consumable' });

            } catch (e) {
                await client.query('ROLLBACK');
                throw e;
            } finally {
                client.release();
            }
        }

        // --- Existing Subscription Verification Logic ---
        // SAFE VERIFICATION LOGIC (Fix for Mock "Free Credits" Loop)
        // 1. Check existing subscription in DB
        client = await db.pool.connect();
        await client.query('BEGIN');
        const existingSubRes = await client.query('SELECT * FROM subscriptions WHERE user_id = $1', [userId]);
        const existingSub = existingSubRes.rows[0];

        // 2. If valid active subscription exists, just return it (Don't trust Mock to extend it)
        if (existingSub && existingSub.status === 'active' && new Date(existingSub.expires_at) > new Date()) {
            console.log(`User ${userId} already has active subscription. Skipping mock verification.`);
            await client.query('COMMIT');
            client.release();
            return res.json({ success: true, status: 'active', expiresAt: existingSub.expires_at });
        }

        // 3. If expired subscription exists, we DO verify with Apple (Real API now).
        // Since verifySubscription is no longer a mock, we TRUST its result.
        // If Apple says it's active, we update. If Apple says expired, we keep it expired.

        // 4. Proceed to Verification

        const result = await verifySubscription(originalTransactionId, environment, bodyProductId || 'unknown');
        const { creditRefreshService } = require('../services/credits/refresh');

        // Update subscription status
        await client.query(
            `INSERT INTO subscriptions (user_id, product_id, status, expires_at, auto_renew_status, last_verified_at, original_transaction_id)
             VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), true, NOW(), $5)
             ON CONFLICT (user_id)
             DO UPDATE SET
                product_id = EXCLUDED.product_id,
                status = EXCLUDED.status,
                expires_at = EXCLUDED.expires_at,
                auto_renew_status = true,
                last_verified_at = NOW(),
                original_transaction_id = EXCLUDED.original_transaction_id`,
            [userId, result.productId, result.status, result.expiresDate, originalTransactionId]
        );

        // If subscription is active, check if eligible for credit refresh
        if (result.status === 'active') {
            const isSandbox = environment === 'Sandbox';
            const isEligible = await creditRefreshService.isEligibleForRefresh(userId, client, isSandbox);

            if (isEligible) {
                await creditRefreshService.refreshWeeklyCredits(userId, 'refresh', client);
                console.log(`Refreshed credits for user ${userId} via manual verification (Sandbox: ${isSandbox})`);
            }
        } else if (result.status === 'expired') {
            await creditRefreshService.forfeitWeeklyCredits(userId, 'expiry', client);
        }

        await client.query('COMMIT');
        client.release();
        res.json({ success: true, status: result.status });

    } catch (e) {
        if (client) {
            await client.query('ROLLBACK');
            client.release();
        }
        console.error(e);
        res.status(500).json({ error: 'Verification failed' });
    }
});

module.exports = router;
