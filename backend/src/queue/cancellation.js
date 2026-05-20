const { UnrecoverableError } = require('bullmq');
const Transcript = require('../models/Transcript');
const logger = require('../utils/logger');
const {
    finalizeClipCancelled,
    finalizeTranscriptCancelled,
    hasActiveClipWork,
    hasActiveTranscriptWork,
    isNonRetryableQueueError,
    requestClipCancel,
    requestTranscriptCancel,
    stopActiveClipWork,
    stopActiveTranscriptWork,
    updateClipActiveJob,
} = require('../utils/backgroundJobs');
const { PIPELINE_STAGES } = require('./stages');
const { networkQueue, transcribeQueue, mediaQueue } = require('./pipeline');

const PENDING_STATES = ['waiting', 'delayed', 'prioritized', 'waiting-children'];
const LIVE_STATES = ['active', ...PENDING_STATES];
const QUEUE_CANCEL_WAIT_MS = parseInt(process.env.QUEUE_CANCEL_WAIT_MS || '30000', 10);

const QUEUES = [
    { name: 'pipeline-network', queue: networkQueue },
    { name: 'pipeline-transcribe', queue: transcribeQueue },
    { name: 'pipeline-media', queue: mediaQueue },
];

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function stageNames() {
    return new Set(PIPELINE_STAGES.map(stage => stage.name));
}

function matchesJobData(data, { transcriptId, clipIndex, types, renderKind, videoId } = {}) {
    if (!data || String(data.transcriptId) !== String(transcriptId)) return false;
    if (Number.isInteger(clipIndex) && Number(data.clipIndex) !== clipIndex) return false;

    const jobType = data.type || 'stage';
    if (Array.isArray(types) && types.length > 0 && !types.includes(jobType)) return false;
    if (renderKind && data.kind !== renderKind) return false;

    if (videoId) {
        const payload = data.payload || {};
        const targetIds = [
            payload.sourceVideoId,
            payload.videoId,
            payload.sourceVideo?.id,
        ].filter(Boolean).map(String);
        if (!targetIds.includes(String(videoId))) return false;
    }

    return true;
}

async function getQueueJobs(states = LIVE_STATES) {
    const results = await Promise.all(QUEUES.map(async ({ name, queue }) => {
        const jobs = await queue.getJobs(states).catch((error) => {
            logger.warn('Failed to list BullMQ jobs for cancellation', { queue: name, error: error.message });
            return [];
        });
        return jobs.map(job => ({ queueName: name, job }));
    }));
    return results.flat();
}

async function findQueueJobs(filter, states = LIVE_STATES) {
    const jobs = await getQueueJobs(states);
    return jobs.filter(({ job }) => matchesJobData(job?.data, filter));
}

async function removePendingQueueJobs(filter) {
    const jobs = await findQueueJobs(filter, PENDING_STATES);
    let removed = 0;
    const failures = [];

    await Promise.allSettled(jobs.map(async ({ queueName, job }) => {
        try {
            await job.remove();
            removed += 1;
        } catch (error) {
            failures.push({ queueName, jobId: job.id, error: error.message });
        }
    }));

    if (failures.length > 0) {
        logger.warn('Some pending BullMQ jobs could not be removed', { failures });
    }

    return { removed, failures };
}

async function countActiveQueueJobs(filter) {
    const jobs = await findQueueJobs(filter, ['active']);
    return jobs.length;
}

async function waitForStopped(filter, { timeoutMs = QUEUE_CANCEL_WAIT_MS, localActive } = {}) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() <= deadline) {
        const activeQueueJobs = await countActiveQueueJobs(filter);
        const activeLocal = typeof localActive === 'function' ? localActive() : false;
        if (activeQueueJobs === 0 && !activeLocal) {
            return true;
        }
        await sleep(250);
    }

    return false;
}

