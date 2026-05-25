const prisma = require('../db/prisma');
const Transcript = require('../models/Transcript');
const { cancelTranscriptQueues } = require('../queue/cancellation');
const { deleteTranscriptMedia, deleteTranscriptTransientMedia } = require('./mediaStorage');
const logger = require('./logger');

async function deleteTranscriptCompletely(transcript) {
    const id = transcript._id || transcript.id;

    await cancelTranscriptQueues(id, {
        jobType: transcript.importUrl ? 'import' : 'upload',
    });

    const deletedMedia = [
        ...await deleteTranscriptMedia(transcript),
        ...await deleteTranscriptTransientMedia(id),
    ];

    try {
        await prisma.$executeRaw`DELETE FROM "DriveExport" WHERE items @> ${JSON.stringify([{ transcriptId: id }])}::jsonb`;
    } catch (err) {
        logger.warn(`Failed to delete DriveExport rows for transcript ${id}: ${err.message}`);
    }

    await Transcript.findByIdAndDelete(id);

    return deletedMedia;
}

module.exports = { deleteTranscriptCompletely };
