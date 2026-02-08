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
        const token = jwt.sign({ id: userId, appleId: appleUserId }, process.env.JWT_SECRET || 'supersecretkey', { expiresIn: '7d' });

        res.json({ token, user: { id: userId, appleUserId } });
    } catch (error) {
        console.error('Apple Auth Error', error);
        res.status(500).json({ error: 'Authentication Failed' });
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
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'supersecretkey');
        userId = decoded.id;
    } catch { return res.status(401).send(); }

    const { originalTransactionId } = req.body;

    try {
        const result = await verifySubscription(originalTransactionId);

        await db.query(
            `INSERT INTO subscriptions (user_id, product_id, status, expires_at, last_verified_at)
             VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), NOW())
             ON CONFLICT (user_id) 
             DO UPDATE SET status = EXCLUDED.status, expires_at = EXCLUDED.expires_at, last_verified_at = NOW()`,
            [userId, result.productId, result.status, result.expiresDate]
        );

        // If newly active, trigger credit refresh logic?
        // Spec says: "Refresh logic (executed on generation request, balance fetch, or cron)"
        // But also "Weekly Credits ... Forfeited immediately on subscription expiry"
        // "Reactivation restarts weekly cycle using new anchor"

        // Update anchor if NEW subscription start? 
        // This logic is complex, simplistic for now: just update status.

        res.json({ success: true, status: result.status });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Verification failed' });
    }
});

module.exports = router;
