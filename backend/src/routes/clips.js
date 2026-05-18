const express = require('express');
const Transcript = require('../models/Transcript');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { generateJsonContent } = require('../utils/gemini');
const {
    buildGeneratedClipsMap,
    deleteClipVideoVersion,
    getPrimaryClipVideo,
    getVideoFilePath,
    normalizeClipHook,
    normalizeTranscriptClips
} = require('../utils/clipVideos');
const { getCoveredTranscriptText } = require('../utils/clipModeration');
const { getActivePromptBody, renderPrompt } = require('../utils/promptStore');
const { generateSingleClipInBackground } = require('../utils/clipGeneration');
const {
    createJobState,
    requestClipCancel,
    startClipWorker,
    updateClipActiveJob,
    updateClipGeneration
} = require('../utils/backgroundJobs');

const router = express.Router();

const HOOK_RESPONSE_SCHEMA = {
    type: 'OBJECT',
    properties: {
        hook: { type: 'STRING' },
    },
    required: ['hook'],
    propertyOrdering: ['hook'],
};

function sanitizeZipName(value, fallback = 'clip') {
    const sanitized = String(value || fallback)
        .replace(/\.[^.]+$/, '')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
    return sanitized || fallback;
}

function getClipDuration(clip) {
    if (typeof clip.totalDuration === 'number') {
        return clip.totalDuration;
    }
    if (typeof clip.start === 'number' && typeof clip.end === 'number') {
        return clip.end - clip.start;
    }
    if (Array.isArray(clip.segments)) {
        return clip.segments.reduce((sum, segment) => sum + (segment.end - segment.start), 0);
    }
    return null;
}

function buildPrimaryClipGroups(transcripts) {
    return transcripts
        .map((transcript) => {
            const clips = normalizeTranscriptClips(transcript)
                .map((clip, clipIndex) => {
                    const primaryVideo = getPrimaryClipVideo(clip);
                    if (!primaryVideo) return null;

                    return {
                        transcriptId: transcript._id,
                        clipIndex,
                        clipTitle: clip.title,
                        duration: getClipDuration(clip),
                        video: {
                            id: primaryVideo.id,
                            type: primaryVideo.type,
                            url: primaryVideo.url,
                            filename: primaryVideo.filename,
                            createdAt: primaryVideo.createdAt,
                            platform: primaryVideo.platform,
                            platformName: primaryVideo.platformName,
                            aspectRatio: primaryVideo.aspectRatio,
                            captions: primaryVideo.captions,
                            hook: primaryVideo.hook || { enabled: false }
                        }
                    };
                })
                .filter(Boolean);

            if (clips.length === 0) return null;

            return {
                transcriptId: transcript._id,
                originalFilename: transcript.originalFilename,
                createdAt: transcript.createdAt,
                clipCount: clips.length,
                clips
            };
        })
        .filter(Boolean);
}

async function queueClipGeneration(transcript, transcriptId, clipIndex) {
    const clip = transcript.clips?.[clipIndex];
    if (!clip) {
        throw new Error('Clip not found.');
    }

    if (clip.generation && ['queued', 'running', 'cancelling'].includes(clip.generation.status)) {
        const error = new Error('Clip generation is already active for this clip.');
        error.status = 409;
        throw error;
    }

    const updatedTranscript = await updateClipGeneration(transcriptId, clipIndex, createJobState({
        status: 'queued',
        phase: 'prepare',
        progressMessage: 'Clip generation queued.',
    }));

    // Clear any stale activeJob (leftover reframe/caption render) so the UI doesn't show stale state
    await updateClipActiveJob(transcriptId, clipIndex, { status: 'completed', completedAt: new Date().toISOString() }).catch(() => {});

    const started = startClipWorker(transcriptId, clipIndex, () => generateSingleClipInBackground(transcriptId, clipIndex));
    if (!started) {
        const error = new Error('Clip generation is already active for this clip.');
        error.status = 409;
        throw error;
    }

    return updatedTranscript;
}

