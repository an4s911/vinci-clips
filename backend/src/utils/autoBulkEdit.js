/**
 * Builds render job payloads for auto bulk-edit.
 * Payloads are fully reconstructible from config + clip state — no HTTP request needed.
 * This is what enables crash/queue-drop recovery without user interaction.
 */

const path = require('path');
const { getPrimaryClipVideo, normalizeClipHook, makeTimestampedFilename } = require('./clipVideos');

const ASPECT_RATIOS = {
    tiktok: { width: 9, height: 16, name: 'TikTok/Shorts' },
    instagram: { width: 1, height: 1, name: 'Instagram Square' },
    youtube: { width: 16, height: 9, name: 'YouTube Landscape' },
};

const MAX_AUTO_REQUEUE_ATTEMPTS = 3;

function buildRenderPayloadForClip(transcript, clipIndex, config) {
    const clip = (transcript.clips || [])[clipIndex];
    if (!clip) return null;

    const primaryVideo = getPrimaryClipVideo(clip);
    if (!primaryVideo) return null;

    const { reframe, captions, hook } = config;
    const useReframe = reframe.enabled;

    const rawHook = clip.hook || {};
    const normalizedHook = normalizeClipHook({
        text: rawHook.text || '',
        enabled: hook.enabled && Boolean(rawHook.text?.trim()),
        timeoutSeconds: hook.timeoutSeconds ?? rawHook.timeoutSeconds ?? null,
    });

    const captionsConfig = { enabled: Boolean(captions.enabled && captions.styleId), style: captions.styleId };
    const hookStyleId = hook.styleId || null;
    const captionsOnly = !useReframe && (captionsConfig.enabled || normalizedHook.enabled);

    const sanitizedOutputName = makeTimestampedFilename(
        transcript._id,
        clipIndex,
        captionsOnly ? '_overlay' : '_reframed'
    );

    const videoUrlToUse = primaryVideo.url;
    const tempVideoPath = path.join(
        process.cwd(),
        videoUrlToUse.replace(/^\/+/, '')
    );

    const payload = {
        transcriptId: String(transcript._id),
        parsedClipIndex: clipIndex,
        targetPlatform: reframe.platform,
        detections: [],
        cropParameters: null,
        generatedClipUrl: videoUrlToUse,
        captions: captionsConfig,
        normalizedHook,
        hookStyleId,
        clipDefinition: clip,
        clipTimeline: primaryVideo.clipTimeline || null,
        sourceVideoId: primaryVideo.sourceVideoId || null,
        reframeStyleId: reframe.reframeStyleId,
        sanitizedOutputName,
        videoUrlToUse,
        tempVideoPath,
        captionsOnly,
        hasOverlay: Boolean(captionsConfig.enabled || normalizedHook.enabled),
        shouldAttachToClip: true,
    };

    return { kind: useReframe ? 'reframe' : 'caption', payload };
}

/**
 * Returns clip indexes eligible for auto bulk-edit:
 * - Have a primary video (clip generated)
 * - No rendered variant yet (type 'reframed' or 'captioned'), OR activeJob is already failed/completed
 *   so re-enqueue (from reconciler) is idempotent.
 * - activeJob is not currently queued/running (prevents duplicate enqueue)
 */
function getEligibleClipIndexes(transcript, liveRenderKeys = new Set()) {
    const clips = transcript.clips || [];
    return clips.reduce((acc, clip, i) => {
        if (!getPrimaryClipVideo(clip)) return acc;

        // Skip if an in-process render job exists in the queue
        if (liveRenderKeys.has(`${transcript._id}:${i}`)) return acc;

        // Skip if activeJob is currently queued/running (may still be valid)
        const aj = clip.activeJob;
        if (aj && ['queued', 'running'].includes(aj.status)) return acc;

        acc.push(i);
        return acc;
    }, []);
}

module.exports = {
    buildRenderPayloadForClip,
    getEligibleClipIndexes,
    MAX_AUTO_REQUEUE_ATTEMPTS,
    ASPECT_RATIOS,
};
