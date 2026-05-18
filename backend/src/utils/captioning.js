const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const prisma = require('../db/prisma');

const ASS_PLAY_RES_HEIGHT = 540;

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

function resolveTemplateForLayout(template, layout) {
    const layouts = template.layouts || {};
    const layoutData = layouts[layout] || layouts.portrait || {};
    return {
        id: template.id,
        name: template.name,
        description: template.description,
        usage: template.usage || 'both',
        layout,
        fontName: template.fontName,
        fontcolor: template.fontColor,
        bordercolor: template.outlineColor,
        backColor: template.backColor || null,
        borderw: template.outlineWidth,
        shadow: template.shadow,
        shadowDepth: template.shadowDepth,
        bold: template.bold,
        italic: template.italic,
        underline: template.underline,
        alignment: template.alignment,
        scaleX: template.scaleX,
        scaleY: template.scaleY,
        spacing: template.spacing,
        uppercase: template.uppercase,
        borderStyle: template.borderStyle,
        preview: template.preview || {},
        ...layoutData,
    };
}

const TEMPLATE_USAGE = {
    CAPTIONS: 'captions',
    HOOKS: 'hooks',
    BOTH: 'both',
};

function normalizeTemplateUsage(usage) {
    return [TEMPLATE_USAGE.CAPTIONS, TEMPLATE_USAGE.HOOKS, TEMPLATE_USAGE.BOTH].includes(usage)
        ? usage
        : TEMPLATE_USAGE.BOTH;
}

function templateAllowsCaptions(template) {
    const usage = normalizeTemplateUsage(template?.usage);
    return usage === TEMPLATE_USAGE.CAPTIONS || usage === TEMPLATE_USAGE.BOTH;
}

function templateAllowsHooks(template) {
    const usage = normalizeTemplateUsage(template?.usage);
    return usage === TEMPLATE_USAGE.HOOKS || usage === TEMPLATE_USAGE.BOTH;
}

async function getResolvedStyle(styleId, videoDimensions, options = {}) {
    const fallbackId = 'bold-yellow';
    const useCase = options.useCase || null;
    const allowsUseCase = useCase === 'hooks'
        ? templateAllowsHooks
        : useCase === 'captions'
            ? templateAllowsCaptions
            : () => true;
    let template = styleId
        ? await prisma.captionTemplate.findUnique({ where: { id: styleId } })
        : null;
    if (styleId && template && !allowsUseCase(template)) {
        throw new Error(`Template "${template.name}" cannot be used for ${useCase}.`);
    }
    if (!template) {
        template = await prisma.captionTemplate.findUnique({ where: { id: fallbackId } });
    }
    if (template && !allowsUseCase(template)) {
        template = null;
    }
    if (!template) {
        const allTemplates = await prisma.captionTemplate.findMany({ orderBy: { createdAt: 'asc' } });
        template = allTemplates.find(allowsUseCase) || null;
    }
    if (!template) {
        throw new Error('No caption templates found in database');
    }
    const layout = detectLayout(videoDimensions);
    return resolveTemplateForLayout(template, layout);
}

async function getCaptionStylesForClient() {
    return prisma.captionTemplate.findMany({ orderBy: { createdAt: 'asc' } });
}

