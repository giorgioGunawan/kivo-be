const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const path = require('path');

// Configure Cloudinary if keys are present
if (process.env.CLOUDINARY_CLOUD_NAME) {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
    });
}

/**
 * Robust storage handler for production.
 * Prioritizes Cloudinary for persistence, fallbacks to local disk for development.
 */
const uploadImage = async (filePath) => {
    // 1. If Cloudinary is configured, use it for true production persistence
    if (process.env.CLOUDINARY_CLOUD_NAME) {
        try {
            console.log(`[Storage] Uploading to Cloudinary: ${filePath}`);
            const result = await cloudinary.uploader.upload(filePath, {
                folder: 'kivo_ai_uploads'
            });
            // Cleanup temp file
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            return result.secure_url;
        } catch (e) {
            console.error('[Storage] Cloudinary upload failed, falling back to local:', e.message);
        }
    }

    // 2. Fallback to Local Storage (Ephemeral on Railway!)
    const fileName = path.basename(filePath);
    const publicDir = path.join(process.cwd(), 'public/uploads');
    const targetPath = path.join(publicDir, fileName);

    if (!fs.existsSync(publicDir)) {
        fs.mkdirSync(publicDir, { recursive: true });
    }

    try {
        fs.copyFileSync(filePath, targetPath);
        fs.unlinkSync(filePath);
    } catch (e) {
        fs.renameSync(filePath, targetPath);
    }

    const rawBaseUrl = process.env.WEBHOOK_URL || 'http://localhost:3000';
    const baseUrl = rawBaseUrl.replace(/\/$/, '');

    return `${baseUrl}/uploads/${fileName}`;
};

module.exports = { uploadImage };
