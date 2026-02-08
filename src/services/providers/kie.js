const axios = require('axios');
const fs = require('fs');
const path = require('path');

const KieProvider = {
    estimate_cost: async (params) => {
        const type = params.media_type || params.mediaType;
        if (type === 'video') return 100;
        return 10;
    },

    _upload_to_kie: async (url, apiKey) => {
        try {
            // If it's already a cloud URL (like Cloudinary), we don't need to proxy it
            if (url.includes('cloudinary.com')) {
                console.log('[Kie] Using direct Cloudinary URL');
                return url;
            }

            const baseUrl = (process.env.WEBHOOK_URL || '').replace(/\/$/, '');
            const isLocal = url.includes('ngrok-free.dev') ||
                url.includes('localhost') ||
                url.includes('127.0.0.1') ||
                (baseUrl && url.startsWith(baseUrl));

            if (isLocal) {
                const fileName = path.basename(url);
                const localPath = path.join(process.cwd(), 'public/uploads', fileName);

                if (fs.existsSync(localPath)) {
                    console.log(`[Kie] Proxying local file to Kie cloud: ${localPath}`);
                    const FormData = require('form-data');
                    const form = new FormData();
                    form.append('file', fs.createReadStream(localPath), {
                        filename: fileName.includes('.') ? fileName : `${fileName}.png`
                    });

                    const res = await axios.post('https://kieai.redpandaai.co/api/file-stream-upload', form, {
                        headers: { ...form.getHeaders(), 'Authorization': `Bearer ${apiKey}` }
                    });

                    const downloadUrl = res.data && res.data.data && (res.data.data.downloadUrl || res.data.data.fileUrl);
                    if (downloadUrl) return downloadUrl;
                }
            }

            // Fallback for non-local or if proxy failed
            const res = await axios.post('https://kieai.redpandaai.co/api/file-url-upload', {
                fileUrl: url,
                uploadPath: 'kivo-uploads'
            }, {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });

            return res.data && res.data.data && (res.data.data.fileUrl || res.data.data.downloadUrl) || url;
        } catch (e) {
            console.error('[Kie] Upload helper failed:', e.message);
            return url;
        }
    },

    submit_job: async (jobData) => {
        console.log('[Kie] Submission starting:', jobData);
        const apiKey = process.env.KIE_KEY;
        if (!apiKey) throw new Error('KIE_KEY not configured');

        let model = jobData.model || 'grok-imagine/image-to-image';
        const isGrokImg2Img = model === 'grok-imagine/image-to-image';

        // 1. Prepare and Upload Media
        let finalImageUrl = jobData.input_image_url || jobData.image_url;
        if (finalImageUrl) {
            finalImageUrl = await KieProvider._upload_to_kie(finalImageUrl, apiKey);
        }

        // 2. Build Payload (Kie expects 'input' as a stringified object for Grok models)
        let inputPayload;
        if (isGrokImg2Img) {
            inputPayload = JSON.stringify({
                image_urls: [finalImageUrl],
                prompt: jobData.prompt
            });
        } else {
            inputPayload = JSON.stringify({
                prompt: jobData.prompt,
                ...(finalImageUrl ? { image_url: finalImageUrl } : {})
            });
        }

        const requestBody = {
            model: model,
            callBackUrl: process.env.WEBHOOK_URL ? `${process.env.WEBHOOK_URL.replace(/\/$/, '')}/webhooks/kie` : undefined,
            input: inputPayload
        };

        try {
            const res = await axios.post('https://kieai.redpandaai.co/api/task-submit', requestBody, {
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
            });

            if (res.data && res.data.data && res.data.data.taskId) {
                return { provider_job_id: res.data.data.taskId, status: 'submitted' };
            }
            throw new Error(`Kie Error: ${JSON.stringify(res.data)}`);
        } catch (e) {
            console.error('[Kie] Submission failed:', e.response ? JSON.stringify(e.response.data) : e.message);
            throw e;
        }
    },

    get_status: async (providerJobId) => {
        return { status: 'pending' }; // Webhooks handle the completion
    }
};

module.exports = KieProvider;
