const appleSignin = require('apple-signin-auth');

/**
 * Verifies Sign-in with Apple identity token using official Apple public keys.
 * This ensures the token is valid, not expired, and intended for our app.
 */
const verifyAppleIdToken = async (identityToken) => {
    // Development fallback
    // ALLOW MOCK TOKEN for Admin Panel Testing
    if (identityToken === 'mock_token') {
        return { sub: 'mock_apple_user_id', email: 'mock@example.com' };
    }

    try {
        const applePayload = await appleSignin.verifyIdToken(identityToken, {
            // THE APP LOCK: Rejects any token not created for your specific App
            audience: 'com.giorgiogunawan.kivoai',
            ignoreExpiration: false, // Security: Ensure token is fresh
        });

        // 'sub' is the unique, persistent ID for this user provided by Apple
        return applePayload;
    } catch (err) {
        console.error('Apple Token Verification Failed:', err.message);
        throw new Error('Invalid Apple Identity Token');
    }
};

/**
 * Placeholder for App Store Server API v2
 * In a full production setup, this would use a private key (.p8) to 
 * generate a JWS and fetch real-time state from Apple.
 */
const verifySubscription = async (originalTransactionId) => {
    console.log(`[Apple] Verifying subscription for ${originalTransactionId}`);

    // Mock response for now (active for 7 days)
    return {
        isValid: true,
        productId: 'com.kivo.pro.weekly',
        expiresDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
        status: 'active'
    };
};

module.exports = { verifyAppleIdToken, verifySubscription };
