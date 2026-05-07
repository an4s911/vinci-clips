const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

const CAPTION_STYLES = {
    'bold-center': {
        name: 'Bold Center',
        description: 'Heavy sans-serif, centered, high contrast',
        fontName: 'DejaVu Sans',
        fontcolor: 'white',
        borderw: 3,
        bordercolor: 'black',
        preview: {
            fontFamily: '"DejaVu Sans", sans-serif',
            fontWeight: 800,
            textColor: '#ffffff',
            backgroundColor: 'transparent',
            borderColor: '#000000',
            borderWidth: 3,
            textShadow: '2px 2px 4px rgba(0,0,0,0.9)'
        },
        layouts: {
            portrait: { fontsize: 24, maxWordsPerPhrase: 2, marginV: 120, marginL: 70, marginR: 70, previewFontSize: 18 },
            square: { fontsize: 22, maxWordsPerPhrase: 3, marginV: 85, marginL: 55, marginR: 55, previewFontSize: 16 },
            landscape: { fontsize: 18, maxWordsPerPhrase: 4, marginV: 60, marginL: 45, marginR: 45, previewFontSize: 14 }
        }
    },
    'neon-pop': {
        name: 'Neon Pop',
        description: 'Bright neon text with bold outlines',
        fontName: 'DejaVu Sans',
        fontcolor: '#FF6B9D',
        borderw: 3,
        bordercolor: '#FFD93D',
        shadow: true,
        preview: {
            fontFamily: '"DejaVu Sans", sans-serif',
            fontWeight: 800,
            textColor: '#FF6B9D',
            backgroundColor: 'rgba(0,0,0,0.2)',
            borderColor: '#FFD93D',
            borderWidth: 2,
            textShadow: '0 0 10px rgba(255,217,61,0.9), 2px 2px 4px rgba(0,0,0,0.85)'
        },
        layouts: {
            portrait: { fontsize: 25, maxWordsPerPhrase: 2, marginV: 120, marginL: 70, marginR: 70, previewFontSize: 18 },
            square: { fontsize: 23, maxWordsPerPhrase: 3, marginV: 90, marginL: 55, marginR: 55, previewFontSize: 16 },
            landscape: { fontsize: 19, maxWordsPerPhrase: 4, marginV: 60, marginL: 45, marginR: 45, previewFontSize: 14 }
        }
    },
    'typewriter': {
        name: 'Typewriter',
        description: 'Monospace subtitles with compact phrasing',
        fontName: 'DejaVu Sans Mono',
        fontcolor: 'white',
        borderw: 2,
        bordercolor: 'black',
        preview: {
            fontFamily: '"DejaVu Sans Mono", monospace',
            fontWeight: 700,
            textColor: '#ffffff',
            backgroundColor: 'rgba(0,0,0,0.55)',
            borderColor: '#000000',
            borderWidth: 2,
            textShadow: '1px 1px 2px rgba(0,0,0,0.85)'
        },
        layouts: {
            portrait: { fontsize: 22, maxWordsPerPhrase: 2, marginV: 120, marginL: 75, marginR: 75, previewFontSize: 17 },
            square: { fontsize: 20, maxWordsPerPhrase: 3, marginV: 90, marginL: 60, marginR: 60, previewFontSize: 15 },
            landscape: { fontsize: 17, maxWordsPerPhrase: 4, marginV: 65, marginL: 50, marginR: 50, previewFontSize: 13 }
        }
    },
    'bubble': {
        name: 'Bubble Style',
        description: 'Rounded, colorful subtitles with strong presence',
        fontName: 'DejaVu Sans',
        fontcolor: 'white',
        borderw: 4,
        bordercolor: '#4ECDC4',
        preview: {
            fontFamily: '"DejaVu Sans", sans-serif',
            fontWeight: 700,
            textColor: '#ffffff',
            backgroundColor: 'rgba(0,0,0,0.55)',
            borderColor: '#4ECDC4',
            borderWidth: 3,
            textShadow: '0 2px 4px rgba(0,0,0,0.8)'
        },
        layouts: {
            portrait: { fontsize: 23, maxWordsPerPhrase: 2, marginV: 125, marginL: 80, marginR: 80, previewFontSize: 17 },
            square: { fontsize: 21, maxWordsPerPhrase: 3, marginV: 95, marginL: 60, marginR: 60, previewFontSize: 15 },
            landscape: { fontsize: 18, maxWordsPerPhrase: 4, marginV: 65, marginL: 50, marginR: 50, previewFontSize: 13 }
        }
    },
    'minimal-clean': {
        name: 'Minimal Clean',
        description: 'Clean, light subtitles with subtle framing',
        fontName: 'DejaVu Sans',
        fontcolor: 'white',
        borderw: 1,
        bordercolor: 'black@0.35',
        preview: {
            fontFamily: '"DejaVu Sans", sans-serif',
            fontWeight: 500,
            textColor: '#ffffff',
            backgroundColor: 'rgba(0,0,0,0.38)',
            borderColor: 'rgba(255,255,255,0.2)',
            borderWidth: 1,
            textShadow: '1px 1px 2px rgba(0,0,0,0.65)'
        },
        layouts: {
            portrait: { fontsize: 20, maxWordsPerPhrase: 2, marginV: 120, marginL: 75, marginR: 75, previewFontSize: 16 },
            square: { fontsize: 19, maxWordsPerPhrase: 3, marginV: 90, marginL: 60, marginR: 60, previewFontSize: 14 },
            landscape: { fontsize: 16, maxWordsPerPhrase: 4, marginV: 60, marginL: 50, marginR: 50, previewFontSize: 12 }
        }
    }
};

