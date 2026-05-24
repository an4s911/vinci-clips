/**
 * Standalone render functions for BullMQ clip-render jobs.
 * Bodies extracted verbatim from the worker closures that were inline in:
 *   - backend/src/routes/reframe.js   /generate
 *   - backend/src/routes/captions.js  /render-clip
 *
 * CAVEAT: a clip-render job retried mid-appendPrimaryClipVideo may append a
 * duplicate clip version. Acceptable for now.
 */

const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const Transcript = require('../models/Transcript');
const logger = require('../utils/logger');
const {
    getCaptionStylesForClient,
    moveFileSafe,
    renderCaptionedVideo,
    buildWordsForClip,
    normalizeTranscriptWords,
} = require('../utils/captioning');
const {
    appendPrimaryClipVideo,
    clipThumbnailUrl,
    createClipVideoRecord,
    generateClipThumbnail,
    getPrimaryClipVideo,
    normalizeTranscriptClips,
} = require('../utils/clipVideos');
const {
    assertClipNotCancelled,
    makeStaleResourceError,
    setActiveClipRenderCommand,
    updateClipActiveJob,
    nowIso,
} = require('../utils/backgroundJobs');

// ─── Reframe helpers (copied from reframe.js) ────────────────────────────────

const ASPECT_RATIOS = {
    tiktok: { width: 9, height: 16, name: 'TikTok/Shorts' },
    instagram: { width: 1, height: 1, name: 'Instagram Square' },
    youtube: { width: 16, height: 9, name: 'YouTube Landscape' },
    story: { width: 9, height: 16, name: 'Instagram/Facebook Story' },
};

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
    let cropWidth, cropHeight;
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
    const PADDING_FACTOR = 2.5;
    const faceWidth = face.boundingBox.width * videoWidth;
    const faceHeight = face.boundingBox.height * videoHeight;
    const faceCenterX = (face.boundingBox.left * videoWidth) + (faceWidth / 2);
    const faceCenterY = (face.boundingBox.top * videoHeight) + (faceHeight / 2);
    let cropHeight = Math.min(faceHeight * PADDING_FACTOR, videoHeight);
    let cropWidth = cropHeight * targetAspect;
    let cropX = faceCenterX - cropWidth / 2;
    let cropY = faceCenterY - cropHeight / 2 - (faceHeight * 0.2);
    cropWidth = Math.min(cropWidth, videoWidth);
    cropHeight = Math.min(cropHeight, videoHeight);
    cropX = Math.max(0, Math.min(cropX, videoWidth - cropWidth));
    cropY = Math.max(0, Math.min(cropY, videoHeight - cropHeight));
    return { width: roundEven(cropWidth), height: roundEven(cropHeight), x: roundEven(cropX), y: roundEven(cropY) };
}

