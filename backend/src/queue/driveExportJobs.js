/**
 * Drive-export BullMQ job helpers.
 * Each job uploads ONE clip to a Drive folder. Jobs land in the dedicated
 * 'drive-export' queue (network-bound; kept off the ffmpeg/media CPU cap).
 */

const { Queue } = require('bullmq');
const connection = require('./connection');

const driveExportQueue = new Queue('drive-export', { connection });

const DRIVE_EXPORT_ATTEMPTS = parseInt(
    process.env.DRIVE_EXPORT_ATTEMPTS || process.env.PIPELINE_STAGE_ATTEMPTS || '3',
    10
);
const BACKOFF_DELAY_MS = parseInt(process.env.PIPELINE_BACKOFF_MS || '5000', 10);

function driveExportJobId(exportId, itemIndex) {
    return `drive-export-${exportId}-${itemIndex}`;
}

async function enqueueDriveExportItem({ exportId, itemIndex, transcriptId, clipIndex, videoId, folderId, name, overlayPath }) {
    const jobId = driveExportJobId(exportId, itemIndex);
    const existing = await driveExportQueue.getJob(jobId).catch(() => null);
    if (existing) {
        const state = await existing.getState().catch(() => null);
        if (state === 'active') return jobId; // genuinely running — leave it
        await existing.remove().catch(() => {});
    }

    await driveExportQueue.add(
        `drive-export:${exportId}:${itemIndex}`,
        { type: 'drive-export', exportId, itemIndex, transcriptId, clipIndex, videoId, folderId, name, overlayPath: overlayPath || null },
        {
            jobId,
            attempts: DRIVE_EXPORT_ATTEMPTS,
            backoff: { type: 'exponential', delay: BACKOFF_DELAY_MS },
            removeOnComplete: { count: 200 },
            removeOnFail: { count: 200 },
        }
    );
    return jobId;
}

module.exports = {
    driveExportQueue,
    enqueueDriveExportItem,
    driveExportJobId,
    DRIVE_EXPORT_ATTEMPTS,
};
