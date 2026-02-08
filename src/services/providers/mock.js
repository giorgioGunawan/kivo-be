const { v4: uuidv4 } = require('uuid');

// Simulating API calls
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MockProvider = {
    // Returns estimated cost in credits
    estimate_cost: async (params) => {
        // Basic logic
        if (params.media_type === 'video') return 100;
        if (params.media_type === 'image') return 10;
        return 1;
    },

    // Returns { provider_job_id, status }
    submit_job: async (jobData) => {
        // Simulate delay
        await delay(500);
        const providerJobId = `mock-${uuidv4()}`;
        return {
            provider_job_id: providerJobId,
            status: 'submitted',
        };
    },

    // Returns { status: 'pending'|'completed'|'failed', result_url?: string, error?: string }
    get_status: async (providerJobId) => {
        // In real implementation, this would call external API
        // For mock, we'll pretend it's always completed after a small delay
        await delay(200);
        // Randomly fail 5% of jobs
        if (Math.random() < 0.05) {
            return { status: 'failed', error: 'Random chaos monkey failure' };
        }
        return { status: 'completed', result_url: `https://mock.kivo.ai/result/${providerJobId}` };
    },

    fetch_result: async (providerJobId) => {
        // Fetch actual artifact or metadata
        return { url: `https://mock.kivo.ai/result/${providerJobId}` };
    },
};

module.exports = MockProvider;
