const { exec, execFile } = require('child_process');
const path = require('path');
const Transcript = require('../models/Transcript');
const logger = require('./logger');

const activeTranscriptJobs = new Map();
const activeClipJobs = new Map();
const activeClipRenderJobs = new Map();

function makeCancelledError(message = 'Processing cancelled.') {
    const error = new Error(message);
    error.code = 'JOB_CANCELLED';
    return error;
}

function makeStaleResourceError(message = 'Resource no longer exists.') {
    const error = new Error(message);
    error.code = 'STALE_RESOURCE';
    return error;
}

function isNonRetryableQueueError(error) {
    return ['JOB_CANCELLED', 'STALE_RESOURCE'].includes(error?.code);
}

function buildTranscriptionPrompt() {
    return "Transcribe this audio with word-level timestamps. All timestamps must be relative to the start of this audio — the first sample is 00:00:000. " +
        "Return a JSON array of objects, each with 'start' (MM:SS:mmm), 'end' (MM:SS:mmm), and 'text' (one word). " +
        "Example: [{'start':'00:00:000','end':'00:00:450','text':'Hello'}, {'start':'00:00:450','end':'00:00:890','text':'world'}]";
}

const TRANSCRIPTION_PROMPT = buildTranscriptionPrompt();
const TRANSCRIPTION_SCHEMA = {
    type: 'ARRAY',
    items: {
        type: 'OBJECT',
        properties: {
            start: { type: 'STRING' },
            end:   { type: 'STRING' },
            text:  { type: 'STRING' },
        },
        required: ['start', 'end', 'text'],
        propertyOrdering: ['start', 'end', 'text'],
    },
};

function nowIso() {
    return new Date().toISOString();
}

function createJobState({ status = 'queued', phase, progressMessage, error = null, errorCode = null } = {}) {
    const now = nowIso();
    return {
        status,
        phase,
        progressMessage: progressMessage || phase || status,
        startedAt: now,
        updatedAt: now,
        completedAt: null,
        cancelRequestedAt: null,
        cancelledAt: null,
        error,
        errorCode,
    };
}

function transcriptStatusForPhase(phase, fallback = 'uploading') {
    if (['extract-metadata', 'download-video'].includes(phase)) return 'downloading';
    if (['probe-duration', 'convert-mp3', 'persist-files', 'thumbnail'].includes(phase)) return 'converting';
    if (['upload-gemini', 'transcribe', 'resolve-mp3', 'probe-audio-duration', 'split-audio', 'merge-transcript'].includes(phase)) return 'transcribing';
    if (phase === 'analyze') return 'analyzing';
    if (phase === 'clips') return 'generating';
    if (phase === 'completed') return 'completed';
    return fallback;
}

function logVideoProcessing(transcriptId, status, message, metadata = {}) {
    logger.logVideoProcessing(transcriptId, status, message, metadata);
}

async function updateTranscriptJob(transcriptId, updates = {}, metadata = {}) {
    const transcript = await Transcript.findById(transcriptId);
    if (!transcript) return null;

    const previousJob = transcript.processingJob || createJobState();
    const processingJob = {
        ...previousJob,
        ...updates,
        updatedAt: nowIso(),
    };

    const payload = {
        processingJob,
    };

    if (updates.phase || updates.status) {
        if (processingJob.status === 'completed') {
            payload.status = 'completed';
        } else if (processingJob.status === 'failed') {
            payload.status = 'failed';
        } else if (processingJob.status === 'cancelled') {
            payload.status = 'cancelled';
        } else {
            payload.status = transcriptStatusForPhase(processingJob.phase, transcript.status || 'uploading');
        }
    }

    const updatedTranscript = await Transcript.findByIdAndUpdate(transcriptId, payload);
    logVideoProcessing(transcriptId, processingJob.status, processingJob.progressMessage || processingJob.phase, {
        jobType: metadata.jobType,
        phase: processingJob.phase,
        ...metadata,
    });

    return updatedTranscript;
}

async function markTranscriptPhase(transcriptId, jobType, phase, progressMessage, extra = {}) {
    return updateTranscriptJob(transcriptId, {
        status: 'running',
        phase,
        progressMessage,
        error: null,
        errorCode: null,
    }, {
        jobType,
        phase,
        ...extra,
    });
}

