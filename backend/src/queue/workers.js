/**
 * BullMQ lane workers.
 * Call startPipelineWorkers() once at server startup.
 * Returns the worker instances (useful for graceful shutdown).
 *
 * The 'pipeline-media' worker is a dispatcher keyed on job.data.type:
 *   type:'stage'         → executeStage (pipeline transcript stages)
 *   type:'clip-generate' → generateSingleClipInBackground + maybeFinalizeTranscriptClips
 *   type:'clip-render'   → runReframeRender / runCaptionRender
 */

const { Worker, UnrecoverableError } = require('bullmq');
const connection = require('./connection');
const { executeStage, handleStageTerminalFailure, maybeFinalizeTranscriptClips } = require('./pipeline');
const { runReframeRender, runCaptionRender } = require('./renderJobs');
const { PRIORITY_PIPELINE_STAGE } = require('./clipJobs');
const { generateSingleClipInBackground } = require('../utils/clipGeneration');
const Transcript = require('../models/Transcript');
const {
    activeClipRenderJobs,
    activeClipJobs,
    activeTranscriptJobs,
    failClipGeneration,
    finalizeClipCancelled,
    isNonRetryableQueueError,
    makeStaleResourceError,
    nowIso,
    updateClipActiveJob,
    updateClipGeneration,
} = require('../utils/backgroundJobs');
const { toUnrecoverableIfNonRetryable } = require('./cancellation');
const logger = require('../utils/logger');

// Stages where YOUTUBE_AUTH_REQUIRED should not be retried — retrying when the IP is
// blocked is pointless and wastes queue capacity.
const IMPORT_STAGES = new Set(['extract-metadata', 'download-video']);

function isYouTubeAuthChallengeError(error, stageName) {
    if (!IMPORT_STAGES.has(stageName)) return false;
    const text = `${error?.stderr || ''}\n${error?.message || ''}`.toLowerCase();
    return text.includes('sign in to confirm') || text.includes('not a bot') || text.includes('--cookies');
}

const NETWORK_CONCURRENCY = parseInt(process.env.PIPELINE_NETWORK_CONCURRENCY || '3', 10);
const TRANSCRIBE_CONCURRENCY = parseInt(process.env.PIPELINE_TRANSCRIBE_CONCURRENCY || '2', 10);
const MEDIA_CONCURRENCY = parseInt(process.env.PIPELINE_MEDIA_CONCURRENCY || '2', 10);

// ─── Clip-generate handler ────────────────────────────────────────────────────

async function handleClipGenerateJob(job) {
    const { transcriptId, clipIndex, origin } = job.data;
    const transcript = await Transcript.findById(transcriptId);
    if (!transcript) {
        throw makeStaleResourceError(`Transcript not found: ${transcriptId}`);
    }
    if (!transcript.clips?.[clipIndex]) {
        throw makeStaleResourceError(`Clip not found: ${transcriptId}:${clipIndex}`);
    }

    await updateClipGeneration(transcriptId, clipIndex, {
        status: 'running',
        phase: 'prepare',
        progressMessage: 'Clip generation starting.',
        startedAt: nowIso(),
    });

    await generateSingleClipInBackground(transcriptId, clipIndex);

    if (origin === 'pipeline') {
        await maybeFinalizeTranscriptClips(transcriptId).catch(err =>
            logger.error('maybeFinalizeTranscriptClips error', { transcriptId, error: err.message })
        );
    }
}

// ─── Clip-render handler ──────────────────────────────────────────────────────

async function handleClipRenderJob(job) {
    const { transcriptId, clipIndex, kind, payload } = job.data;
    const transcript = await Transcript.findById(transcriptId);
    if (!transcript) {
        throw makeStaleResourceError(`Transcript not found: ${transcriptId}`);
    }
    if (!transcript.clips?.[clipIndex]) {
        throw makeStaleResourceError(`Clip not found: ${transcriptId}:${clipIndex}`);
    }
    const renderKey = `render:${transcriptId}:${clipIndex}`;

    activeClipRenderJobs.set(renderKey, { transcriptId, clipIndex, kind });
    try {
        if (kind === 'reframe') {
            await runReframeRender(payload);
        } else if (kind === 'caption') {
            await runCaptionRender(payload);
        } else {
            throw new Error(`Unknown render kind: ${kind}`);
        }
    } finally {
        activeClipRenderJobs.delete(renderKey);
    }
}