async function resolveSelectedPrimaryClips(selectedClips) {
    if (!Array.isArray(selectedClips) || selectedClips.length === 0) {
        throw new Error('Select at least one clip to download.');
    }

    const resolvedClips = [];

    for (const selected of selectedClips) {
        const clipIndex = Number.parseInt(selected.clipIndex, 10);
        if (!selected.transcriptId || !selected.videoId || !Number.isInteger(clipIndex)) {
            throw new Error('Invalid selected clip payload.');
        }

        const transcript = await Transcript.findById(selected.transcriptId);
        if (!transcript) {
            throw new Error('Selected transcript was not found.');
        }

        const normalizedClips = normalizeTranscriptClips(transcript);
        const clip = normalizedClips[clipIndex];
        if (!clip) {
            throw new Error(`Selected clip ${clipIndex + 1} was not found.`);
        }

        const primaryVideo = getPrimaryClipVideo(clip);
        if (!primaryVideo || primaryVideo.id !== selected.videoId) {
            throw new Error(`"${clip.title}" is no longer the current primary clip.`);
        }

        const filePath = getVideoFilePath(primaryVideo);
        if (!fs.existsSync(filePath)) {
            throw new Error(`File is missing for "${clip.title}".`);
        }

        resolvedClips.push({
            transcript,
            clip,
            clipIndex,
            primaryVideo,
            filePath
        });
    }

    return resolvedClips;
}

router.get('/primary', async (req, res) => {
    try {
        const transcripts = await Transcript.find({});
        const videos = buildPrimaryClipGroups(transcripts);
        const totalClips = videos.reduce((sum, video) => sum + video.clipCount, 0);

        res.json({
            videos,
            totalVideos: videos.length,
            totalClips
        });
    } catch (error) {
        console.error('Error fetching primary clips:', error);
        res.status(500).json({ error: 'Failed to fetch primary clips.' });
    }
});

router.post('/download-zip', async (req, res) => {
    try {
        let archiver;
        try {
            archiver = require('archiver');
        } catch (error) {
            return res.status(500).json({
                error: 'ZIP support is not installed on the backend.',
                details: 'Run npm install in the backend service and restart it.'
            });
        }

        const resolvedClips = await resolveSelectedPrimaryClips(req.body.clips);
        const archive = archiver('zip', { zlib: { level: 9 } });
        const usedNames = new Set();

        res.attachment('vinci-primary-clips.zip');
        archive.on('error', (error) => {
            console.error('Archive stream error:', error);
            res.destroy(error);
        });
        archive.pipe(res);

        resolvedClips.forEach(({ transcript, clip, clipIndex, primaryVideo, filePath }) => {
            const folder = sanitizeZipName(transcript.originalFilename || transcript._id, 'video');
            const clipName = sanitizeZipName(clip.title || primaryVideo.filename, `clip-${clipIndex + 1}`);
            const extension = path.extname(primaryVideo.filename || filePath) || '.mp4';
            let entryName = `${folder}/${String(clipIndex + 1).padStart(2, '0')}-${clipName}${extension}`;
            let duplicate = 2;

            while (usedNames.has(entryName)) {
                entryName = `${folder}/${String(clipIndex + 1).padStart(2, '0')}-${clipName}-${duplicate}${extension}`;
                duplicate += 1;
            }

            usedNames.add(entryName);
            archive.file(filePath, { name: entryName });
        });

        await archive.finalize();
    } catch (error) {
        console.error('Error creating clip zip:', error);
        if (!res.headersSent) {
            res.status(400).json({
                error: 'Failed to create clip ZIP.',
                details: error.message
            });
        } else {
            res.end();
        }
    }
});


// Generate actual video clips from analyzed clips
router.post('/generate/:transcriptId', async (req, res) => {
    const { transcriptId } = req.params;
    const requestedClipIndex = req.body.clipIndex !== undefined ? Number.parseInt(req.body.clipIndex, 10) : undefined;

    try {
        const transcript = await Transcript.findById(transcriptId);
        if (!transcript) {
            return res.status(404).json({ error: 'Transcript not found.' });
        }

        if (!transcript.clips || transcript.clips.length === 0) {
            return res.status(400).json({ error: 'No clips found. Run analysis first.' });
        }

        if (!Number.isInteger(requestedClipIndex)) {
            return res.status(400).json({ error: 'clipIndex is required for background clip generation.' });
        }

        if (requestedClipIndex < 0 || requestedClipIndex >= transcript.clips.length) {
            return res.status(400).json({
                error: `Invalid clip index. Must be between 0 and ${transcript.clips.length - 1}.`
            });
        }

        const updatedTranscript = await queueClipGeneration(transcript, transcriptId, requestedClipIndex);

        res.status(202).json({
            message: 'Clip generation accepted. Processing continues in the background.',
            transcript: updatedTranscript,
        });
    } catch (error) {
        console.error('Error starting clip generation:', error);
        res.status(500).json({
            error: 'Failed to start clip generation.',
            details: error.message,
        });
    }
});

