const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const Transcript = require('../models/Transcript');
const { createJobState, logVideoProcessing } = require('../utils/backgroundJobs');
const { enqueuePipeline } = require('../queue/pipeline');

const upload = multer({
    dest: 'uploads/temp/',
    limits: { fileSize: 2 * 1024 * 1024 * 1024 }
});

const tempDir = 'uploads/temp';
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

const uploadsDir = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

router.post('/file', upload.single('video'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Video file is required.' });
    }

    const transcript = await Transcript.create({
        userId: req.user.id,
        title: req.file.originalname.replace(/\.[^./\\]+$/, ''),
        originalFilename: req.file.originalname,
        transcript: [],
        status: 'uploading',
        processingJob: createJobState({
            status: 'queued',
            phase: 'probe-duration',
            progressMessage: 'Upload received. Queued for processing.',
        }),
    });

    // Rename multer temp file to a deterministic path so stage functions can find it
    const ext = path.extname(req.file.originalname) || '.mp4';
    const tempVideoPath = path.join(tempDir, `${transcript._id}${ext}`);
    fs.renameSync(req.file.path, tempVideoPath);

    logVideoProcessing(transcript._id, 'accepted', 'Upload request accepted — enqueued', {
        jobType: 'upload',
        phase: 'probe-duration',
        fileName: req.file.originalname,
        tempPath: tempVideoPath,
    });

    await enqueuePipeline(transcript._id, 'upload', 'probe-duration');

    res.status(202).json({
        message: 'Upload accepted. Processing continues in the background.',
        transcript,
    });
});

module.exports = router;
