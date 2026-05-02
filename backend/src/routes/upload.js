const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const Transcript = require('../models/Transcript');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');
const { generateJsonContent } = require('../utils/gemini');
const {
    TRANSCRIPTION_PROMPT,
    TRANSCRIPTION_SCHEMA,
    assertTranscriptNotCancelled,
    completeTranscriptJob,
    createJobState,
    logVideoProcessing,
    markTranscriptPhase,
    runTrackedCommand,
    startTranscriptWorker,
} = require('../utils/backgroundJobs');

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

function safeUploadName(originalName, transcriptId) {
    const parsed = path.parse(originalName || 'uploaded-video.mp4');
    const base = parsed.name
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 140) || 'uploaded-video';
    const ext = parsed.ext || '.mp4';
    return `${base}-${transcriptId}${ext}`;
}

async function processUploadedFile({ transcriptId, originalName, videoPath }) {
    const jobType = 'upload';
    const mp3Path = `${videoPath}.mp3`;
    const thumbnailPath = `${videoPath}_thumbnail.jpg`;
    let videoDestPath = null;
    let mp3DestPath = null;
    let thumbnailDestPath = null;

    logVideoProcessing(transcriptId, 'running', 'Background upload job started', { jobType, phase: 'uploaded', fileName: originalName });

    await assertTranscriptNotCancelled(transcriptId, jobType);
    await markTranscriptPhase(transcriptId, jobType, 'probe-duration', 'Reading video duration.', { fileName: originalName });
    let videoDuration = null;
    try {
        const result = await runTrackedCommand({
            transcriptId,
            jobType,
            phase: 'probe-duration',
            command: `ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`
        });
        videoDuration = parseFloat(result.stdout.trim());
        if (!Number.isFinite(videoDuration)) videoDuration = null;
    } catch (durationError) {
        logVideoProcessing(transcriptId, 'warning', 'Could not read video duration', {
            jobType,
            phase: 'probe-duration',
            error: durationError.message,
        });
    }

    await assertTranscriptNotCancelled(transcriptId, jobType);
    await markTranscriptPhase(transcriptId, jobType, 'thumbnail', 'Generating thumbnail.', { fileName: originalName });
    try {
        await runTrackedCommand({
            transcriptId,
            jobType,
            phase: 'thumbnail',
            command: `ffmpeg -y -i "${videoPath}" -ss 00:00:01 -vframes 1 "${thumbnailPath}"`
        });
    } catch (thumbnailError) {
        logVideoProcessing(transcriptId, 'warning', 'Thumbnail generation failed; continuing without thumbnail', {
            jobType,
            phase: 'thumbnail',
            error: thumbnailError.message,
        });
    }

    await assertTranscriptNotCancelled(transcriptId, jobType);
    await markTranscriptPhase(transcriptId, jobType, 'convert-mp3', 'Converting video audio to MP3.', { fileName: originalName });
    await runTrackedCommand({
        transcriptId,
        jobType,
        phase: 'convert-mp3',
        command: `ffmpeg -y -i "${videoPath}" -vn -acodec libmp3lame -q:a 2 "${mp3Path}"`
    });

    await assertTranscriptNotCancelled(transcriptId, jobType);
    await markTranscriptPhase(transcriptId, jobType, 'persist-files', 'Saving media files.', { fileName: originalName });
    const videoFileName = safeUploadName(originalName, transcriptId);
    const mp3FileName = videoFileName.replace(/\.[^/.]+$/, '') + '.mp3';
    const thumbnailFileName = videoFileName.replace(/\.[^/.]+$/, '') + '_thumbnail.jpg';

    videoDestPath = path.join(uploadsDir, videoFileName);
    mp3DestPath = path.join(uploadsDir, mp3FileName);
    thumbnailDestPath = path.join(uploadsDir, thumbnailFileName);

    fs.renameSync(videoPath, videoDestPath);
    fs.renameSync(mp3Path, mp3DestPath);
    if (fs.existsSync(thumbnailPath)) {
        fs.renameSync(thumbnailPath, thumbnailDestPath);
    }

    const videoUrl = `/uploads/${videoFileName}`;
    const mp3Url = `/uploads/${mp3FileName}`;
    const thumbnailUrl = fs.existsSync(thumbnailDestPath) ? `/uploads/${thumbnailFileName}` : null;

    await Transcript.findByIdAndUpdate(transcriptId, {
        videoUrl,
        mp3Url,
        duration: videoDuration,
        thumbnailUrl,
        failureReason: null,
        failedAt: null,
    });

    await assertTranscriptNotCancelled(transcriptId, jobType);
    await markTranscriptPhase(transcriptId, jobType, 'upload-gemini', 'Uploading audio to Gemini.', { mp3FileName });
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);
    const uploadResult = await fileManager.uploadFile(mp3DestPath, {
        mimeType: 'audio/mpeg',
        displayName: mp3FileName
    });

    await assertTranscriptNotCancelled(transcriptId, jobType);
    await markTranscriptPhase(transcriptId, jobType, 'transcribe', 'Transcribing audio with Gemini.', { mp3FileName });
    const audioPart = { fileData: { mimeType: uploadResult.file.mimeType, fileUri: uploadResult.file.uri } };
    const { data: transcriptContent, model: resolvedModel } = await generateJsonContent({
        genAI,
        logLabel: `Upload transcription for ${transcriptId}`,
        contents: [{
            role: 'user',
            parts: [
                { text: TRANSCRIPTION_PROMPT },
                audioPart,
            ],
        }],
        responseSchema: TRANSCRIPTION_SCHEMA,
    });

    await assertTranscriptNotCancelled(transcriptId, jobType);
    await Transcript.findByIdAndUpdate(transcriptId, {
        transcript: transcriptContent,
        videoUrl,
        mp3Url,
        duration: videoDuration,
        thumbnailUrl,
        failureReason: null,
        failedAt: null,
    });
    logVideoProcessing(transcriptId, 'completed', 'Gemini transcription completed', {
        jobType,
        phase: 'transcribe',
        model: resolvedModel,
        wordCount: Array.isArray(transcriptContent) ? transcriptContent.length : null,
    });
    await completeTranscriptJob(transcriptId, jobType, 'Transcription completed.');
}

router.post('/file', upload.single('video'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Video file is required.' });
    }

    const transcript = await Transcript.create({
        originalFilename: req.file.originalname,
        transcript: [],
        status: 'uploading',
        processingJob: createJobState({
            status: 'running',
            phase: 'uploaded',
            progressMessage: 'Upload received. Preparing video processing.',
        }),
    });

    logVideoProcessing(transcript._id, 'accepted', 'Upload request accepted', {
        jobType: 'upload',
        phase: 'uploaded',
        fileName: req.file.originalname,
        tempPath: req.file.path,
    });

    startTranscriptWorker(transcript._id, 'upload', () => processUploadedFile({
        transcriptId: transcript._id,
        originalName: req.file.originalname,
        videoPath: req.file.path.trim(),
    }));

    res.status(202).json({
        message: 'Upload accepted. Processing continues in the background.',
        transcript,
    });
});

module.exports = router;
