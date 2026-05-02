const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const Transcript = require('../models/Transcript');
const logger = require('../utils/logger');
const { moveFileSafe, renderCaptionedVideo } = require('../utils/captioning');
const {
    appendPrimaryClipVideo,
    buildGeneratedClipsMap,
    createClipVideoRecord,
    getPrimaryClipVideo,
    makeTimestampedFilename,
    normalizeTranscriptClips
} = require('../utils/clipVideos');
const { deleteLocalMedia } = require('../utils/mediaStorage');

const router = express.Router();

const upload = multer({
    dest: 'uploads/temp/',
    limits: { fileSize: 100 * 1024 * 1024 }
});

const ASPECT_RATIOS = {
    'tiktok': { width: 9, height: 16, name: 'TikTok/Shorts' },
    'instagram': { width: 1, height: 1, name: 'Instagram Square' },
    'youtube': { width: 16, height: 9, name: 'YouTube Landscape' },
    'story': { width: 9, height: 16, name: 'Instagram/Facebook Story' }
};

// --- Time Conversion Helpers ---
function timeToSeconds(timeStr) {
    if (!timeStr) return 0;
    const parts = String(timeStr).split(':');
    const minutes = parseInt(parts[0]) || 0;
    const seconds = parseInt(parts[1]) || 0;
    const milliseconds = parseInt(parts[2]) || 0;
    return minutes * 60 + seconds + (milliseconds / 1000);
}

// --- Smart Cropping Logic ---

/**
 * Calculates an optimal 9:16 crop window for a single face.
 * @param {object} face - A single face detection object with a boundingBox.
 * @param {object} videoDimensions - The original video's width and height.
 * @returns {object} The calculated crop parameters {x, y, width, height}.
 */
function getTargetAspect(targetRatio) {
    return targetRatio.width / targetRatio.height;
}

function roundEven(value) {
    return Math.max(2, Math.floor(value / 2) * 2);
}

function calculateCenterCrop(videoDimensions, targetRatio) {
    const { width: videoWidth, height: videoHeight } = videoDimensions;
    const targetAspect = getTargetAspect(targetRatio);
    const videoAspect = videoWidth / videoHeight;

    let cropWidth;
    let cropHeight;

    if (videoAspect > targetAspect) {
        cropHeight = videoHeight;
        cropWidth = cropHeight * targetAspect;
    } else {
        cropWidth = videoWidth;
        cropHeight = cropWidth / targetAspect;
    }

    const width = roundEven(cropWidth);
    const height = roundEven(cropHeight);
    const x = roundEven((videoWidth - width) / 2);
    const y = roundEven((videoHeight - height) / 2);

    return { width, height, x, y };
}

function calculateCropForFace(face, videoDimensions, targetRatio) {
    const { width: videoWidth, height: videoHeight } = videoDimensions;
    const targetAspect = getTargetAspect(targetRatio);

    // Increased padding for a more cinematic, less tight shot
    const PADDING_FACTOR = 2.5; 

    const faceWidth = face.boundingBox.width * videoWidth;
    const faceHeight = face.boundingBox.height * videoHeight;
    const faceCenterX = (face.boundingBox.left * videoWidth) + (faceWidth / 2);
    const faceCenterY = (face.boundingBox.top * videoHeight) + (faceHeight / 2);

    let cropHeight, cropWidth, cropX, cropY;

    // Determine crop dimensions based on face height and padding
    cropHeight = Math.min(faceHeight * PADDING_FACTOR, videoHeight);
    cropWidth = cropHeight * targetAspect;

    // Center the crop on the face, with a slight vertical offset for headroom
    cropX = faceCenterX - cropWidth / 2;
    cropY = faceCenterY - cropHeight / 2 - (faceHeight * 0.2);

    // Ensure the crop window stays within the video boundaries
    cropWidth = Math.min(cropWidth, videoWidth);
    cropHeight = Math.min(cropHeight, videoHeight);
    cropX = Math.max(0, Math.min(cropX, videoWidth - cropWidth));
    cropY = Math.max(0, Math.min(cropY, videoHeight - cropHeight));

    // Return dimensions rounded to the nearest even number for FFmpeg compatibility
    return {
        width: roundEven(cropWidth),
        height: roundEven(cropHeight),
        x: roundEven(cropX),
        y: roundEven(cropY),
    };
}

