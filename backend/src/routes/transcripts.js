const express = require('express');
const Transcript = require('../models/Transcript');
const path = require('path');
const {
    buildGeneratedClipsMap,
    normalizeTranscriptClips
} = require('../utils/clipVideos');
const { requestTranscriptCancel } = require('../utils/backgroundJobs');
const { deleteTranscriptMedia } = require('../utils/mediaStorage');

const router = express.Router();

// Get all transcripts
router.get('/', async (req, res) => {
    try {
        const transcripts = await Transcript.find({});
        res.status(200).json(transcripts);
    } catch (error) {
        res.status(500).send({ message: 'Failed to fetch transcripts: ' + error.message });
    }
});

// Get a single transcript by ID
router.get('/:id', async (req, res) => {
    try {
        const transcript = await Transcript.findById(req.params.id);
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

// Update transcript (for clearing clips)
router.put('/:id', async (req, res) => {
    try {
        const { clips } = req.body;
        const updatePayload = { clips };

        if (Array.isArray(clips) && clips.length === 0) {
            updatePayload.analysisMetadata = null;
        }

        const transcript = await Transcript.findByIdAndUpdate(
            req.params.id,
            updatePayload,
            { new: true }
        );
        if (!transcript) {
            return res.status(404).send('Transcript not found');
        }
        res.status(200).json(transcript);
    } catch (error) {
        res.status(500).send({ message: error.message });
    }
});

router.post('/:id/cancel-processing', async (req, res) => {
    try {
        const transcript = await Transcript.findById(req.params.id);
        if (!transcript) {
            return res.status(404).json({ error: 'Transcript not found.' });
        }

        if (!transcript.processingJob || !['queued', 'running', 'cancelling'].includes(transcript.processingJob.status)) {
            return res.status(409).json({ error: 'Transcript processing is not active.' });
        }

        const updatedTranscript = await requestTranscriptCancel(req.params.id);
        res.status(200).json({
            message: 'Cancellation requested.',
            transcript: updatedTranscript,
        });
    } catch (error) {
        res.status(500).json({
            error: 'Failed to cancel transcript processing.',
            details: error.message,
        });
    }
});

// Delete a transcript
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const transcript = await Transcript.findById(id);
        if (!transcript) {
            return res.status(404).json({ message: 'Transcript not found' });
        }

        const deletedMedia = await deleteTranscriptMedia(transcript);
        
        // Delete the transcript from the database
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
