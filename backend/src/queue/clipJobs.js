/**
 * Clip-level BullMQ job helpers.
 * All clip-generate and clip-render jobs land in the shared 'pipeline-media' queue,
 * which is the global ffmpeg concurrency cap.
 */

const { Queue } = require('bullmq');
const connection = require('./connection');

// Creates its own Queue instance — multiple instances pointing to the same
// Redis-backed queue is fine in BullMQ.
const mediaQueue = new Queue('pipeline-media', { connection });

const MAX_CLIP_ATTEMPTS = parseInt(process.env.PIPELINE_STAGE_ATTEMPTS || '3', 10);
const BACKOFF_DELAY_MS = parseInt(process.env.PIPELINE_BACKOFF_MS || '5000', 10);

const PRIORITY_PIPELINE_STAGE = parseInt(process.env.PIPELINE_PRIORITY_STAGE || '1', 10);
const PRIORITY_PIPELINE_CLIP = parseInt(process.env.PIPELINE_PRIORITY_CLIP || '5', 10);
const PRIORITY_MANUAL_CLIP = parseInt(process.env.PIPELINE_PRIORITY_MANUAL_CLIP || '8', 10);
const PRIORITY_MANUAL_RENDER = parseInt(process.env.PIPELINE_PRIORITY_MANUAL_RENDER || '10', 10);

function clipGenerateJobId(transcriptId, clipIndex) {
    return `clip-gen-${transcriptId}-${clipIndex}`;
}

function legacyClipGenerateJobId(transcriptId, clipIndex) {
    return `clip-gen:${transcriptId}:${clipIndex}`;
}

async function enqueueClipGenerate({ transcriptId, clipIndex, origin = 'manual', priority }) {
    const resolvedPriority = priority ?? (origin === 'pipeline' ? PRIORITY_PIPELINE_CLIP : PRIORITY_MANUAL_CLIP);
    const jobId = clipGenerateJobId(transcriptId, clipIndex);
    const oldJobId = legacyClipGenerateJobId(transcriptId, clipIndex);
    for (const candidateId of [jobId, oldJobId]) {
        const existingJob = await mediaQueue.getJob(candidateId).catch(() => null);
        if (existingJob) {
            const state = await existingJob.getState().catch(() => null);
            if (state === 'active') continue; // worker is genuinely running it — skip
            await existingJob.remove().catch(() => {}); // remove any non-active leftover
        }
    }

    await mediaQueue.add(
        `clip-generate:${transcriptId}:${clipIndex}`,
        { type: 'clip-generate', transcriptId, clipIndex, origin },
        {
            jobId,
            priority: resolvedPriority,
            attempts: MAX_CLIP_ATTEMPTS,
            backoff: { type: 'exponential', delay: BACKOFF_DELAY_MS },
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 100 },
        }
    );

    return jobId;
}

async function enqueueClipRender({ transcriptId, clipIndex, kind, payload, priority }) {
    const resolvedPriority = priority ?? PRIORITY_MANUAL_RENDER;
    // Render jobs get a time-based suffix so multiple renders can coexist in the queue.
    const jobId = `clip-render-${transcriptId}-${clipIndex}-${Date.now()}`;

    await mediaQueue.add(
        `clip-render:${transcriptId}:${clipIndex}`,
        { type: 'clip-render', transcriptId, clipIndex, kind, payload },
        {
            jobId,
            priority: resolvedPriority,
            attempts: MAX_CLIP_ATTEMPTS,
            backoff: { type: 'exponential', delay: BACKOFF_DELAY_MS },
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 100 },
        }
    );

    return jobId;
}

async function removeClipJobs(transcriptId) {
    const jobs = await mediaQueue.getJobs(['waiting', 'delayed', 'prioritized', 'waiting-children']).catch(() => []);
    const clipJobs = jobs.filter(job => {
        const d = job?.data;
        return d && (d.type === 'clip-generate' || d.type === 'clip-render') && d.transcriptId === transcriptId;
    });
    await Promise.allSettled(clipJobs.map(job => job.remove().catch(() => {})));
    return clipJobs.length;
}

module.exports = {
    enqueueClipGenerate,
    enqueueClipRender,
    removeClipJobs,
    clipGenerateJobId,
    legacyClipGenerateJobId,
    PRIORITY_PIPELINE_STAGE,
    PRIORITY_PIPELINE_CLIP,
    PRIORITY_MANUAL_CLIP,
    PRIORITY_MANUAL_RENDER,
};
