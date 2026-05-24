/**
 * Pipeline Stage Registry
 *
 * This is the single authoritative list of pipeline stages in execution order.
 * Each stage descriptor has:
 *   - name        : unique string, matches the `phase` key used in processingJob
 *   - lane        : 'network' | 'transcribe' | 'media'  — controls concurrency bucket
 *   - run(ctx)    : async function that executes the stage work
 *   - isComplete  : function(transcript) → bool — true when the stage output already
 *                   exists (used by resume: skip stages whose artifacts are present)
 *   - skip        : optional function(transcript, jobType) → bool — skip this stage
 *                   entirely for certain job types (e.g. upload skips network stages)
 *   - optional    : if true, a failure is logged but NOT re-thrown (stage is non-fatal)
 *
 * HOW TO ADD A NEW STAGE (e.g. 'reframe', 'captions'):
 *   1. Insert a new descriptor object into PIPELINE_STAGES at the desired position.
 *   2. Implement run(ctx) — ctx carries { transcriptId, jobType, transcript }.
 *      Call markTranscriptPhase / Transcript.findByIdAndUpdate as needed.
 *   3. Implement isComplete(transcript) — inspect existing artifact fields so
 *      "Retry and continue" can skip over already-finished stages.
 *   4. Assign the correct lane:
 *        network   → IO-bound, no heavy CPU (download, metadata fetch)
 *        transcribe→ Gemini/LLM calls (high latency, internal chunk parallelism)
 *        media     → CPU-bound ffmpeg work, file moves, clip generation
 *   5. No other file needs changing — the worker automatically discovers your stage.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Transcript = require('../models/Transcript');
const { transcribeAudioFile } = require('../utils/whisperTranscription');
const { analyzeTranscriptForClips } = require('../utils/clipAnalysis');
const { extractYouTubeMetadata } = require('../services/youtubeMetadata');
const { downloadYouTubeVideoSavenow } = require('../services/savenowDownloader');
const { downloadYouTubeVideoCloudApiHub } = require('../services/cloudApiHubDownloader');
const {
    assertTranscriptNotCancelled,
    completeTranscriptJob,
    createJobState,
    ensureActiveAbortController,
    logVideoProcessing,
    markTranscriptPhase,
    nowIso,
    resolveLocalUploadPath,
    runTrackedCommand,
    runTrackedFile,
    updateClipGeneration,
} = require('../utils/backgroundJobs');
const { enqueueClipGenerate } = require('./clipJobs');
const { normalizeTranscriptClips, getPrimaryClipVideo } = require('../utils/clipVideos');
const { deleteLocalMedia } = require('../utils/mediaStorage');
const logger = require('../utils/logger');

const DOWNLOAD_PROVIDER = (process.env.VIDEO_DOWNLOAD_PROVIDER || 'ytdlp').toLowerCase();
const execOptions = { maxBuffer: 20 * 1024 * 1024 };

// ─── Path helpers ────────────────────────────────────────────────────────────

function importsVideoPath(transcriptId) {
    return path.join('uploads/imports', `${transcriptId}.mp4`);
}
function importsMp3Path(transcriptId) {
    return `${importsVideoPath(transcriptId)}.mp3`;
}
function importsThumbnailPath(transcriptId) {
    return `${importsVideoPath(transcriptId)}_thumbnail.jpg`;
}

function uploadTempVideoPath(transcript) {
    const ext = path.extname(transcript.originalFilename) || '.mp4';
    return path.join('uploads/temp', `${transcript._id}${ext}`);
}
function uploadTempMp3Path(transcript) {
    return `${uploadTempVideoPath(transcript)}.mp3`;
}
function uploadTempThumbnailPath(transcript) {
    return `${uploadTempVideoPath(transcript)}_thumbnail.jpg`;
}

// Returns the transient video path (before persist-files moves it to uploads/)
function transientVideoPath(transcript, jobType) {
    return jobType === 'upload'
        ? uploadTempVideoPath(transcript)
        : importsVideoPath(transcript._id);
}

function sanitizeFilename(value) {
    return String(value || 'imported-video')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 140) || 'imported-video';
}

// ─── isComplete helpers ───────────────────────────────────────────────────────

function videoFileExists(transcript, jobType) {
    if (transcript.videoUrl) return true;
    const p = jobType === 'upload'
        ? uploadTempVideoPath(transcript)
        : importsVideoPath(transcript._id);
    return fs.existsSync(p);
}

function mp3FileExists(transcript, jobType) {
    if (transcript.mp3Url) return true;
    const p = jobType === 'upload'
        ? uploadTempMp3Path(transcript)
        : importsMp3Path(transcript._id);
    return fs.existsSync(p);
}

// Used as stage isComplete — only counts genuinely successful clips.
function clipsAllGenerated(transcript) {
    const clips = transcript.clips;
    if (!Array.isArray(clips) || clips.length === 0) return false;
    return clips.every(c => c.primaryVideoId || c.generation?.status === 'completed');
}

// Used by maybeFinalizeTranscriptClips — failed/cancelled count as terminal.
function clipsAllTerminal(transcript) {
    const clips = transcript.clips;
    if (!Array.isArray(clips) || clips.length === 0) return false;
    return clips.every(c =>
        !c.generation ||
        c.generation.status === 'idle' ||
        ['completed', 'failed', 'cancelled'].includes(c.generation.status)
    );
}

// ─── Stage run functions ──────────────────────────────────────────────────────

async function runExtractMetadata({ transcriptId, jobType, transcript }) {
    const url = transcript.importUrl;
    const platform = transcript.platform;

    await markTranscriptPhase(transcriptId, jobType, 'extract-metadata', 'Extracting video metadata.', { url, platform });
    await assertTranscriptNotCancelled(transcriptId, jobType);

    let videoInfo;
    let rawTitle = null;
    if (platform === 'youtube') {
        const meta = await extractYouTubeMetadata(url);
        rawTitle = meta.title || null;
        videoInfo = { ...meta, title: sanitizeFilename(meta.title || 'youtube-import') };
    } else {
        throw new Error(`Platform ${platform} is not implemented.`);
    }

    const originalFilename = `${videoInfo.title}-${transcriptId}.mp4`;
    await Transcript.findByIdAndUpdate(transcriptId, {
        originalFilename,
        title: rawTitle,
        duration: videoInfo.duration,
        externalVideoId: videoInfo.videoId,
    });

    logVideoProcessing(transcriptId, 'running', 'Metadata extracted', { jobType, platform, title: videoInfo.title });
}

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
    if (cookiesPath) finalArgs.unshift('--cookies', cookiesPath);
    if (userAgent) finalArgs.unshift('--user-agent', userAgent);
    return finalArgs;
}

async function runDownloadVideo({ transcriptId, jobType, transcript }) {
    const url = transcript.importUrl;
    const platform = transcript.platform;
    const videoPath = importsVideoPath(transcriptId);

    await markTranscriptPhase(transcriptId, jobType, 'download-video', 'Downloading source video.', { url, platform });
    await assertTranscriptNotCancelled(transcriptId, jobType);

    if (!fs.existsSync('uploads/imports')) {
        fs.mkdirSync('uploads/imports', { recursive: true });
    }

    if (DOWNLOAD_PROVIDER === 'savenow') {
        const abortController = ensureActiveAbortController(transcriptId);
        await downloadYouTubeVideoSavenow(transcriptId, url, videoPath, {
            signal: abortController?.signal,
            onProgress: (pct, text) => markTranscriptPhase(
                transcriptId, jobType, 'download-video',
                text ? `Downloading ${pct}% — ${text}` : `Downloading ${pct}%`,
                { url, platform }
            ),
        });
    } else if (DOWNLOAD_PROVIDER === 'cloudapihub') {
        const abortController = ensureActiveAbortController(transcriptId);
        await downloadYouTubeVideoCloudApiHub(transcriptId, url, videoPath, {
            signal: abortController?.signal,
            onProgress: (pct, text) => markTranscriptPhase(
                transcriptId, jobType, 'download-video',
                text ? `Downloading ${pct}% — ${text}` : `Downloading ${pct}%`,
                { url, platform }
            ),
        });
    } else {
        await runTrackedFile({
            transcriptId,
            jobType,
            phase: 'download-video',
            file: 'yt-dlp',
            args: getYtDlpArgs([
                '--no-playlist',
                '--format', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
                '--merge-output-format', 'mp4',
                '--output', videoPath,
                url,
            ]),
            options: execOptions,
        });
    }

    logVideoProcessing(transcriptId, 'running', 'Video downloaded', { jobType, videoPath });
}

async function runProbeDuration({ transcriptId, jobType, transcript }) {
    const videoPath = transientVideoPath(transcript, jobType);

    await markTranscriptPhase(transcriptId, jobType, 'probe-duration', 'Reading video duration.', {});
    await assertTranscriptNotCancelled(transcriptId, jobType);

    try {
        const result = await runTrackedCommand({
            transcriptId,
            jobType,
            phase: 'probe-duration',
            command: `ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
        });
        const duration = parseFloat(result.stdout.trim());
        if (Number.isFinite(duration)) {
            await Transcript.findByIdAndUpdate(transcriptId, { duration });
        }
    } catch (err) {
        logVideoProcessing(transcriptId, 'warning', 'Could not read video duration', { jobType, error: err.message });
    }
}

async function runThumbnail({ transcriptId, jobType, transcript }) {
    const videoPath = transientVideoPath(transcript, jobType);
    const thumbPath = jobType === 'upload'
        ? uploadTempThumbnailPath(transcript)
        : importsThumbnailPath(transcriptId);

    await markTranscriptPhase(transcriptId, jobType, 'thumbnail', 'Generating thumbnail.', {});
    await assertTranscriptNotCancelled(transcriptId, jobType);

    try {
        await runTrackedCommand({
            transcriptId,
            jobType,
            phase: 'thumbnail',
            command: `ffmpeg -y -i "${videoPath}" -ss 00:00:01 -vframes 1 "${thumbPath}"`,
            options: execOptions,
        });
    } catch (err) {
        logVideoProcessing(transcriptId, 'warning', 'Thumbnail generation failed; continuing', { jobType, error: err.message });
    }
}

async function runConvertMp3({ transcriptId, jobType, transcript }) {
    const videoPath = transientVideoPath(transcript, jobType);
    const mp3Path = jobType === 'upload'
        ? uploadTempMp3Path(transcript)
        : importsMp3Path(transcriptId);

    await markTranscriptPhase(transcriptId, jobType, 'convert-mp3', 'Converting video audio to MP3.', {});
    await assertTranscriptNotCancelled(transcriptId, jobType);

    await runTrackedCommand({
        transcriptId,
        jobType,
        phase: 'convert-mp3',
        command: `ffmpeg -y -i "${videoPath}" -vn -acodec libmp3lame -q:a 2 "${mp3Path}"`,
        options: execOptions,
    });
}

const uploadsDir = path.join(__dirname, '..', '..', 'uploads');

async function runPersistFiles({ transcriptId, jobType, transcript }) {
    await markTranscriptPhase(transcriptId, jobType, 'persist-files', 'Saving media files.', {});
    await assertTranscriptNotCancelled(transcriptId, jobType);

    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
    }

    let videoSrc, mp3Src, thumbnailSrc, videoFileName;

    if (jobType === 'upload') {
        const ext = path.extname(transcript.originalFilename) || '.mp4';
        videoSrc = uploadTempVideoPath(transcript);
        mp3Src = uploadTempMp3Path(transcript);
        thumbnailSrc = uploadTempThumbnailPath(transcript);
        const base = path.basename(transcript.originalFilename, ext)
            .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 140) || 'uploaded-video';
        videoFileName = `${base}-${transcriptId}${ext}`;
    } else {
        videoSrc = importsVideoPath(transcriptId);
        mp3Src = importsMp3Path(transcriptId);
        thumbnailSrc = importsThumbnailPath(transcriptId);
        videoFileName = transcript.originalFilename;
    }

    const mp3FileName = videoFileName.replace(/\.[^/.]+$/, '') + '.mp3';
    const thumbnailFileName = videoFileName.replace(/\.[^/.]+$/, '') + '_thumbnail.jpg';

    const videoDestPath = path.join(uploadsDir, videoFileName);
    const mp3DestPath = path.join(uploadsDir, mp3FileName);
    const thumbnailDestPath = path.join(uploadsDir, thumbnailFileName);

    if (fs.existsSync(videoSrc)) fs.renameSync(videoSrc, videoDestPath);
    if (fs.existsSync(mp3Src)) fs.renameSync(mp3Src, mp3DestPath);
    if (fs.existsSync(thumbnailSrc)) fs.renameSync(thumbnailSrc, thumbnailDestPath);

    const videoUrl = `/uploads/${videoFileName}`;
    const mp3Url = `/uploads/${mp3FileName}`;
    const thumbnailUrl = fs.existsSync(thumbnailDestPath) ? `/uploads/${thumbnailFileName}` : null;

    const fresh = await Transcript.findById(transcriptId);
    await Transcript.findByIdAndUpdate(transcriptId, {
        videoUrl,
        mp3Url,
        thumbnailUrl,
        duration: fresh?.duration ?? null,
        failureReason: null,
        failedAt: null,
    });

    logVideoProcessing(transcriptId, 'running', 'Files persisted to uploads/', { jobType, videoUrl, mp3Url });
}

async function runTranscribe({ transcriptId, jobType, transcript }) {
    await assertTranscriptNotCancelled(transcriptId, jobType);
    const mp3Path = resolveLocalUploadPath(transcript.mp3Url);
    if (!mp3Path || !fs.existsSync(mp3Path)) {
        throw new Error('MP3 file not found on disk. Cannot transcribe.');
    }

    const { transcript: transcriptContent, model: resolvedModel } = await transcribeAudioFile({
        mp3Path,
        transcriptId,
        jobType,
        logLabel: `Pipeline transcription for ${transcriptId}`,
        onPhaseChange: (phase, message, extra = {}) => markTranscriptPhase(transcriptId, jobType, phase, message, extra),
    });

    await assertTranscriptNotCancelled(transcriptId, jobType);
    await Transcript.findByIdAndUpdate(transcriptId, {
        transcript: transcriptContent,
        failureReason: null,
        failedAt: null,
    });

    logVideoProcessing(transcriptId, 'running', 'Transcription completed', {
        jobType,
        model: resolvedModel,
        wordCount: Array.isArray(transcriptContent) ? transcriptContent.length : null,
    });
}

async function runAnalyze({ transcriptId, jobType }) {
    await markTranscriptPhase(transcriptId, jobType, 'analyze', 'Analyzing transcript for clips.', {});
    await assertTranscriptNotCancelled(transcriptId, jobType);

    const transcript = await Transcript.findById(transcriptId);
    if (!transcript || !Array.isArray(transcript.transcript) || transcript.transcript.length === 0) {
        logVideoProcessing(transcriptId, 'warning', 'No transcript content to analyze', { jobType });
        return;
    }

    await analyzeTranscriptForClips(transcript);
    logVideoProcessing(transcriptId, 'running', 'Clip analysis completed', { jobType });
}

function rankClipIndexes(clips) {
    return clips
        .map((clip, index) => ({
            index,
            rank: Number.isFinite(Number(clip.rank)) ? Number(clip.rank) : index + 1,
            score: Number.isFinite(Number(clip.viralityScore)) ? Number(clip.viralityScore) : 0,
        }))
        .sort((a, b) => (a.rank - b.rank) || (b.score - a.score) || (a.index - b.index))
        .map(entry => entry.index);
}

async function runClips({ transcriptId, jobType }) {
    await markTranscriptPhase(transcriptId, jobType, 'clips', 'Generating clips.', {});
    await assertTranscriptNotCancelled(transcriptId, jobType);

    const transcript = await Transcript.findById(transcriptId);
    const clips = normalizeTranscriptClips(transcript);
    const indexes = rankClipIndexes(clips).filter(index => {
        const clip = clips[index];
        const active = Boolean(clip.generation && ['queued', 'running', 'cancelling'].includes(clip.generation.status));
        return !active && !getPrimaryClipVideo(clip);
    });

    if (indexes.length === 0) {
        // Nothing to generate — complete inline so the pipeline finishes normally.
        await completeTranscriptJob(transcriptId, jobType, 'No clips to generate.');
        logVideoProcessing(transcriptId, 'completed', 'Clips stage: no clips to generate', { jobType });
        return;
    }

    // Enqueue one BullMQ job per clip and return immediately.
    // maybeFinalizeTranscriptClips() in pipeline.js will complete the transcript
    // once all pipeline clip jobs reach a terminal state.
    for (const clipIndex of indexes) {
        await updateClipGeneration(transcriptId, clipIndex, {
            ...createJobState({ status: 'queued', phase: 'prepare', progressMessage: 'Clip generation queued automatically.' }),
            origin: 'pipeline',
        });
        await enqueueClipGenerate({ transcriptId, clipIndex, origin: 'pipeline' });
    }

    logVideoProcessing(transcriptId, 'running', `Enqueued ${indexes.length} clip job(s)`, { jobType });
    // Return DEFERRED sentinel — executeStage must NOT call enqueueNextStage / completeTranscriptJob.
    return DEFERRED;
}

// Returned by a stage run() to tell executeStage not to auto-chain to the next stage.
// Used by 'clips' which self-finalizes asynchronously via maybeFinalizeTranscriptClips.
const DEFERRED = Symbol('DEFERRED');

// ─── Stage registry ───────────────────────────────────────────────────────────

/**
 * PIPELINE_STAGES — ordered list of all pipeline stages.
 *
 * To add a stage: insert a descriptor here and implement run/isComplete.
 * The driver in pipeline.js reads this list and handles everything else.
 */