router.post('/generate-batch/:transcriptId', async (req, res) => {
    const { transcriptId } = req.params;

    try {
        const transcript = await Transcript.findById(transcriptId);
        if (!transcript) {
            return res.status(404).json({ error: 'Transcript not found.' });
        }

        const normalizedClips = normalizeTranscriptClips(transcript);
        if (normalizedClips.length === 0) {
            return res.status(400).json({ error: 'No clips found. Run analysis first.' });
        }

        const requestedIndexes = Array.isArray(req.body.clipIndexes)
            ? req.body.clipIndexes.map(value => Number.parseInt(value, 10)).filter(Number.isInteger)
            : normalizedClips.map((_, index) => index);
        const limit = Number.isInteger(req.body.limit)
            ? Math.max(1, req.body.limit)
            : requestedIndexes.length;
        const uniqueIndexes = [...new Set(requestedIndexes)]
            .filter(index => index >= 0 && index < normalizedClips.length)
            .filter(index => {
                const clip = normalizedClips[index];
                const hasVideo = Boolean(getPrimaryClipVideo(clip));
                const active = Boolean(clip.generation && ['queued', 'running', 'cancelling'].includes(clip.generation.status));
                return !hasVideo && !active;
            })
            .slice(0, limit);

        let updatedTranscript = transcript;
        const queuedClipIndexes = [];
        for (const clipIndex of uniqueIndexes) {
            updatedTranscript = await queueClipGeneration(updatedTranscript, transcriptId, clipIndex);
            queuedClipIndexes.push(clipIndex);
        }

        res.status(202).json({
            message: queuedClipIndexes.length
                ? 'Batch clip generation accepted. Processing continues in the background.'
                : 'No missing clips needed generation.',
            queuedClipIndexes,
            transcript: updatedTranscript,
        });
    } catch (error) {
        console.error('Error starting batch clip generation:', error);
        res.status(error.status || 500).json({
            error: 'Failed to start batch clip generation.',
            details: error.message,
        });
    }
});

router.post('/:transcriptId/:clipIndex/cancel-generation', async (req, res) => {
    const { transcriptId } = req.params;
    const clipIndex = Number.parseInt(req.params.clipIndex, 10);

    try {
        const transcript = await Transcript.findById(transcriptId);
        if (!transcript) {
            return res.status(404).json({ error: 'Transcript not found.' });
        }

        const clip = transcript.clips?.[clipIndex];
        if (!clip) {
            return res.status(404).json({ error: 'Clip not found.' });
        }

        if (!clip.generation || !['queued', 'running', 'cancelling'].includes(clip.generation.status)) {
            return res.status(409).json({ error: 'Clip generation is not active.' });
        }

        const updatedTranscript = await requestClipCancel(transcriptId, clipIndex);
        res.status(200).json({
            message: 'Clip generation cancellation requested.',
            transcript: updatedTranscript,
        });
    } catch (error) {
        res.status(500).json({
            error: 'Failed to cancel clip generation.',
            details: error.message,
        });
    }
});

router.patch('/:transcriptId/:clipIndex/hook', async (req, res) => {
    const { transcriptId } = req.params;
    const clipIndex = Number.parseInt(req.params.clipIndex, 10);

    try {
        const transcript = await Transcript.findById(transcriptId);
        if (!transcript) {
            return res.status(404).json({ error: 'Transcript not found.' });
        }

        if (!Number.isInteger(clipIndex) || clipIndex < 0 || clipIndex >= (transcript.clips || []).length) {
            return res.status(400).json({ error: 'Invalid clip index.' });
        }

        const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
        const enabled = Boolean(req.body.enabled && text);
        const timeoutSeconds = req.body.timeoutSeconds ?? undefined;
        const normalizedClips = normalizeTranscriptClips(transcript);

        normalizedClips[clipIndex] = {
            ...normalizedClips[clipIndex],
            hook: normalizeClipHook({
                text,
                enabled,
                timeoutSeconds,
                updatedAt: new Date().toISOString()
            })
        };

        const updatedTranscript = await Transcript.findByIdAndUpdate(transcript._id, {
            clips: normalizedClips
        });
        const clips = normalizeTranscriptClips(updatedTranscript);

        res.json({
            success: true,
            clips,
            generatedClips: buildGeneratedClipsMap(clips)
        });
    } catch (error) {
        console.error('Error updating clip hook:', error);
        res.status(500).json({
            error: 'Failed to update clip hook.',
            details: error.message
        });
    }
});

