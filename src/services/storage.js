const fs = require('fs');
const path = require('path');

const uploadImage = async (filePath) => {
    // Move file from temp 'uploads/' to 'public/uploads/'
    const fileName = path.basename(filePath);
    const targetPath = path.join(process.cwd(), 'public/uploads', fileName);

    // Create dir if not exists
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    try {
        // Use copy + unlink instead of rename because rename can fail across partitions in cloud environments
        fs.copyFileSync(filePath, targetPath);
        fs.unlinkSync(filePath);
    } catch (e) {
        console.error('Storage move failed, trying rename fallback:', e.message);
        fs.renameSync(filePath, targetPath);
    }

    // Return URL
    // Use WEBHOOK_URL (ngrok) if available so external providers can access the file
    const baseUrl = process.env.WEBHOOK_URL || 'http://localhost:3000';
    return `${baseUrl}/uploads/${fileName}`;
};

module.exports = {
    uploadImage
};
