const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const Transcript = require('../models/Transcript');
const { generateJsonContent } = require('./gemini');
const {
    buildGeneratedClipsMap,
    normalizeClipHook,
    normalizeTranscriptClips
} = require('./clipVideos');
const {
    loadBlockedWordTerms,
    moderateClipLanguage,
    parseTimestampToSeconds
} = require('./clipModeration');
const { getActivePromptBody, renderPrompt } = require('./promptStore');

const MIN_CLIP_DURATION_SEC = 15;
const MAX_CLIP_DURATION_SEC = 75;
const MAX_SEGMENTS_PER_CLIP = 3;
const AUTO_GENERATE_LIMIT = 6;

const CLIP_ANALYSIS_RESPONSE_SCHEMA = {
    type: 'ARRAY',
    items: {
        type: 'OBJECT',
        properties: {
            title: { type: 'STRING' },
            hook: { type: 'STRING' },
            reason: { type: 'STRING' },
            viralityScore: { type: 'NUMBER' },
            subScores: {
                type: 'OBJECT',
                properties: {
                    hook: { type: 'NUMBER' },
                    payoff: { type: 'NUMBER' },
                    emotion: { type: 'NUMBER' },
                    novelty: { type: 'NUMBER' },
                    clarity: { type: 'NUMBER' },
                },
            },
            tags: {
                type: 'ARRAY',
                items: { type: 'STRING' },
            },
            languageFlag: { type: 'BOOLEAN' },
            languageReason: { type: 'STRING' },
            startSec: { type: 'NUMBER' },
            endSec: { type: 'NUMBER' },
            segments: {
                type: 'ARRAY',
                items: {
                    type: 'OBJECT',
                    properties: {
                        startSec: { type: 'NUMBER' },
                        endSec: { type: 'NUMBER' },
                    },
                    required: ['startSec', 'endSec'],
                },
            },
            sourceChunkIds: {
                type: 'ARRAY',
                items: { type: 'STRING' },
            },
        },
        required: ['title', 'hook', 'reason', 'viralityScore'],
        propertyOrdering: [
            'title',
            'hook',
            'reason',
            'viralityScore',
            'subScores',
            'tags',
            'languageFlag',
            'languageReason',
            'startSec',
            'endSec',
            'segments',
            'sourceChunkIds',
        ],
    },
};

function clampNumber(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.min(max, Math.max(min, number));
}

function normalizeText(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
}

function getWordStart(word) {
    return parseTimestampToSeconds(word?.start);
}

function getWordEnd(word) {
    return parseTimestampToSeconds(word?.end);
}

function buildTranscriptChunks(transcriptSegments, { maxWords = 70, maxDurationSec = 25 } = {}) {
    if (!Array.isArray(transcriptSegments)) return [];

    const words = transcriptSegments
        .map((word, index) => ({
            index,
            start: getWordStart(word),
            end: getWordEnd(word),
            speaker: normalizeText(word?.speaker || 'Speaker'),
            text: normalizeText(word?.text),
        }))
        .filter(word => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end >= word.start && word.text);

    const chunks = [];
    let current = null;

    for (const word of words) {
        if (!current) {
            current = {
                id: `c${chunks.length + 1}`,
                startSec: word.start,
                endSec: word.end,
                speakers: new Set([word.speaker]),
                words: [word.text],
                wordCount: 1,
            };
            continue;
        }

        const projectedDuration = word.end - current.startSec;
        if (current.wordCount >= maxWords || projectedDuration > maxDurationSec) {
            chunks.push({
                ...current,
                speakers: Array.from(current.speakers),
                text: current.words.join(' '),
            });
            current = {
                id: `c${chunks.length + 1}`,
                startSec: word.start,
                endSec: word.end,
                speakers: new Set([word.speaker]),
                words: [word.text],
                wordCount: 1,
            };
            continue;
        }

        current.endSec = word.end;
        current.speakers.add(word.speaker);
        current.words.push(word.text);
        current.wordCount += 1;
    }

    if (current) {
        chunks.push({
            ...current,
            speakers: Array.from(current.speakers),
            text: current.words.join(' '),
        });
    }

    return chunks;
}

