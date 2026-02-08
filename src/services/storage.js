const fs = require('fs');
const path = require('path');

/**
 * Handles moving uploaded images to a permanent public location.
 * Uses process.cwd() for absolute path reliability on cloud platforms like Railway.
 * Note: Storage is ephemeral on Railway and will be cleared on redeploy.
 */
const uploadImage = async (filePath) => {
    // 1. Determine local paths
    const fileName = path.basename(filePath);
    const publicDir = path.join(process.cwd(), 'public/uploads');
    const targetPath = path.join(publicDir, fileName);

    console.log(`[Storage] Moving upload from ${filePath} to ${targetPath}`);

    // 2. Ensure directory exists
    if (!fs.existsSync(publicDir)) {
        fs.mkdirSync(publicDir, { recursive: true });
    }

    // 3. Move file robustly
    try {
        // copy + unlink is safer than rename across virtual partitions in cloud environments
        fs.copyFileSync(filePath, targetPath);
        fs.unlinkSync(filePath);
    } catch (e) {
        console.warn(`[Storage] Primary move failed, trying rename fallback: ${e.message}`);
        fs.renameSync(filePath, targetPath);
    }

    // 4. Construct Public URL
    const rawBaseUrl = process.env.WEBHOOK_URL || 'http://localhost:3000';
    const baseUrl = rawBaseUrl.replace(/\/$/, '');

    return `${baseUrl}/uploads/${fileName}`;
};

module.exports = {
    uploadImage
};