router.post('/:transcriptId/:clipIndex/hook/regenerate', async (req, res) => {
    const { transcriptId } = req.params;
    const clipIndex = Number.parseInt(req.params.clipIndex, 10);

    try {
        const transcript = await Transcript.findById(transcriptId);
        if (!transcript) {
            return res.status(404).json({ error: 'Transcript not found.' });
        }

        const normalizedClips = normalizeTranscriptClips(transcript);
        if (!Number.isInteger(clipIndex) || clipIndex < 0 || clipIndex >= normalizedClips.length) {
            return res.status(400).json({ error: 'Invalid clip index.' });
        }

        const clip = normalizedClips[clipIndex];
        const coveredText = getCoveredTranscriptText(transcript.transcript, clip);
        if (!coveredText.trim()) {
            return res.status(400).json({
                error: 'Cannot regenerate hook.',
                details: 'No transcript text was found for this clip.'
            });
        }

        const currentHookText = typeof clip.hook?.text === 'string' ? clip.hook.text.trim() : '';
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const hookBody = await getActivePromptBody('hookRegen');
        const prompt = renderPrompt(hookBody, {
            currentHookText: currentHookText || 'none',
            clipTitle: clip.title || 'Untitled clip',
            clipTranscript: coveredText,
        });

        const { data, model: resolvedModel } = await generateJsonContent({
            genAI,
            logLabel: `Hook regeneration for ${transcriptId}:${clipIndex}`,
            contents: [{
                role: 'user',
                parts: [{ text: prompt }],
            }],
            responseSchema: HOOK_RESPONSE_SCHEMA,
            safetySettings: [
                {
                    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
                    threshold: HarmBlockThreshold.BLOCK_NONE,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                    threshold: HarmBlockThreshold.BLOCK_NONE,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                    threshold: HarmBlockThreshold.BLOCK_NONE,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                    threshold: HarmBlockThreshold.BLOCK_NONE,
                },
            ],
        });

        const hookText = typeof data?.hook === 'string'
            ? data.hook.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').slice(0, 120)
            : '';
        if (!hookText) {
            return res.status(502).json({
                error: 'Failed to regenerate hook.',
                details: 'The AI returned an empty hook.'
            });
        }

        console.log(`Hook regeneration for ${transcriptId}:${clipIndex} used Gemini model: ${resolvedModel}`);

        normalizedClips[clipIndex] = {
            ...clip,
            hook: normalizeClipHook({
                text: hookText,
                enabled: true,
                updatedAt: new Date().toISOString()
            })
        };

        const updatedTranscript = await Transcript.findByIdAndUpdate(transcript._id, {
            clips: normalizedClips
        });
        const clips = normalizeTranscriptClips(updatedTranscript);

        res.json({
            success: true,
            hook: clips[clipIndex].hook,
            clips,
            generatedClips: buildGeneratedClipsMap(clips)
        });
    } catch (error) {
        console.error('Error regenerating clip hook:', error);
        res.status(500).json({
            error: 'Failed to regenerate clip hook.',
            details: error.message
        });
    }
});

router.delete('/:transcriptId/:clipIndex/videos/:videoId', async (req, res) => {
    const { transcriptId, videoId } = req.params;
    const clipIndex = Number.parseInt(req.params.clipIndex, 10);

    try {
        const transcript = await Transcript.findById(transcriptId);
        if (!transcript) {
            return res.status(404).json({ error: 'Transcript not found.' });
        }

        if (!Number.isInteger(clipIndex) || clipIndex < 0 || clipIndex >= (transcript.clips || []).length) {
            return res.status(400).json({ error: 'Invalid clip index.' });
        }

        const updatedTranscript = await deleteClipVideoVersion(Transcript, transcript, clipIndex, videoId);
        if (!updatedTranscript) {
            return res.status(404).json({ error: 'Video version not found.' });
        }

        // Clear stale activeJob so the render indicator doesn't persist after deletion
        await updateClipActiveJob(transcriptId, clipIndex, { status: 'completed', completedAt: new Date().toISOString() }).catch(() => {});

        const clips = normalizeTranscriptClips(updatedTranscript);
        res.json({
            success: true,
            clips,
            generatedClips: buildGeneratedClipsMap(clips)
        });
    } catch (error) {
        console.error('Error deleting clip video version:', error);
        res.status(500).json({
            error: 'Failed to delete clip video version.',
            details: error.message
        });
    }
});

module.exports = router;
