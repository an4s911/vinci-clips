const fs = require('fs');
const path = require('path');
const Transcript = require('../models/Transcript');
const {
    CLIPS_DIR,
    appendPrimaryClipVideo,
    clipThumbnailUrl,
    createClipVideoRecord,
    generateClipThumbnail,
    makeTimestampedFilename,
} = require('./clipVideos');
const {
    assertClipNotCancelled,
    completeClipGeneration,
    markClipPhase,
    makeStaleResourceError,
    runTrackedCommand,
} = require('./backgroundJobs');
const { deleteLocalMedia } = require('./mediaStorage');

async function probeDurationSeconds(filePath) {
    return new Promise((resolve) => {
        const ffmpeg = require('fluent-ffmpeg');
        ffmpeg.ffprobe(filePath, (error, metadata) => {
            if (error) {
                resolve(null);
                return;
            }

            const duration = Number(metadata?.format?.duration);
            resolve(Number.isFinite(duration) && duration > 0 ? duration : null);
        });
    });
}

async function generateSingleClipInBackground(transcriptId, clipIndex) {
    let transcript = await Transcript.findById(transcriptId);
    const clip = transcript?.clips?.[clipIndex];
    if (!transcript || !clip) {
        throw makeStaleResourceError('Clip not found.');
    }

    if (!fs.existsSync(CLIPS_DIR)) {
        fs.mkdirSync(CLIPS_DIR, { recursive: true });
    }

    await assertClipNotCancelled(transcriptId, clipIndex);
    await markClipPhase(transcriptId, clipIndex, 'prepare', 'Preparing clip generation.');
    const outputFilename = makeTimestampedFilename(transcriptId, clipIndex);
    const outputPath = path.join(CLIPS_DIR, outputFilename);
    const clipUrl = `/uploads/clips/${outputFilename}`;
    const videoPath = path.join(__dirname, '..', '..', 'uploads', path.basename(transcript.videoUrl));

    if (!fs.existsSync(videoPath)) {
        throw new Error('Source video file is missing.');
    }

    let mediaTimeline = null;
    if (clip.segments && clip.segments.length > 0) {
        const segmentFiles = [];
        mediaTimeline = [];
        const concatFilePath = path.join(CLIPS_DIR, `${transcriptId}_clip_${clipIndex}_${Date.now()}_concat.txt`);

        try {
            for (let j = 0; j < clip.segments.length; j += 1) {
                await assertClipNotCancelled(transcriptId, clipIndex);
                const segment = clip.segments[j];
                const phase = `cut-segment-${j + 1}`;
                const segmentPath = path.join(CLIPS_DIR, `${transcriptId}_clip_${clipIndex}_${Date.now()}_segment_${j}.mp4`);
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
                    command: `ffmpeg -y -ss ${segment.start} -t ${duration} -i "${videoPath}" -avoid_negative_ts make_zero -reset_timestamps 1 -c:v libx264 -c:a aac "${segmentPath}"`
                });
                segmentFiles.push(segmentPath);
                const actualDuration = await probeDurationSeconds(segmentPath);
                const outputStart = mediaTimeline.length > 0
                    ? mediaTimeline[mediaTimeline.length - 1].outputEnd
                    : 0;
                const outputDuration = actualDuration || duration;
                mediaTimeline.push({
                    sourceStart: segment.start,
                    sourceEnd: segment.end,
                    outputStart,
                    outputEnd: outputStart + outputDuration,
                });
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
                command: `ffmpeg -y -f concat -safe 0 -i "${concatFilePath}" -avoid_negative_ts make_zero -c:v libx264 -c:a aac "${outputPath}"`
            });
            const stitchedDuration = await probeDurationSeconds(outputPath);
            const expectedDuration = mediaTimeline[mediaTimeline.length - 1]?.outputEnd;
            if (stitchedDuration && expectedDuration && Math.abs(stitchedDuration - expectedDuration) > 0.05) {
                const drift = stitchedDuration - expectedDuration;
                await markClipPhase(transcriptId, clipIndex, 'stitch-segments',
                    `Stitched duration drift ${drift.toFixed(3)}s — keeping per-segment timeline.`,
                    { driftSec: drift, expectedDuration, stitchedDuration });
            }
        } finally {
            await markClipPhase(transcriptId, clipIndex, 'cleanup-temp', 'Cleaning up temporary segment files.');
            await Promise.all([
                ...segmentFiles.map(file => deleteLocalMedia(file, { missingOk: true })),
                deleteLocalMedia(concatFilePath, { missingOk: true }),
            ]);
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
            command: `ffmpeg -y -ss ${clip.start} -t ${duration} -i "${videoPath}" -avoid_negative_ts make_zero -reset_timestamps 1 -c:v libx264 -c:a aac "${outputPath}"`
        });
        mediaTimeline = [{
            sourceStart: clip.start,
            sourceEnd: clip.end,
            outputStart: 0,
            outputEnd: await probeDurationSeconds(outputPath) || duration,
        }];
    } else {
        throw new Error('Clip does not contain valid timing data.');
    }

    await assertClipNotCancelled(transcriptId, clipIndex);
    await markClipPhase(transcriptId, clipIndex, 'save-video', 'Saving generated clip.');
    transcript = await Transcript.findById(transcriptId);
    if (!transcript || !transcript.clips?.[clipIndex]) {
        throw makeStaleResourceError('Clip no longer exists.');
    }
    const thumbAbsPath = await generateClipThumbnail(outputPath);
    const videoRecord = createClipVideoRecord({
        type: 'generated',
        url: clipUrl,
        filename: outputFilename,
        hook: { enabled: false },
        clipTimeline: mediaTimeline,
        thumbnailUrl: thumbAbsPath ? clipThumbnailUrl(clipUrl) : null,
    });
    await appendPrimaryClipVideo(Transcript, transcript, clipIndex, videoRecord);
    await completeClipGeneration(transcriptId, clipIndex, clipUrl);
}

module.exports = {
    generateSingleClipInBackground,
};