async function completeTranscriptJob(transcriptId, jobType, progressMessage = 'Processing completed.') {
    return updateTranscriptJob(transcriptId, {
        status: 'completed',
        phase: 'completed',
        progressMessage,
        completedAt: nowIso(),
        error: null,
        errorCode: null,
    }, { jobType, phase: 'completed' });
}

async function failTranscriptJob(transcriptId, jobType, error, progressMessage = 'Processing failed.') {
    const message = error?.publicMessage || error?.message || String(error);
    const errorCode = error?.publicCode || error?.code || null;
    const updated = await updateTranscriptJob(transcriptId, {
        status: 'failed',
        progressMessage,
        completedAt: nowIso(),
        error: message,
        errorCode,
    }, { jobType, error: message, errorCode });
    const current = await Transcript.findById(transcriptId);
    if (current && !current.failureReason) {
        await Transcript.findByIdAndUpdate(transcriptId, {
            failureReason: message,
            failedAt: nowIso(),
        });
    }
    return updated;
}

async function isTranscriptCancelRequested(transcriptId) {
    const transcript = await Transcript.findById(transcriptId);
    return Boolean(transcript?.processingJob?.cancelRequestedAt);
}

async function assertTranscriptNotCancelled(transcriptId, jobType) {
    if (await isTranscriptCancelRequested(transcriptId)) {
        logVideoProcessing(transcriptId, 'cancelled', 'Transcript processing cancelled before next phase', { jobType });
        throw makeCancelledError('Processing cancelled.');
    }
}

async function requestTranscriptCancel(transcriptId) {
    const job = activeTranscriptJobs.get(transcriptId);
    if (job?.abortController && !job.abortController.signal.aborted) {
        job.abortController.abort();
    }
    if (job?.child && !job.child.killed) {
        job.child.kill('SIGTERM');
        logVideoProcessing(transcriptId, 'cancelling', 'Cancellation requested; stopped active subprocess', {
            jobType: job.jobType,
            phase: job.phase,
            childPid: job.child.pid,
        });
    }

    return updateTranscriptJob(transcriptId, {
        status: 'cancelling',
        progressMessage: 'Cancellation requested. Waiting for the current step to stop.',
        cancelRequestedAt: nowIso(),
    }, { jobType: job?.jobType || 'transcript-processing' });
}

async function finalizeTranscriptCancelled(transcriptId, jobType) {
    const updated = await updateTranscriptJob(transcriptId, {
        status: 'cancelled',
        progressMessage: 'Processing cancelled.',
        cancelledAt: nowIso(),
        completedAt: nowIso(),
        error: null,
        errorCode: null,
    }, { jobType });
    return Transcript.findByIdAndUpdate(transcriptId, {
        failureReason: null,
        failedAt: null,
        processingJob: updated?.processingJob,
        status: updated?.status,
    });
}

function getActiveTranscriptJob(transcriptId) {
    return activeTranscriptJobs.get(transcriptId) || null;
}

function getActiveClipJob(transcriptId, clipIndex) {
    return activeClipJobs.get(`${transcriptId}:${clipIndex}`) || null;
}

function getActiveClipRenderJob(transcriptId, clipIndex) {
    return activeClipRenderJobs.get(`render:${transcriptId}:${clipIndex}`) || null;
}

function hasActiveTranscriptWork(transcriptId) {
    return activeTranscriptJobs.has(transcriptId)
        || [...activeClipJobs.keys()].some(key => key.startsWith(`${transcriptId}:`))
        || [...activeClipRenderJobs.keys()].some(key => key.startsWith(`render:${transcriptId}:`));
}

function hasActiveClipWork(transcriptId, clipIndex) {
    return activeClipJobs.has(`${transcriptId}:${clipIndex}`)
        || activeClipRenderJobs.has(`render:${transcriptId}:${clipIndex}`);
}

