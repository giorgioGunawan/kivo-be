const fs = require('fs');
const path = require('path');

const uploadImage = async (filePath) => {
    // Move file from temp 'uploads/' to 'public/uploads/'
    const fileName = path.basename(filePath);
    const targetPath = path.join(__dirname, '../../public/uploads', fileName);

    // Create dir if not exists
    if (!fs.existsSync(path.dirname(targetPath))) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    }

    fs.renameSync(filePath, targetPath);

    // Return URL
    // Use WEBHOOK_URL (ngrok) if available so external providers can access the file
    const baseUrl = process.env.WEBHOOK_URL || 'http://localhost:3000';
    return `${baseUrl}/uploads/${fileName}`;
};

module.exports = {
    uploadImage
};
