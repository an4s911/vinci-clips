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
    const parts = String(timeStr).split(':');
    const minutes = parseInt(parts[0], 10) || 0;
    const seconds = parseInt(parts[1], 10) || 0;
    const milliseconds = parseInt(parts[2], 10) || 0;
    return (minutes * 60) + seconds + (milliseconds / 1000);
}

function formatWordTime(totalSeconds) {
    const mins = Math.floor(totalSeconds / 60);
    const secs = Math.floor(totalSeconds % 60);
    const ms = Math.floor((totalSeconds % 1) * 1000);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}:${ms.toString().padStart(3, '0')}`;
}

function convertToSRTTime(timeStr) {
    const parts = timeStr.split(':');
    let hours = 0;
    let minutes = 0;
    let seconds = 0;
    let milliseconds = 0;

    if (parts.length === 3) {
        minutes = parseInt(parts[0], 10) || 0;
        seconds = parseInt(parts[1], 10) || 0;
        milliseconds = parseInt(parts[2], 10) || 0;
    } else if (parts.length === 2) {
        minutes = parseInt(parts[0], 10) || 0;
        seconds = parseInt(parts[1], 10) || 0;
    }

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

function buildWordsForClip(words, clipDefinition) {
    if (!clipDefinition) {
        return words;
    }

    if (Array.isArray(clipDefinition.segments) && clipDefinition.segments.length > 0) {
        let accumulatedOffset = 0;
        const adjustedWords = [];

        clipDefinition.segments.forEach((segment) => {
            const segmentDuration = segment.end - segment.start;
            words.forEach((word) => {
                const wordStart = timeToSeconds(word.start);
                const wordEnd = timeToSeconds(word.end);

                if (wordStart >= segment.start && wordEnd <= segment.end) {
                    adjustedWords.push({
                        ...word,
                        start: formatWordTime((wordStart - segment.start) + accumulatedOffset),
                        end: formatWordTime((wordEnd - segment.start) + accumulatedOffset)
                    });
                }
            });
            accumulatedOffset += segmentDuration;
        });

        return adjustedWords;
    }

    if (clipDefinition.start !== undefined && clipDefinition.end !== undefined) {
        return words
            .filter((word) => {
                const wordStart = timeToSeconds(word.start);
                const wordEnd = timeToSeconds(word.end);
                return wordStart >= clipDefinition.start && wordEnd <= clipDefinition.end;
            })
            .map((word) => {
                const wordStart = timeToSeconds(word.start) - clipDefinition.start;
                const wordEnd = timeToSeconds(word.end) - clipDefinition.start;
                return {
                    ...word,
                    start: formatWordTime(wordStart),
                    end: formatWordTime(wordEnd)
                };
            });
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
        return wordStart >= startTime && wordEnd <= endTime;
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
                height: stream.height
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
    startTime,
    endTime,
    logger = console
}) {
    const videoDimensions = await probeVideoDimensions(inputPath);
    const resolvedStyle = getResolvedStyle(styleId, videoDimensions);
    let words = normalizeTranscriptWords(transcriptSegments);
    words = buildWordsForClip(words, clipDefinition);
    words = filterWordsByRange(words, startTime, endTime);

    if (words.length === 0) {
        throw new Error('No words found in specified time range');
    }

    const tempDir = path.dirname(outputPath);
    fs.mkdirSync(tempDir, { recursive: true });

    const srtPath = path.join(tempDir, `${path.basename(outputPath, path.extname(outputPath))}.srt`);
    const srtContent = buildSRTContent(words, resolvedStyle.maxWordsPerPhrase);
    fs.writeFileSync(srtPath, srtContent);

    const subtitleFilter = buildSubtitleFilter(srtPath, resolvedStyle);
    logger.info?.('Caption render configuration', {
        inputPath,
        outputPath,
        layout: resolvedStyle.layout,
        styleId: resolvedStyle.id,
        maxWordsPerPhrase: resolvedStyle.maxWordsPerPhrase
    });

    await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .videoFilters([subtitleFilter])
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

    try {
        fs.unlinkSync(srtPath);
    } catch (error) {
        logger.warn?.(`Failed to clean up subtitle file: ${error.message}`);
    }

    return {
        wordCount: words.length,
        resolvedStyle,
        videoDimensions
    };
}

module.exports = {
    CAPTION_STYLES,
    detectLayout,
    getCaptionStylesForClient,
    getResolvedStyle,
    moveFileSafe,
    probeVideoDimensions,
    renderCaptionedVideo,
    timeToSeconds
};
