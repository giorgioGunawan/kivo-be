// Lightweight content safeguard for AI generation prompts
// Blocks obvious disallowed keywords and logs abuse attempts

const BLOCKED_PATTERNS = [
    // Child exploitation (highest priority)
    /\bchild\b.*\b(nude|naked|sexual|porn)/i,
    /\bminor\b.*\b(nude|naked|sexual|porn)/i,
    /\bunderage\b/i,
    /\bpedophil/i,
    /\bcsam\b/i,

    // Explicit NSFW
    /\b(porn|pornograph)/i,
    /\bhentai\b/i,
    /\bxxx\b/i,

    // Violence & gore
    /\b(dismember|decapitat|mutilat)/i,
    /\btorture\b/i,
    /\bgore\b/i,

    // Illegal activity
    /\b(bomb\s*making|how\s*to\s*make\s*a\s*bomb)/i,
    /\b(bioweapon|chemical\s*weapon)/i,

    // Deepfake / non-consensual
    /\bdeepfake\b/i,
    /\brevenge\s*porn/i,
];

const contentFilter = (req, res, next) => {
    const prompt = req.body?.prompt;

    // No prompt = image-only job, allow through
    if (!prompt || typeof prompt !== 'string') {
        return next();
    }

    for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(prompt)) {
            const userId = req.user?.id || 'unknown';
            console.warn(`[ContentFilter] BLOCKED user=${userId} pattern=${pattern.source} prompt="${prompt.substring(0, 100)}"`);
            return res.status(403).json({ error: 'Content policy violation' });
        }
    }

    next();
};

module.exports = { contentFilter };
