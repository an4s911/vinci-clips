/**
 * Pipeline driver — BullMQ queues, stage chaining, and failure handling.
 *
 * Three lane queues with separate concurrency:
 *   network   - metadata extraction, video download
 *   transcribe - Gemini/LLM transcription
 *   media     - ffmpeg conversion, file ops, clip generation
 *
 * Each BullMQ job carries { transcriptId, jobType, stageName }.
 * On success, the worker enqueues the next applicable stage automatically.
 * On final failure (all attempts exhausted), the transcript is marked failed
 * at the specific stage so the user can "Retry and continue" from that point.
 */

const { Queue } = require('bullmq');
const Transcript = require('../models/Transcript');
const connection = require('./connection');
const { DEFERRED, PIPELINE_STAGES, clipsAllTerminal } = require('./stages');
const {
    assertTranscriptNotCancelled,
    completeTranscriptJob,
    createJobState,
    failTranscriptJob,
    logVideoProcessing,
    markTranscriptPhase,
    nowIso,
} = require('../utils/backgroundJobs');
const { classifyImportFailure, classifyTranscriptionFailure } = require('../utils/failureMessages');
const { getCookieStatus } = require('../services/cookieMonitor');
const logger = require('../utils/logger');

const MAX_STAGE_ATTEMPTS = parseInt(process.env.PIPELINE_STAGE_ATTEMPTS || '3', 10);
const BACKOFF_DELAY_MS = parseInt(process.env.PIPELINE_BACKOFF_MS || '5000', 10);

// ─── Lane queues ─────────────────────────────────────────────────────────────

const networkQueue = new Queue('pipeline-network', { connection });
const transcribeQueue = new Queue('pipeline-transcribe', { connection });
const mediaQueue = new Queue('pipeline-media', { connection });

const LANE_QUEUES = {
    network: networkQueue,
    transcribe: transcribeQueue,
    media: mediaQueue,
};

function queueForLane(lane) {
    return LANE_QUEUES[lane] || mediaQueue;
}

function jobIdForStage(transcriptId, stageName) {
    return `stage:${stageName}:${transcriptId}`;
}

async function removeTerminalJobIfPresent(queue, jobId) {
    const existingJob = await queue.getJob(jobId).catch(() => null);
    if (!existingJob) return;
    const state = await existingJob.getState().catch(() => null);
    if (['completed', 'failed'].includes(state)) {
        await existingJob.remove().catch(() => {});
    }
}

// ─── Stage selection helpers ──────────────────────────────────────────────────

function getApplicableStages(transcript, jobType) {
    return PIPELINE_STAGES.filter(s => !s.skip || !s.skip(transcript, jobType));
}

function getNextApplicableStage(currentStageName, transcript, jobType) {
    const stages = getApplicableStages(transcript, jobType);
    const currentIdx = stages.findIndex(s => s.name === currentStageName);
    if (currentIdx === -1) return null;
    return stages[currentIdx + 1] || null;
}

// ─── Failure classification ───────────────────────────────────────────────────

function classifyStageFailure(stageName, error, transcript) {
    if (stageName === 'transcribe') {
        return classifyTranscriptionFailure(error);
    }
    if (['extract-metadata', 'download-video'].includes(stageName)) {
        const failure = classifyImportFailure(error);
        if (failure.code === 'YOUTUBE_AUTH_REQUIRED' && process.env.YTDLP_COOKIES_PATH) {
            const cookieStatus = getCookieStatus();
            logger.warn('YouTube auth challenge during download', {
                stageName,
                cookieState: cookieStatus.state,
                cookieDaysRemaining: cookieStatus.daysRemaining,
            });
        }
        return failure;
    }
    return {
        code: 'PROCESSING_FAILED',
        message: error.message || 'Processing failed at this stage.',
    };
}

// ─── Core execute ─────────────────────────────────────────────────────────────

/**
 * Executes a single stage. Called by a lane Worker for each BullMQ job.
 * Throws on failure so BullMQ can retry up to MAX_STAGE_ATTEMPTS times.
 */
