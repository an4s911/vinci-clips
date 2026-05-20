const express = require('express');
const path = require('path');
const fs = require('fs');
const Transcript = require('../models/Transcript');
const {
    getCaptionStylesForClient,
    templateAllowsCaptions,
    templateAllowsHooks,
    moveFileSafe,
    renderCaptionedVideo,
    buildWordsForClip,
    normalizeTranscriptWords,
} = require('../utils/captioning');
const {
    getPrimaryClipVideo,
    getVideoFilePath,
    createClipVideoRecord,
    appendPrimaryClipVideo,
    normalizeTranscriptClips,
    makeTimestampedFilename,
} = require('../utils/clipVideos');
const {
    activeClipRenderJobs,
    updateClipActiveJob,
    nowIso,
} = require('../utils/backgroundJobs');
const { enqueueClipRender } = require('../queue/clipJobs');

const router = express.Router();

async function validateTemplateUsage(styleId, useCase) {
    if (!styleId) return;
    const styles = await getCaptionStylesForClient();
    const template = styles.find((style) => style.id === styleId);
    if (!template) return;
    const valid = useCase === 'hooks' ? templateAllowsHooks(template) : templateAllowsCaptions(template);
    if (!valid) {
        const label = useCase === 'hooks' ? 'hooks' : 'captions';
        const error = new Error(`Template "${template.name}" cannot be used for ${label}.`);
        error.statusCode = 400;
        throw error;
    }
}

router.get('/styles', async (req, res) => {
    try {
        const styles = await getCaptionStylesForClient();
        res.json({
            success: true,
            styles,
            captionStyles: styles.filter(templateAllowsCaptions),
            hookStyles: styles.filter(templateAllowsHooks),
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/generate/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { style = 'bold-yellow', startTime, endTime } = req.body;

        const transcript = await Transcript.findById(id, { userId: req.user.id });
        if (!transcript) {
            return res.status(404).json({
                success: false,
                error: 'Transcript not found'
            });
        }

        if (transcript.status !== 'completed') {
            return res.status(400).json({
                success: false,
                error: 'Transcript not ready for caption generation'
            });
        }

        const tempDir = path.join(__dirname, '../../temp');
        fs.mkdirSync(tempDir, { recursive: true });
        await validateTemplateUsage(style, 'captions');

        const outputFileName = `${transcript._id}_captioned_${style}_${Date.now()}.mp4`;
        const outputPath = path.join(tempDir, outputFileName);
        const inputPath = path.join(__dirname, '..', '..', 'uploads', path.basename(transcript.videoUrl));

        const result = await renderCaptionedVideo({
            inputPath,
            outputPath,
            transcriptSegments: transcript.transcript,
            styleId: style,
            startTime,
            endTime,
            logger: console
        });

        const destDir = path.join(__dirname, '..', '..', 'uploads', 'captioned');
        fs.mkdirSync(destDir, { recursive: true });
        const destPath = path.join(destDir, outputFileName);
        moveFileSafe(outputPath, destPath);

        res.json({
            success: true,
            captionedVideoUrl: `/uploads/captioned/${outputFileName}`,
            style: {
                id: result.resolvedStyle.id,
                name: result.resolvedStyle.name,
                description: result.resolvedStyle.description,
                layout: result.resolvedStyle.layout
            },
            wordCount: result.wordCount,
            message: 'Captioned video generated successfully'
        });
    } catch (error) {
        console.error('Caption generation error:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            error: error.statusCode ? error.message : 'Failed to generate captioned video',
            details: error.statusCode ? undefined : error.message
        });
    }
});

router.post('/render-clip', async (req, res) => {
    try {
        const { transcriptId, clipIndex, captionStyleId, hookStyleId, hookText } = req.body;

        if (!transcriptId || clipIndex === undefined || clipIndex === null) {
            return res.status(400).json({ success: false, error: 'transcriptId and clipIndex are required' });
        }

        const parsedClipIndex = Number(clipIndex);
        if (!Number.isInteger(parsedClipIndex) || parsedClipIndex < 0) {
            return res.status(400).json({ success: false, error: 'clipIndex must be a non-negative integer' });
        }

        const transcript = await Transcript.findById(transcriptId, { userId: req.user.id });
        if (!transcript) {
            return res.status(404).json({ success: false, error: 'Transcript not found' });
        }

        const normalizedClips = normalizeTranscriptClips(transcript);
        const clip = normalizedClips[parsedClipIndex];
        if (!clip) {
            return res.status(404).json({ success: false, error: 'Clip not found' });
        }

        const primaryVideo = getPrimaryClipVideo(clip);
        if (!primaryVideo) {
            return res.status(400).json({ success: false, error: 'Clip has no primary video yet — generate the clip first' });
        }

        await validateTemplateUsage(captionStyleId, 'captions');
        const effectiveHookText = typeof hookText === 'string' ? hookText.trim() : (clip.hook?.text || '');
        const hookEnabled = Boolean(clip.hook?.enabled && effectiveHookText);
        if (hookEnabled && hookStyleId) {
            await validateTemplateUsage(hookStyleId, 'hooks');
        }

        const words = normalizeTranscriptWords(transcript.transcript);
        const clipWords = buildWordsForClip(words, clip, primaryVideo.clipTimeline);
        if (clipWords.length === 0) {
            return res.status(400).json({ success: false, error: 'No transcript words found for this clip time range' });
        }

        const renderKey = `render:${transcriptId}:${parsedClipIndex}`;
        if (activeClipRenderJobs.has(renderKey)) {
            return res.status(409).json({ success: false, error: 'A render is already in progress for this clip' });
        }

        const inputPath = getVideoFilePath(primaryVideo);
        const tempDir = path.join(__dirname, '../../temp');
        fs.mkdirSync(tempDir, { recursive: true });
        const outputFilename = makeTimestampedFilename(transcriptId, parsedClipIndex, '_captioned');
        const outputPath = path.join(tempDir, outputFilename);
        const destDir = path.join(__dirname, '..', '..', 'uploads', 'captioned');
        const destPath = path.join(destDir, outputFilename);

        try {
            await updateClipActiveJob(transcriptId, parsedClipIndex, {
                status: 'queued',
                jobType: 'caption-render',
                progressMessage: 'Caption render queued.',
                startedAt: nowIso(),
                completedAt: null,
                error: null,
            });

            await enqueueClipRender({
                transcriptId,
                clipIndex: parsedClipIndex,
                kind: 'caption',
                payload: {
                    transcriptId,
                    parsedClipIndex,
                    captionStyleId,
                    hookStyleId,
                    effectiveHookText,
                    hookEnabled,
                    outputFilename,
                    inputPath,
                },
            });
        } catch (enqueueError) {
            await updateClipActiveJob(transcriptId, parsedClipIndex, {
                status: 'failed',
                progressMessage: 'Caption render could not be queued.',
                completedAt: nowIso(),
                error: enqueueError.message,
            }).catch(() => {});
            throw enqueueError;
        }

        return res.status(202).json({ accepted: true, transcriptId, clipIndex: parsedClipIndex });
    } catch (error) {
        console.error('Clip caption render error:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            error: error.statusCode ? error.message : 'Failed to render captioned clip',
            details: error.statusCode ? undefined : error.message,
        });
    }
});

