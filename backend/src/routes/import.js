const express = require('express');
const fs = require('fs');
const Transcript = require('../models/Transcript');
const { createJobState, logVideoProcessing } = require('../utils/backgroundJobs');
const { enqueuePipeline } = require('../queue/pipeline');
const { validateUrl, detectPlatform } = require('../utils/videoUrl');

const router = express.Router();

const importsDir = 'uploads/imports';
if (!fs.existsSync(importsDir)) {
    fs.mkdirSync(importsDir, { recursive: true });
}

const sanitizeFilename = (value) => String(value || 'imported-video')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140) || 'imported-video';

router.post('/url', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }
    if (!validateUrl(url)) {
        return res.status(400).json({ error: 'Invalid URL format' });
    }

    const platform = detectPlatform(url);
    if (platform === 'unknown') {
        return res.status(400).json({ error: 'Unsupported platform' });
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

    logVideoProcessing(transcript._id, 'accepted', 'URL import request accepted — enqueued', {
        jobType: 'import',
        phase: 'extract-metadata',
        url,
        platform,
    });

    await enqueuePipeline(transcript._id, 'import', 'extract-metadata');

    res.status(202).json({
        message: 'Import accepted. Processing continues in the background.',
        transcript,
    });
});

module.exports = router;