function stopActiveTranscriptWork(transcriptId) {
    const stopped = [];
    const transcriptJob = activeTranscriptJobs.get(transcriptId);
    if (transcriptJob) {
        stopActiveEntry(transcriptJob);
        stopped.push({ type: 'transcript', phase: transcriptJob.phase });
    }

    for (const [key, job] of activeClipJobs.entries()) {
        if (!key.startsWith(`${transcriptId}:`)) continue;
        stopActiveEntry(job);
        stopped.push({ type: 'clip-generate', clipIndex: job.clipIndex, phase: job.phase });
    }

    for (const [key, job] of activeClipRenderJobs.entries()) {
        if (!key.startsWith(`render:${transcriptId}:`)) continue;
        stopActiveEntry(job);
        stopped.push({ type: 'clip-render', clipIndex: job.clipIndex, phase: job.phase || job.kind });
    }

    return stopped;
}

function stopActiveClipWork(transcriptId, clipIndex) {
    const stopped = [];
    const clipJob = activeClipJobs.get(`${transcriptId}:${clipIndex}`);
    if (clipJob) {
        stopActiveEntry(clipJob);
        stopped.push({ type: 'clip-generate', clipIndex, phase: clipJob.phase });
    }

    const renderJob = activeClipRenderJobs.get(`render:${transcriptId}:${clipIndex}`);
    if (renderJob) {
        stopActiveEntry(renderJob);
        stopped.push({ type: 'clip-render', clipIndex, phase: renderJob.phase || renderJob.kind });
    }

    return stopped;
}

function stopActiveEntry(job) {
    if (job?.abortController && !job.abortController.signal.aborted) {
        job.abortController.abort();
    }
    if (job?.child && !job.child.killed) {
        job.child.kill('SIGTERM');
    }
    if (job?.ffmpegCommand) {
        try { job.ffmpegCommand.kill('SIGTERM'); } catch {}
    }
}

function ensureActiveAbortController(transcriptId, clipIndex) {
    const isClip = Number.isInteger(clipIndex);
    const key = isClip ? `${transcriptId}:${clipIndex}` : transcriptId;
    const activeMap = isClip ? activeClipJobs : activeTranscriptJobs;
    const job = activeMap.get(key);
    if (!job) return null;
    if (!job.abortController) {
        job.abortController = new AbortController();
    }
    return job.abortController;
}

function setActiveClipRenderCommand(transcriptId, clipIndex, ffmpegCommand) {
    const key = `render:${transcriptId}:${clipIndex}`;
    const job = activeClipRenderJobs.get(key);
    if (job) {
        job.ffmpegCommand = ffmpegCommand || null;
    }
}

function runTrackedCommand({ transcriptId, clipIndex, jobType, phase, command, options = {} }) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        logVideoProcessing(transcriptId, 'running', 'Subprocess started', {
            jobType,
            phase,
            clipIndex,
            command,
        });

        const child = exec(command, options, (error, stdout, stderr) => {
            const duration = Date.now() - startedAt;
            const activeMap = Number.isInteger(clipIndex) ? activeClipJobs : activeTranscriptJobs;
            const key = Number.isInteger(clipIndex) ? `${transcriptId}:${clipIndex}` : transcriptId;
            const active = activeMap.get(key);
            if (active?.child === child) {
                active.child = null;
            }

            if (error) {
                error.stderr = stderr;
                logVideoProcessing(transcriptId, 'failed', 'Subprocess failed', {
                    jobType,
                    phase,
                    clipIndex,
                    duration,
                    exitCode: error.code,
                    signal: error.signal,
                    stderr: stderr?.slice?.(0, 2000),
                });
                reject(error);
                return;
            }

            logVideoProcessing(transcriptId, 'completed', 'Subprocess completed', {
                jobType,
                phase,
                clipIndex,
                duration,
            });
            resolve({ stdout, stderr, duration });
        });

        const activeMap = Number.isInteger(clipIndex) ? activeClipJobs : activeTranscriptJobs;
        const key = Number.isInteger(clipIndex) ? `${transcriptId}:${clipIndex}` : transcriptId;
        activeMap.set(key, {
            ...(activeMap.get(key) || {}),
            transcriptId,
            clipIndex,
            jobType,
            phase,
            child,
        });
    });
}