function convertColorToASS(color) {
    if (!color) return '&H00FFFFFF';
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
        `FontSize=${resolvedStyle.fontSize}`,
        `PrimaryColour=${convertColorToASS(resolvedStyle.fontcolor)}`,
        `OutlineColour=${convertColorToASS(resolvedStyle.bordercolor)}`,
        `Outline=${resolvedStyle.borderw}`,
        `Alignment=${resolvedStyle.alignment ?? 2}`,
        `MarginV=${resolvedStyle.marginV}`,
        `MarginL=${resolvedStyle.marginL}`,
        `MarginR=${resolvedStyle.marginR}`,
        'WrapStyle=0',
        `ScaleX=${resolvedStyle.scaleX ?? 1}`,
        `ScaleY=${resolvedStyle.scaleY ?? 1}`,
        `Spacing=${resolvedStyle.spacing ?? 0}`,
        `Bold=${resolvedStyle.bold ? 1 : 0}`,
        `Italic=${resolvedStyle.italic ? 1 : 0}`,
        `Underline=${resolvedStyle.underline ? 1 : 0}`,
        `BorderStyle=${resolvedStyle.borderStyle ?? 1}`,
        `Shadow=${resolvedStyle.shadow ? (resolvedStyle.shadowDepth ?? 1) : 0}`,
    ];

    if (resolvedStyle.backColor) {
        styleParts.push(`BackColour=${convertColorToASS(resolvedStyle.backColor)}`);
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

function convertScaleToASSPercent(value) {
    const numeric = Number(value ?? 1);
    if (!Number.isFinite(numeric)) return 100;

    // Templates store scale as a multiplier for CSS previews: 1 = normal, 3 = 300%.
    // ASS Style fields use percentages: 100 = normal.
    return numeric > 10 ? numeric : numeric * 100;
}

function roundEven(value) {
    return Math.max(2, Math.round(value / 2) * 2);
}

function getASSPlayRes(videoDimensions) {
    const width = Number(videoDimensions?.width);
    const height = Number(videoDimensions?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return { width: 960, height: ASS_PLAY_RES_HEIGHT };
    }

    return {
        width: roundEven((width / height) * ASS_PLAY_RES_HEIGHT),
        height: ASS_PLAY_RES_HEIGHT,
    };
}

function buildHookASSContent(text, resolvedStyle, videoDimensions, timeoutSeconds) {
    const playRes = getASSPlayRes(videoDimensions);
    const hookFontSize = Math.round(resolvedStyle.fontSize || 20);
    const sideMargin = Math.max(32, Math.round(videoDimensions.width * 0.08));
    const duration = videoDimensions.duration || 24 * 60 * 60;
    const effectiveEnd = (timeoutSeconds && timeoutSeconds > 0) ? Math.min(timeoutSeconds, duration) : duration;
    const hookColor = convertColorToASS(resolvedStyle.fontcolor);
    const hookScaleXASS = convertScaleToASSPercent(resolvedStyle.scaleX ?? 1);
    const hookScaleYASS = convertScaleToASSPercent(resolvedStyle.scaleY ?? 1);

    const hookBorderStyle = resolvedStyle.borderStyle ?? 1;
    // libass uses OutlineColour as box fill for BorderStyle=3
    const hookOutlineColour = hookBorderStyle === 3 && resolvedStyle.backColor
        ? convertColorToASS(resolvedStyle.backColor)
        : convertColorToASS(resolvedStyle.bordercolor);
    const hookBackColour = '&H80000000';

    return `[Script Info]
ScriptType: v4.00+
PlayResX: ${playRes.width}
PlayResY: ${playRes.height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,${resolvedStyle.fontName},${hookFontSize},${hookColor},&H000000FF,${hookOutlineColour},${hookBackColour},${resolvedStyle.bold ? -1 : 0},${resolvedStyle.italic ? 1 : 0},${resolvedStyle.underline ? 1 : 0},0,${hookScaleXASS},${hookScaleYASS},${resolvedStyle.spacing ?? 0},0,${hookBorderStyle},${resolvedStyle.borderw},${resolvedStyle.shadow ? (resolvedStyle.shadowDepth ?? 1) : 0},${resolvedStyle.alignment ?? 2},${resolvedStyle.marginL ?? sideMargin},${resolvedStyle.marginR ?? sideMargin},${resolvedStyle.marginV ?? 20},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,${formatASSTime(0)},${formatASSTime(effectiveEnd)},Hook,,0,0,0,,${escapeASSText(text)}
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

function buildPhrases(words, maxWordsPerPhrase, uppercase = true) {
    if (!Array.isArray(words) || words.length === 0) {
        throw new Error('Words array is empty or invalid');
    }

    const phrases = [];
    let currentPhrase = [];
    let phraseStart = null;

    for (let i = 0; i < words.length; i += 1) {
        const word = words[i];
        if (!word || !word.start || !word.end || !word.text) continue;
        if (phraseStart === null) phraseStart = word.start;
        currentPhrase.push(word.text);
        const shouldEndPhrase = currentPhrase.length >= maxWordsPerPhrase || i === words.length - 1;
        if (shouldEndPhrase) {
            const text = currentPhrase.join(' ');
            phrases.push({
                start: phraseStart,
                end: word.end,
                text: uppercase ? text.toUpperCase() : text,
            });
            currentPhrase = [];
            phraseStart = null;
        }
    }
    return phrases;
}

function buildSRTContent(words, maxWordsPerPhrase, uppercase = true) {
    const phrases = buildPhrases(words, maxWordsPerPhrase, uppercase);
    let srtContent = '';
    phrases.forEach((phrase, index) => {
        srtContent += `${index + 1}\n`;
        srtContent += `${convertToSRTTime(phrase.start)} --> ${convertToSRTTime(phrase.end)}\n`;
        srtContent += `${phrase.text}\n\n`;
    });
    return srtContent;
}

function buildCaptionASSContent(phrases, resolvedStyle, videoDimensions) {
    const playRes = getASSPlayRes(videoDimensions);
    const scaleX = convertScaleToASSPercent(resolvedStyle.scaleX);
    const scaleY = convertScaleToASSPercent(resolvedStyle.scaleY);
    const alignment = resolvedStyle.alignment ?? 2;
    const isOpaqueBox = (resolvedStyle.borderStyle ?? 1) === 3;
    // libass uses OutlineColour (not BackColour) as the box fill for BorderStyle=3
    const outlineColour = isOpaqueBox && resolvedStyle.backColor
        ? convertColorToASS(resolvedStyle.backColor)
        : convertColorToASS(resolvedStyle.bordercolor);
    const backColour = '&H80000000';

    const styleFields = [
        'Default',
        resolvedStyle.fontName,
        resolvedStyle.fontSize,
        convertColorToASS(resolvedStyle.fontcolor),
        '&H000000FF',
        outlineColour,
        backColour,
        resolvedStyle.bold ? -1 : 0,
        resolvedStyle.italic ? 1 : 0,
        resolvedStyle.underline ? 1 : 0,
        0,
        scaleX,
        scaleY,
        resolvedStyle.spacing ?? 0,
        0,
        resolvedStyle.borderStyle ?? 1,
        resolvedStyle.borderw ?? 1,
        resolvedStyle.shadow ? (resolvedStyle.shadowDepth ?? 1) : 0,
        alignment,
        resolvedStyle.marginL ?? 0,
        resolvedStyle.marginR ?? 0,
        resolvedStyle.marginV ?? 20,
        1,
    ].join(',');

    const dialogues = phrases.map((phrase) =>
        `Dialogue: 0,${formatASSTime(timeToSeconds(phrase.start))},${formatASSTime(timeToSeconds(phrase.end))},Default,,0,0,0,,${escapeASSText(phrase.text)}`
    ).join('\n');

    return `[Script Info]
ScriptType: v4.00+
PlayResX: ${playRes.width}
PlayResY: ${playRes.height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: ${styleFields}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${dialogues}
`;
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
    hookStyleId,
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
    const hookText = typeof hook?.text === 'string' ? hook.text.trim() : '';
    const hookEnabled = Boolean(hook?.enabled && hookText);
    const resolvedStyle = captionsEnabled
        ? await getResolvedStyle(styleId, videoDimensions, { useCase: 'captions' })
        : null;
    const resolvedHookStyle = hookEnabled && hookStyleId
        ? await getResolvedStyle(hookStyleId, videoDimensions, { useCase: 'hooks' })
        : (resolvedStyle && templateAllowsHooks(resolvedStyle))
            ? resolvedStyle
            : (hookEnabled ? await getResolvedStyle(null, videoDimensions, { useCase: 'hooks' }) : null);

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

        const phrases = buildPhrases(words, resolvedStyle.maxWordsPerPhrase, resolvedStyle.uppercase);
        const assPath = path.join(tempDir, `${path.basename(outputPath, path.extname(outputPath))}.ass`);
        fs.writeFileSync(assPath, buildCaptionASSContent(phrases, resolvedStyle, videoDimensions));
        tempSubtitlePaths.push(assPath);
        filters.push(buildASSSubtitleFilter(assPath));
    }

    if (hookEnabled) {
        const hookPath = path.join(tempDir, `${path.basename(outputPath, path.extname(outputPath))}_hook.ass`);
        fs.writeFileSync(hookPath, buildHookASSContent(hookText, resolvedHookStyle, videoDimensions, hook?.timeoutSeconds));
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
    clipWordToSegment,
    detectLayout,
    resolveTemplateForLayout,
    getCaptionStylesForClient,
    getResolvedStyle,
    normalizeTemplateUsage,
    templateAllowsCaptions,
    templateAllowsHooks,
    moveFileSafe,
    probeVideoDimensions,
    renderCaptionedVideo,
    buildWordsForClip,
    buildPhrases,
    buildSRTContent,
    buildCaptionASSContent,
    buildSubtitleFilter,
    buildHookASSContent,
    buildASSSubtitleFilter,
    escapeSubtitlePath,
    convertColorToASS,
    convertToSRTTime,
    filterWordsByRange,
    normalizeTranscriptWords,
    timeToSeconds,
};
