const axios = require('axios');
const fs = require('fs');
const { spawn } = require('child_process');
const logger = require('../utils/logger');

const VIDEO_ID_RE = /(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;
const API_HOST = 'cloud-api-hub-youtube-downloader.p.rapidapi.com';
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;

// Quality labels in preference order — 720p primary, fall through on unavailability.
// Matched against format_note (not raw pixel height) so portrait/vertical videos work correctly.
const TARGET_QUALITIES = ['720p', '1080p', '480p', '360p'];

/**
 * Pick the best video-only DASH stream: H.264 mp4, no audio track.
 * Selects by format_note label so non-standard aspect ratios (portrait, shorts) work correctly.
 * H.264 (avc1) is the only codec that can be -c copy muxed into mp4 without re-encode.
 */
function pickVideoStream(formats) {
    const candidates = formats.filter(f =>
        f.vcodec && f.vcodec.toLowerCase().startsWith('avc1') &&
        f.acodec === 'none' &&
        f.ext === 'mp4' &&
        f.url
    );
    // Match by quality label — handles non-standard heights like portrait videos
    for (const q of TARGET_QUALITIES) {
        const match = candidates.find(f => f.format_note && f.format_note.startsWith(q));
        if (match) return match;
    }
    // Last resort: highest available avc1 mp4 stream
    if (candidates.length > 0) {
        return candidates.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    }
    return null;
}

/**
 * Pick the best audio-only stream: AAC in m4a container, no DRC variant.
 * mp4a (AAC) in m4a can be -c copy muxed into mp4 without re-encode.
 */
function pickAudioStream(formats) {
    return formats.find(f =>
        f.acodec && f.acodec.toLowerCase().startsWith('mp4a') &&
        f.vcodec === 'none' &&
        f.ext === 'm4a' &&
        !String(f.format_id).endsWith('-drc') &&
        f.url
    ) || null;
}

/**
 * Pick a combined (video+audio) mp4 stream as a fallback when no separate audio is found.
 */
function pickCombinedStream(formats, targetQualities) {
    const candidates = formats.filter(f =>
        f.vcodec && f.vcodec !== 'none' &&
        f.acodec && f.acodec !== 'none' &&
        f.ext === 'mp4' &&
        f.url
    );
    for (const q of targetQualities) {
        const match = candidates.find(f => f.format_note && f.format_note.startsWith(q));
        if (match) return match;
    }
    // Last resort: highest available combined mp4
    if (candidates.length > 0) {
        return candidates.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    }
    return null;
}

async function streamToFile(url, destPath, signal, onBytes) {
    const response = await axios.get(url, {
        responseType: 'stream',
        timeout: DOWNLOAD_TIMEOUT_MS,
        signal,
    });
    const total = parseInt(response.headers['content-length'] || '0', 10);
    let received = 0;
    await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(destPath);
        response.data.on('data', chunk => {
            received += chunk.length;
            onBytes?.(received, total);
        });
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
        response.data.on('error', reject);
    });
}