function runTrackedFile({ transcriptId, jobType, phase, file, args, options = {} }) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        logVideoProcessing(transcriptId, 'running', 'Subprocess started', {
            jobType,
            phase,
            command: `${file} ${args.join(' ')}`,
        });

        const child = execFile(file, args, options, (error, stdout, stderr) => {
            const duration = Date.now() - startedAt;
            const active = activeTranscriptJobs.get(transcriptId);
            if (active?.child === child) {
                active.child = null;
            }

            if (error) {
                error.stderr = stderr;
                logVideoProcessing(transcriptId, 'failed', 'Subprocess failed', {
                    jobType,
                    phase,
                    duration,
                    exitCode: error.code,
                    signal: error.signal,
                    stderr: stderr?.slice?.(0, 2000),
                });
                reject(error);
                return;
            }

            logVideoProcessing(transcriptId, 'completed', 'Subprocess completed', {
                jobType,
                phase,
                duration,
            });
            resolve({ stdout, stderr, duration });
        });

        activeTranscriptJobs.set(transcriptId, {
            ...(activeTranscriptJobs.get(transcriptId) || {}),
            transcriptId,
            jobType,
            phase,
            child,
        });
    });
}

function startTranscriptWorker(transcriptId, jobType, worker) {
    if (activeTranscriptJobs.has(transcriptId)) return false;
    activeTranscriptJobs.set(transcriptId, { transcriptId, jobType, child: null });

    setImmediate(async () => {
        try {
            await worker();
        } catch (error) {
            if (error?.code === 'JOB_CANCELLED' || await isTranscriptCancelRequested(transcriptId)) {
                await finalizeTranscriptCancelled(transcriptId, jobType);
            } else {
                await failTranscriptJob(transcriptId, jobType, error);
            }
        } finally {
            activeTranscriptJobs.delete(transcriptId);
        }
    });

    return true;
}

async function updateClipGeneration(transcriptId, clipIndex, updates = {}, metadata = {}) {
    const transcript = await Transcript.findById(transcriptId);
    if (!transcript || !Array.isArray(transcript.clips) || !transcript.clips[clipIndex]) return null;

    const clips = transcript.clips.map((clip, index) => {
        if (index !== clipIndex) return clip;
        const previous = clip.generation || createJobState({ status: 'idle', phase: 'prepare' });
        return {
            ...clip,
            generation: {
                ...previous,
                ...updates,
                updatedAt: nowIso(),
            },
        };
    });

    const updatedTranscript = await Transcript.findByIdAndUpdate(transcriptId, { clips });
    const generation = updatedTranscript?.clips?.[clipIndex]?.generation;
    logVideoProcessing(transcriptId, generation?.status || updates.status || 'running', generation?.progressMessage || updates.phase || 'Clip generation update', {
        jobType: 'clip-generation',
        clipIndex,
        phase: generation?.phase || updates.phase,
        ...metadata,
    });

    return updatedTranscript;
}

async function markClipPhase(transcriptId, clipIndex, phase, progressMessage, extra = {}) {
    return updateClipGeneration(transcriptId, clipIndex, {
        status: 'running',
        phase,
        progressMessage,
        error: null,
    }, extra);
}

async function requestClipCancel(transcriptId, clipIndex) {
    const key = `${transcriptId}:${clipIndex}`;
    const job = activeClipJobs.get(key);
    if (job?.abortController && !job.abortController.signal.aborted) {
        job.abortController.abort();
    }
    if (job?.child && !job.child.killed) {
        job.child.kill('SIGTERM');
    }

    return updateClipGeneration(transcriptId, clipIndex, {
        status: 'cancelling',
        progressMessage: 'Cancellation requested. Waiting for the current step to stop.',
        cancelRequestedAt: nowIso(),
    }, {
        phase: job?.phase,
    });
}

async function isClipCancelRequested(transcriptId, clipIndex) {
    const transcript = await Transcript.findById(transcriptId);
    return Boolean(transcript?.clips?.[clipIndex]?.generation?.cancelRequestedAt);
}

async function assertClipNotCancelled(transcriptId, clipIndex) {
    if (await isClipCancelRequested(transcriptId, clipIndex)) {
        throw makeCancelledError('Clip generation cancelled.');
    }
}

async function finalizeClipCancelled(transcriptId, clipIndex) {
    return updateClipGeneration(transcriptId, clipIndex, {
        status: 'cancelled',
        progressMessage: 'Clip generation cancelled.',
        cancelledAt: nowIso(),
        completedAt: nowIso(),
        error: null,
    });
}

