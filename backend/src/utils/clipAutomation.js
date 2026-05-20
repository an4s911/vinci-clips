const Transcript = require('../models/Transcript');
const { analyzeTranscriptForClips } = require('./clipAnalysis');
const { getPrimaryClipVideo, normalizeTranscriptClips } = require('./clipVideos');
const {
    createJobState,
    logVideoProcessing,
    updateClipGeneration,
} = require('./backgroundJobs');
const { enqueueClipGenerate } = require('../queue/clipJobs');

function rankClipIndexes(clips) {
    return clips
        .map((clip, index) => ({
            index,
            rank: Number.isFinite(Number(clip.rank)) ? Number(clip.rank) : index + 1,
            score: Number.isFinite(Number(clip.viralityScore)) ? Number(clip.viralityScore) : 0,
        }))
        .sort((a, b) => (a.rank - b.rank) || (b.score - a.score) || (a.index - b.index))
        .map(entry => entry.index);
}

async function queueAutoClipGeneration(transcriptId) {
    let transcript = await Transcript.findById(transcriptId);
    const clips = normalizeTranscriptClips(transcript);
    const indexes = rankClipIndexes(clips)
        .filter(index => {
            const clip = clips[index];
            const active = Boolean(clip.generation && ['queued', 'running', 'cancelling'].includes(clip.generation.status));
            return !active && !getPrimaryClipVideo(clip);
        });

    const queuedClipIndexes = [];
    for (const clipIndex of indexes) {
        transcript = await updateClipGeneration(transcriptId, clipIndex, createJobState({
            status: 'queued',
            phase: 'prepare',
            progressMessage: 'Clip generation queued automatically.',
        }));
        await enqueueClipGenerate({ transcriptId, clipIndex, origin: 'pipeline' });
        queuedClipIndexes.push(clipIndex);
    }

    return queuedClipIndexes;
}

async function analyzeAndAutoGenerateClips(transcriptId, options = {}) {
    try {
        const transcript = await Transcript.findById(transcriptId);
        if (!transcript || !Array.isArray(transcript.transcript) || transcript.transcript.length === 0) {
            return { analyzed: false, queuedClipIndexes: [] };
        }

        const analyzedTranscript = await analyzeTranscriptForClips(transcript);
        const queuedClipIndexes = await queueAutoClipGeneration(transcriptId);
        logVideoProcessing(transcriptId, 'completed', 'Automatic clip analysis and generation queued', {
            jobType: 'auto-clips',
            phase: 'completed',
            visibleClipCount: analyzedTranscript.clips?.length || 0,
            queuedClipIndexes,
        });

        return { analyzed: true, queuedClipIndexes };
    } catch (error) {
        logVideoProcessing(transcriptId, 'failed', 'Automatic clip analysis/generation failed', {
            jobType: 'auto-clips',
            phase: 'auto-clips',
            error: error.message,
        });
        return { analyzed: false, queuedClipIndexes: [], error };
    }
}

module.exports = {
    analyzeAndAutoGenerateClips,
    queueAutoClipGeneration,
};
