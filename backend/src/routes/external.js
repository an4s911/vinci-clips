const express = require('express');
const Transcript = require('../models/Transcript');
const { createJobState, logVideoProcessing } = require('../utils/backgroundJobs');
const { enqueuePipeline } = require('../queue/pipeline');
const { validateUrl, detectPlatform } = require('../utils/videoUrl');

const router = express.Router();

// POST /api/v1/pipeline — trigger pipeline for a video URL
router.post('/pipeline', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'url is required.' });
    }
    if (!validateUrl(url)) {
        return res.status(400).json({ error: 'Invalid URL format.' });
    }
    const platform = detectPlatform(url);
    if (platform === 'unknown') {
        return res.status(400).json({ error: 'Unsupported platform.' });
    }

    const transcript = await Transcript.create({
        userId: req.user.id,
        originalFilename: 'Importing video...',
        transcript: [],
        status: 'uploading',
        failureReason: null,
        failedAt: null,
        importUrl: url,
        platform,
        processingJob: createJobState({
            status: 'queued',
            phase: 'extract-metadata',
            progressMessage: 'Queued for processing.',
        }),
    });

    logVideoProcessing(transcript._id, 'accepted', 'API pipeline request accepted — enqueued', {
        jobType: 'import',
        phase: 'extract-metadata',
        url,
        platform,
    });

    await enqueuePipeline(transcript._id, 'import', 'extract-metadata');

    res.status(202).json({ id: transcript._id, status: transcript.status });
});

// GET /api/v1/pipeline/:id — poll pipeline progress
router.get('/pipeline/:id', async (req, res) => {
    const transcript = await Transcript.findById(req.params.id, { userId: req.user.id });
    if (!transcript) {
        return res.status(404).json({ error: 'Not found.' });
    }

    const pj = transcript.processingJob || {};
    res.json({
        id: transcript._id,
        status: transcript.status,
        phase: pj.phase || null,
        message: pj.progressMessage || null,
        failureReason: transcript.failureReason || null,
        failedStage: transcript.failedStage || null,
        clipCount: Array.isArray(transcript.clips) ? transcript.clips.length : 0,
        updatedAt: transcript.processingJob?.updatedAt || null,
    });
});

module.exports = router;
