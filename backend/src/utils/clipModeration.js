const prisma = require('../db/prisma');
const TOKEN_PATTERN = /[a-z0-9]+(?:['’_-][a-z0-9]+)*/gi;

function tokenizeText(value) {
    if (typeof value !== 'string') {
        return [];
    }

    return (value.toLowerCase().match(TOKEN_PATTERN) || [])
        .map(token => token.replace(/['’_-]+/g, ''))
        .filter(Boolean);
}

function parseTimestampToSeconds(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    if (typeof value !== 'string' || !value.trim()) {
        return NaN;
    }

    const rawParts = value.trim().split(':');
    if (rawParts.some(part => part.trim() === '')) {
        return NaN;
    }

    const parts = rawParts.map(Number);
    if (parts.some(part => Number.isNaN(part))) {
        return NaN;
    }

    if (parts.length === 2) {
        const [minutes, seconds] = parts;
        return (minutes * 60) + seconds;
    }

    if (parts.length === 3) {
        const [minutes, seconds, milliseconds] = parts;
        return (minutes * 60) + seconds + (milliseconds / 1000);
    }

    return NaN;
}

async function loadBlockedWordTerms() {
    try {
        const blockedWords = await prisma.blockedWord.findMany({
            orderBy: { term: 'asc' },
        });

        return blockedWords
            .filter(entry => typeof entry?.term === 'string')
            .map(entry => ({
                original: entry.term,
                tokens: tokenizeText(entry.term)
            }))
            .filter(entry => entry.tokens.length > 0);
    } catch (error) {
        console.error('Failed to load blocked words from database:', error);
        return [];
    }
}

function getClipRanges(clip) {
    if (Array.isArray(clip?.segments) && clip.segments.length > 0) {
        return clip.segments
            .map(segment => ({
                start: Number(segment.start),
                end: Number(segment.end)
            }))
            .filter(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.start < segment.end);
    }

    if (Number.isFinite(clip?.start) && Number.isFinite(clip?.end) && clip.start < clip.end) {
        return [{ start: clip.start, end: clip.end }];
    }

    return [];
}

function getCoveredTranscriptText(transcriptSegments, clip) {
    const ranges = getClipRanges(clip);

    if (ranges.length === 0 || !Array.isArray(transcriptSegments)) {
        return '';
    }

    const includedText = transcriptSegments
        .filter(segment => {
            const segmentStart = parseTimestampToSeconds(segment?.start);
            const segmentEnd = parseTimestampToSeconds(segment?.end);

            if (!Number.isFinite(segmentStart) || !Number.isFinite(segmentEnd) || segmentStart >= segmentEnd) {
                return false;
            }

            return ranges.some(range => segmentStart < range.end && segmentEnd > range.start);
        })
        .map(segment => segment.text)
        .filter(Boolean);

    return includedText.join(' ');
}

function findBlockedTermsInText(text, blockedTerms) {
    const tokens = tokenizeText(text);
    if (tokens.length === 0 || !Array.isArray(blockedTerms) || blockedTerms.length === 0) {
        return [];
    }

    const matches = new Set();

    for (const term of blockedTerms) {
        const termTokens = term.tokens;
        if (!Array.isArray(termTokens) || termTokens.length === 0 || termTokens.length > tokens.length) {
            continue;
        }

        for (let index = 0; index <= tokens.length - termTokens.length; index += 1) {
            const matched = termTokens.every((token, offset) => tokens[index + offset] === token);
            if (matched) {
                matches.add(term.original);
                break;
            }
        }
    }

    return Array.from(matches);
}

function moderateClipLanguage({ transcriptSegments, clip, blockedTerms, geminiFlag = false, geminiReason = '' }) {
    const coveredText = getCoveredTranscriptText(transcriptSegments, clip);
    const localMatches = findBlockedTermsInText(coveredText, blockedTerms);

    return {
        coveredText,
        localMatches,
        geminiFlag: Boolean(geminiFlag),
        geminiReason: typeof geminiReason === 'string' ? geminiReason.trim() : '',
        isBlocked: localMatches.length > 0 || Boolean(geminiFlag)
    };
}

module.exports = {
    findBlockedTermsInText,
    getCoveredTranscriptText,
    loadBlockedWordTerms,
    moderateClipLanguage,
    parseTimestampToSeconds
};
