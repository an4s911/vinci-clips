const express = require('express');
const Transcript = require('../models/Transcript');
const path = require('path');
const {
    buildGeneratedClipsMap,
    getVideoFilePath,
    normalizeTranscriptClips
} = require('../utils/clipVideos');
const {
    cancelClipQueues,
    cancelTranscriptQueues,
    removePendingQueueJobs,
} = require('../queue/cancellation');
const { deleteLocalMedia, deleteTranscriptMedia, deleteTranscriptTransientMedia } = require('../utils/mediaStorage');

const router = express.Router();

router.get('/', async (req, res) => {
    try {
        const transcripts = await Transcript.find({ userId: req.user.id });
        res.status(200).json(transcripts);
    } catch (error) {
        res.status(500).send({ message: 'Failed to fetch transcripts: ' + error.message });
    }
});

// GET /clips/transcripts/failures?since=<iso>  — returns failed transcripts for login notification
router.get('/failures', async (req, res) => {
    try {
        const { since } = req.query;
        const sinceDate = since ? new Date(since) : null;
        const allTranscripts = await Transcript.find({ userId: req.user.id });
        const failures = allTranscripts.filter(t => {
            if (t.status !== 'failed') return false;
            if (sinceDate && t.failedAt && new Date(t.failedAt) <= sinceDate) return false;
            return true;
        });
        res.status(200).json(failures);
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch failure notifications: ' + error.message });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const transcript = await Transcript.findById(req.params.id, { userId: req.user.id });
        if (!transcript) {
            return res.status(404).send('Transcript not found');
        }

        const transcriptObject = { ...transcript };

        if (transcriptObject.videoUrl) {
            transcriptObject.videoUrl = `/uploads/${path.basename(transcriptObject.videoUrl)}`;
        }

        transcriptObject.clips = normalizeTranscriptClips(transcriptObject);
        transcriptObject.generatedClips = buildGeneratedClipsMap(transcriptObject.clips);

        res.status(200).json(transcriptObject);
    } catch (error) {
        console.error('Error fetching transcript:', error);
        res.status(500).send({ message: error.message });
    }
});

router.put('/:id', async (req, res) => {
    try {
        const existing = await Transcript.findById(req.params.id, { userId: req.user.id });
        if (!existing) return res.status(404).send('Transcript not found');

        const { clips } = req.body;
        const updatePayload = { clips };
        if (Array.isArray(clips) && clips.length === 0) {
            updatePayload.analysisMetadata = null;
        }

        const transcript = await Transcript.findByIdAndUpdate(req.params.id, updatePayload);
        res.status(200).json(transcript);
    } catch (error) {
        res.status(500).send({ message: error.message });
    }
});

router.post('/:id/cancel-processing', async (req, res) => {
    try {
        const transcript = await Transcript.findById(req.params.id, { userId: req.user.id });
        if (!transcript) {
            return res.status(404).json({ error: 'Transcript not found.' });
        }

        if (!transcript.processingJob || !['queued', 'running', 'cancelling'].includes(transcript.processingJob.status)) {
            return res.status(409).json({ error: 'Transcript processing is not active.' });
        }

        await cancelTranscriptQueues(req.params.id, {
            jobType: transcript.importUrl ? 'import' : 'upload',
        });
        const updatedTranscript = await Transcript.findById(req.params.id, { userId: req.user.id });
        res.status(200).json({
            message: 'Processing cancelled.',
            transcript: updatedTranscript,
        });
    } catch (error) {
        res.status(error.status || 500).json({
            error: 'Failed to cancel transcript processing.',
            details: error.message,
        });
    }
});

router.delete('/:id/clips', async (req, res) => {
    try {
        const transcript = await Transcript.findById(req.params.id, { userId: req.user.id });
        if (!transcript) {
            return res.status(404).json({ error: 'Transcript not found.' });
        }

        const clips = normalizeTranscriptClips(transcript);
        for (let clipIndex = 0; clipIndex < clips.length; clipIndex += 1) {
            await cancelClipQueues(req.params.id, clipIndex, { timeoutMs: 5000 }).catch((error) => {
                if (error.code !== 'QUEUE_CANCEL_TIMEOUT') throw error;
                throw error;
            });
        }

        const deletedMedia = [];
        for (const clip of clips) {
            for (const video of clip.videos || []) {
                try {
                    deletedMedia.push(await deleteLocalMedia(getVideoFilePath(video), { missingOk: true }));
                } catch (error) {
                    deletedMedia.push(await deleteLocalMedia(video.url, { missingOk: true }));
                }
            }
        }

        await removePendingQueueJobs({ transcriptId: req.params.id, types: ['clip-generate', 'clip-render'] });
        const updatedTranscript = await Transcript.findByIdAndUpdate(req.params.id, {
            clips: [],
            analysisMetadata: null,
        });

        res.json({
            success: true,
            transcript: updatedTranscript,
            deletedMedia: deletedMedia.filter(item => item.deleted).length,
        });
    } catch (error) {
        res.status(error.status || 500).json({
            error: 'Failed to clear clips.',
            details: error.message,
        });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const transcript = await Transcript.findById(id, { userId: req.user.id });
        if (!transcript) {
            return res.status(404).json({ message: 'Transcript not found' });
        }

        await cancelTranscriptQueues(id, {
            jobType: transcript.importUrl ? 'import' : 'upload',
        });

        const deletedMedia = [
            ...await deleteTranscriptMedia(transcript),
            ...await deleteTranscriptTransientMedia(id),
        ];
        await Transcript.findByIdAndDelete(id);

        res.status(200).json({
            message: 'Transcript and associated files deleted successfully',
            deletedMedia: deletedMedia.filter((item) => item.deleted).length,
        });
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ message: `Failed to delete transcript: ${error.message}` });
    }
});

module.exports = router;
