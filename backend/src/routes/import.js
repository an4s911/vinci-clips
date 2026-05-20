const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Transcript = require('../models/Transcript');
const { transcribeAudioFile } = require('../utils/audioTranscription');
const {
    assertTranscriptNotCancelled,
    completeTranscriptJob,
    createJobState,
    isTranscriptCancelRequested,
    logVideoProcessing,
    markTranscriptPhase,
    runTrackedCommand,
    runTrackedFile,
    startTranscriptWorker,
} = require('../utils/backgroundJobs');
const { deleteLocalMedia, deleteTranscriptTransientMedia } = require('../utils/mediaStorage');
const { analyzeAndAutoGenerateClips } = require('../utils/clipAutomation');
const { classifyImportFailure, classifyTranscriptionFailure } = require('../utils/failureMessages');
const { extractYouTubeMetadata } = require('../services/youtubeMetadata');
const { downloadYouTubeVideoSavenow } = require('../services/savenowDownloader');

const DOWNLOAD_PROVIDER = (process.env.VIDEO_DOWNLOAD_PROVIDER || 'ytdlp').toLowerCase();

const router = express.Router();
const execOptions = { maxBuffer: 20 * 1024 * 1024 };

const importsDir = 'uploads/imports';
const uploadsDir = 'uploads';
if (!fs.existsSync(importsDir)) {
    fs.mkdirSync(importsDir, { recursive: true });
}
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const sanitizeFilename = (value) => String(value || 'imported-video')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140) || 'imported-video';

const detectPlatform = (url) => {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) return 'youtube';
    if (hostname.includes('vimeo.com')) return 'vimeo';
    if (hostname.includes('instagram.com')) return 'instagram';
    if (hostname.includes('linkedin.com')) return 'linkedin';
    if (hostname.includes('tiktok.com')) return 'tiktok';
    if (hostname.includes('facebook.com') || hostname.includes('fb.com')) return 'facebook';
    return 'unknown';
};

const validateUrl = (url) => {
    try {
        const urlObj = new URL(url);
        return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
    } catch (error) {
        return false;
    }
};

function getYtDlpArgs(args) {
    const cookiesPath = process.env.YTDLP_COOKIES_PATH;
    const userAgent = process.env.YTDLP_USER_AGENT;
    const bgutilUrl = process.env.YTDLP_BGUTIL_URL || 'http://bgutil-provider:4416';

    const finalArgs = [
        '--js-runtimes', 'node',
        '--remote-components', 'ejs:github',
        '--extractor-args', `youtubepot-bgutilhttp:base_url=${bgutilUrl}`,
        '--extractor-args', 'youtube:player_client=mweb',
        ...args,
    ];

    if (cookiesPath) {
        finalArgs.unshift('--cookies', cookiesPath);
    }

    if (userAgent) {
        finalArgs.unshift('--user-agent', userAgent);
    }

    return finalArgs;
}

async function extractYouTubeVideo(url) {
    const meta = await extractYouTubeMetadata(url);
    return {
        ...meta,
        title: sanitizeFilename(meta.title || 'youtube-import'),
    };
}

