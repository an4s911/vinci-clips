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
const { networkQueue, transcribeQueue, mediaQueue, enqueuePipeline, maybeFinalizeTranscriptClips, maybeFinalizeBulkEdit } = require('./pipeline');
const { enqueueClipGenerate, enqueueClipRender } = require('./clipJobs');
const {
    finalizeClipCancelled,
    finalizeTranscriptCancelled,
    updateClipActiveJob,
    nowIso,
} = require('../utils/backgroundJobs');
const { getAutoBulkEditConfig } = require('../utils/appSettings');
const { buildRenderPayloadForClip, MAX_AUTO_REQUEUE_ATTEMPTS } = require('../utils/autoBulkEdit');

const RECONCILE_INTERVAL_MIN = parseInt(process.env.RECONCILE_INTERVAL_MIN || '5', 10);
// Only treat a row as orphaned if it hasn't been updated in this many minutes.
// Default 2 min (down from 10) so steady-state orphans clear fast.
const STALE_THRESHOLD_MIN = parseInt(process.env.RECONCILE_STALE_THRESHOLD_MIN || '2', 10);

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

    // Clips with a live clip-render job (auto pipeline renders)
    const liveRenderKeys = new Set(
        allJobs.filter(j => j.data?.type === 'clip-render').map(j => `${j.data.transcriptId}:${j.data.clipIndex}`)
    );

    return { liveTranscriptIds, liveClipKeys, liveRenderKeys };
}