const PIPELINE_STAGES = [
    // ── Network lane (IO-bound, no heavy CPU) ──────────────────────────────
    {
        name: 'extract-metadata',
        lane: 'network',
        run: runExtractMetadata,
        isComplete: t => !!t.platform && t.originalFilename !== 'Importing video...',
        skip: (t, jobType) => jobType === 'upload',
    },
    {
        name: 'download-video',
        lane: 'network',
        run: runDownloadVideo,
        isComplete: (t, jobType) => !!t.videoUrl || (jobType !== 'upload' && fs.existsSync(importsVideoPath(t._id))),
        skip: (t, jobType) => jobType === 'upload',
    },

    // ── Media lane (CPU-bound: ffmpeg, file ops) ───────────────────────────
    {
        name: 'probe-duration',
        lane: 'media',
        run: runProbeDuration,
        isComplete: t => t.duration !== null && t.duration !== undefined,
        skip: (t, jobType) => jobType !== 'upload',
        optional: true, // failure logged but not re-thrown
    },
    {
        name: 'thumbnail',
        lane: 'media',
        run: runThumbnail,
        isComplete: () => false, // always attempt; fast and idempotent
        optional: true,
    },
    {
        name: 'convert-mp3',
        lane: 'media',
        run: runConvertMp3,
        isComplete: (t, jobType) => !!t.mp3Url || mp3FileExists(t, jobType),
    },
    {
        name: 'persist-files',
        lane: 'media',
        run: runPersistFiles,
        isComplete: t => !!t.videoUrl && !!t.mp3Url,
    },

    // ── Media lane: faster-whisper is CPU-bound, same cap as ffmpeg ──────────
    {
        name: 'transcribe',
        lane: 'media',
        run: runTranscribe,
        isComplete: t => Array.isArray(t.transcript) && t.transcript.length > 0,
    },

    // ── Transcribe lane: Gemini analyze call (network/LLM, not CPU) ───────
    {
        name: 'analyze',
        lane: 'transcribe',
        run: runAnalyze,
        isComplete: t => !!t.analysisMetadata,
    },

    // ── Media lane continued ───────────────────────────────────────────────
    {
        name: 'clips',
        lane: 'media',
        run: runClips,
        isComplete: clipsAllGenerated,
        // run() returns DEFERRED when it enqueues per-clip jobs; executeStage
        // must not auto-chain or call completeTranscriptJob in that case.
        selfFinalizing: true,
    },

    // ── Future stages go here ──────────────────────────────────────────────
    // Example: reframing, caption burning, social media publishing.
    // Insert a descriptor above this comment. No other changes needed.
];

module.exports = {
    DEFERRED,
    PIPELINE_STAGES,
    clipsAllTerminal,
    importsVideoPath,
    importsMp3Path,
    importsThumbnailPath,
    uploadTempVideoPath,
};
