const express = require('express');
const Transcript = require('../models/Transcript');
const fs = require('fs');
const path = require('path');
const { transcribeAudioFile } = require('../utils/audioTranscription');
const {
    assertTranscriptNotCancelled,
    completeTranscriptJob,
    createJobState,
    isTranscriptCancelRequested,
    logVideoProcessing,
    markTranscriptPhase,
    resolveLocalUploadPath,
    startTranscriptWorker,
} = require('../utils/backgroundJobs');
const { analyzeAndAutoGenerateClips } = require('../utils/clipAutomation');
const { classifyTranscriptionFailure } = require('../utils/failureMessages');

const router = express.Router();

const hasTranscriptContent = (transcript) => Array.isArray(transcript?.transcript) && transcript.transcript.length > 0;

async function runRetryTranscription(transcriptId, mp3Path) {
    const jobType = 'retry-transcription';

    await assertTranscriptNotCancelled(transcriptId, jobType);
    await markTranscriptPhase(transcriptId, jobType, 'resolve-mp3', 'Resolved saved MP3 for retry.', {
        mp3FileName: path.basename(mp3Path),
    });

    await assertTranscriptNotCancelled(transcriptId, jobType);
    const result = await transcribeAudioFile({
        mp3Path,
        transcriptId,
        jobType,
        logLabel: `Retry transcription for ${transcriptId}`,
        onPhaseChange: (phase, message, extra = {}) => markTranscriptPhase(transcriptId, jobType, phase, message, extra),
    });

    await assertTranscriptNotCancelled(transcriptId, jobType);
    await Transcript.findByIdAndUpdate(transcriptId, {
        transcript: result.transcript,
        failureReason: null,
        failedAt: null,
    });
    logVideoProcessing(transcriptId, 'completed', 'Retry transcription completed', {
        jobType,
        phase: 'transcribe',
        model: result.model,
        wordCount: Array.isArray(result.transcript) ? result.transcript.length : null,
    });
    await completeTranscriptJob(transcriptId, jobType, 'Transcription retry completed.');
    await analyzeAndAutoGenerateClips(transcriptId);
}

router.post('/:transcriptId', async (req, res) => {
    const { transcriptId } = req.params;

    try {
        const transcript = await Transcript.findById(transcriptId);
        if (!transcript) {
            return res.status(404).json({ error: 'Transcript not found.' });
        }

        if (transcript.processingJob && ['queued', 'running', 'cancelling'].includes(transcript.processingJob.status)) {
            return res.status(409).json({ error: 'Transcript processing is already active.' });
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

        const updatedTranscript = await Transcript.findByIdAndUpdate(transcriptId, {
            status: 'transcribing',
            processingJob: createJobState({
                status: 'running',
                phase: 'resolve-mp3',
                progressMessage: 'Starting transcription retry.',
            }),
            failureReason: null,
            failedAt: null,
        });

        logVideoProcessing(transcriptId, 'accepted', 'Transcription retry accepted', {
            jobType: 'retry-transcription',
            phase: 'resolve-mp3',
            mp3FileName: path.basename(mp3Path),
        });

        startTranscriptWorker(transcriptId, 'retry-transcription', async () => {
            try {
                await runRetryTranscription(transcriptId, mp3Path);
            } catch (error) {
                if (error?.code === 'JOB_CANCELLED' || await isTranscriptCancelRequested(transcriptId)) {
                    throw error;
                }
                const failure = classifyTranscriptionFailure(error);
                error.publicCode = failure.code;
                error.publicMessage = failure.message;
                await Transcript.findByIdAndUpdate(transcriptId, {
                    failureReason: failure.message,
                    failedAt: new Date().toISOString(),
                });
                throw error;
            }
        });

        res.status(202).json({
            message: 'Transcription retry accepted. Processing continues in the background.',
            transcript: updatedTranscript,
        });
    } catch (error) {
        logVideoProcessing(transcriptId, 'failed', 'Transcription retry failed before it could start', {
            jobType: 'retry-transcription',
            error: error.message,
        });
        res.status(500).json({
            error: 'Failed to retry transcription.',
            details: error.message,
        });
    }
});

module.exports = router;