async function reconcileQueue({ boot = false } = {}) {
    // In boot mode, ignore the stale threshold — act on any orphan immediately.
    const staleThresholdMs = boot ? 0 : STALE_THRESHOLD_MIN * 60 * 1000;
    const now = Date.now();

    let transcripts;
    try {
        transcripts = await Transcript.find({});
    } catch (err) {
        logger.error('Reconcile: failed to fetch transcripts', { error: err.message });
        return;
    }

    const { liveTranscriptIds, liveClipKeys, liveRenderKeys } = await getLiveJobSets();

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
                // Cancelling transcripts with no live job are finalized immediately —
                // no stale threshold, so the UI clears without waiting up to 10 min.
                if (pj.cancelRequestedAt || pj.status === 'cancelling') {
                    logger.warn(`Reconcile: finalizing cancelled transcript ${id}`);
                    await finalizeTranscriptCancelled(id, jobType).catch(err =>
                        logger.error(`Reconcile: failed to finalize cancelled transcript ${id}`, { error: err.message })
                    );
                    cancelledTranscripts++;
                    continue;
                }

                const lastUpdate = pj.updatedAt ? new Date(pj.updatedAt).getTime() : 0;
                const isStale = now - lastUpdate > staleThresholdMs;

                if (isStale) {
                    const phase = pj.phase || 'extract-metadata';
                    // 'bulk-edit' is not a pipeline stage — it is handled by the deadlock
                    // sweep below. Skip enqueuePipeline for it but continue processing clips.
                    if (phase !== 'bulk-edit') {
                        logger.warn(`Reconcile: re-enqueueing orphaned transcript ${id} from phase ${phase}`);
                        await enqueuePipeline(id, jobType, phase).catch(err =>
                            logger.error(`Reconcile: failed to re-enqueue transcript ${id}`, { error: err.message })
                        );
                        reEnqueuedTranscripts++;
                    }
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
                    if (gen.cancelRequestedAt || gen.status === 'cancelling') {
                        logger.warn(`Reconcile: finalizing cancelled clip-generate ${id}:${i}`);
                        await finalizeClipCancelled(id, i).catch(() => {});
                        cancelledClips++;
                        continue;
                    }

                    const lastUpdate = gen.updatedAt ? new Date(gen.updatedAt).getTime() : 0;
                    if (now - lastUpdate > staleThresholdMs) {
                        const origin = gen.origin || 'manual';
                        logger.warn(`Reconcile: re-enqueueing orphaned clip-generate ${id}:${i}`, { origin });
                        await enqueueClipGenerate({ transcriptId: id, clipIndex: i, origin }).catch(err =>
                            logger.error(`Reconcile: failed to re-enqueue clip ${id}:${i}`, { error: err.message })
                        );
                        reEnqueuedClips++;
                    }
                }
            }

            // Clip-render orphan: activeJob stuck running but no live clip-render job.
            // In boot mode, skip — BullMQ stall recovery will re-claim the job shortly.
            // In periodic mode, if still orphaned after the stale threshold:
            //   - Auto pipeline renders (origin:'pipeline'): re-enqueue by rebuilding payload
            //     from saved config + clip state (payload is reconstructible without the user).
            //   - Manual renders: mark failed so the spinner clears and the user can retry.
            if (!boot) {
                const aj = clip.activeJob;
                if (aj && ['queued', 'running'].includes(aj.status)) {
                    const renderKey = `${id}:${i}`;
                    if (liveRenderKeys.has(renderKey)) continue; // live job exists, skip
                    const lastUpdate = aj.updatedAt ? new Date(aj.updatedAt).getTime() : 0;
                    if (now - lastUpdate > staleThresholdMs) {
                        const isAutoPipeline = aj.origin === 'pipeline' &&
                            transcript.processingJob?.phase === 'bulk-edit';

                        if (isAutoPipeline) {
                            const autoAttempts = aj.autoAttempts || 1;
                            if (autoAttempts < MAX_AUTO_REQUEUE_ATTEMPTS) {
                                logger.warn(`Reconcile: re-enqueueing orphaned auto render ${id}:${i}`, { autoAttempts });
                                try {
                                    const config = await getAutoBulkEditConfig();
                                    const fresh = await Transcript.findById(id);
                                    const renderJob = fresh ? buildRenderPayloadForClip(fresh, i, config) : null;
                                    if (renderJob) {
                                        await updateClipActiveJob(id, i, {
                                            status: 'queued',
                                            autoAttempts: autoAttempts + 1,
                                            progressMessage: 'Auto bulk-edit re-queued after interruption.',
                                            startedAt: nowIso(),
                                            completedAt: null,
                                            error: null,
                                        });
                                        await enqueueClipRender({
                                            transcriptId: id,
                                            clipIndex: i,
                                            kind: renderJob.kind,
                                            payload: { ...renderJob.payload, autoPipeline: true },
                                        });
                                        reEnqueuedClips++;
                                    } else {
                                        // Clip or config no longer valid — fail gracefully
                                        await updateClipActiveJob(id, i, {
                                            status: 'failed',
                                            progressMessage: 'Auto bulk-edit failed (clip no longer valid). Retry manually.',
                                            completedAt: nowIso(),
                                            error: 'Could not rebuild render payload during reconcile.',
                                        }).catch(() => {});
                                        failedRenders++;
                                        await maybeFinalizeBulkEdit(id).catch(() => {});
                                    }
                                } catch (reEnqueueErr) {
                                    logger.error(`Reconcile: failed to re-enqueue auto render ${id}:${i}`, { error: reEnqueueErr.message });
                                }
                            } else {
                                logger.warn(`Reconcile: auto render ${id}:${i} exceeded requeue limit, marking failed`);
                                await updateClipActiveJob(id, i, {
                                    status: 'failed',
                                    progressMessage: `Auto bulk-edit failed after ${MAX_AUTO_REQUEUE_ATTEMPTS} attempts. Retry manually.`,
                                    completedAt: nowIso(),
                                    error: 'Exceeded auto re-enqueue limit.',
                                }).catch(() => {});
                                failedRenders++;
                                await maybeFinalizeBulkEdit(id).catch(() => {});
                            }
                        } else {
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
        }

        // ── Bulk-edit deadlock sweep ─────────────────────────────────────────
        // If transcript is stuck at phase:'bulk-edit' with no live clip-render jobs,
        // re-enqueue orphaned auto renders or attempt finalization.
        const pjBulk = transcript.processingJob;
        if (pjBulk && pjBulk.phase === 'bulk-edit' &&
            !['completed', 'failed', 'cancelled'].includes(pjBulk.status) &&
            !['completed', 'failed', 'cancelled'].includes(transcript.status)) {

            const hasLiveRenderJob = Array.isArray(transcript.clips) && transcript.clips.some((_, i) =>
                liveRenderKeys.has(`${id}:${i}`)
            );

            if (!hasLiveRenderJob && !liveTranscriptIds.has(id)) {
                let swept = 0;
                let config = null;
                if (Array.isArray(transcript.clips)) {
                    for (let i = 0; i < transcript.clips.length; i++) {
                        const aj = transcript.clips[i]?.activeJob;
                        if (aj && aj.origin === 'pipeline' && ['queued', 'running'].includes(aj.status)) {
                            const lastUpdate = aj.updatedAt ? new Date(aj.updatedAt).getTime() : 0;
                            if (now - lastUpdate > staleThresholdMs) {
                                const autoAttempts = aj.autoAttempts || 1;
                                if (autoAttempts < MAX_AUTO_REQUEUE_ATTEMPTS) {
                                    try {
                                        if (!config) config = await getAutoBulkEditConfig();
                                        const fresh = await Transcript.findById(id);
                                        const renderJob = fresh ? buildRenderPayloadForClip(fresh, i, config) : null;
                                        if (renderJob) {
                                            logger.warn(`Reconcile: bulk-edit sweep re-enqueue ${id}:${i}`, { autoAttempts });
                                            await updateClipActiveJob(id, i, {
                                                status: 'queued',
                                                autoAttempts: autoAttempts + 1,
                                                progressMessage: 'Auto bulk-edit re-queued (deadlock sweep).',
                                                startedAt: nowIso(),
                                                completedAt: null,
                                                error: null,
                                            });
                                            await enqueueClipRender({
                                                transcriptId: id,
                                                clipIndex: i,
                                                kind: renderJob.kind,
                                                payload: { ...renderJob.payload, autoPipeline: true },
                                            });
                                            swept++;
                                        }
                                    } catch (e) {
                                        logger.error(`Reconcile: bulk-edit sweep re-enqueue failed ${id}:${i}`, { error: e.message });
                                    }
                                } else {
                                    await updateClipActiveJob(id, i, {
                                        status: 'failed',
                                        progressMessage: `Auto bulk-edit failed after ${MAX_AUTO_REQUEUE_ATTEMPTS} attempts. Retry manually.`,
                                        completedAt: nowIso(),
                                        error: 'Exceeded auto re-enqueue limit.',
                                    }).catch(() => {});
                                    failedRenders++;
                                }
                            }
                        }
                    }
                }
                if (swept === 0) {
                    await maybeFinalizeBulkEdit(id).catch(err =>
                        logger.error(`Reconcile: maybeFinalizeBulkEdit error for ${id}`, { error: err.message })
                    );
                }
                reEnqueuedClips += swept;
            }
        }

        // ── Clips-deadlock sweep ─────────────────────────────────────────────
        // If transcript is stuck at phase:'clips' but no live clip-generate jobs
        // exist, re-enqueue any non-terminal clips and attempt finalization.
        const pjAfter = transcript.processingJob;
        if (pjAfter && pjAfter.phase === 'clips' &&
            !['completed', 'failed', 'cancelled'].includes(pjAfter.status) &&
            !['completed', 'failed', 'cancelled'].includes(transcript.status)) {

            const hasLiveClipJob = Array.isArray(transcript.clips) && transcript.clips.some((_, i) =>
                liveClipKeys.has(`${id}:${i}`)
            );

            if (!hasLiveClipJob && !liveTranscriptIds.has(id)) {
                let sweptClips = 0;
                if (Array.isArray(transcript.clips)) {
                    for (let i = 0; i < transcript.clips.length; i++) {
                        const gen = transcript.clips[i]?.generation;
                        if (gen && ['queued', 'running'].includes(gen.status)) {
                            const lastUpdate = gen.updatedAt ? new Date(gen.updatedAt).getTime() : 0;
                            if (now - lastUpdate > staleThresholdMs) {
                                const origin = gen.origin || 'manual';
                                logger.warn(`Reconcile: clips-deadlock sweep re-enqueue ${id}:${i}`, { origin });
                                await enqueueClipGenerate({ transcriptId: id, clipIndex: i, origin }).catch(() => {});
                                sweptClips++;
                            }
                        }
                    }
                }
                if (sweptClips === 0) {
                    // No non-terminal clips to re-enqueue — attempt finalization directly.
                    await maybeFinalizeTranscriptClips(id).catch(err =>
                        logger.error(`Reconcile: maybeFinalizeTranscriptClips error for ${id}`, { error: err.message })
                    );
                }
                reEnqueuedClips += sweptClips;
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