function ffmpegMux(videoPath, audioPath, outputPath) {
    return new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', [
            '-i', videoPath,
            '-i', audioPath,
            '-c', 'copy',
            '-y',
            outputPath,
        ]);
        let stderr = '';
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg mux exited ${code}: ${stderr.slice(-500)}`));
        });
        proc.on('error', reject);
    });
}

function tryUnlink(p) {
    try { fs.unlinkSync(p); } catch { /* already gone */ }
}

/**
 * Download a YouTube video via the CloudApiHub RapidAPI provider.
 *
 * @param {string} transcriptId
 * @param {string} url - Full YouTube URL
 * @param {string} outputPath - Final mp4 destination
 * @param {{ signal?: AbortSignal, onProgress?: (pct: number, text: string) => void }} opts
 */
async function downloadYouTubeVideoCloudApiHub(transcriptId, url, outputPath, { signal, onProgress } = {}) {
    const apiKey = process.env.VIDEO_DOWNLOAD_RAPIDAPI_KEY;
    if (!apiKey) throw new Error('VIDEO_DOWNLOAD_RAPIDAPI_KEY is not configured.');

    const match = url.match(VIDEO_ID_RE);
    if (!match) throw new Error(`Could not extract video ID from URL: ${url}`);
    const videoId = match[1];

    if (signal?.aborted) throw Object.assign(new Error('Download cancelled.'), { code: 'JOB_CANCELLED' });

    logger.info('CloudApiHub: fetching stream list', { transcriptId, videoId });

    const { data: formats } = await axios.get(`https://${API_HOST}/download`, {
        params: { id: videoId },
        headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': API_HOST },
        timeout: 30000,
        signal,
    });

    if (!Array.isArray(formats) || formats.length === 0) {
        throw new Error(`CloudApiHub returned no formats for video ${videoId}`);
    }

    logger.info('CloudApiHub: stream list fetched', { transcriptId, videoId, totalFormats: formats.length });
    onProgress?.(5, 'Stream list fetched.');

    if (signal?.aborted) throw Object.assign(new Error('Download cancelled.'), { code: 'JOB_CANCELLED' });

    const videoStream = pickVideoStream(formats);

    if (!videoStream) {
        const available = formats
            .filter(f => f.vcodec && f.vcodec !== 'none' && f.ext !== 'mhtml')
            .map(f => `${f.format_id}(${f.ext},${f.format_note || f.height}p,v=${f.vcodec},a=${f.acodec})`);
        logger.error('CloudApiHub: no H.264 mp4 video stream found', { transcriptId, videoId, available });
        throw new Error(`CloudApiHub: no H.264 mp4 video stream found for ${videoId}`);
    }

    const audioStream = pickAudioStream(formats);

    if (audioStream) {
        // DASH path: separate video + audio, mux with ffmpeg -c copy (near-zero CPU)
        logger.info('CloudApiHub: selected streams', {
            transcriptId, videoId,
            video: {
                format_id: videoStream.format_id,
                quality: videoStream.format_note,
                resolution: videoStream.resolution,
                vcodec: videoStream.vcodec,
                fps: videoStream.fps,
                url: videoStream.url,
            },
            audio: {
                format_id: audioStream.format_id,
                quality: audioStream.format_note,
                acodec: audioStream.acodec,
                abr: audioStream.abr,
                url: audioStream.url,
            },
        });

        const vtmp = `${outputPath}_vtmp.mp4`;
        const atmp = `${outputPath}_atmp.m4a`;

        const videoSize = videoStream.filesize || videoStream.filesize_approx || 0;
        const audioSize = audioStream.filesize || audioStream.filesize_approx || 0;
        const totalSize = videoSize + audioSize;

        let videoBytesReceived = 0;
        let audioBytesReceived = 0;
        let lastReportedPct = -1;

        const reportProgress = () => {
            let pct;
            if (totalSize > 0) {
                pct = Math.round(5 + ((videoBytesReceived + audioBytesReceived) / totalSize) * 85);
            } else {
                pct = 47;
            }
            if (pct - lastReportedPct >= 5) {
                lastReportedPct = pct;
                onProgress?.(pct, 'Fetching streams…');
            }
        };

        try {
            await Promise.all([
                streamToFile(videoStream.url, vtmp, signal, (received) => {
                    videoBytesReceived = received;
                    reportProgress();
                }),
                streamToFile(audioStream.url, atmp, signal, (received) => {
                    audioBytesReceived = received;
                    reportProgress();
                }),
            ]);

            onProgress?.(90, 'Muxing streams…');
            await ffmpegMux(vtmp, atmp, outputPath);
            onProgress?.(100, 'Download complete.');
            logger.info('CloudApiHub: mux complete', { transcriptId, outputPath });
        } finally {
            tryUnlink(vtmp);
            tryUnlink(atmp);
        }
        return;
    }

    // Fallback: no compatible audio stream — try a combined mp4 at preferred quality
    const videoQuality = videoStream.format_note || '';
    const qualityOrder = [videoQuality, ...TARGET_QUALITIES.filter(q => !videoQuality.startsWith(q))];
    const combined = pickCombinedStream(formats, qualityOrder);

    if (!combined) {
        throw new Error(`CloudApiHub: no compatible audio or combined stream found for ${videoId}`);
    }

    logger.info('CloudApiHub: combined stream fallback (no separate audio found)', {
        transcriptId, videoId,
        format_id: combined.format_id,
        quality: combined.format_note,
        resolution: combined.resolution,
        vcodec: combined.vcodec,
        acodec: combined.acodec,
        url: combined.url,
    });

    const combinedSize = combined.filesize || combined.filesize_approx || 0;
    let lastCombinedPct = -1;
    await streamToFile(combined.url, outputPath, signal, (received, total) => {
        const knownTotal = total || combinedSize;
        const pct = knownTotal ? Math.round(5 + (received / knownTotal) * 85) : 5;
        if (pct - lastCombinedPct >= 5) {
            lastCombinedPct = pct;
            onProgress?.(pct, 'Fetching video…');
        }
    });
    onProgress?.(100, 'Download complete.');
    logger.info('CloudApiHub: combined download complete', { transcriptId, outputPath });
}

module.exports = { downloadYouTubeVideoCloudApiHub };
