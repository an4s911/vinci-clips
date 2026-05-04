const { exec, execFile } = require('child_process');
const path = require('path');
const Transcript = require('../models/Transcript');
const logger = require('./logger');

const activeTranscriptJobs = new Map();
const activeClipJobs = new Map();

const TRANSCRIPTION_PROMPT = "Transcribe the provided audio with word-level timestamps and identify the speaker for each word. Format the output as a JSON array of objects, where each object represents a single word with precise millisecond timing. Each object should have 'start' (in format MM:SS:mmm), 'end' (in format MM:SS:mmm), 'text' (single word), and 'speaker' fields. For example: [{'start': '00:00:000', 'end': '00:00:450', 'text': 'Hello', 'speaker': 'Speaker 1'}, {'start': '00:00:450', 'end': '00:00:890', 'text': 'world', 'speaker': 'Speaker 1'}]";
const TRANSCRIPTION_SCHEMA = {
    type: 'ARRAY',
    items: {
        type: 'OBJECT',
        properties: {
            start: { type: 'STRING' },
            end: { type: 'STRING' },
            text: { type: 'STRING' },
            speaker: { type: 'STRING' },
        },
        required: ['start', 'end', 'text', 'speaker'],
        propertyOrdering: ['start', 'end', 'text', 'speaker'],
    },
};

function nowIso() {
    return new Date().toISOString();
}

function createJobState({ status = 'queued', phase, progressMessage, error = null } = {}) {
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
    };
}

function transcriptStatusForPhase(phase, fallback = 'uploading') {
    if (phase === 'convert-mp3' || phase === 'persist-files' || phase === 'thumbnail') return 'converting';
    if (phase === 'upload-gemini' || phase === 'transcribe' || phase === 'resolve-mp3' || phase === 'probe-audio-duration' || phase === 'split-audio' || phase === 'merge-transcript') return 'transcribing';
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
        } else if (processingJob.status === 'failed' || processingJob.status === 'cancelled') {
            payload.status = 'failed';
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
    }, { jobType, phase: 'completed' });
}

async function failTranscriptJob(transcriptId, jobType, error, progressMessage = 'Processing failed.') {
    const message = error?.message || String(error);
    const updated = await updateTranscriptJob(transcriptId, {
        status: 'failed',
        progressMessage,
        completedAt: nowIso(),
        error: message,
    }, { jobType, error: message });
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
        const error = new Error('Processing cancelled.');
        error.code = 'JOB_CANCELLED';
        logVideoProcessing(transcriptId, 'cancelled', 'Transcript processing cancelled before next phase', { jobType });
        throw error;
    }
}

async function requestTranscriptCancel(transcriptId) {
    const job = activeTranscriptJobs.get(transcriptId);
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
    }, { jobType });
    return Transcript.findByIdAndUpdate(transcriptId, {
        failureReason: null,
        failedAt: null,
        processingJob: updated?.processingJob,
        status: updated?.status,
    });
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
        const error = new Error('Clip generation cancelled.');
        error.code = 'JOB_CANCELLED';
        throw error;
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
    TRANSCRIPTION_PROMPT,
    TRANSCRIPTION_SCHEMA,
    activeClipJobs,
    activeTranscriptJobs,
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
    startClipWorker,
    startTranscriptWorker,
    updateClipGeneration,
    updateTranscriptJob,
};
