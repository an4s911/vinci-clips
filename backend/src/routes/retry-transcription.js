const express = require('express');
const Transcript = require('../models/Transcript');
const { logVideoProcessing } = require('../utils/backgroundJobs');
const { enqueuePipeline } = require('../queue/pipeline');

const router = express.Router();

// POST /clips/retry/:transcriptId  — retry the pipeline from the failed stage.
// Works for any failed stage (download, convert, transcribe, clips, etc.).
router.post('/:transcriptId', async (req, res) => {
    const { transcriptId } = req.params;

    try {
        const transcript = await Transcript.findById(transcriptId);
        if (!transcript) {
            return res.status(404).json({ error: 'Transcript not found.' });
        }

        if (transcript.processingJob && ['queued', 'running', 'cancelling'].includes(transcript.processingJob.status)) {
            return res.status(409).json({ error: 'Processing is already active for this transcript.' });
        }

        if (transcript.status === 'completed') {
            return res.status(400).json({ error: 'Transcript already completed. Nothing to retry.' });
        }

        // Determine which stage to resume from.
        // Use the recorded failedStage if available, otherwise fall back to the
        // first stage that is not yet complete.
        const jobType = transcript.importUrl ? 'import' : 'upload';
        const fromStage = transcript.failedStage || (jobType === 'import' ? 'extract-metadata' : 'probe-duration');

        logVideoProcessing(transcriptId, 'accepted', 'Retry-continue accepted', {
            jobType,
            fromStage,
            previousFailedStage: transcript.failedStage,
        });

        await enqueuePipeline(transcriptId, jobType, fromStage);

        const updated = await Transcript.findById(transcriptId);
        res.status(202).json({
            message: 'Processing retry accepted. Resuming from failed stage.',
            transcript: updated,
        });
    } catch (error) {
        logVideoProcessing(transcriptId, 'failed', 'Retry-continue failed before it could start', {
            error: error.message,
        });
        res.status(500).json({
            error: 'Failed to retry processing.',
            details: error.message,
        });
    }
});

module.exports = router;
