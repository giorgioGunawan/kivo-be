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

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '../public')));

app.use(express.json());

app.get('/', (req, res) => {
    res.send('Kivo AI Backend is running 🚀');
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/admin.html'));
});

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
    concurrency: 5 // Process 5 jobs concurrently
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