function formatSeconds(value) {
    return Number(value).toFixed(2).replace(/\.00$/, '');
}

function estimateCandidateCount(durationSec) {
    if (!Number.isFinite(durationSec) || durationSec <= 0) return 10;
    if (durationSec < 180) return 8;
    if (durationSec < 600) return 10;
    if (durationSec < 1800) return 16;
    return 24;
}

async function buildClipAnalysisPrompt({ transcriptDoc, transcriptChunks, candidateCount }) {
    const durationText = Number.isFinite(transcriptDoc.duration)
        ? `${formatSeconds(transcriptDoc.duration)} seconds`
        : 'unknown duration';
    const chunkText = transcriptChunks
        .map(chunk => [
            `[${chunk.id}] ${formatSeconds(chunk.startSec)}-${formatSeconds(chunk.endSec)}s`,
            `speakers=${chunk.speakers.join(', ')}`,
            chunk.text,
        ].join(' | '))
        .join('\n');

    const body = await getActivePromptBody('clipAnalysis');
    return renderPrompt(body, {
        candidateCount,
        minDuration: MIN_CLIP_DURATION_SEC,
        maxDuration: MAX_CLIP_DURATION_SEC,
        durationText,
        chunkText,
    });
}

function normalizeScore(value) {
    const score = Number(value);
    if (!Number.isFinite(score)) return 0;
    return Math.max(0, Math.min(100, score));
}

