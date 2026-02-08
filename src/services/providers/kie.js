const axios = require('axios');
const fs = require('fs');
const path = require('path');

const KieProvider = {
    // Returns estimated cost in credits
    // Estimates based on media type for now
    estimate_cost: async (params) => {
        const type = params.media_type || params.mediaType;
        if (type === 'video') return 100;
        return 10;
    },

    // Upload to Kie helper
    _upload_to_kie: async (url, apiKey) => {
        try {
            // Detection Logic: If it's one of ours (local, ngrok, or production railway URL), use stream upload
            const baseUrl = (process.env.WEBHOOK_URL || '').replace(/\/$/, '');
            const isLocal = url.includes('ngrok-free.dev') ||
                url.includes('localhost') ||
                url.includes('127.0.0.1') ||
                (baseUrl && url.startsWith(baseUrl));

            if (isLocal) {
                // Map URL back to local file path
                // URL format: https://.../uploads/filename
                const fileName = path.basename(url);
                const localPath = path.join(process.cwd(), 'public/uploads', fileName);

                if (fs.existsSync(localPath)) {
                    console.log('Uploading local file via stream:', localPath);
                    const FormData = require('form-data');
                    const form = new FormData();

                    // Add filename to append so Kie knows the extension
                    form.append('file', fs.createReadStream(localPath), {
                        filename: fileName.includes('.') ? fileName : `${fileName}.png`
                    });
                    form.append('uploadPath', 'kivo-uploads');

                    const res = await axios.post('https://kieai.redpandaai.co/api/file-stream-upload', form, {
                        headers: {
                            ...form.getHeaders(),
                            'Authorization': `Bearer ${apiKey}`
                        }
                    });

                    // Check for fileUrl OR downloadUrl based on actual API response
                    const kieData = res.data && res.data.data;
                    const finalUrl = kieData && (kieData.fileUrl || kieData.downloadUrl);

                    if (finalUrl) {
                        console.log('Successfully uploaded stream to Kie:', finalUrl);
                        return finalUrl;
                    }
                } else {
                    console.warn('Local file not found at path:', localPath);
                }
            }

            // Fallback to URL upload if no local file found or not local
            console.log('Falling back to URL upload for:', url);
            const res = await axios.post('https://kieai.redpandaai.co/api/file-url-upload', {
                fileUrl: url,
                uploadPath: 'kivo-uploads'
            }, {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });

            const kieData = res.data && res.data.data;
            const finalUrl = kieData && (kieData.fileUrl || kieData.downloadUrl);

            if (finalUrl) {
                console.log('Successfully uploaded via URL to Kie:', finalUrl);
                return finalUrl;
            }

            console.warn('Kie upload helper failed to get URL, using original:', res.data);
            return url;
        } catch (e) {
            console.error('Error in _upload_to_kie:', e.response ? e.response.data : e.message);
            return url;
        }
    },

    // Submits job to Kie.ai
    submit_job: async (jobData) => {
        console.log('Submitting to Kie.ai', jobData);

        const apiKey = process.env.KIE_KEY;
        if (!apiKey) throw new Error('KIE_KEY not configured');

        // Determine model
        let model = jobData.model;

        // Map common shorthands or user-requested aliases
        if (model === 'grok-beta' || model === 'grok-imagine') {
            if (jobData.input_image_url) {
                model = 'grok-imagine/image-to-image';
            } else {
                model = 'grok-imagine/text-to-image';
            }
        }

        if (!model) {
            // Default logic if not provided by user
            if (jobData.input_image_url) {
                model = 'kling-v1';
            } else {
                model = 'grok-imagine/text-to-image';
            }
        }

        // Construct Input Object
        const inputParams = {
            prompt: jobData.prompt || ''
        };

        const isGrokImg2Img = model === 'grok-imagine/image-to-image';

        // Aspect ratio is NOT supported by Grok img2img based on docs
        if (!isGrokImg2Img) {
            inputParams.aspect_ratio = jobData.aspect_ratio || '1:1';
        }

        // Handle Image Input (for img2img or editing)
        if (jobData.input_image_url) {
            let finalImageUrl = jobData.input_image_url;

            // If it's a local URL (ngrok, localhost, or production Railway), upload it to Kie's cloud storage first
            const baseUrl = (process.env.WEBHOOK_URL || '').replace(/\/$/, '');
            const isLocal = finalImageUrl.includes('ngrok-free.dev') ||
                finalImageUrl.includes('localhost') ||
                finalImageUrl.includes('127.0.0.1') ||
                (baseUrl && finalImageUrl.startsWith(baseUrl));

            if (isLocal) {
                console.log('🔄 Local image detected, proxying to Kie.ai storage...');
                finalImageUrl = await KieProvider._upload_to_kie(finalImageUrl, apiKey);
            }

            if (isGrokImg2Img) {
                // Grok img2img requires ONLY image_urls as an array
                inputParams.image_urls = [finalImageUrl];
            } else {
                // Falling back to image_url/image for other models (like Kling)
                inputParams.image = finalImageUrl;
                inputParams.image_url = finalImageUrl;
            }
        }

        const requestBody = {
            model: model,
            callBackUrl: process.env.WEBHOOK_URL ? `${process.env.WEBHOOK_URL.replace(/\/$/, '')}/webhooks/kie` : undefined,
            input: inputParams
        };

        console.log('Kie.ai Request Body:', JSON.stringify(requestBody, null, 2));

        try {
            const response = await axios.post('https://api.kie.ai/api/v1/jobs/createTask', requestBody, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.data && response.data.data && response.data.data.taskId) {
                return {
                    provider_job_id: response.data.data.taskId,
                    status: 'queued'
                };
            } else {
                throw new Error('No taskId in Kie.ai response: ' + JSON.stringify(response.data));
            }
        } catch (error) {
            console.error('Kie.ai submission error:', error.response ? error.response.data : error.message);
            throw error;
        }
    },

    // Poll status from Kie.ai
    get_status: async (providerJobId) => {
        const apiKey = process.env.KIE_KEY;
        try {
            // Endpoint: GET https://api.kie.ai/api/v1/jobs/recordInfo?taskId={taskId}
            const response = await axios.get(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${providerJobId}`, {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });

            const data = response.data.data;
            if (!data) throw new Error('No data in Kie.ai status response');

            // Status mapping
            // Kie statuses: wait, queueing, generating, success, fail
            const map = {
                'wait': 'queued',
                'queueing': 'queued',
                'generating': 'processing',
                'success': 'completed',
                'fail': 'failed'
            };

            const status = map[data.status] || 'processing';

            if (status === 'completed') {
                let resultUrl = data.result || data.url;

                // Handle resultJson structure seen in logs
                if (!resultUrl && data.resultJson) {
                    try {
                        const resultJson = typeof data.resultJson === 'string' ? JSON.parse(data.resultJson) : data.resultJson;
                        if (resultJson.resultUrls && resultJson.resultUrls.length > 0) {
                            resultUrl = resultJson.resultUrls[0];
                        }
                    } catch (e) {
                        console.error('Failed to parse resultJson in status check:', e);
                    }
                }

                return {
                    status: 'completed',
                    result_url: resultUrl
                };
            }

            if (status === 'failed') {
                return { status: 'failed', error: data.failReason || 'Unknown error' };
            }

            return { status };

        } catch (error) {
            console.error('Kie.ai status check error:', error.response ? error.response.data : error.message);
            throw error;
        }
    },

    fetch_result: async (providerJobId) => {
        // Just re-use get_status logic or specific result endpoint if needed
        const status = await KieProvider.get_status(providerJobId);
        if (status.status === 'completed') return { url: status.result_url };
        throw new Error('Job not completed');
    }
};

module.exports = KieProvider;
