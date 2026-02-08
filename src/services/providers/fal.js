const fal = require('@fal-ai/serverless-client');

const FalProvider = {
    // Returns estimated cost in credits
    // For basic MVP, hardcode or estimate based on model
    estimate_cost: async (params) => {
        // 1 Credit = 1 Image approx? Or 10?
        // Let's say 1 Generation = 10 Credits
        if (params.media_type === 'video') return 100; // Video is more expensive
        return 10;
    },

    // Submits job to Fal.AI queue
    submit_job: async (jobData) => {
        // Using fal.queue.submit instead of subscribe so we can poll/webhook later
        // or use subscribe if we want to keep connection open (but for durable backend, submit+poll is safer)

        // Choose model based on input or default
        // Example: fal-ai/flux/dev or fal-ai/fast-sdxl
        const modelId = jobData.model_id || 'fal-ai/flux/dev';

        console.log(`Submitting to FalAI [${modelId}]`, jobData);

        const { request_id } = await fal.queue.submit(modelId, {
            input: {
                prompt: jobData.prompt,
                image_size: jobData.image_size || 'square_hd',
                // Add other fal specific params here
            },
            webhookUrl: process.env.WEBHOOK_URL ? `${process.env.WEBHOOK_URL}/webhooks/fal` : undefined
        });

        return {
            provider_job_id: request_id,
            status: 'queued'
        };
    },

    // Poll status from Fal.AI
    get_status: async (providerJobId) => {
        const status = await fal.queue.status(providerJobId);

        // map fal status to our internal status
        // Fal: IN_QUEUE, IN_PROGRESS, COMPLETED, FAILED
        const map = {
            'IN_QUEUE': 'queued',
            'IN_PROGRESS': 'processing',
            'COMPLETED': 'completed',
            'FAILED': 'failed'
        };

        if (status.status === 'COMPLETED') {
            const result = await fal.queue.result(providerJobId);
            return {
                status: 'completed',
                result_url: result.images?.[0]?.url || result.video?.url || JSON.stringify(result)
            };
        }

        if (status.status === 'FAILED') {
            return { status: 'failed', error: status.error || 'Unknown Fal error' };
        }

        return { status: map[status.status] || 'processing' };
    }
};

// Configure Fal Client
fal.config({
    credentials: process.env.FAL_KEY
});

module.exports = FalProvider;
