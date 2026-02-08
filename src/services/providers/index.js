const MockProvider = require('./mock');
const FalProvider = require('./fal');
const KieProvider = require('./kie');

// Simple registry for providers
const providers = {
    mock: MockProvider,
    fal: FalProvider,
    kie: KieProvider,
    // Add other providers here: 'vertex': VertexProvider, 'openai': OpenAIProvider, etc.
};

// Default to kie if not configured
const activeProvider = process.env.AI_PROVIDER || 'kie';

module.exports = {
    getProvider: (name) => {
        const provider = providers[name || activeProvider];
        if (!provider) {
            throw new Error(`Provider ${name} not found`);
        }
        return provider;
    },
    activeProvider,
};
