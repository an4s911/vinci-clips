const express = require('express');
const Transcript = require('../models/Transcript');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
    CLIPS_DIR,
    appendPrimaryClipVideo,
    buildGeneratedClipsMap,
    createClipVideoRecord,
    deleteClipVideoVersion,
    getPrimaryClipVideo,
    getVideoFilePath,
    makeTimestampedFilename,
    normalizeTranscriptClips
} = require('../utils/clipVideos');

const router = express.Router();

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
                            captions: primaryVideo.captions
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


// Generate actual video clips from analyzed clips
router.post('/generate/:transcriptId', async (req, res) => {
    const { transcriptId } = req.params;
    const { clipIndex } = req.body; // Optional: generate specific clip by index
    const requestedClipIndex = clipIndex !== undefined ? Number.parseInt(clipIndex, 10) : undefined;

    try {
        // Validate transcript ID format

        const transcript = await Transcript.findById(transcriptId);
        if (!transcript) {
            return res.status(404).json({ error: 'Transcript not found.' });
        }

        if (!transcript.clips || transcript.clips.length === 0) {
            return res.status(400).json({ error: 'No clips found. Run analysis first.' });
        }

        // Validate clip index if provided
        if (requestedClipIndex !== undefined && (!Number.isInteger(requestedClipIndex) || requestedClipIndex < 0 || requestedClipIndex >= transcript.clips.length)) {
            return res.status(400).json({ 
                error: `Invalid clip index. Must be between 0 and ${transcript.clips.length - 1}.` 
            });
        }

        const clipsToGenerate = requestedClipIndex !== undefined ? [transcript.clips[requestedClipIndex]] : transcript.clips;
        const generatedClips = [];

        // Ensure clips directory exists
        const clipsDir = CLIPS_DIR;
        if (!fs.existsSync(clipsDir)) {
            fs.mkdirSync(clipsDir, { recursive: true });
        }

        for (let i = 0; i < clipsToGenerate.length; i++) {
            const clip = clipsToGenerate[i];
            const actualIndex = requestedClipIndex !== undefined ? requestedClipIndex : i;
            
            try {
                const outputFilename = makeTimestampedFilename(transcriptId, actualIndex);
                const outputPath = path.join(clipsDir, outputFilename);
                const clipUrl = `/uploads/clips/${outputFilename}`;
                
                // Use absolute path for the source video
                const videoPath = path.join(__dirname, '..', '..', 'uploads', path.basename(transcript.videoUrl));

                let ffmpegCmd;
                
                if (clip.segments && clip.segments.length > 0) {
                    // Multi-segment clip - need to concatenate segments
                    const segmentFiles = [];
                    
                    for (let j = 0; j < clip.segments.length; j++) {
                        const segment = clip.segments[j];
                        const segmentPath = path.join(clipsDir, `${transcriptId}_clip_${actualIndex}_${Date.now()}_segment_${j}.mp4`);
                        
                        const segmentCmd = `ffmpeg -i "${videoPath}" -ss ${segment.start} -t ${segment.end - segment.start} "${segmentPath}"`;
                        
                        await new Promise((resolve, reject) => {
                            exec(segmentCmd, (error) => {
                                if (error) reject(error);
                                else resolve();
                            });
                        });
                        
                        segmentFiles.push(segmentPath);
                    }
                    
                    // Create concat file for FFmpeg
                    const concatFilePath = path.join(clipsDir, `${transcriptId}_clip_${actualIndex}_${Date.now()}_concat.txt`);
                    const concatContent = segmentFiles.map(file => `file '${path.resolve(file)}'`).join('\n');
                    fs.writeFileSync(concatFilePath, concatContent);
                    
                    // Concatenate segments
                    ffmpegCmd = `ffmpeg -f concat -safe 0 -i "${concatFilePath}" -c copy "${outputPath}"`;
                    
                    await new Promise((resolve, reject) => {
                        exec(ffmpegCmd, (error) => {
                            if (error) reject(error);
                            else resolve();
                        });
                    });
                    
                    // Cleanup segment files and concat file
                    segmentFiles.forEach(file => fs.unlink(file, () => {}));
                    fs.unlink(concatFilePath, () => {});
                    
                } else if (clip.start !== undefined && clip.end !== undefined) {
                    // Single segment clip
                    const duration = clip.end - clip.start;
                    ffmpegCmd = `ffmpeg -i "${videoPath}" -ss ${clip.start} -t ${duration} "${outputPath}"`;
                    
                    await new Promise((resolve, reject) => {
                        exec(ffmpegCmd, (error) => {
                            if (error) reject(error);
                            else resolve();
                        });
                    });
                }

                const videoRecord = createClipVideoRecord({
                    type: 'generated',
                    url: clipUrl,
                    filename: outputFilename
                });
                await appendPrimaryClipVideo(Transcript, transcript, actualIndex, videoRecord);

                generatedClips.push({
                    index: actualIndex,
                    title: clip.title,
                    ...videoRecord,
                    url: clipUrl,
                    localPath: outputPath
                });

            } catch (clipError) {
                console.error(`Error generating clip ${actualIndex}:`, clipError);
                // Return more specific error information
                return res.status(500).json({ 
                    error: `Failed to generate clip ${actualIndex + 1}`,
                    details: clipError.message,
                    clipIndex: actualIndex
                });
            }
        }

        // Cleanup temp video file

        if (generatedClips.length === 0) {
            return res.status(500).json({ error: 'Failed to generate any clips.' });
        }

        res.json({
            message: `Generated ${generatedClips.length} clip(s) successfully.`,
            clips: generatedClips,
            generatedClips: buildGeneratedClipsMap(normalizeTranscriptClips(transcript))
        });

    } catch (error) {
        console.error('Error generating clips:', error);
        res.status(500).json({ error: 'Failed to generate clips.' });
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