async function executeStage({ transcriptId, jobType, stageName }) {
    const stage = PIPELINE_STAGES.find(s => s.name === stageName);
    if (!stage) throw new Error(`Unknown pipeline stage: ${stageName}`);

    const transcript = await Transcript.findById(transcriptId);
    if (!transcript) {
        logger.warn(`Skipping stale stage ${stageName}; transcript no longer exists`, { transcriptId, jobType });
        return;
    }

    if (transcript.status === 'failed' && transcript.processingJob?.status === 'failed') {
        // Stale retry of an already-failed job (e.g. leftover from a previous run).
        // Do not re-run unless explicitly re-queued via retry-continue.
        logger.warn(`Skipping stale stage ${stageName} for already-failed transcript ${transcriptId}`);
        return;
    }

    await assertTranscriptNotCancelled(transcriptId, jobType);

    // isComplete uses (transcript, jobType) for stages that need to know the type
    const alreadyDone = typeof stage.isComplete === 'function'
        ? stage.isComplete(transcript, jobType)
        : false;

    if (alreadyDone) {
        logVideoProcessing(transcriptId, 'running', `Stage ${stageName} already complete, skipping`, { jobType });
        await enqueueNextStage(transcriptId, jobType, stageName, transcript);
        return;
    }

    const ctx = { transcriptId, jobType, transcript };

    if (stage.optional) {
        try {
            await stage.run(ctx);
        } catch (err) {
            logVideoProcessing(transcriptId, 'warning', `Optional stage ${stageName} failed, continuing`, {
                jobType, error: err.message,
            });
        }
        await enqueueNextStage(transcriptId, jobType, stageName, transcript);
        return;
    }

    const result = await stage.run(ctx);
    if (result !== DEFERRED) {
        await enqueueNextStage(transcriptId, jobType, stageName, transcript);
    }
}

// ─── Stage chaining ───────────────────────────────────────────────────────────

async function enqueueNextStage(transcriptId, jobType, completedStageName, transcriptHint) {
    const transcript = transcriptHint || await Transcript.findById(transcriptId);
    const nextStage = getNextApplicableStage(completedStageName, transcript, jobType);

    if (!nextStage) {
        // All stages done — mark the transcript completed
        await completeTranscriptJob(transcriptId, jobType, 'All pipeline stages completed.');
        logVideoProcessing(transcriptId, 'completed', 'Pipeline finished', { jobType });
        return;
    }

    const queue = queueForLane(nextStage.lane);
    const jobId = jobIdForStage(transcriptId, nextStage.name);
    await removeTerminalJobIfPresent(queue, jobId);
    await queue.add(
        `${nextStage.name}:${transcriptId}`,
        { transcriptId, jobType, stageName: nextStage.name },
        {
            jobId,
            attempts: MAX_STAGE_ATTEMPTS,
            backoff: { type: 'exponential', delay: BACKOFF_DELAY_MS },
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 100 },
        }
    );
}

// ─── Terminal failure handler (called by worker 'failed' event) ───────────────