function generateVisualDirectorFilter(allDetections, videoDimensions, targetRatio) {
    if (!allDetections || allDetections.length === 0) return null;
    const detectionsByTime = allDetections.reduce((acc, detection) => {
        const time = detection.time.toFixed(1);
        if (!acc[time]) acc[time] = [];
        acc[time].push(detection);
        return acc;
    }, {});
    const protagonistTimeline = Object.entries(detectionsByTime).map(([time, detections]) => {
        let protagonist = detections[0];
        if (detections.length > 1) {
            protagonist = detections.reduce((prev, curr) => {
                const prevCenterDist = Math.abs(0.5 - (prev.boundingBox.left + prev.boundingBox.width / 2));
                const currCenterDist = Math.abs(0.5 - (curr.boundingBox.left + curr.boundingBox.width / 2));
                return currCenterDist < prevCenterDist ? curr : prev;
            });
        }
        return { time: parseFloat(time), id: protagonist.id, detection: protagonist };
    });
    const scenes = [];
    if (protagonistTimeline.length > 0) {
        let currentScene = { id: protagonistTimeline[0].id, startTime: protagonistTimeline[0].time, detections: [] };
        protagonistTimeline.forEach((p) => {
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
    const sceneCrops = scenes.map(scene => {
        const avgX = scene.detections.reduce((sum, d) => sum + d.boundingBox.left, 0) / scene.detections.length;
        const avgY = scene.detections.reduce((sum, d) => sum + d.boundingBox.top, 0) / scene.detections.length;
        const avgW = scene.detections.reduce((sum, d) => sum + d.boundingBox.width, 0) / scene.detections.length;
        const avgH = scene.detections.reduce((sum, d) => sum + d.boundingBox.height, 0) / scene.detections.length;
        const avgDetection = { boundingBox: { left: avgX, top: avgY, width: avgW, height: avgH } };
        return { ...scene, crop: calculateCropForFace(avgDetection, videoDimensions, targetRatio) };
    });
    if (sceneCrops.length === 0) return null;
    const TRANSITION_DURATION = 0.5;
    const initialCrop = sceneCrops[0].crop;
    let xExpr = `'if(lt(t,${sceneCrops[0].startTime}),${initialCrop.x},\n`;
    let yExpr = `'if(lt(t,${sceneCrops[0].startTime}),${initialCrop.y},\n`;
    for (let i = 0; i < sceneCrops.length; i++) {
        const current = sceneCrops[i];
        const next = sceneCrops[i + 1];
        if (next) {
            const transitionStart = current.endTime;
            const transitionEnd = current.endTime + TRANSITION_DURATION;
            const xPan = `(${current.crop.x}+(${next.crop.x}-${current.crop.x})*(t-${transitionStart})/${TRANSITION_DURATION})`;
            const yPan = `(${current.crop.y}+(${next.crop.y}-${current.crop.y})*(t-${transitionStart})/${TRANSITION_DURATION})`;
            xExpr += `if(between(t,${current.startTime},${transitionStart}),${current.crop.x}, if(between(t,${transitionStart},${transitionEnd}),${xPan},\n`;
            yExpr += `if(between(t,${current.startTime},${transitionStart}),${current.crop.y}, if(between(t,${transitionStart},${transitionEnd}),${yPan},\n`;
        } else {
            xExpr += `${current.crop.x}`;
            yExpr += `${current.crop.y}`;
        }
    }
    xExpr += ')'.repeat(sceneCrops.length * 2 - 1) + `'`;
    yExpr += ')'.repeat(sceneCrops.length * 2 - 1) + `'`;
    const initialCropRounded = sceneCrops[0].crop;
    return `crop=w=${initialCropRounded.width}:h=${initialCropRounded.height}:x=${xExpr}:y=${yExpr}`;
}

function buildStaticCropFilter(cropParameters) {
    return `crop=${cropParameters.width}:${cropParameters.height}:${cropParameters.x}:${cropParameters.y}`;
}

function buildBlurredComplexFilter() {
    return [
        '[0:v]split=2[fgsrc][bgsrc]',
        '[bgsrc]crop=trunc(ih*9/16/2)*2:ih,scale=270:480,gblur=sigma=20,scale=1080:1920,setsar=1[bg]',
        '[fgsrc]scale=1080:-2,setsar=1[fg]',
        '[bg][fg]overlay=x=0:y=(H-h)/2[out]',
    ].join(';');
}

async function runBlurredComposition(inputPath, outputPath, context = {}) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const complexGraph = buildBlurredComplexFilter();
    return new Promise((resolve, reject) => {
        const command = ffmpeg(inputPath)
            .outputOptions([
                '-filter_complex', complexGraph,
                '-map', '[out]',
                '-map', '0:a?',
                '-c:v', 'libx264',
                '-crf', '23',
                '-preset', 'medium',
                '-c:a', 'aac',
                '-b:a', '128k',
            ])
            .output(outputPath)
            .on('progress', (progress) => logger.info(`Blurred composition: ${progress.percent}% done`))
            .on('end', () => {
                if (Number.isInteger(context.clipIndex)) {
                    setActiveClipRenderCommand(context.transcriptId, context.clipIndex, null);
                }
                resolve();
            })
            .on('error', (error) => {
                if (Number.isInteger(context.clipIndex)) {
                    setActiveClipRenderCommand(context.transcriptId, context.clipIndex, null);
                }
                reject(error);
            });
        if (Number.isInteger(context.clipIndex)) {
            setActiveClipRenderCommand(context.transcriptId, context.clipIndex, command);
        }
        command.run();
    });
}

function getAssetState(transcript, generatedClipUrl) {
    const assetKey = generatedClipUrl || transcript.videoUrl;
    const reframeAssets = transcript.reframeAssets || {};
    return { assetKey, reframeAssets, assetState: reframeAssets[assetKey] || { detections: [], analyses: {} } };
}

// ─── Reframe render ───────────────────────────────────────────────────────────

async function runReframeRender(payload) {
    const {
        transcriptId, parsedClipIndex, targetPlatform, detections, generatedClipUrl,
        cropParameters, captions, normalizedHook, hookStyleId, clipDefinition, clipTimeline,
        sourceVideoId, reframeStyleId, sanitizedOutputName, videoUrlToUse,
        captionsOnly, hasOverlay, shouldAttachToClip,
    } = payload;

    const targetRatio = ASPECT_RATIOS[targetPlatform];
    const tempVideoPath = path.join(
        __dirname, '..', '..', generatedClipUrl ? videoUrlToUse.substring(1) : `uploads/${path.basename(videoUrlToUse)}`
    );
    const outputPath = path.join('uploads/temp', sanitizedOutputName);

    if (Number.isInteger(parsedClipIndex)) {
        await updateClipActiveJob(transcriptId, parsedClipIndex, {
            status: 'running',
            phase: 'render',
            progressMessage: 'Rendering…',
        });
        await assertClipNotCancelled(transcriptId, parsedClipIndex);
    }

    const freshTranscript = await Transcript.findById(transcriptId);
    if (!freshTranscript) {
        throw makeStaleResourceError('Transcript no longer exists.');
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    let finalSourcePath = outputPath;

    if (!captionsOnly) {
        if (Number.isInteger(parsedClipIndex)) {
            await assertClipNotCancelled(transcriptId, parsedClipIndex);
        }
        const videoDimensions = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(tempVideoPath, (err, metadata) => {
                if (err) return reject(err);
                const s = metadata.streams.find(s => s.codec_type === 'video');
                resolve({ width: s.width, height: s.height });
            });
        });

        const videoAspect = videoDimensions.width / videoDimensions.height;
        const isBlurred = reframeStyleId === 'blurred' && videoAspect > (9 / 16 + 0.01);

        let cropFilter = null;
        let resolvedCropParameters = null;
        if (!isBlurred) {
            const { assetState } = getAssetState(freshTranscript, generatedClipUrl);
            const resolvedDetections = Array.isArray(detections) && detections.length > 0
                ? detections : (assetState.detections || []);
            resolvedCropParameters = cropParameters
                || assetState.analyses?.[targetPlatform]?.cropParameters
                || calculateCenterCrop(videoDimensions, targetRatio);
            cropFilter = resolvedDetections.length > 0
                ? generateVisualDirectorFilter(resolvedDetections, videoDimensions, targetRatio)
                : buildStaticCropFilter(resolvedCropParameters);
        }

        if (hasOverlay) {
            const captionedOutputPath = path.join('uploads', 'temp', `captioned_${sanitizedOutputName}`);
            if (isBlurred) {
                const blurredTempPath = path.join('uploads', 'temp', `blur_${sanitizedOutputName}`);
                await runBlurredComposition(tempVideoPath, blurredTempPath, { transcriptId, clipIndex: parsedClipIndex });
                if (Number.isInteger(parsedClipIndex)) {
                    await assertClipNotCancelled(transcriptId, parsedClipIndex);
                }
                await renderCaptionedVideo({
                    inputPath: blurredTempPath,
                    outputPath: captionedOutputPath,
                    transcriptSegments: freshTranscript.transcript,
                    styleId: captions.style,
                    hookStyleId: hookStyleId || (captions?.enabled ? captions.style : undefined),
                    clipDefinition, clipTimeline,
                    captionsEnabled: Boolean(captions?.enabled),
                    hook: normalizedHook, logger,
                    prependVideoFilters: [],
                    videoDimensions: { width: 1080, height: 1920 },
                    onCommand: command => setActiveClipRenderCommand(transcriptId, parsedClipIndex, command),
                });
                try { fs.unlinkSync(blurredTempPath); } catch {}
            } else {
                const croppedDimensions = { width: resolvedCropParameters.width, height: resolvedCropParameters.height };
                await renderCaptionedVideo({
                    inputPath: tempVideoPath,
                    outputPath: captionedOutputPath,
                    transcriptSegments: freshTranscript.transcript,
                    styleId: captions.style,
                    hookStyleId: hookStyleId || (captions?.enabled ? captions.style : undefined),
                    clipDefinition, clipTimeline,
                    captionsEnabled: Boolean(captions?.enabled),
                    hook: normalizedHook, logger,
                    prependVideoFilters: [cropFilter],
                    videoDimensions: croppedDimensions,
                    onCommand: command => setActiveClipRenderCommand(transcriptId, parsedClipIndex, command),
                });
            }
            finalSourcePath = captionedOutputPath;
        } else {
            if (isBlurred) {
                await runBlurredComposition(tempVideoPath, outputPath, { transcriptId, clipIndex: parsedClipIndex });
            } else {
                await new Promise((resolve, reject) => {
                    const command = ffmpeg(tempVideoPath)
                        .videoFilters(cropFilter)
                        .outputOptions(['-c:v libx264', '-crf 23', '-preset medium', '-c:a aac', '-b:a 128k'])
                        .output(outputPath)
                        .on('progress', (progress) => logger.info(`Processing: ${progress.percent}% done`))
                        .on('end', () => {
                            setActiveClipRenderCommand(transcriptId, parsedClipIndex, null);
                            resolve();
                        })
                        .on('error', (error) => {
                            setActiveClipRenderCommand(transcriptId, parsedClipIndex, null);
                            reject(error);
                        });
                    setActiveClipRenderCommand(transcriptId, parsedClipIndex, command);
                    command.run();
                });
            }
        }
    }

    if (captionsOnly && hasOverlay) {
        const captionedOutputPath = path.join('uploads', 'temp', `captioned_${sanitizedOutputName}`);
        await renderCaptionedVideo({
            inputPath: tempVideoPath,
            outputPath: captionedOutputPath,
            transcriptSegments: freshTranscript.transcript,
            styleId: captions.style,
            hookStyleId: hookStyleId || (captions?.enabled ? captions.style : undefined),
            clipDefinition, clipTimeline,
            captionsEnabled: Boolean(captions?.enabled),
            hook: normalizedHook, logger,
            onCommand: command => setActiveClipRenderCommand(transcriptId, parsedClipIndex, command),
        });
        finalSourcePath = captionedOutputPath;
    }

    const reframedDestPath = path.join('uploads', 'clips', 'reframed', sanitizedOutputName);
    fs.mkdirSync(path.dirname(reframedDestPath), { recursive: true });
    moveFileSafe(finalSourcePath, reframedDestPath);
    const reframedUrl = `/uploads/clips/reframed/${sanitizedOutputName}`;

    const reframedThumbAbsPath = await generateClipThumbnail(path.resolve(reframedDestPath));

    if (shouldAttachToClip && Number.isInteger(parsedClipIndex)) {
        const normalizedClips = normalizeTranscriptClips(freshTranscript);
        const sourceClip = normalizedClips[parsedClipIndex];
        const sourceVideo = sourceClip.videos?.find(v => v.id === sourceVideoId)
            || sourceClip.videos?.find(v => v.url === generatedClipUrl)
            || getPrimaryClipVideo(sourceClip);
        const videoRecord = createClipVideoRecord({
            type: 'reframed',
            url: reframedUrl,
            filename: sanitizedOutputName,
            sourceVideoId: sourceVideo?.id || null,
            platform: captionsOnly ? null : targetPlatform,
            platformName: captionsOnly ? 'Original frame' : targetRatio.name,
            aspectRatio: captionsOnly ? null : `${targetRatio.width}:${targetRatio.height}`,
            captions: captions?.enabled ? { enabled: true, style: captions.style } : { enabled: false },
            hook: normalizedHook.enabled ? normalizedHook : { enabled: false },
            clipTimeline: Array.isArray(clipTimeline) ? clipTimeline : sourceVideo?.clipTimeline || null,
            thumbnailUrl: reframedThumbAbsPath ? clipThumbnailUrl(reframedUrl) : null,
        });
        await appendPrimaryClipVideo(Transcript, freshTranscript, parsedClipIndex, videoRecord);
    }

    if (Number.isInteger(parsedClipIndex)) {
        await updateClipActiveJob(transcriptId, parsedClipIndex, {
            status: 'completed',
            phase: 'completed',
            progressMessage: 'Done.',
            completedAt: nowIso(),
            error: null,
        });
    }
}

// ─── Caption render ───────────────────────────────────────────────────────────

async function runCaptionRender(payload) {
    const {
        transcriptId, parsedClipIndex, captionStyleId, hookStyleId,
        effectiveHookText, hookEnabled, outputFilename, inputPath,
    } = payload;

    await updateClipActiveJob(transcriptId, parsedClipIndex, {
        status: 'running',
        progressMessage: 'Rendering captions…',
    });
    await assertClipNotCancelled(transcriptId, parsedClipIndex);

    const tempDir = path.join(__dirname, '..', '..', 'temp');
    fs.mkdirSync(tempDir, { recursive: true });
    const outputPath = path.join(tempDir, outputFilename);
    const destDir = path.join(__dirname, '..', '..', 'uploads', 'captioned');

    const freshTranscript = await Transcript.findById(transcriptId);
    if (!freshTranscript) {
        throw makeStaleResourceError('Transcript no longer exists.');
    }
    const freshClips = normalizeTranscriptClips(freshTranscript);
    const freshClip = freshClips[parsedClipIndex];
    if (!freshClip) {
        throw makeStaleResourceError('Clip no longer exists.');
    }
    const freshPrimary = getPrimaryClipVideo(freshClip);
    const freshWords = normalizeTranscriptWords(freshTranscript.transcript);
    const freshClipWords = buildWordsForClip(freshWords, freshClip, freshPrimary.clipTimeline);

    const result = await renderCaptionedVideo({
        inputPath,
        outputPath,
        transcriptSegments: freshClipWords,
        styleId: captionStyleId,
        hookStyleId,
        captionsEnabled: true,
        hook: { enabled: hookEnabled, text: effectiveHookText },
        logger: console,
        onCommand: command => setActiveClipRenderCommand(transcriptId, parsedClipIndex, command),
    });

    fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, outputFilename);
    moveFileSafe(outputPath, destPath);

    const captionedUrl = `/uploads/captioned/${outputFilename}`;
    const captionedThumbAbsPath = await generateClipThumbnail(path.resolve(destPath));

    const videoRecord = createClipVideoRecord({
        type: 'captioned',
        url: captionedUrl,
        filename: outputFilename,
        captions: { enabled: true, style: result.resolvedStyle.id },
        hook: { enabled: hookEnabled, text: effectiveHookText, style: hookStyleId || captionStyleId },
        thumbnailUrl: captionedThumbAbsPath ? clipThumbnailUrl(captionedUrl) : null,
    });

    await appendPrimaryClipVideo(Transcript, freshTranscript, parsedClipIndex, videoRecord);

    await updateClipActiveJob(transcriptId, parsedClipIndex, {
        status: 'completed',
        progressMessage: 'Caption render completed.',
        completedAt: nowIso(),
        error: null,
    });
}

module.exports = { runReframeRender, runCaptionRender };
