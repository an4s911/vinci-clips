const express = require('express');
const Transcript = require('../models/Transcript');
const { analyzeTranscriptForClips } = require('../utils/clipAnalysis');

const router = express.Router();

router.post('/:transcriptId', async (req, res) => {
    try {
        const transcriptDoc = await Transcript.findById(req.params.transcriptId);
        if (!transcriptDoc) {
            return res.status(404).json({ error: 'Transcript not found.' });
        }

        const updatedTranscript = await analyzeTranscriptForClips(transcriptDoc);
        res.json(updatedTranscript);
    } catch (err) {
        console.error(`Server error during analysis: ${err}`);
        res.status(500).json({
            error: 'Failed to analyze transcript and generate clips.',
            details: err.message,
        });
    }
});

module.exports = router;