async function cancelTranscriptQueues(transcriptId, options = {}) {
    const jobType = options.jobType || 'transcript-processing';
    const filter = { transcriptId };

    const removed = await removePendingQueueJobs(filter);
    await requestTranscriptCancel(transcriptId).catch(() => {});
    stopActiveTranscriptWork(transcriptId);

    const stopped = await waitForStopped(filter, {
        timeoutMs: options.timeoutMs,
        localActive: () => hasActiveTranscriptWork(transcriptId),
    });

    if (!stopped) {
        const error = new Error('Active processing did not stop before the cancellation timeout. Try again in a moment.');
        error.status = 409;
        error.code = 'QUEUE_CANCEL_TIMEOUT';
        throw error;
    }

    const transcript = await Transcript.findById(transcriptId);
    if (Array.isArray(transcript?.clips)) {
        await Promise.allSettled(transcript.clips.map(async (clip, clipIndex) => {
            if (clip?.generation && ['queued', 'running', 'cancelling'].includes(clip.generation.status)) {
                await finalizeClipCancelled(transcriptId, clipIndex);
            }
            if (clip?.activeJob && ['queued', 'running', 'cancelling'].includes(clip.activeJob.status)) {
                await updateClipActiveJob(transcriptId, clipIndex, {
                    status: 'cancelled',
                    progressMessage: 'Render cancelled.',
                    completedAt: new Date().toISOString(),
                    error: null,
                });
            }
        }));
    }

    await finalizeTranscriptCancelled(transcriptId, jobType).catch(() => {});
    return removed;
}

async function cancelClipQueues(transcriptId, clipIndex, options = {}) {
    const filter = {
        transcriptId,
        clipIndex,
        types: options.types || ['clip-generate', 'clip-render'],
        ...(options.renderKind ? { renderKind: options.renderKind } : {}),
        ...(options.videoId ? { videoId: options.videoId } : {}),
    };

    const removed = await removePendingQueueJobs(filter);
    if (filter.types.includes('clip-generate')) {
        await requestClipCancel(transcriptId, clipIndex).catch(() => {});
    }
    if (filter.types.includes('clip-render')) {
        await updateClipActiveJob(transcriptId, clipIndex, {
            status: 'cancelling',
            progressMessage: 'Render cancellation requested.',
        }).catch(() => {});
    }
    stopActiveClipWork(transcriptId, clipIndex);

    const stopped = await waitForStopped(filter, {
        timeoutMs: options.timeoutMs,
        localActive: () => hasActiveClipWork(transcriptId, clipIndex),
    });

    if (!stopped) {
        const error = new Error('Active clip work did not stop before the cancellation timeout. Try again in a moment.');
        error.status = 409;
        error.code = 'QUEUE_CANCEL_TIMEOUT';
        throw error;
    }

    if (filter.types.includes('clip-generate')) {
        await finalizeClipCancelled(transcriptId, clipIndex).catch(() => {});
    }
    if (filter.types.includes('clip-render')) {
        await updateClipActiveJob(transcriptId, clipIndex, {
            status: 'cancelled',
            progressMessage: 'Render cancelled.',
            completedAt: new Date().toISOString(),
            error: null,
        }).catch(() => {});
    }

    return removed;
}

function toUnrecoverableIfNonRetryable(error) {
    if (!isNonRetryableQueueError(error)) return error;
    const wrapped = new UnrecoverableError(error.message);
    wrapped.code = error.code;
    return wrapped;
}

async function isTranscriptGoneOrCancelled(transcriptId) {
    const transcript = await Transcript.findById(transcriptId);
    return !transcript || Boolean(transcript.processingJob?.cancelRequestedAt);
}

module.exports = {
    LIVE_STATES,
    PENDING_STATES,
    QUEUE_CANCEL_WAIT_MS,
    cancelClipQueues,
    cancelTranscriptQueues,
    findQueueJobs,
    isTranscriptGoneOrCancelled,
    matchesJobData,
    removePendingQueueJobs,
    stageNames,
    toUnrecoverableIfNonRetryable,
    waitForStopped,
};