router.post('/render-batch', async (req, res) => {
    try {
        const { transcriptId, clipIndexes, captionStyleId, hookStyleId } = req.body;

        if (!transcriptId || !Array.isArray(clipIndexes) || clipIndexes.length === 0) {
            return res.status(400).json({ success: false, error: 'transcriptId and clipIndexes[] are required' });
        }

        const transcript = await Transcript.findById(transcriptId, { userId: req.user.id });
        if (!transcript) {
            return res.status(404).json({ success: false, error: 'Transcript not found' });
        }

        const normalizedClips = normalizeTranscriptClips(transcript);
        const results = [];
        const errors = [];
        await validateTemplateUsage(captionStyleId, 'captions');
        if (hookStyleId) {
            await validateTemplateUsage(hookStyleId, 'hooks');
        }

        for (const rawIndex of clipIndexes) {
            const clipIndex = Number(rawIndex);
            const clip = normalizedClips[clipIndex];
            if (!clip) {
                errors.push({ clipIndex, error: 'Clip not found' });
                continue;
            }

            const primaryVideo = getPrimaryClipVideo(clip);
            if (!primaryVideo) {
                errors.push({ clipIndex, error: 'No primary video — generate clip first' });
                continue;
            }

            try {
                const inputPath = getVideoFilePath(primaryVideo);
                const outputFilename = makeTimestampedFilename(transcriptId, clipIndex, '_captioned');
                const effectiveHookText = clip.hook?.text || '';
                const hookEnabled = Boolean(clip.hook?.enabled && effectiveHookText);

                const words = normalizeTranscriptWords(transcript.transcript);
                const clipWords = buildWordsForClip(words, clip, primaryVideo.clipTimeline);
                if (clipWords.length === 0) {
                    errors.push({ clipIndex, error: 'No transcript words in clip range' });
                    continue;
                }

                try {
                    await updateClipActiveJob(transcriptId, clipIndex, {
                        status: 'queued',
                        jobType: 'caption-render',
                        progressMessage: 'Caption render queued.',
                        startedAt: nowIso(),
                        completedAt: null,
                        error: null,
                    });

                    await enqueueClipRender({
                        transcriptId,
                        clipIndex,
                        kind: 'caption',
                        payload: {
                            transcriptId,
                            parsedClipIndex: clipIndex,
                            captionStyleId,
                            hookStyleId,
                            effectiveHookText,
                            hookEnabled,
                            outputFilename,
                            inputPath,
                        },
                    });
                } catch (enqueueError) {
                    await updateClipActiveJob(transcriptId, clipIndex, {
                        status: 'failed',
                        progressMessage: 'Caption render could not be queued.',
                        completedAt: nowIso(),
                        error: enqueueError.message,
                    }).catch(() => {});
                    throw enqueueError;
                }
                results.push({ clipIndex, queued: true });
            } catch (clipError) {
                console.error(`Batch caption render error for clip ${clipIndex}:`, clipError);
                errors.push({ clipIndex, error: clipError.message });
            }
        }

        res.json({
            success: true,
            queued: results.length,
            failed: errors.length,
            results,
            errors,
        });
    } catch (error) {
        console.error('Batch caption render error:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            error: error.statusCode ? error.message : 'Failed to render captioned clips',
            details: error.statusCode ? undefined : error.message,
        });
    }
});

module.exports = router;
