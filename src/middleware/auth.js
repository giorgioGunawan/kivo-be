const jwt = require('jsonwebtoken');

const verifyToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];

    if (!token) {
        return res.status(403).json({ error: 'No token provided' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
};

const verifyAdmin = (req, res, next) => {
    // Logic for admin auth (e.g. separate secret or role in JWT)
    // For MVP/Spec: "Simple password-protected panel"
    const adminPass = req.headers['x-admin-password'];
    if (adminPass !== (process.env.ADMIN_PASSWORD || 'admin123')) {
        return res.status(401).json({ error: 'Admin Unauthorized' });
    }
    next();
};

module.exports = { verifyToken, verifyAdmin };