// ─── Lane worker factory ──────────────────────────────────────────────────────

function createNetworkOrTranscribeWorker(queueName, concurrency) {
    const worker = new Worker(
        queueName,
        async (job) => {
            const { transcriptId, jobType, stageName } = job.data;
            logger.info(`Pipeline worker: running stage ${stageName} for ${transcriptId}`, { jobType, attemptsMade: job.attemptsMade });
            activeTranscriptJobs.set(transcriptId, { transcriptId, jobType, phase: stageName, child: null });
            try {
                await executeStage({ transcriptId, jobType, stageName });
            } catch (error) {
                if (isYouTubeAuthChallengeError(error, stageName)) {
                    // IP-level block — retrying immediately won't help; fail fast.
                    await handleStageTerminalFailure(transcriptId, jobType, stageName, error).catch(() => {});
                    throw new UnrecoverableError(error.message);
                }
                throw toUnrecoverableIfNonRetryable(error);
            } finally {
                activeTranscriptJobs.delete(transcriptId);
            }
        },
        { connection, concurrency }
    );

    worker.on('completed', (job) => {
        const { transcriptId, stageName } = job.data;
        logger.info(`Pipeline stage completed: ${stageName} for ${transcriptId}`);
    });

    worker.on('failed', async (job, err) => {
        if (!job) return;
        const { transcriptId, jobType, stageName } = job.data;
        if (isNonRetryableQueueError(err)) {
            logger.info(`Pipeline stage stopped without retry: ${stageName} for ${transcriptId}`, { jobType, code: err.code });
            return;
        }
        const attemptsLeft = (job.opts?.attempts ?? 1) - (job.attemptsMade ?? 1);

        if (attemptsLeft > 0) {
            logger.warn(`Pipeline stage ${stageName} attempt failed, will retry`, {
                transcriptId, attemptsMade: job.attemptsMade, attemptsLeft, error: err.message,
            });
            return;
        }

        logger.error(`Pipeline stage ${stageName} exhausted all retries for ${transcriptId}`, { jobType, error: err.message });
        await handleStageTerminalFailure(transcriptId, jobType, stageName, err);
    });

    worker.on('error', (err) => {
        logger.error(`Pipeline worker error on queue ${queueName}`, { error: err.message });
    });

    return worker;
}