async function handleStageTerminalFailure(transcriptId, jobType, stageName, error) {
    try {
        const transcript = await Transcript.findById(transcriptId);
        if (!transcript) {
            logger.warn('Skipping stage failure persistence for deleted transcript', { transcriptId, stageName });
            return;
        }
        if (transcript.processingJob?.cancelRequestedAt || error?.code === 'JOB_CANCELLED') {
            logger.info('Skipping stage failure persistence for cancelled transcript', { transcriptId, stageName });
            return;
        }
        const failure = classifyStageFailure(stageName, error, transcript);

        error.publicCode = failure.code;
        error.publicMessage = failure.message;

        await Transcript.findByIdAndUpdate(transcriptId, {
            status: 'failed',
            failureReason: failure.message,
            failedAt: nowIso(),
            failedStage: stageName,
        });

        await failTranscriptJob(transcriptId, jobType, error, `Failed at stage: ${stageName}`);

        logVideoProcessing(transcriptId, 'failed', `Stage ${stageName} exhausted retries`, {
            jobType,
            stageName,
            errorCode: failure.code,
            errorMessage: failure.message,
        });
    } catch (persistErr) {
        logger.error('Failed to persist stage terminal failure', {
            transcriptId,
            stageName,
            error: persistErr.message,
        });
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Enqueues the pipeline starting from a given stage.
 * Used for initial start (import/upload) and for "Retry and continue".
 *
 * For retry: finds the first not-yet-complete stage at or after `fromStageName`
 * and enqueues it. Stages whose isComplete() returns true are automatically
 * skipped when the worker runs, so retry is always idempotent.
 */
async function enqueuePipeline(transcriptId, jobType, fromStageName) {
    const transcript = await Transcript.findById(transcriptId);
    if (!transcript) throw new Error(`Transcript ${transcriptId} not found`);

    const stages = getApplicableStages(transcript, jobType);
    const fromIdx = stages.findIndex(s => s.name === fromStageName);
    const startIdx = fromIdx === -1 ? 0 : fromIdx;
    const stage = stages[startIdx];

    if (!stage) {
        logger.warn(`enqueuePipeline: no applicable stage found at or after ${fromStageName} for ${transcriptId}`);
        return;
    }

    // Reset failure fields so the transcript shows as processing again
    await Transcript.findByIdAndUpdate(transcriptId, {
        status: 'uploading',
        failedStage: null,
        failureReason: null,
        failedAt: null,
        processingJob: createJobState({
            status: 'queued',
            phase: stage.name,
            progressMessage: `Queued: ${stage.name}`,
        }),
    });

    const queue = queueForLane(stage.lane);
    const jobId = jobIdForStage(transcriptId, stage.name);
    await removeTerminalJobIfPresent(queue, jobId);
    await queue.add(
        `${stage.name}:${transcriptId}`,
        { transcriptId, jobType, stageName: stage.name },
        {
            jobId,
            attempts: MAX_STAGE_ATTEMPTS,
            backoff: { type: 'exponential', delay: BACKOFF_DELAY_MS },
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 100 },
        }
    );

    logVideoProcessing(transcriptId, 'queued', `Pipeline enqueued from stage ${stage.name}`, { jobType });
}

/**
 * Removes any pending (waiting/delayed) BullMQ jobs for a transcript.
 * Called when a user cancels processing.
 */
async function removePipelineJobs(transcriptId) {
    const allStages = PIPELINE_STAGES;
    const removals = allStages.flatMap(stage => {
        const jobId = jobIdForStage(transcriptId, stage.name);
        const queue = queueForLane(stage.lane);
        return [
            queue.remove(jobId).catch(() => {}),
        ];
    });
    await Promise.allSettled(removals);
}

// ─── Transcript finalization after clip jobs ──────────────────────────────────

/**
 * Called after every terminal clip-generate job whose origin === 'pipeline'.
 * If all pipeline clip jobs are done and all clips are in a terminal state,
 * completes (or fails) the transcript.
 */
async function maybeFinalizeTranscriptClips(transcriptId) {
    const transcript = await Transcript.findById(transcriptId);
    if (!transcript) return;

    const pj = transcript.processingJob;
    if (!pj || pj.phase !== 'clips') return;
    if (['completed', 'failed', 'cancelled'].includes(pj.status)) return;

    // Check for pending pipeline clip-generate jobs still in the queue.
    const liveJobs = await mediaQueue.getJobs(['active', 'waiting', 'delayed', 'prioritized', 'waiting-children']).catch(() => []);
    const hasPending = liveJobs.some(job => {
        const d = job?.data;
        return d && d.type === 'clip-generate' && d.transcriptId === transcriptId && d.origin === 'pipeline';
    });
    if (hasPending) return;

    // All pipeline clip jobs are done — check DB state.
    if (!clipsAllTerminal(transcript)) return;

    const clips = transcript.clips || [];
    const anyFailed = clips.some(c => c.generation?.status === 'failed');
    const jobType = transcript.importUrl ? 'import' : 'upload';

    if (anyFailed) {
        const failedCount = clips.filter(c => c.generation?.status === 'failed').length;
        const err = new Error(`${failedCount} clip(s) failed to generate`);
        await handleStageTerminalFailure(transcriptId, jobType, 'clips', err);
    } else {
        await completeTranscriptJob(transcriptId, jobType, 'All clips generated.');
        logVideoProcessing(transcriptId, 'completed', 'Pipeline finished', { jobType });
    }
}

module.exports = {
    executeStage,
    handleStageTerminalFailure,
    enqueuePipeline,
    maybeFinalizeTranscriptClips,
    removePipelineJobs,
    networkQueue,
    transcribeQueue,
    mediaQueue,
};
