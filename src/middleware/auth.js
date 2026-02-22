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
    const adminPass = req.headers['x-admin-password'];
    if (!process.env.ADMIN_PASSWORD) {
        console.error('CRITICAL: ADMIN_PASSWORD environment variable is not set!');
        return res.status(500).json({ error: 'Server configuration error' });
    }
    if (adminPass !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Admin Unauthorized' });
    }
    next();
};

module.exports = { verifyToken, verifyAdmin };