async function extractVimeoVideo(url) {
    const response = await axios.get(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`);
    const videoData = response.data;
    const vimeoIdMatch = url.match(/vimeo\.com\/(?:.*\/)?(\d+)/);

    return {
        title: sanitizeFilename(videoData.title || 'vimeo-import'),
        description: videoData.description || '',
        duration: videoData.duration || 0,
        thumbnail: videoData.thumbnail_url,
        platform: 'vimeo',
        originalUrl: url,
        videoId: vimeoIdMatch?.[1] || null
    };
}

async function downloadYouTubeVideo(transcriptId, url, outputPath, { onProgress, signal } = {}) {
    if (DOWNLOAD_PROVIDER === 'savenow') {
        await downloadYouTubeVideoSavenow(transcriptId, url, outputPath, { onProgress, signal });
    } else {
        await runTrackedFile({
            transcriptId,
            jobType: 'import',
            phase: 'download-video',
            file: 'yt-dlp',
            args: getYtDlpArgs([
                '--no-playlist',
                '--format', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
                '--merge-output-format', 'mp4',
                '--output', outputPath,
                url
            ]),
            options: execOptions,
        });
    }
}

async function processUrlImport({ transcriptId, url, platform }) {
    const jobType = 'import';
    let videoPath = path.join(importsDir, `${transcriptId}.mp4`);
    let mp3Path = `${videoPath}.mp3`;
    let thumbnailPath = `${videoPath}_thumbnail.jpg`;
    let hasSavedMediaArtifacts = false;

    try {
    logVideoProcessing(transcriptId, 'running', 'Background URL import job started', { jobType, phase: 'extract-metadata', url, platform });

    await assertTranscriptNotCancelled(transcriptId, jobType);
    await markTranscriptPhase(transcriptId, jobType, 'extract-metadata', 'Extracting video metadata.', { url, platform });
    let videoInfo;
    if (platform === 'youtube') {
        videoInfo = await extractYouTubeVideo(url);
    } else if (platform === 'vimeo') {
        videoInfo = await extractVimeoVideo(url);
        throw new Error('Direct download is not supported for Vimeo imports yet.');
    } else {
        throw new Error(`Platform ${platform} is not implemented.`);
    }

    const originalFilename = `${videoInfo.title}-${transcriptId}.mp4`;
    await Transcript.findByIdAndUpdate(transcriptId, {
        originalFilename,
        duration: videoInfo.duration,
        platform,
        externalVideoId: videoInfo.videoId,
    });

    await assertTranscriptNotCancelled(transcriptId, jobType);
    await markTranscriptPhase(transcriptId, jobType, 'download-video', 'Downloading source video.', { url, platform });
    const abortController = new AbortController();
    await downloadYouTubeVideo(transcriptId, url, videoPath, {
        signal: abortController.signal,
        onProgress: (pct, text) => markTranscriptPhase(
            transcriptId, jobType, 'download-video',
            text ? `Downloading ${pct}% — ${text}` : `Downloading ${pct}%`,
            { url, platform }
        ),
    });

    await assertTranscriptNotCancelled(transcriptId, jobType);
    await markTranscriptPhase(transcriptId, jobType, 'convert-mp3', 'Converting video audio to MP3.', { fileName: originalFilename });
    await runTrackedCommand({
        transcriptId,
        jobType,
        phase: 'convert-mp3',
        command: `ffmpeg -y -i "${videoPath}" -vn -acodec libmp3lame -q:a 2 "${mp3Path}"`,
        options: execOptions,
    });

    await assertTranscriptNotCancelled(transcriptId, jobType);
    await markTranscriptPhase(transcriptId, jobType, 'thumbnail', 'Generating thumbnail.', { fileName: originalFilename });
    try {
        await runTrackedCommand({
            transcriptId,
            jobType,
            phase: 'thumbnail',
            command: `ffmpeg -y -i "${videoPath}" -ss 00:00:01 -vframes 1 "${thumbnailPath}"`,
            options: execOptions,
        });
    } catch (thumbnailError) {
        logVideoProcessing(transcriptId, 'warning', 'Thumbnail generation failed; continuing without thumbnail', {
            jobType,
            phase: 'thumbnail',
            error: thumbnailError.message,
        });
    }

    await assertTranscriptNotCancelled(transcriptId, jobType);
    await markTranscriptPhase(transcriptId, jobType, 'persist-files', 'Saving imported media files.', { fileName: originalFilename });
    const mp3FileName = originalFilename.replace(/\.[^/.]+$/, '') + '.mp3';
    const thumbnailFileName = originalFilename.replace(/\.[^/.]+$/, '') + '_thumbnail.jpg';
    const videoDestPath = path.join(uploadsDir, originalFilename);
    const mp3DestPath = path.join(uploadsDir, mp3FileName);
    const thumbnailDestPath = path.join(uploadsDir, thumbnailFileName);

    fs.renameSync(videoPath, videoDestPath);
    fs.renameSync(mp3Path, mp3DestPath);
    if (fs.existsSync(thumbnailPath)) {
        fs.renameSync(thumbnailPath, thumbnailDestPath);
    }

    const videoUrl = `/uploads/${originalFilename}`;
    const mp3Url = `/uploads/${mp3FileName}`;
    const thumbnailUrl = fs.existsSync(thumbnailDestPath) ? `/uploads/${thumbnailFileName}` : null;
    await Transcript.findByIdAndUpdate(transcriptId, {
        videoUrl,
        mp3Url,
        thumbnailUrl,
        duration: videoInfo.duration,
        failureReason: null,
        failedAt: null,
    });
    hasSavedMediaArtifacts = true;

    await assertTranscriptNotCancelled(transcriptId, jobType);
    const { transcript: transcriptContent, model: resolvedModel } = await transcribeAudioFile({
        mp3Path: mp3DestPath,
        transcriptId,
        jobType,
        logLabel: `URL import transcription for ${transcriptId}`,
        onPhaseChange: (phase, message, extra = {}) => markTranscriptPhase(transcriptId, jobType, phase, message, extra),
    });

    await assertTranscriptNotCancelled(transcriptId, jobType);
    await Transcript.findByIdAndUpdate(transcriptId, {
        transcript: transcriptContent,
        failureReason: null,
        failedAt: null,
    });
    logVideoProcessing(transcriptId, 'completed', 'Gemini transcription completed', {
        jobType,
        phase: 'transcribe',
        model: resolvedModel,
        wordCount: Array.isArray(transcriptContent) ? transcriptContent.length : null,
    });
    await completeTranscriptJob(transcriptId, jobType, 'Import and transcription completed.');
    await analyzeAndAutoGenerateClips(transcriptId);

    return { hasSavedMediaArtifacts };
    } finally {
        await Promise.all([
            deleteLocalMedia(videoPath, { missingOk: true }),
            deleteLocalMedia(mp3Path, { missingOk: true }),
            deleteLocalMedia(thumbnailPath, { missingOk: true }),
            deleteTranscriptTransientMedia(transcriptId),
        ]);
    }
}

router.post('/url', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    if (!validateUrl(url)) {
        return res.status(400).json({ error: 'Invalid URL format' });
    }

    const platform = detectPlatform(url);
    if (platform === 'unknown') {
        return res.status(400).json({ error: 'Unsupported platform' });
    }

    const transcript = await Transcript.create({
        userId: req.user.id,
        originalFilename: 'Importing video...',
        transcript: [],
        status: 'uploading',
        failureReason: null,
        failedAt: null,
        importUrl: url,
        platform,
        processingJob: createJobState({
            status: 'running',
            phase: 'extract-metadata',
            progressMessage: 'Extracting video metadata.',
        }),
    });

    logVideoProcessing(transcript._id, 'accepted', 'URL import request accepted', {
        jobType: 'import',
        phase: 'extract-metadata',
        url,
        platform,
    });

    startTranscriptWorker(transcript._id, 'import', async () => {
        try {
            await processUrlImport({ transcriptId: transcript._id, url, platform });
        } catch (error) {
            if (error?.code === 'JOB_CANCELLED' || await isTranscriptCancelRequested(transcript._id)) {
                throw error;
            }
            logVideoProcessing(transcript._id, 'failed', 'Import error (raw)', {
                jobType: 'import',
                rawError: error?.message,
                rawCode: error?.code,
                stderr: error?.stderr?.slice?.(0, 500),
            });
            const current = await Transcript.findById(transcript._id);
            const failure = current?.mp3Url
                ? classifyTranscriptionFailure(error)
                : classifyImportFailure(error);
            error.publicCode = failure.code;
            error.publicMessage = failure.message;
            await Transcript.findByIdAndUpdate(transcript._id, {
                failureReason: failure.message,
                failedAt: new Date().toISOString(),
            });
            throw error;
        }
    });

    res.status(202).json({
        message: 'Import accepted. Processing continues in the background.',
        transcript,
    });
});

module.exports = router;
