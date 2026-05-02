const express = require('express');
const Transcript = require('../models/Transcript');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { generateJsonContent } = require('../utils/gemini');
const {
    CLIPS_DIR,
    appendPrimaryClipVideo,
    buildGeneratedClipsMap,
    createClipVideoRecord,
    deleteClipVideoVersion,
    getPrimaryClipVideo,
    getVideoFilePath,
    makeTimestampedFilename,
    normalizeClipHook,
    normalizeTranscriptClips
} = require('../utils/clipVideos');
const { getCoveredTranscriptText } = require('../utils/clipModeration');
const {
    assertClipNotCancelled,
    completeClipGeneration,
    createJobState,
    logVideoProcessing,
    markClipPhase,
    requestClipCancel,
    runTrackedCommand,
    startClipWorker,
    updateClipGeneration
} = require('../utils/backgroundJobs');
const { deleteLocalMedia } = require('../utils/mediaStorage');

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


async function generateSingleClipInBackground(transcriptId, clipIndex) {
    let transcript = await Transcript.findById(transcriptId);
    const clip = transcript?.clips?.[clipIndex];
    if (!transcript || !clip) {
        throw new Error('Clip not found.');
    }

    const clipsDir = CLIPS_DIR;
    if (!fs.existsSync(clipsDir)) {
        fs.mkdirSync(clipsDir, { recursive: true });
    }

    await assertClipNotCancelled(transcriptId, clipIndex);
    await markClipPhase(transcriptId, clipIndex, 'prepare', 'Preparing clip generation.');
    const outputFilename = makeTimestampedFilename(transcriptId, clipIndex);
    const outputPath = path.join(clipsDir, outputFilename);
    const clipUrl = `/uploads/clips/${outputFilename}`;
    const videoPath = path.join(__dirname, '..', '..', 'uploads', path.basename(transcript.videoUrl));

    if (!fs.existsSync(videoPath)) {
        throw new Error('Source video file is missing.');
    }

    if (clip.segments && clip.segments.length > 0) {
        const segmentFiles = [];
        const concatFilePath = path.join(clipsDir, `${transcriptId}_clip_${clipIndex}_${Date.now()}_concat.txt`);

        try {
            for (let j = 0; j < clip.segments.length; j++) {
                await assertClipNotCancelled(transcriptId, clipIndex);
                const segment = clip.segments[j];
                const phase = `cut-segment-${j + 1}`;
                const segmentPath = path.join(clipsDir, `${transcriptId}_clip_${clipIndex}_${Date.now()}_segment_${j}.mp4`);
                const duration = segment.end - segment.start;

                await markClipPhase(transcriptId, clipIndex, phase, `Cutting segment ${j + 1}/${clip.segments.length}.`, {
                    segmentIndex: j + 1,
                    segmentCount: clip.segments.length,
                });
                await runTrackedCommand({
                    transcriptId,
                    clipIndex,
                    jobType: 'clip-generation',
                    phase,
                    command: `ffmpeg -y -i "${videoPath}" -ss ${segment.start} -t ${duration} "${segmentPath}"`
                });
                segmentFiles.push(segmentPath);
            }

            await assertClipNotCancelled(transcriptId, clipIndex);
            await markClipPhase(transcriptId, clipIndex, 'stitch-segments', 'Stitching generated segments.', {
                segmentCount: clip.segments.length,
            });
            const concatContent = segmentFiles.map(file => `file '${path.resolve(file)}'`).join('\n');
            fs.writeFileSync(concatFilePath, concatContent);
            await runTrackedCommand({
                transcriptId,
                clipIndex,
                jobType: 'clip-generation',
                phase: 'stitch-segments',
                command: `ffmpeg -y -f concat -safe 0 -i "${concatFilePath}" -c copy "${outputPath}"`
            });
        } finally {
            await markClipPhase(transcriptId, clipIndex, 'cleanup-temp', 'Cleaning up temporary segment files.');
            await Promise.all([
                ...segmentFiles.map(file => deleteLocalMedia(file, { missingOk: true })),
                deleteLocalMedia(concatFilePath, { missingOk: true }),
            ]);
            logVideoProcessing(transcriptId, 'completed', 'Clip generation temp cleanup completed', {
                jobType: 'clip-generation',
                clipIndex,
                phase: 'cleanup-temp',
                segmentCount: segmentFiles.length,
            });
        }
    } else if (clip.start !== undefined && clip.end !== undefined) {
        await assertClipNotCancelled(transcriptId, clipIndex);
        await markClipPhase(transcriptId, clipIndex, 'cut-segment', 'Cutting clip segment.');
        const duration = clip.end - clip.start;
        await runTrackedCommand({
            transcriptId,
            clipIndex,
            jobType: 'clip-generation',
            phase: 'cut-segment',
            command: `ffmpeg -y -i "${videoPath}" -ss ${clip.start} -t ${duration} "${outputPath}"`
        });
    } else {
        throw new Error('Clip does not contain valid timing data.');
    }

    await assertClipNotCancelled(transcriptId, clipIndex);
    await markClipPhase(transcriptId, clipIndex, 'save-video', 'Saving generated clip.');
    transcript = await Transcript.findById(transcriptId);
    const videoRecord = createClipVideoRecord({
        type: 'generated',
        url: clipUrl,
        filename: outputFilename,
        hook: { enabled: false }
    });
    await appendPrimaryClipVideo(Transcript, transcript, clipIndex, videoRecord);
    await completeClipGeneration(transcriptId, clipIndex, clipUrl);
}

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

        const clip = transcript.clips[requestedClipIndex];
        if (clip.generation && ['queued', 'running', 'cancelling'].includes(clip.generation.status)) {
            return res.status(409).json({ error: 'Clip generation is already active for this clip.' });
        }

        const updatedTranscript = await updateClipGeneration(transcriptId, requestedClipIndex, createJobState({
            status: 'queued',
            phase: 'prepare',
            progressMessage: 'Clip generation queued.',
        }));

        const started = startClipWorker(transcriptId, requestedClipIndex, () => generateSingleClipInBackground(transcriptId, requestedClipIndex));
        if (!started) {
            return res.status(409).json({ error: 'Clip generation is already active for this clip.' });
        }

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
        const normalizedClips = normalizeTranscriptClips(transcript);

        normalizedClips[clipIndex] = {
            ...normalizedClips[clipIndex],
            hook: normalizeClipHook({
                text,
                enabled,
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
        const prompt = `Create one new short creator overlay hook for this video clip.

Rules:
- Return a hook only, not a title or explanation.
- 3-10 words.
- Write it like YouTube Shorts/TikTok top-overlay setup text, not a polished title.
- Make viewers want to see what happens next, not understand the whole clip.
- Use casual, punchy, creator-style phrasing.
- Prefer setup lines, cliffhangers, reaction teases, bold claims, or occasional questions.
- Questions are allowed, but most hooks should be statements unless the clip naturally fits a question.
- Avoid generic summaries like "A funny moment from the video" or "Discussion about gaming strategy".
- Do not use title case unless it naturally fits the phrase.
- Good hook examples:
  - "look what this guy did:"
  - "he instantly regretted this"
  - "this should not have worked"
  - "wait for his reaction"
  - "then everything changed"
  - "a $5 mouse can do this?"
  - "bro thought he had it"
  - "this got awkward fast"
  - "nobody expected that ending"
  - "he said it too early"
- Avoid reusing this current hook: "${currentHookText || 'none'}"

Clip title: ${clip.title || 'Untitled clip'}
Clip transcript: ${coveredText}`;

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