function getClipRangesFromSuggestion(suggestion, videoDurationSeconds) {
    const maxEnd = Number.isFinite(videoDurationSeconds) ? videoDurationSeconds : Number.MAX_SAFE_INTEGER;

    if (Array.isArray(suggestion?.segments) && suggestion.segments.length > 0) {
        return suggestion.segments
            .slice(0, MAX_SEGMENTS_PER_CLIP)
            .map(segment => ({
                start: clampNumber(segment.startSec, 0, maxEnd),
                end: clampNumber(segment.endSec, 0, maxEnd),
            }))
            .filter(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start);
    }

    const start = clampNumber(suggestion?.startSec, 0, maxEnd);
    const end = clampNumber(suggestion?.endSec, 0, maxEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    return [{ start, end }];
}

function rangesDuration(ranges) {
    return ranges.reduce((sum, range) => sum + (range.end - range.start), 0);
}

function rangesOverlapRatio(aRanges, bRanges) {
    let overlap = 0;
    for (const a of aRanges) {
        for (const b of bRanges) {
            overlap += Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
        }
    }
    const shortest = Math.min(rangesDuration(aRanges), rangesDuration(bRanges));
    return shortest > 0 ? overlap / shortest : 0;
}

function normalizeSubScores(subScores) {
    if (!subScores || typeof subScores !== 'object') return null;
    const clamp = (v, max) => Math.min(max, Math.max(0, Number(v) || 0));
    return {
        hook: clamp(subScores.hook, 30),
        payoff: clamp(subScores.payoff, 25),
        emotion: clamp(subScores.emotion, 15),
        novelty: clamp(subScores.novelty, 15),
        clarity: clamp(subScores.clarity, 15),
    };
}

const VALID_TAGS = new Set(['funny', 'insight', 'controversy', 'story', 'advice', 'mistake', 'reaction', 'debate', 'achievement', 'warning']);

function normalizeTags(tags) {
    if (!Array.isArray(tags)) return [];
    return tags.map(t => normalizeText(t).toLowerCase()).filter(t => VALID_TAGS.has(t)).slice(0, 4);
}

function toProcessedClip(suggestion, ranges, rank) {
    const hookText = normalizeText(suggestion.hook).slice(0, 120);
    const base = {
        title: normalizeText(suggestion.title).slice(0, 140) || `Clip ${rank}`,
        rank,
        viralityScore: normalizeScore(suggestion.viralityScore),
        subScores: normalizeSubScores(suggestion.subScores),
        tags: normalizeTags(suggestion.tags),
        reason: normalizeText(suggestion.reason).slice(0, 300),
        sourceChunkIds: Array.isArray(suggestion.sourceChunkIds)
            ? suggestion.sourceChunkIds.map(normalizeText).filter(Boolean).slice(0, 8)
            : [],
        hook: normalizeClipHook({
            text: hookText,
            enabled: Boolean(hookText),
            updatedAt: hookText ? new Date().toISOString() : null,
        }),
    };

    if (ranges.length > 1) {
        return {
            ...base,
            segments: ranges,
            totalDuration: rangesDuration(ranges),
        };
    }

    return {
        ...base,
        start: ranges[0].start,
        end: ranges[0].end,
        totalDuration: rangesDuration(ranges),
    };
}

async function analyzeTranscriptForClips(transcriptDoc, options = {}) {
    if (!transcriptDoc || !Array.isArray(transcriptDoc.transcript) || transcriptDoc.transcript.length === 0) {
        throw new Error('Transcript content is required for clip analysis.');
    }

    const transcriptChunks = buildTranscriptChunks(transcriptDoc.transcript);
    if (transcriptChunks.length === 0) {
        throw new Error('Timestamped transcript content is required for clip analysis.');
    }

    const candidateCount = options.candidateCount || estimateCandidateCount(transcriptDoc.duration);
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const prompt = await buildClipAnalysisPrompt({ transcriptDoc, transcriptChunks, candidateCount });
    const blockedTerms = await loadBlockedWordTerms();

    const { data: suggestions, model: resolvedModel } = await generateJsonContent({
        genAI,
        logLabel: `Clip analysis for ${transcriptDoc._id}`,
        contents: [{
            role: 'user',
            parts: [{ text: prompt }],
        }],
        responseSchema: CLIP_ANALYSIS_RESPONSE_SCHEMA,
        safetySettings: [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ],
    });

    const sortedSuggestions = Array.isArray(suggestions)
        ? [...suggestions].sort((a, b) => normalizeScore(b?.viralityScore) - normalizeScore(a?.viralityScore))
        : [];
    const videoDurationSeconds = Number.isFinite(transcriptDoc.duration) ? transcriptDoc.duration : Infinity;
    const validatedClips = [];
    const acceptedRanges = [];
    let filteredClipCount = 0;
    let rejectedClipCount = 0;

    for (const suggestion of sortedSuggestions) {
        const ranges = getClipRangesFromSuggestion(suggestion, videoDurationSeconds);
        const totalDuration = rangesDuration(ranges);
        if (ranges.length === 0 || totalDuration < MIN_CLIP_DURATION_SEC || totalDuration > MAX_CLIP_DURATION_SEC) {
            rejectedClipCount += 1;
            continue;
        }

        if (acceptedRanges.some(existing => rangesOverlapRatio(existing, ranges) > 0.5)) {
            rejectedClipCount += 1;
            continue;
        }

        const processedClip = toProcessedClip(suggestion, ranges, validatedClips.length + 1);
        const moderationResult = moderateClipLanguage({
            transcriptSegments: transcriptDoc.transcript,
            clip: processedClip,
            blockedTerms,
            geminiFlag: suggestion.languageFlag,
            geminiReason: suggestion.languageReason,
        });

        if (moderationResult.isBlocked) {
            filteredClipCount += 1;
            continue;
        }

        acceptedRanges.push(ranges);
        validatedClips.push(processedClip);
    }

    const updatedTranscript = await Transcript.findByIdAndUpdate(transcriptDoc._id, {
        clips: validatedClips,
        analysisMetadata: {
            filteredClipCount,
            rejectedClipCount,
            visibleClipCount: validatedClips.length,
            suggestedClipCount: sortedSuggestions.length,
            blockedWordSource: 'database',
            promptVersion: 'viral-rubric-v3',
            analyzedAt: new Date().toISOString(),
            model: resolvedModel,
            autoGenerateLimit: AUTO_GENERATE_LIMIT,
        },
    });
    const normalizedClips = normalizeTranscriptClips(updatedTranscript);

    return {
        ...updatedTranscript,
        clips: normalizedClips,
        generatedClips: buildGeneratedClipsMap(normalizedClips),
    };
}

module.exports = {
    AUTO_GENERATE_LIMIT,
    buildTranscriptChunks,
    analyzeTranscriptForClips,
    estimateCandidateCount,
};
