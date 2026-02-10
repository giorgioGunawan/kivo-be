const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
require('dotenv').config();

const redisConnection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
});

const jobQueue = new Queue('kivo-ai-jobs', {
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 1000,
        },
        removeOnComplete: 100, // Keep last 100 completed jobs for visibility
        removeOnFail: 500, // Keep more failed jobs for debugging
    },
});

// A function to add jobs to the queue
const addJob = async (type, data, opts = {}) => {
    return await jobQueue.add(type, data, opts);
};

module.exports = { jobQueue, addJob, redisConnection };
