const fs = require('fs');
const prisma = require('../db/prisma');
const Transcript = require('../models/Transcript');
const { normalizeTranscriptClips, getPrimaryClipVideo, getVideoFilePath } = require('./clipVideos');

// Resolve the on-disk file path for one selected clip, enforcing the uploads-dir
// boundary via getVideoFilePath. Mirrors resolveSelectedPrimaryClips (clips.js)
// but for a single item.
async function resolveClipFilePath({ transcriptId, clipIndex, videoId }) {
    const transcript = await Transcript.findById(transcriptId);
    if (!transcript) throw new Error('Transcript not found.');

    const clip = normalizeTranscriptClips(transcript)[clipIndex];
    if (!clip) throw new Error(`Clip ${clipIndex} not found.`);

    const primaryVideo = getPrimaryClipVideo(clip);
    if (!primaryVideo || primaryVideo.id !== videoId) {
        throw new Error('Clip is no longer the current primary clip.');
    }

    const filePath = getVideoFilePath(primaryVideo);
    if (!fs.existsSync(filePath)) throw new Error('Clip file is missing on disk.');
    return filePath;
}

function recomputeExport(exp) {
    const items = exp.items || [];
    const completed = items.filter(i => i.status === 'done').length;
    const failed = items.filter(i => i.status === 'failed').length;
    const allTerminal = items.every(i => i.status === 'done' || i.status === 'failed');
    let status = exp.status;
    if (allTerminal) {
        status = failed === 0 ? 'completed' : (completed === 0 ? 'failed' : 'partial');
    } else {
        status = 'running';
    }
    return { completed, failed, status };
}

async function createExport({ userId, folderId, folderName, clips }) {
    const items = clips.map(c => ({
        transcriptId: c.transcriptId,
        clipIndex: c.clipIndex,
        videoId: c.videoId,
        name: `${c.videoId}.mp4`,
        status: 'pending',
    }));
    return prisma.driveExport.create({
        data: {
            userId,
            folderId,
            folderName,
            items,
            total: items.length,
            status: items.length ? 'running' : 'completed',
        },
    });
}

// Atomically mutate one item then recompute counts/status. Serializes concurrent
// writers on the same export row via an interactive transaction.
async function patchItem(exportId, itemIndex, patch) {
    return prisma.$transaction(async (tx) => {
        const exp = await tx.driveExport.findUnique({ where: { id: exportId } });
        if (!exp) return null;
        const items = Array.isArray(exp.items) ? exp.items.slice() : [];
        if (!items[itemIndex]) return exp;
        items[itemIndex] = { ...items[itemIndex], ...patch };
        const { completed, failed, status } = recomputeExport({ ...exp, items });
        return tx.driveExport.update({
            where: { id: exportId },
            data: { items, completed, failed, status },
        });
    });
}

module.exports = { resolveClipFilePath, createExport, patchItem, recomputeExport };