/**
 * Generates a dynamic FFmpeg filter to follow the active person on screen.
 * @param {Array} allDetections - Array of all face detections from the frontend.
 * @param {object} videoDimensions - The original video's width and height.
 * @returns {string|null} The complex FFmpeg filter string.
 */
function generateVisualDirectorFilter(allDetections, videoDimensions, targetRatio) {
    if (!allDetections || allDetections.length === 0) {
        logger.warn('Cannot generate visual director cut: no detections provided.');
        return null;
    }

    // 1. Group detections by timestamp
    const detectionsByTime = allDetections.reduce((acc, detection) => {
        const time = detection.time.toFixed(1); // Group by 100ms intervals
        if (!acc[time]) acc[time] = [];
        acc[time].push(detection);
        return acc;
    }, {});

    // 2. Determine the "protagonist" (most central face) for each timestamp
    const protagonistTimeline = Object.entries(detectionsByTime).map(([time, detections]) => {
        let protagonist = detections[0];
        if (detections.length > 1) {
            // Find the face closest to the center of the frame
            protagonist = detections.reduce((prev, curr) => {
                const prevCenterDist = Math.abs(0.5 - (prev.boundingBox.left + prev.boundingBox.width / 2));
                const currCenterDist = Math.abs(0.5 - (curr.boundingBox.left + curr.boundingBox.width / 2));
                return currCenterDist < prevCenterDist ? curr : prev;
            });
        }
        return { time: parseFloat(time), id: protagonist.id, detection: protagonist };
    });

    // 3. Create "scenes" based on who the protagonist is
    const scenes = [];
    if (protagonistTimeline.length > 0) {
        let currentScene = { id: protagonistTimeline[0].id, startTime: protagonistTimeline[0].time, detections: [] };
        protagonistTimeline.forEach((p, i) => {
            if (p.id !== currentScene.id) {
                currentScene.endTime = p.time;
                scenes.push(currentScene);
                currentScene = { id: p.id, startTime: p.time, detections: [p.detection] };
            } else {
                currentScene.detections.push(p.detection);
            }
        });
        currentScene.endTime = protagonistTimeline[protagonistTimeline.length - 1].time;
        scenes.push(currentScene);
    }

    // 4. Calculate the average, stable crop for each scene
    const sceneCrops = scenes.map(scene => {
        const avgX = scene.detections.reduce((sum, d) => sum + d.boundingBox.left, 0) / scene.detections.length;
        const avgY = scene.detections.reduce((sum, d) => sum + d.boundingBox.top, 0) / scene.detections.length;
        const avgW = scene.detections.reduce((sum, d) => sum + d.boundingBox.width, 0) / scene.detections.length;
        const avgH = scene.detections.reduce((sum, d) => sum + d.boundingBox.height, 0) / scene.detections.length;
        
        const avgDetection = { boundingBox: { left: avgX, top: avgY, width: avgW, height: avgH }};
        return {
            ...scene,
            crop: calculateCropForFace(avgDetection, videoDimensions, targetRatio)
        };
    });

    if (sceneCrops.length === 0) {
        logger.warn('No scenes could be generated from detections.');
        return null;
    }

    // 5. Build the FFmpeg filter string with smooth transitions
    const TRANSITION_DURATION = 0.5; // seconds
    const initialCrop = sceneCrops[0].crop;

    let xExpr = `'if(lt(t,${sceneCrops[0].startTime}),${initialCrop.x},
`;
    let yExpr = `'if(lt(t,${sceneCrops[0].startTime}),${initialCrop.y},
`;

    for (let i = 0; i < sceneCrops.length; i++) {
        const current = sceneCrops[i];
        const next = sceneCrops[i + 1];

        if (next) {
            const transitionStart = current.endTime;
            const transitionEnd = current.endTime + TRANSITION_DURATION;
            // Linear interpolation for smooth transition
            const xPan = `(${current.crop.x}+(${next.crop.x}-${current.crop.x})*(t-${transitionStart})/${TRANSITION_DURATION})`;
            const yPan = `(${current.crop.y}+(${next.crop.y}-${current.crop.y})*(t-${transitionStart})/${TRANSITION_DURATION})`;

            xExpr += `if(between(t,${current.startTime},${transitionStart}),${current.crop.x}, if(between(t,${transitionStart},${transitionEnd}),${xPan},
`;
            yExpr += `if(between(t,${current.startTime},${transitionStart}),${current.crop.y}, if(between(t,${transitionStart},${transitionEnd}),${yPan},
`;
        } else {
            // Last scene, hold the crop
            xExpr += `${current.crop.x}`;
            yExpr += `${current.crop.y}`;
        }
    }
    
    xExpr += ')'.repeat(sceneCrops.length * 2 - 1) + `'`;
    yExpr += ')'.repeat(sceneCrops.length * 2 - 1) + `'`;

    const initialCropRounded = sceneCrops[0].crop;
    const filterString = `crop=w=${initialCropRounded.width}:h=${initialCropRounded.height}:x=${xExpr}:y=${yExpr}`;
    
    logger.info('Generated Visual Director Filter String:', { length: filterString.length });
    return filterString;
}