function createMediaWorker(concurrency) {
    const worker = new Worker(
        'pipeline-media',
        async (job) => {
            const { type = 'stage', transcriptId, jobType, stageName, clipIndex, origin } = job.data;

            if (type === 'stage') {
                logger.info(`Pipeline media worker: running stage ${stageName} for ${transcriptId}`, { jobType, attemptsMade: job.attemptsMade });
                activeTranscriptJobs.set(transcriptId, { transcriptId, jobType, phase: stageName, child: null });
                try {
                    await executeStage({ transcriptId, jobType, stageName });
                } catch (error) {
                    throw toUnrecoverableIfNonRetryable(error);
                } finally {
                    activeTranscriptJobs.delete(transcriptId);
                }
            } else if (type === 'clip-generate') {
                logger.info(`Clip-generate worker: clip ${clipIndex} for ${transcriptId}`, { origin, attemptsMade: job.attemptsMade });
                activeClipJobs.set(`${transcriptId}:${clipIndex}`, { transcriptId, clipIndex, jobType: 'clip-generation', phase: 'prepare', child: null });
                try {
                    await handleClipGenerateJob(job);
                } catch (error) {
                    throw toUnrecoverableIfNonRetryable(error);
                } finally {
                    activeClipJobs.delete(`${transcriptId}:${clipIndex}`);
                }
            } else if (type === 'clip-render') {
                logger.info(`Clip-render worker: clip ${clipIndex} for ${transcriptId}`, { kind: job.data.kind, attemptsMade: job.attemptsMade });
                try {
                    await handleClipRenderJob(job);
                } catch (error) {
                    throw toUnrecoverableIfNonRetryable(error);
                }
            } else {
                throw new Error(`Unknown media job type: ${type}`);
            }
        },
        { connection, concurrency }
    );

    worker.on('completed', async (job) => {
        const { type, transcriptId, stageName, clipIndex, origin } = job.data;

        if (type === 'stage') {
            logger.info(`Pipeline stage completed: ${stageName} for ${transcriptId}`);
        } else if (type === 'clip-generate') {
            logger.info(`Clip-generate completed: clip ${clipIndex} for ${transcriptId}`);
            if (origin === 'pipeline') {
                // Already called inside handleClipGenerateJob, but guard here too.
                await maybeFinalizeTranscriptClips(transcriptId).catch(() => {});
            }
        } else if (type === 'clip-render') {
            logger.info(`Clip-render completed: clip ${clipIndex} for ${transcriptId}`);
        }
    });

    worker.on('failed', async (job, err) => {
        if (!job) return;
        const { type, transcriptId, jobType, stageName, clipIndex, origin } = job.data;
        if (isNonRetryableQueueError(err)) {
            logger.info('Media job stopped without retry', { type, transcriptId, clipIndex, stageName, code: err.code });
            if (type === 'clip-generate' && err.code === 'JOB_CANCELLED') {
                await finalizeClipCancelled(transcriptId, clipIndex).catch(() => {});
                if (origin === 'pipeline') {
                    await maybeFinalizeTranscriptClips(transcriptId).catch(() => {});
                }
            }
            if (type === 'clip-render' && err.code === 'JOB_CANCELLED') {
                await updateClipActiveJob(transcriptId, clipIndex, {
                    status: 'cancelled',
                    progressMessage: 'Render cancelled.',
                    completedAt: nowIso(),
                    error: null,
                }).catch(() => {});
            }
            return;
        }
        const attemptsLeft = (job.opts?.attempts ?? 1) - (job.attemptsMade ?? 1);

        if (type === 'clip-generate') {
            if (attemptsLeft > 0) {
                logger.warn('Clip-generate attempt failed, will retry', { transcriptId, clipIndex, attemptsMade: job.attemptsMade, error: err.message });
                return;
            }
            logger.error(`Clip-generate exhausted retries: clip ${clipIndex} for ${transcriptId}`, { error: err.message });
            await failClipGeneration(transcriptId, clipIndex, err).catch(() => {});
            if (origin === 'pipeline') {
                await maybeFinalizeTranscriptClips(transcriptId).catch(() => {});
            }
            return;
        }

        if (type === 'clip-render') {
            if (attemptsLeft > 0) {
                logger.warn('Clip-render attempt failed, will retry', { transcriptId, clipIndex, attemptsMade: job.attemptsMade, error: err.message });
                return;
            }
            logger.error(`Clip-render exhausted retries: clip ${clipIndex} for ${transcriptId}`, { error: err.message });
            await updateClipActiveJob(transcriptId, clipIndex, {
                status: 'failed',
                progressMessage: 'Render failed.',
                completedAt: nowIso(),
                error: err.message,
            }).catch(() => {});
            return;
        }

        // Stage job
        if (attemptsLeft > 0) {
            logger.warn(`Pipeline stage ${stageName} attempt failed, will retry`, {
                transcriptId, attemptsMade: job.attemptsMade, attemptsLeft, error: err.message,
            });
            return;
        }

        logger.error(`Pipeline stage ${stageName} exhausted all retries for ${transcriptId}`, { jobType, error: err.message });
        await handleStageTerminalFailure(transcriptId, jobType, stageName, err);
    });

    worker.on('error', (err) => {
        logger.error('Pipeline media worker error', { error: err.message });
    });

    return worker;
}

function startPipelineWorkers() {
    const networkWorker = createNetworkOrTranscribeWorker('pipeline-network', NETWORK_CONCURRENCY);
    const transcribeWorker = createNetworkOrTranscribeWorker('pipeline-transcribe', TRANSCRIBE_CONCURRENCY);
    const mediaWorker = createMediaWorker(MEDIA_CONCURRENCY);

    logger.info('Pipeline workers started', {
        networkConcurrency: NETWORK_CONCURRENCY,
        transcribeConcurrency: TRANSCRIBE_CONCURRENCY,
        mediaConcurrency: MEDIA_CONCURRENCY,
    });

    return [networkWorker, transcribeWorker, mediaWorker];
}

module.exports = { startPipelineWorkers };