function timeToSeconds(timeStr) {
    if (!timeStr) return 0;
    const parts = String(timeStr).split(':').map((p) => parseInt(p, 10) || 0);
    if (parts.length === 4) {
        const [h, m, s, ms] = parts;
        return (h * 3600) + (m * 60) + s + (ms / 1000);
    }
    const [m = 0, s = 0, ms = 0] = parts;
    return (m * 60) + s + (ms / 1000);
}

function formatWordTime(totalSeconds) {
    const mins = Math.floor(totalSeconds / 60);
    const secs = Math.floor(totalSeconds % 60);
    const ms = Math.floor((totalSeconds % 1) * 1000);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}:${ms.toString().padStart(3, '0')}`;
}

function convertToSRTTime(timeStr) {
    const totalMs = Math.max(0, Math.round(timeToSeconds(timeStr) * 1000));
    const hours = Math.floor(totalMs / 3600000);
    const minutes = Math.floor((totalMs % 3600000) / 60000);
    const seconds = Math.floor((totalMs % 60000) / 1000);
    const milliseconds = totalMs % 1000;

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')},${milliseconds.toString().padStart(3, '0')}`;
}

function detectLayout(videoDimensions) {
    const aspect = videoDimensions.width / videoDimensions.height;
    if (aspect < 0.9) return 'portrait';
    if (aspect > 1.2) return 'landscape';
    return 'square';
}

function getResolvedStyle(styleId, videoDimensions) {
    const style = CAPTION_STYLES[styleId] || CAPTION_STYLES['bold-center'];
    const layout = detectLayout(videoDimensions);
    return {
        id: styleId in CAPTION_STYLES ? styleId : 'bold-center',
        layout,
        ...style,
        ...style.layouts[layout]
    };
}

function convertColorToASS(color) {
    if (color === 'white') return '&H00FFFFFF';
    if (color === 'black') return '&H00000000';
    if (color.startsWith('#')) {
        const hex = color.slice(1);
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        return `&H00${b.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${r.toString(16).padStart(2, '0')}`.toUpperCase();
    }
    return '&H00FFFFFF';
}

function moveFileSafe(sourcePath, destPath) {
    try {
        fs.renameSync(sourcePath, destPath);
    } catch (error) {
        if (error.code !== 'EXDEV') {
            throw error;
        }

        fs.copyFileSync(sourcePath, destPath);
        fs.unlinkSync(sourcePath);
    }
}

function escapeSubtitlePath(filePath) {
    return path.resolve(filePath)
        .replace(/\\/g, '\\\\')
        .replace(/:/g, '\\:')
        .replace(/,/g, '\\,')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/'/g, "\\'");
}