function buildStaticCropFilter(cropParameters) {
    return `crop=${cropParameters.width}:${cropParameters.height}:${cropParameters.x}:${cropParameters.y}`;
}

function getAssetKey(transcript, generatedClipUrl) {
    return generatedClipUrl || transcript.videoUrl;
}

function getAssetState(transcript, generatedClipUrl) {
    const assetKey = getAssetKey(transcript, generatedClipUrl);
    const reframeAssets = transcript.reframeAssets || {};
    return {
        assetKey,
        reframeAssets,
        assetState: reframeAssets[assetKey] || { detections: [], analyses: {} }
    };
}

async function persistAssetState(transcript, generatedClipUrl, updater) {
    const { assetKey, reframeAssets, assetState } = getAssetState(transcript, generatedClipUrl);
    const nextState = updater(assetState);
    const nextAssets = {
        ...reframeAssets,
        [assetKey]: nextState
    };
    await Transcript.findByIdAndUpdate(transcript._id, {
        reframeAssets: nextAssets
    });
    transcript.reframeAssets = nextAssets;
    return nextState;
}


// --- Express Routes ---
router.post('/generate', async (req, res) => {
    try {
        const { transcriptId, targetPlatform, detections, outputName, generatedClipUrl, cropParameters, captions, hook, clipDefinition, clipIndex, processingMode, sourceVideoId } = req.body;
        const captionsOnly = processingMode === 'captions-only';
        const hookText = typeof hook?.text === 'string' ? hook.text.trim() : '';
        const normalizedHook = {
            enabled: Boolean(hook?.enabled && hookText),
            text: hookText || undefined
        };
        const hasOverlay = Boolean(captions?.enabled || normalizedHook.enabled);
        
        if (!transcriptId || !targetPlatform) {
            return res.status(400).json({ error: 'Required parameters are missing' });
        }
        if (captionsOnly && !hasOverlay) {
            return res.status(400).json({ error: 'Enable captions or a top hook to keep the original frame.' });
        }
        
        const transcript = await Transcript.findById(transcriptId);
        if (!transcript || !transcript.videoUrl) {
            return res.status(404).json({ error: 'Transcript or video not found' });
        }
        
        const targetRatio = ASPECT_RATIOS[targetPlatform];
        if (!targetRatio) return res.status(400).json({ error: 'Invalid target platform' });

        const parsedClipIndex = Number.isInteger(clipIndex) ? clipIndex : Number.parseInt(clipIndex, 10);
        const shouldAttachToClip = generatedClipUrl || Number.isInteger(parsedClipIndex);
        if (generatedClipUrl && !Number.isInteger(parsedClipIndex)) {
            return res.status(400).json({ error: 'clipIndex is required when reframing a generated clip' });
        }
        if (Number.isInteger(parsedClipIndex) && (parsedClipIndex < 0 || parsedClipIndex >= (transcript.clips || []).length)) {
            return res.status(400).json({ error: 'Invalid clip index' });
        }
        
        const videoUrlToUse = generatedClipUrl || transcript.videoUrl;
        const tempVideoPath = path.join(__dirname, '..', '..', generatedClipUrl ? videoUrlToUse.substring(1) : `uploads/${path.basename(videoUrlToUse)}`);
        
        const outputBaseName = (outputName || `${transcript.originalFilename.replace(/\.[^.]+$/, '')}_${targetPlatform}_reframed`)
            .replace(/\.mp4$/i, '')
            .replace(/[/\\:*?"<>|]/g, '_');
        const sanitizedOutputName = Number.isInteger(parsedClipIndex)
            ? makeTimestampedFilename(transcriptId, parsedClipIndex, captionsOnly ? '_overlay' : '_reframed')
            : `${outputBaseName}_${Date.now()}.mp4`;
        const outputPath = path.join('uploads/temp', sanitizedOutputName);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });

        let finalSourcePath = outputPath;

        if (!captionsOnly) {
            const videoDimensions = await new Promise((resolve, reject) => {
                ffmpeg.ffprobe(tempVideoPath, (err, metadata) => {
                    if (err) return reject(err);
                    const s = metadata.streams.find(s => s.codec_type === 'video');
                    resolve({ width: s.width, height: s.height });
                });
            });

            const { assetState } = getAssetState(transcript, generatedClipUrl);
            const resolvedDetections = Array.isArray(detections) && detections.length > 0
                ? detections
                : (assetState.detections || []);
            const resolvedCropParameters = cropParameters
                || assetState.analyses?.[targetPlatform]?.cropParameters
                || calculateCenterCrop(videoDimensions, targetRatio);
            const cropFilter = resolvedDetections.length > 0
                ? generateVisualDirectorFilter(resolvedDetections, videoDimensions, targetRatio)
                : buildStaticCropFilter(resolvedCropParameters);

            await new Promise((resolve, reject) => {
                ffmpeg(tempVideoPath)
                    .videoFilters(cropFilter)
                    .outputOptions(['-c:v libx264', '-crf 23', '-preset medium', '-c:a aac', '-b:a 128k'])
                    .output(outputPath)
                    .on('progress', (progress) => logger.info(`Processing: ${progress.percent}% done`))
                    .on('end', resolve)
                    .on('error', reject)
                    .run();
            });
        }

        if (hasOverlay) {
            const captionedOutputPath = path.join('uploads', 'temp', `captioned_${sanitizedOutputName}`);
            await renderCaptionedVideo({
                inputPath: captionsOnly ? tempVideoPath : outputPath,
                outputPath: captionedOutputPath,
                transcriptSegments: transcript.transcript,
                styleId: captions.style,
                clipDefinition,
                captionsEnabled: Boolean(captions?.enabled),
                hook: normalizedHook,
                logger
            });
            if (!captionsOnly) {
                await deleteLocalMedia(outputPath, { missingOk: true });
            }
            finalSourcePath = captionedOutputPath;
        }
        
        const reframedDestPath = path.join('uploads', 'clips', 'reframed', sanitizedOutputName);
        fs.mkdirSync(path.dirname(reframedDestPath), { recursive: true });
        moveFileSafe(finalSourcePath, reframedDestPath);
        const reframedUrl = `/uploads/clips/reframed/${sanitizedOutputName}`;
        let reframedVideo = {
            filename: sanitizedOutputName,
            url: reframedUrl,
            platform: captionsOnly ? null : targetPlatform,
            platformName: captionsOnly ? 'Original frame' : targetRatio.name,
            aspectRatio: captionsOnly ? null : `${targetRatio.width}:${targetRatio.height}`,
            captions: captions?.enabled
                ? { enabled: true, style: captions.style }
                : { enabled: false },
            hook: normalizedHook.enabled
                ? normalizedHook
                : { enabled: false }
        };

        if (shouldAttachToClip && Number.isInteger(parsedClipIndex)) {
            const normalizedClips = normalizeTranscriptClips(transcript);
            const sourceClip = normalizedClips[parsedClipIndex];
            const sourceVideo = sourceClip.videos?.find(video => video.id === sourceVideoId)
                || sourceClip.videos?.find(video => video.url === generatedClipUrl)
                || getPrimaryClipVideo(sourceClip);
            const videoRecord = createClipVideoRecord({
                type: 'reframed',
                url: reframedUrl,
                filename: sanitizedOutputName,
                sourceVideoId: sourceVideo?.id || null,
                platform: captionsOnly ? null : targetPlatform,
                platformName: captionsOnly ? 'Original frame' : targetRatio.name,
                aspectRatio: captionsOnly ? null : `${targetRatio.width}:${targetRatio.height}`,
                captions: reframedVideo.captions,
                hook: reframedVideo.hook
            });

            await appendPrimaryClipVideo(Transcript, transcript, parsedClipIndex, videoRecord);
            reframedVideo = {
                ...reframedVideo,
                ...videoRecord
            };
        }

        res.json({
            success: true,
            reframedVideo,
            generatedClips: buildGeneratedClipsMap(normalizeTranscriptClips(transcript))
        });
        
    } catch (error) {
        logger.logError(error, { context: 'reframe_generation' });
        res.status(500).json({ error: 'Failed to generate reframed video', details: error.message });
    }
});

