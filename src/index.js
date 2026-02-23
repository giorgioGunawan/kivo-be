const express = require('express');
const db = require('./config/db');
require('dotenv').config();
require('./crons/index'); // Load crons

const authRoutes = require('./routes/auth');
const jobRoutes = require('./routes/jobs');
const creditRoutes = require('./routes/credits');
const adminRoutes = require('./routes/admin');
const webhookRoutes = require('./routes/webhooks');
const { jobQueue } = require('./services/queue');
const { processJob } = require('./services/jobs/processor');

const path = require('path');
const multer = require('multer');
const { uploadImage } = require('./services/storage');

const upload = multer({ dest: 'uploads/' });

const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '../public')));

app.use(express.json());

// Rate limiters
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' }
});

const verifyLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 5, // 5 verification requests per minute per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many verification requests, please try again later' }
});

const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60, // Apple sends bursts
    standardHeaders: true,
    legacyHeaders: false,
});

const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' }
});

const deleteLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many deletion requests, please try again later' }
});

const generationLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many generation requests, please try again later' }
});

app.get('/', (req, res) => {
    res.send('Kivo AI Backend is running 🚀');
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/admin.html'));
});

app.get('/boxscore', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/boxscore.html'));
});

// Rate limiting on sensitive routes
app.use('/auth/apple', authLimiter);
app.use('/auth/subscription/verify', verifyLimiter);
app.use('/webhooks', webhookLimiter);
app.use('/admin', adminLimiter);
app.delete('/auth/user', deleteLimiter);
app.post('/jobs', generationLimiter);

// Routes
app.use('/auth', authRoutes);
app.use('/jobs', jobRoutes);
app.use('/credits', creditRoutes);
app.use('/admin', adminRoutes);
app.use('/webhooks', webhookRoutes);

const { verifyAdmin, verifyToken } = require('./middleware/auth');

// Admin Upload (Protected by admin password)
app.post('/admin/upload', verifyAdmin, upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const url = await uploadImage(req.file.path, req.file.originalname);
        res.json({ url });
    } catch (e) {
        res.status(500).json({ error: 'Upload Failed' });
    }
});

// App User Upload (Protected by JWT)
app.post('/jobs/upload', verifyToken, upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const url = await uploadImage(req.file.path, req.file.originalname);
        res.json({ url });
    } catch (e) {
        console.error('User upload error:', e);
        res.status(500).json({ error: 'Upload Failed' });
    }
});

// BullMQ Worker Setup (Same process for MVP)
const { Worker } = require('bullmq');
const worker = new Worker('kivo-ai-jobs', async (job) => {
    return await processJob(job);
}, {
    connection: require('./services/queue').redisConnection,
    concurrency: 50, // Allow up to 50 concurrent jobs (below provider ~100 limit)
    limiter: {
        max: 20, // Max 20 jobs started...
        duration: 10000 // ...per 10 seconds
    }
});

worker.on('completed', (job) => {
    console.log(`Worker: Job ${job.id} completed!`);
});

worker.on('failed', (job, err) => {
    console.log(`Worker: Job ${job.id} failed with ${err.message}`);
});

// Start Server
app.listen(PORT, () => {
    console.log(`Kivo AI Backend running on port ${PORT}`);
});
