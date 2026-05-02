const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { deleteLocalMedia, resolveLocalMediaPath } = require('./mediaStorage');

const CLIPS_DIR = path.join(__dirname, '..', '..', 'uploads', 'clips');
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');

function getLegacyClipFilename(transcriptId, clipIndex) {
    return `${transcriptId}_clip_${clipIndex}.mp4`;
}

function getLegacyClipPath(transcriptId, clipIndex) {
    return path.join(CLIPS_DIR, getLegacyClipFilename(transcriptId, clipIndex));
}

function getLegacyClipVideo(transcript, clip, clipIndex) {
    const filename = getLegacyClipFilename(transcript._id, clipIndex);
    const legacyPath = getLegacyClipPath(transcript._id, clipIndex);

    if (!fs.existsSync(legacyPath)) {
        return null;
    }

    return {
        id: `legacy-${transcript._id}-${clipIndex}`,
        type: 'generated',
        url: `/uploads/clips/${filename}`,
        filename,
        createdAt: transcript.createdAt || new Date().toISOString(),
        sourceVideoId: null,
        platform: null,
        platformName: null,
        aspectRatio: null,
        captions: { enabled: false },
        hook: { enabled: false },
        title: clip.title
    };
}

function normalizeClipHook(hook) {
    const text = typeof hook?.text === 'string' ? hook.text.trim() : '';
    return {
        text,
        enabled: Boolean(hook?.enabled && text),
        updatedAt: hook?.updatedAt || null
    };
}

function normalizeClipVideos(transcript, clip, clipIndex) {
    const videos = Array.isArray(clip.videos) ? clip.videos.filter(Boolean) : [];
    const normalizedVideos = videos.length > 0
        ? videos.map(video => ({
            id: video.id || uuidv4(),
            type: video.type || 'generated',
            url: video.url,
            filename: video.filename || (video.url ? path.basename(video.url) : ''),
            createdAt: video.createdAt || transcript.createdAt || new Date().toISOString(),
            sourceVideoId: video.sourceVideoId ?? null,
            platform: video.platform ?? null,
            platformName: video.platformName ?? null,
            aspectRatio: video.aspectRatio ?? null,
            captions: video.captions || { enabled: false },
            hook: video.hook || { enabled: false },
            title: video.title || clip.title
        })).filter(video => video.url)
        : [];

    if (normalizedVideos.length === 0) {
        const legacyVideo = getLegacyClipVideo(transcript, clip, clipIndex);
        if (legacyVideo) {
            normalizedVideos.push(legacyVideo);
        }
    }

    const primaryVideoId = normalizedVideos.some(video => video.id === clip.primaryVideoId)
        ? clip.primaryVideoId
        : normalizedVideos[normalizedVideos.length - 1]?.id;

    return {
        ...clip,
        hook: normalizeClipHook(clip.hook),
        videos: normalizedVideos,
        primaryVideoId: primaryVideoId || null
    };
}

function normalizeTranscriptClips(transcript) {
    const clips = Array.isArray(transcript.clips) ? transcript.clips : [];
    return clips.map((clip, index) => normalizeClipVideos(transcript, clip, index));
}

function getPrimaryClipVideo(clip) {
    if (!Array.isArray(clip.videos) || clip.videos.length === 0) {
        return null;
    }

    return clip.videos.find(video => video.id === clip.primaryVideoId) || clip.videos[clip.videos.length - 1];
}

function buildGeneratedClipsMap(clips) {
    return clips.reduce((acc, clip, index) => {
        const primaryVideo = getPrimaryClipVideo(clip);
        if (primaryVideo) {
            acc[index] = {
                index,
                title: clip.title,
                ...primaryVideo
            };
        }
        return acc;
    }, {});
}

function createClipVideoRecord({
    type,
    url,
    filename,
    sourceVideoId = null,
    platform = null,
    platformName = null,
    aspectRatio = null,
    captions = { enabled: false },
    hook = { enabled: false }
}) {
    return {
        id: uuidv4(),
        type,
        url,
        filename,
        createdAt: new Date().toISOString(),
        sourceVideoId,
        platform,
        platformName,
        aspectRatio,
        captions,
        hook
    };
}

async function appendPrimaryClipVideo(Transcript, transcript, clipIndex, videoRecord) {
    if (!Number.isInteger(clipIndex) || clipIndex < 0 || clipIndex >= (transcript.clips || []).length) {
        throw new Error('Invalid clip index for video version.');
    }

    const normalizedClips = normalizeTranscriptClips(transcript);
    const targetClip = normalizedClips[clipIndex];
    const nextVideos = [...(targetClip.videos || []), videoRecord];
    normalizedClips[clipIndex] = {
        ...targetClip,
        videos: nextVideos,
        primaryVideoId: videoRecord.id
    };

    const updatedTranscript = await Transcript.findByIdAndUpdate(transcript._id, {
        clips: normalizedClips
    });
    transcript.clips = normalizedClips;
    return updatedTranscript;
}

function getVideoFilePath(video) {
    if (!video?.url) {
        throw new Error('Video URL is not a local upload path.');
    }

    const resolvedPath = resolveLocalMediaPath(video.url);
    if (!resolvedPath || !resolvedPath.startsWith(path.resolve(UPLOADS_DIR))) {
        throw new Error('Video URL is not a local upload path.');
    }

    return resolvedPath;
}

async function deleteClipVideoVersion(Transcript, transcript, clipIndex, videoId) {
    if (!Number.isInteger(clipIndex) || clipIndex < 0 || clipIndex >= (transcript.clips || []).length) {
        throw new Error('Invalid clip index for video deletion.');
    }

    const normalizedClips = normalizeTranscriptClips(transcript);
    const targetClip = normalizedClips[clipIndex];
    const videos = targetClip.videos || [];
    const videoToDelete = videos.find(video => video.id === videoId);

    if (!videoToDelete) {
        return null;
    }

    await deleteLocalMedia(videoToDelete.url, { missingOk: true });

    const remainingVideos = videos.filter(video => video.id !== videoId);
    const nextPrimary = remainingVideos.length > 0
        ? remainingVideos
            .map((video, index) => ({ video, index }))
            .sort((a, b) => {
                const timeA = new Date(a.video.createdAt).getTime();
                const timeB = new Date(b.video.createdAt).getTime();
                const safeTimeA = Number.isNaN(timeA) ? 0 : timeA;
                const safeTimeB = Number.isNaN(timeB) ? 0 : timeB;
                return (safeTimeB - safeTimeA) || (b.index - a.index);
            })[0].video
        : null;

    normalizedClips[clipIndex] = {
        ...targetClip,
        videos: remainingVideos,
        primaryVideoId: nextPrimary?.id || null
    };

    const updatedTranscript = await Transcript.findByIdAndUpdate(transcript._id, {
        clips: normalizedClips
    });
    transcript.clips = normalizedClips;
    return updatedTranscript;
}

function makeTimestampedFilename(transcriptId, clipIndex, suffix = '') {
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
    const random = Math.random().toString(36).slice(2, 8);
    return `${transcriptId}_clip_${clipIndex}${suffix}_${timestamp}_${random}.mp4`;
}

module.exports = {
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
};