// This is a simplified preview endpoint. A full implementation would need to calculate
// the crop for the specific timestamp requested.
router.post('/analyze', async (req, res) => {
    try {
        const { detections, targetPlatform, transcriptId, generatedClipUrl } = req.body;
        if (!transcriptId) return res.status(400).json({ error: 'Transcript ID is required' });
        const transcript = await Transcript.findById(transcriptId);
        if (!transcript) return res.status(404).json({ error: 'Transcript not found' });
        const videoUrlToUse = generatedClipUrl || transcript.videoUrl;
        if (!videoUrlToUse) return res.status(404).json({ error: 'Video not found' });
        const videoPath = path.join(__dirname, '..', '..', generatedClipUrl ? videoUrlToUse.substring(1) : `uploads/${path.basename(videoUrlToUse)}`);
        
        const videoDimensions = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(videoPath, (err, metadata) => {
                if (err) return reject(err);
                const s = metadata.streams.find(s => s.codec_type === 'video');
                resolve({ width: s.width, height: s.height });
            });
        });
        
        const targetRatio = ASPECT_RATIOS[targetPlatform];
        const parsedDetections = typeof detections === 'string' ? JSON.parse(detections) : detections;
        const hasDetections = Array.isArray(parsedDetections) && parsedDetections.length > 0;
        const cropParams = hasDetections
            ? calculateCropForFace(parsedDetections[0], videoDimensions, targetRatio)
            : calculateCenterCrop(videoDimensions, targetRatio);

        const previewPath = await generatePreviewFrame(videoPath, cropParams);
        const previewsDir = path.join('uploads', 'previews');
        fs.mkdirSync(previewsDir, { recursive: true });
        const previewUrl = `/uploads/previews/${path.basename(previewPath)}`;
        moveFileSafe(previewPath, path.join(previewsDir, path.basename(previewPath)));

        const savedState = await persistAssetState(transcript, generatedClipUrl, (assetState) => ({
            ...assetState,
            detections: hasDetections ? parsedDetections : (assetState.detections || []),
            analyses: {
                ...(assetState.analyses || {}),
                [targetPlatform]: {
                    cropParameters: cropParams,
                    previewUrl,
                    mode: hasDetections ? 'detection' : 'center',
                    updatedAt: new Date().toISOString()
                }
            }
        }));
        
        res.json({
            success: true,
            analysis: {
                cropParameters: cropParams,
                previewUrl,
                mode: hasDetections ? 'detection' : 'center'
            },
            savedAsset: savedState
        });
        
    } catch (error) {
        logger.logError(error, { context: 'reframe_analysis' });
        res.status(500).json({ error: 'Failed to analyze video', details: error.message });
    }
});


async function generatePreviewFrame(videoPath, cropParams, timestamp = 2) {
    return new Promise((resolve, reject) => {
        const previewPath = path.join('uploads/temp', `preview_${Date.now()}.jpg`);
        ffmpeg(videoPath)
            .seekInput(timestamp)
            .frames(1)
            .videoFilters([`crop=${cropParams.width}:${cropParams.height}:${cropParams.x}:${cropParams.y}`, 'scale=400:-1'])
            .output(previewPath)
            .on('end', () => resolve(previewPath))
            .on('error', reject)
            .run();
    });
}

module.exports = router;