function buildSubtitleFilter(srtPath, resolvedStyle) {
    const escapedPath = escapeSubtitlePath(srtPath);
    const styleParts = [
        `FontName=${resolvedStyle.fontName}`,
        `FontSize=${resolvedStyle.fontsize}`,
        `PrimaryColour=${convertColorToASS(resolvedStyle.fontcolor)}`,
        `OutlineColour=${convertColorToASS(resolvedStyle.bordercolor)}`,
        `Outline=${resolvedStyle.borderw}`,
        'Alignment=2',
        `MarginV=${resolvedStyle.marginV}`,
        `MarginL=${resolvedStyle.marginL}`,
        `MarginR=${resolvedStyle.marginR}`,
        'WrapStyle=0'
    ];

    if (resolvedStyle.shadow) {
        styleParts.push('Shadow=2');
    }

    return `subtitles='${escapedPath}':force_style='${styleParts.join(',')}'`;
}

function formatASSTime(totalSeconds) {
    const safeSeconds = Math.max(0, Number(totalSeconds) || 0);
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const seconds = Math.floor(safeSeconds % 60);
    const centiseconds = Math.floor((safeSeconds % 1) * 100);
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${centiseconds.toString().padStart(2, '0')}`;
}

function escapeASSText(text) {
    return String(text || '')
        .replace(/\r?\n/g, '\\N')
        .replace(/[{}]/g, '')
        .trim();
}

function buildHookASSContent(text, resolvedStyle, videoDimensions) {
    const hookFontSize = Math.round(resolvedStyle.fontsize * 1.08);
    const topMargin = resolvedStyle.layout === 'portrait' ? 70 : resolvedStyle.layout === 'square' ? 48 : 36;
    const sideMargin = Math.max(32, Math.round(videoDimensions.width * 0.08));
    const duration = videoDimensions.duration || 24 * 60 * 60;

    return `[Script Info]
ScriptType: v4.00+
PlayResX: ${videoDimensions.width}
PlayResY: ${videoDimensions.height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,${resolvedStyle.fontName},${hookFontSize},${convertColorToASS(resolvedStyle.fontcolor)},&H000000FF,${convertColorToASS(resolvedStyle.bordercolor)},&H80000000,-1,0,0,0,100,100,0,0,1,${resolvedStyle.borderw},${resolvedStyle.shadow ? 2 : 0},8,${sideMargin},${sideMargin},${topMargin},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,${formatASSTime(0)},${formatASSTime(duration)},Hook,,0,0,0,,${escapeASSText(text)}
`;
}

function buildASSSubtitleFilter(assPath) {
    return `subtitles='${escapeSubtitlePath(assPath)}'`;
}

function convertToWordLevel(segments) {
    const words = [];

    segments.forEach((segment) => {
        const startTime = timeToSeconds(segment.start);
        const endTime = timeToSeconds(segment.end);
        const duration = Math.max(endTime - startTime, 0);
        const text = String(segment.text || '').trim();
        const wordsInSegment = text.split(/\s+/).filter(Boolean);

        if (!wordsInSegment.length) return;

        const timePerWord = wordsInSegment.length > 0 ? duration / wordsInSegment.length : 0;

        wordsInSegment.forEach((word, index) => {
            const wordStart = startTime + (index * timePerWord);
            const wordEnd = wordStart + timePerWord;

            words.push({
                start: formatWordTime(wordStart),
                end: formatWordTime(wordEnd),
                text: word.replace(/[.,!?;]/g, ''),
                speaker: segment.speaker
            });
        });
    });

    return words;
}

function normalizeTranscriptWords(segments) {
    if (!Array.isArray(segments) || segments.length === 0) {
        return [];
    }

    const first = segments[0];
    if (!first || !first.text) {
        return [];
    }

    const isWordLevel = String(first.text).trim().split(/\s+/).length === 1;
    return isWordLevel ? segments : convertToWordLevel(segments);
}

function normalizeClipTimeline(clipDefinition, clipTimeline) {
    const rawTimeline = Array.isArray(clipTimeline) && clipTimeline.length > 0
        ? clipTimeline
        : clipDefinition?.mediaTimeline;

    if (!Array.isArray(rawTimeline) || rawTimeline.length === 0) {
        return [];
    }

    return rawTimeline
        .map((segment) => ({
            sourceStart: Number(segment.sourceStart),
            sourceEnd: Number(segment.sourceEnd),
            outputStart: Number(segment.outputStart),
            outputEnd: Number(segment.outputEnd),
        }))
        .filter((segment) => (
            Number.isFinite(segment.sourceStart)
            && Number.isFinite(segment.sourceEnd)
            && Number.isFinite(segment.outputStart)
            && Number.isFinite(segment.outputEnd)
            && segment.sourceStart < segment.sourceEnd
            && segment.outputStart <= segment.outputEnd
        ));
}

function clipWordToSegment(word, segStartSec, segEndSec, outputStartSec) {
    const wordStart = timeToSeconds(word.start);
    const wordEnd = timeToSeconds(word.end);
    if (!(wordEnd > segStartSec && wordStart < segEndSec)) return null;
    const clippedStart = Math.max(wordStart, segStartSec);
    const clippedEnd = Math.min(wordEnd, segEndSec);
    return {
        ...word,
        start: formatWordTime((clippedStart - segStartSec) + outputStartSec),
        end: formatWordTime((clippedEnd - segStartSec) + outputStartSec),
    };
}

function buildWordsForClip(words, clipDefinition, clipTimeline) {
    if (!clipDefinition) {
        return words;
    }

    const timeline = normalizeClipTimeline(clipDefinition, clipTimeline);
    if (timeline.length > 0) {
        return timeline.flatMap((segment) => words
            .map((w) => clipWordToSegment(w, segment.sourceStart, segment.sourceEnd, segment.outputStart))
            .filter(Boolean));
    }

    if (Array.isArray(clipDefinition.segments) && clipDefinition.segments.length > 0) {
        const out = [];
        let acc = 0;
        clipDefinition.segments.forEach((segment) => {
            words.forEach((w) => {
                const mapped = clipWordToSegment(w, segment.start, segment.end, acc);
                if (mapped) out.push(mapped);
            });
            acc += (segment.end - segment.start);
        });
        return out;
    }

    if (clipDefinition.start !== undefined && clipDefinition.end !== undefined) {
        return words
            .map((w) => clipWordToSegment(w, clipDefinition.start, clipDefinition.end, 0))
            .filter(Boolean);
    }

    return words;
}

function buildSRTContent(words, maxWordsPerPhrase) {
    if (!Array.isArray(words) || words.length === 0) {
        throw new Error('Words array is empty or invalid');
    }

    const phrases = [];
    let currentPhrase = [];
    let phraseStart = null;

    for (let i = 0; i < words.length; i += 1) {
        const word = words[i];
        if (!word || !word.start || !word.end || !word.text) {
            continue;
        }

        if (phraseStart === null) {
            phraseStart = word.start;
        }

        currentPhrase.push(word.text);
        const shouldEndPhrase = currentPhrase.length >= maxWordsPerPhrase || i === words.length - 1;

        if (shouldEndPhrase) {
            phrases.push({
                start: phraseStart,
                end: word.end,
                text: currentPhrase.join(' ')
            });
            currentPhrase = [];
            phraseStart = null;
        }
    }

    let srtContent = '';
    phrases.forEach((phrase, index) => {
        srtContent += `${index + 1}\n`;
        srtContent += `${convertToSRTTime(phrase.start)} --> ${convertToSRTTime(phrase.end)}\n`;
        srtContent += `${phrase.text}\n\n`;
    });

    return srtContent;
}

function filterWordsByRange(words, startTime, endTime) {
    if (startTime === undefined || endTime === undefined) {
        return words;
    }

    return words.filter((word) => {
        const wordStart = timeToSeconds(word.start);
        const wordEnd = timeToSeconds(word.end);
        return wordEnd > startTime && wordStart < endTime;
    });
}

function getCaptionStylesForClient() {
    return Object.entries(CAPTION_STYLES).map(([id, style]) => ({
        id,
        name: style.name,
        description: style.description,
        preview: {
            ...style.preview,
            portraitFontSize: style.layouts.portrait.previewFontSize,
            squareFontSize: style.layouts.square.previewFontSize,
            landscapeFontSize: style.layouts.landscape.previewFontSize
        }
    }));
}

async function probeVideoDimensions(inputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(inputPath, (err, metadata) => {
            if (err) {
                reject(err);
                return;
            }

            const stream = metadata.streams.find((entry) => entry.codec_type === 'video');
            if (!stream) {
                reject(new Error('Video stream not found'));
                return;
            }

            resolve({
                width: stream.width,
                height: stream.height,
                duration: metadata.format?.duration || stream.duration || 0
            });
        });
    });
}

async function renderCaptionedVideo({
    inputPath,
    outputPath,
    transcriptSegments,
    styleId,
    clipDefinition,
    clipTimeline,
    startTime,
    endTime,
    captionsEnabled = true,
    hook = { enabled: false },
    logger = console,
    prependVideoFilters = [],
    videoDimensions: videoDimensionsOverride = null,
}) {
    const videoDimensions = videoDimensionsOverride || await probeVideoDimensions(inputPath);
    const resolvedStyle = getResolvedStyle(styleId, videoDimensions);
    const hookText = typeof hook?.text === 'string' ? hook.text.trim() : '';
    const hookEnabled = Boolean(hook?.enabled && hookText);

    const tempDir = path.dirname(outputPath);
    fs.mkdirSync(tempDir, { recursive: true });

    const tempSubtitlePaths = [];
    const filters = [];
    let words = [];

    if (captionsEnabled) {
        words = normalizeTranscriptWords(transcriptSegments);
        words = buildWordsForClip(words, clipDefinition, clipTimeline);
        words = filterWordsByRange(words, startTime, endTime);

        if (words.length === 0) {
            throw new Error('No words found in specified time range');
        }

        const srtPath = path.join(tempDir, `${path.basename(outputPath, path.extname(outputPath))}.srt`);
        const srtContent = buildSRTContent(words, resolvedStyle.maxWordsPerPhrase);
        fs.writeFileSync(srtPath, srtContent);
        tempSubtitlePaths.push(srtPath);
        filters.push(buildSubtitleFilter(srtPath, resolvedStyle));
    }

    if (hookEnabled) {
        const hookPath = path.join(tempDir, `${path.basename(outputPath, path.extname(outputPath))}_hook.ass`);
        fs.writeFileSync(hookPath, buildHookASSContent(hookText, resolvedStyle, videoDimensions));
        tempSubtitlePaths.push(hookPath);
        filters.push(buildASSSubtitleFilter(hookPath));
    }

    if (filters.length === 0) {
        throw new Error('No overlays requested');
    }

    logger.info?.('Caption render configuration', {
        inputPath,
        outputPath,
        layout: resolvedStyle.layout,
        styleId: resolvedStyle.id,
        maxWordsPerPhrase: resolvedStyle.maxWordsPerPhrase,
        captionsEnabled,
        hookEnabled
    });

    const allVideoFilters = [...prependVideoFilters, ...filters];

    await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .videoFilters(allVideoFilters)
            .outputOptions([
                '-c:v libx264',
                '-c:a aac',
                '-crf 23',
                '-preset medium'
            ])
            .output(outputPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
    });

    tempSubtitlePaths.forEach((subtitlePath) => {
        try {
            fs.unlinkSync(subtitlePath);
        } catch (error) {
            logger.warn?.(`Failed to clean up subtitle file: ${error.message}`);
        }
    });

    return {
        wordCount: words.length,
        hookEnabled,
        resolvedStyle,
        videoDimensions
    };
}

module.exports = {
    CAPTION_STYLES,
    clipWordToSegment,
    detectLayout,
    getCaptionStylesForClient,
    getResolvedStyle,
    moveFileSafe,
    probeVideoDimensions,
    renderCaptionedVideo,
    buildWordsForClip,
    convertToSRTTime,
    filterWordsByRange,
    timeToSeconds,
};
