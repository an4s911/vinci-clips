const express = require('express');
const Transcript = require('../models/Transcript');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { generateJsonContent } = require('../utils/gemini');

const router = express.Router();
const TRANSCRIPTION_PROMPT = "Transcribe the provided audio with word-level timestamps and identify the speaker for each word. Format the output as a JSON array of objects, where each object represents a single word with precise millisecond timing. Each object should have 'start' (in format MM:SS:mmm), 'end' (in format MM:SS:mmm), 'text' (single word), and 'speaker' fields. For example: [{'start': '00:00:000', 'end': '00:00:450', 'text': 'Hello', 'speaker': 'Speaker 1'}, {'start': '00:00:450', 'end': '00:00:890', 'text': 'world', 'speaker': 'Speaker 1'}]";
const TRANSCRIPTION_SCHEMA = {
    type: 'ARRAY',
    items: {
        type: 'OBJECT',
        properties: {
            start: { type: 'STRING' },
            end: { type: 'STRING' },
            text: { type: 'STRING' },
            speaker: { type: 'STRING' },
        },
        required: ['start', 'end', 'text', 'speaker'],
        propertyOrdering: ['start', 'end', 'text', 'speaker'],
    },
};

const hasTranscriptContent = (transcript) => Array.isArray(transcript?.transcript) && transcript.transcript.length > 0;

const getUserSafeFailureReason = (error) => {
    if (error?.code === 'TRANSCRIPTION_PARSE_FAILED') {
        return 'Video import/download succeeded, but transcription failed because Gemini returned invalid JSON. Retry transcription to try again.';
    }

    return 'Video import/download succeeded, but transcription failed while talking to Gemini. Retry transcription to try again.';
};

const resolveLocalUploadPath = (mediaUrl) => {
    if (!mediaUrl || typeof mediaUrl !== 'string') {
        return null;
    }

    const normalized = mediaUrl.replace(/^\/+/, '');
    const candidates = [
        path.resolve(process.cwd(), normalized),
        path.resolve(__dirname, '..', '..', normalized),
    ];

    return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
};

// Retry transcription for a stuck transcript
router.post('/:transcriptId', async (req, res) => {
    const { transcriptId } = req.params;

    try {
        const transcript = await Transcript.findById(transcriptId);
        if (!transcript) {
            return res.status(404).json({ error: 'Transcript not found.' });
        }

        if (transcript.status === 'completed') {
            return res.status(400).json({
                error: 'Transcript already completed',
                details: 'Retry is only available before a transcript has been successfully created.',
            });
        }

        if (hasTranscriptContent(transcript)) {
            return res.status(400).json({
                error: 'Transcript already has content',
                details: 'Retry is only available when no transcript content has been saved yet.',
            });
        }

        if (!transcript.mp3Url) {
            return res.status(400).json({
                error: 'No MP3 available',
                details: 'This video cannot be retried because no MP3 file was saved for it.',
            });
        }

        const mp3Path = resolveLocalUploadPath(transcript.mp3Url);
        if (!mp3Path || !fs.existsSync(mp3Path)) {
            return res.status(400).json({
                error: 'No MP3 available',
                details: 'The saved MP3 file could not be found on disk for this transcript.',
            });
        }

        logger.logVideoProcessing(transcriptId, 'retrying', 'Starting transcription retry');

        await Transcript.findByIdAndUpdate(transcriptId, {
            status: 'transcribing',
        });

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);

        console.log('Uploading MP3 to Gemini API...');
        const uploadResult = await fileManager.uploadFile(mp3Path, {
            mimeType: 'audio/mpeg',
            displayName: path.basename(mp3Path)
        });

        const audioPart = { fileData: { mimeType: uploadResult.file.mimeType, fileUri: uploadResult.file.uri } };

        console.log('Sending transcription request to Gemini...');

        const result = await generateJsonContent({
            genAI,
            logLabel: `Retry transcription for ${transcriptId}`,
            contents: [{
                role: 'user',
                parts: [
                    { text: TRANSCRIPTION_PROMPT },
                    audioPart,
                ],
            }],
            responseSchema: TRANSCRIPTION_SCHEMA,
        });

        const transcriptContent = result.data;
        console.log(`Retry transcription for ${transcriptId} used Gemini model: ${result.model}`);
        
        console.log(`Transcription completed with ${transcriptContent.length} segments`);

        const updatedTranscript = await Transcript.findByIdAndUpdate(transcriptId, {
            transcript: transcriptContent,
            status: 'completed',
            failureReason: null,
            failedAt: null,
        });

        console.log(`Transcription retry successful for ${transcriptId}`);

        res.status(200).json({
            message: 'Transcription retry completed successfully',
            transcript: updatedTranscript,
            segmentCount: transcriptContent.length
        });

    } catch (error) {
        console.error(`Transcription retry failed for ${transcriptId}:`, error);

        const failureReason = getUserSafeFailureReason(error);
        try {
            await Transcript.findByIdAndUpdate(transcriptId, {
                status: 'failed',
                failureReason,
                failedAt: new Date().toISOString(),
            });
        } catch (updateError) {
            console.error('Failed to update transcript status:', updateError);
        }

        const isParseFailure = error?.code === 'TRANSCRIPTION_PARSE_FAILED';
        res.status(isParseFailure ? 422 : 502).json({
            error: isParseFailure ? 'Transcription parse failed' : 'Gemini transcription failed',
            details: isParseFailure
                ? 'Gemini returned invalid or truncated JSON. The saved MP3 is still available, so you can retry transcription again.'
                : failureReason,
        });
    }
});

module.exports = router;
