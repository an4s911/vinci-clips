/**
 * Queue reconciler — replaces the manual fix-status.js for the "spinner forever,
 * nothing running" case.
 *
 * reconcileQueue() runs once at boot and periodically thereafter.
 * It finds:
 *   1. Transcript orphans — non-terminal status/processingJob with no live BullMQ job
 *      → re-enqueue from processingJob.phase
 *   2. Clip-generate orphans — clip stuck in queued/running with no live BullMQ job
 *      → re-enqueue clip-generate
 *   3. Clip-render orphans — clip stuck in activeJob.status queued/running but no live job
 *      → mark failed (payload is lost; can't resume)
 *
 * BullMQ's stalled-job re-claim handles jobs that were active when the worker died —
 * this reconciler handles DB rows that have no corresponding job at all.
 */

const Transcript = require('../models/Transcript');
const logger = require('../utils/logger');
const { networkQueue, transcribeQueue, mediaQueue, enqueuePipeline } = require('./pipeline');
const { enqueueClipGenerate } = require('./clipJobs');
const {
    finalizeClipCancelled,
    finalizeTranscriptCancelled,
    updateClipActiveJob,
    nowIso,
} = require('../utils/backgroundJobs');

const RECONCILE_INTERVAL_MIN = parseInt(process.env.RECONCILE_INTERVAL_MIN || '5', 10);
// Only treat a row as orphaned if it hasn't been updated in this many minutes.
const STALE_THRESHOLD_MIN = parseInt(process.env.RECONCILE_STALE_THRESHOLD_MIN || '10', 10);

async function getLiveJobSets() {
    const [networkJobs, transcribeJobs, mediaJobs] = await Promise.all([
        networkQueue.getJobs(['active', 'waiting', 'delayed', 'prioritized', 'waiting-children']).catch(() => []),
        transcribeQueue.getJobs(['active', 'waiting', 'delayed', 'prioritized', 'waiting-children']).catch(() => []),
        mediaQueue.getJobs(['active', 'waiting', 'delayed', 'prioritized', 'waiting-children']).catch(() => []),
    ]);

    const allJobs = [...networkJobs, ...transcribeJobs, ...mediaJobs];

    // Transcripts with a live pipeline stage job
    const liveTranscriptIds = new Set(
        allJobs.filter(j => !j.data?.type || j.data.type === 'stage').map(j => String(j.data.transcriptId))
    );
    // Clips with a live clip-generate job
    const liveClipKeys = new Set(
        allJobs.filter(j => j.data?.type === 'clip-generate').map(j => `${j.data.transcriptId}:${j.data.clipIndex}`)
    );

    return { liveTranscriptIds, liveClipKeys };
}