async function failClipGeneration(transcriptId, clipIndex, error) {
    return updateClipGeneration(transcriptId, clipIndex, {
        status: 'failed',
        progressMessage: 'Clip generation failed.',
        completedAt: nowIso(),
        error: error?.message || String(error),
    });
}

async function completeClipGeneration(transcriptId, clipIndex, activeOutputUrl) {
    return updateClipGeneration(transcriptId, clipIndex, {
        status: 'completed',
        phase: 'completed',
        progressMessage: 'Clip generation completed.',
        completedAt: nowIso(),
        activeOutputUrl,
        error: null,
    });
}

function startClipWorker(transcriptId, clipIndex, worker) {
    const key = `${transcriptId}:${clipIndex}`;
    if (activeClipJobs.has(key)) return false;
    activeClipJobs.set(key, { transcriptId, clipIndex, jobType: 'clip-generation', child: null });

    setImmediate(async () => {
        try {
            await worker();
        } catch (error) {
            if (error?.code === 'JOB_CANCELLED' || await isClipCancelRequested(transcriptId, clipIndex)) {
                await finalizeClipCancelled(transcriptId, clipIndex);
            } else {
                await failClipGeneration(transcriptId, clipIndex, error);
            }
        } finally {
            activeClipJobs.delete(key);
        }
    });

    return true;
}

async function updateClipActiveJob(transcriptId, clipIndex, updates = {}) {
    const transcript = await Transcript.findById(transcriptId);
    if (!transcript || !Array.isArray(transcript.clips) || !transcript.clips[clipIndex]) return null;

    const clips = transcript.clips.map((clip, index) => {
        if (index !== clipIndex) return clip;
        return {
            ...clip,
            activeJob: {
                ...(clip.activeJob || {}),
                ...updates,
                updatedAt: nowIso(),
            },
        };
    });

    return Transcript.findByIdAndUpdate(transcriptId, { clips });
}

function startClipRenderWorker(transcriptId, clipIndex, jobType, worker) {
    const key = `render:${transcriptId}:${clipIndex}`;
    if (activeClipRenderJobs.has(key)) return false;
    activeClipRenderJobs.set(key, { transcriptId, clipIndex, jobType });

    setImmediate(async () => {
        try {
            await worker();
        } catch (error) {
            await updateClipActiveJob(transcriptId, clipIndex, {
                status: 'failed',
                progressMessage: 'Render failed.',
                completedAt: nowIso(),
                error: error?.message || String(error),
            }).catch(() => {});
        } finally {
            activeClipRenderJobs.delete(key);
        }
    });

    return true;
}

function resolveLocalUploadPath(mediaUrl) {
    if (!mediaUrl || typeof mediaUrl !== 'string') return null;
    const normalized = mediaUrl.replace(/^\/+/, '');
    const candidates = [
        path.resolve(process.cwd(), normalized),
        path.resolve(__dirname, '..', '..', normalized),
    ];
    return candidates.find((candidate) => require('fs').existsSync(candidate)) || candidates[0];
}

module.exports = {
    buildTranscriptionPrompt,
    TRANSCRIPTION_PROMPT,
    TRANSCRIPTION_SCHEMA,
    activeClipJobs,
    activeClipRenderJobs,
    activeTranscriptJobs,
    ensureActiveAbortController,
    getActiveClipJob,
    getActiveClipRenderJob,
    getActiveTranscriptJob,
    hasActiveClipWork,
    hasActiveTranscriptWork,
    isNonRetryableQueueError,
    makeCancelledError,
    makeStaleResourceError,
    startClipRenderWorker,
    updateClipActiveJob,
    assertClipNotCancelled,
    assertTranscriptNotCancelled,
    completeClipGeneration,
    completeTranscriptJob,
    createJobState,
    failClipGeneration,
    failTranscriptJob,
    finalizeClipCancelled,
    finalizeTranscriptCancelled,
    isTranscriptCancelRequested,
    logVideoProcessing,
    markClipPhase,
    markTranscriptPhase,
    nowIso,
    requestClipCancel,
    requestTranscriptCancel,
    resolveLocalUploadPath,
    runTrackedCommand,
    runTrackedFile,
    setActiveClipRenderCommand,
    stopActiveClipWork,
    stopActiveTranscriptWork,
    startClipWorker,
    startTranscriptWorker,
    updateClipGeneration,
    updateTranscriptJob,
};
