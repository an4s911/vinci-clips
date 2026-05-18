const axios = require('axios');
const fs = require('fs');

const POLL_INTERVAL_MS = 2000;
const TIMEOUT_MS = 15 * 60 * 1000;

async function downloadYouTubeVideoSavenow(transcriptId, url, outputPath, { onProgress, signal } = {}) {
    const apiKey = process.env.VIDEO_DOWNLOAD_API_KEY;
    const host = process.env.VIDEO_DOWNLOAD_API_HOST || 'p.savenow.to';
    const format = process.env.VIDEO_DOWNLOAD_FORMAT || '1080';

    if (!apiKey) throw new Error('VIDEO_DOWNLOAD_API_KEY is not configured.');

    const params = {
        url,
        format,
        apikey: apiKey,
        add_info: 1,
        no_merge: 0,
    };

    const createResp = await axios.get(`https://${host}/ajax/download.php`, {
        params,
        timeout: 30000,
    });

    if (!createResp.data.success) {
        throw new Error(`savenow job creation failed: ${JSON.stringify(createResp.data)}`);
    }

    const jobId = createResp.data.id;
    if (!jobId) throw new Error('savenow did not return a job id.');

    const deadline = Date.now() + TIMEOUT_MS;

    while (true) {
        if (signal?.aborted) throw Object.assign(new Error('Download cancelled.'), { code: 'JOB_CANCELLED' });
        if (Date.now() > deadline) throw new Error(`savenow download timed out after ${TIMEOUT_MS / 60000} minutes.`);

        await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));

        if (signal?.aborted) throw Object.assign(new Error('Download cancelled.'), { code: 'JOB_CANCELLED' });

        let pollResp;
        try {
            pollResp = await axios.get(`https://${host}/ajax/progress`, {
                params: { id: jobId },
                timeout: 15000,
            });
        } catch (err) {
            // transient poll failure — keep retrying until deadline
            continue;
        }

        const { success, progress, download_url, text } = pollResp.data;

        if (onProgress && typeof progress === 'number') {
            onProgress(Math.round(progress / 10), text || '');
        }

        if (success === 1 && download_url) {
            await streamDownload(download_url, outputPath, signal);
            return;
        }

        if (success === 1 && !download_url) {
            throw new Error(`savenow job finished but no download_url returned. Message: ${pollResp.data.message || ''}`);
        }
    }
}

async function streamDownload(downloadUrl, outputPath, signal) {
    const response = await axios.get(downloadUrl, {
        responseType: 'stream',
        timeout: 0,
        signal,
    });

    await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(outputPath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
        response.data.on('error', reject);
    });
}

module.exports = { downloadYouTubeVideoSavenow };