async function reconcileQueue() {
    const staleThresholdMs = STALE_THRESHOLD_MIN * 60 * 1000;
    const now = Date.now();

    let transcripts;
    try {
        transcripts = await Transcript.find({});
    } catch (err) {
        logger.error('Reconcile: failed to fetch transcripts', { error: err.message });
        return;
    }

    const { liveTranscriptIds, liveClipKeys } = await getLiveJobSets();

    let reEnqueuedTranscripts = 0;
    let reEnqueuedClips = 0;
    let failedRenders = 0;
    let cancelledTranscripts = 0;
    let cancelledClips = 0;

    for (const transcript of transcripts) {
        const id = String(transcript._id);
        const jobType = transcript.importUrl ? 'import' : 'upload';

        // ── Transcript-level orphan check ────────────────────────────────────
        const pj = transcript.processingJob;
        if (pj && !['completed', 'failed', 'cancelled'].includes(pj.status) &&
            !['completed', 'failed', 'cancelled'].includes(transcript.status)) {

            if (!liveTranscriptIds.has(id)) {
                const lastUpdate = pj.updatedAt ? new Date(pj.updatedAt).getTime() : 0;
                const isStale = now - lastUpdate > staleThresholdMs;

                if (isStale) {
                    if (pj.cancelRequestedAt || pj.status === 'cancelling') {
                        logger.warn(`Reconcile: finalizing cancelled transcript ${id}`);
                        await finalizeTranscriptCancelled(id, jobType).catch(err =>
                            logger.error(`Reconcile: failed to finalize cancelled transcript ${id}`, { error: err.message })
                        );
                        cancelledTranscripts++;
                        continue;
                    }
                    const phase = pj.phase || 'extract-metadata';
                    logger.warn(`Reconcile: re-enqueueing orphaned transcript ${id} from phase ${phase}`);
                    await enqueuePipeline(id, jobType, phase).catch(err =>
                        logger.error(`Reconcile: failed to re-enqueue transcript ${id}`, { error: err.message })
                    );
                    reEnqueuedTranscripts++;
                }
            }
        }

        // ── Clip-level orphan checks ─────────────────────────────────────────
        if (!Array.isArray(transcript.clips)) continue;

        for (let i = 0; i < transcript.clips.length; i++) {
            const clip = transcript.clips[i];

            // Clip-generate orphan
            const gen = clip.generation;
            if (gen && ['queued', 'running', 'cancelling'].includes(gen.status)) {
                const key = `${id}:${i}`;
                if (!liveClipKeys.has(key)) {
                    const lastUpdate = gen.updatedAt ? new Date(gen.updatedAt).getTime() : 0;
                    if (now - lastUpdate > staleThresholdMs) {
                        if (gen.cancelRequestedAt || gen.status === 'cancelling') {
                            logger.warn(`Reconcile: finalizing cancelled clip-generate ${id}:${i}`);
                            await finalizeClipCancelled(id, i).catch(() => {});
                            cancelledClips++;
                            continue;
                        }
                        logger.warn(`Reconcile: re-enqueueing orphaned clip-generate ${id}:${i}`);
                        await enqueueClipGenerate({ transcriptId: id, clipIndex: i, origin: 'manual' }).catch(err =>
                            logger.error(`Reconcile: failed to re-enqueue clip ${id}:${i}`, { error: err.message })
                        );
                        reEnqueuedClips++;
                    }
                }
            }

            // Clip-render orphan: activeJob stuck running but no live clip-render job.
            // We can't recover the render payload from the job — mark it failed so the
            // spinner clears and the user can retry.
            const aj = clip.activeJob;
            if (aj && ['queued', 'running'].includes(aj.status)) {
                const lastUpdate = aj.updatedAt ? new Date(aj.updatedAt).getTime() : 0;
                if (now - lastUpdate > staleThresholdMs) {
                    logger.warn(`Reconcile: clearing orphaned clip-render activeJob ${id}:${i}`);
                    await updateClipActiveJob(id, i, {
                        status: 'failed',
                        progressMessage: 'Render did not complete (server restarted). Please retry.',
                        completedAt: nowIso(),
                        error: 'Render interrupted by server restart.',
                    }).catch(() => {});
                    failedRenders++;
                }
            }
        }
    }

    if (reEnqueuedTranscripts + reEnqueuedClips + failedRenders + cancelledTranscripts + cancelledClips > 0) {
        logger.info('Reconcile complete', { reEnqueuedTranscripts, reEnqueuedClips, failedRenders, cancelledTranscripts, cancelledClips });
    } else {
        logger.debug('Reconcile complete: no orphans found');
    }
}

function startReconcileScheduler() {
    if (RECONCILE_INTERVAL_MIN <= 0) {
        logger.info('Reconcile scheduler disabled (RECONCILE_INTERVAL_MIN=0).');
        return;
    }

    const intervalMs = RECONCILE_INTERVAL_MIN * 60 * 1000;
    setInterval(() => {
        reconcileQueue().catch(err =>
            logger.error('Reconcile scheduler error', { error: err.message })
        );
    }, intervalMs).unref();

    logger.info(`Reconcile scheduler started (every ${RECONCILE_INTERVAL_MIN} min).`);
}

module.exports = { reconcileQueue, startReconcileScheduler };
