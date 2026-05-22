const express = require('express');
const Transcript = require('../models/Transcript');
const { enqueuePipeline } = require('../queue/pipeline');

const router = express.Router();

router.post('/:transcriptId', async (req, res) => {
    try {
        const transcriptDoc = await Transcript.findById(req.params.transcriptId);
        if (!transcriptDoc) {
            return res.status(404).json({ error: 'Transcript not found.' });
        }

        const jobType = transcriptDoc.importUrl ? 'import' : 'upload';
        await enqueuePipeline(req.params.transcriptId, jobType, 'analyze');
        res.status(202).json({ status: 'queued', message: 'Re-analysis queued.' });
    } catch (err) {
        console.error(`Server error during analysis: ${err}`);
        res.status(500).json({
            error: 'Failed to queue re-analysis.',
            details: err.message,
        });
    }
});

module.exports = router;
