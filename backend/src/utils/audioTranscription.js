const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');
const { generateJsonContent, getModelCandidates } = require('./gemini');
const {
    TRANSCRIPTION_PROMPT,
    TRANSCRIPTION_SCHEMA,
    assertTranscriptNotCancelled,
    logVideoProcessing,
    runTrackedCommand,
} = require('./backgroundJobs');

const DEFAULT_CHUNK_DURATION_SEC = 300;
const DEFAULT_CHUNK_OVERLAP_SEC = 30;
const DEFAULT_CHUNK_CONCURRENCY = 4;

function readPositiveNumberEnv(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readNonNegativeNumberEnv(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function getChunkConfig() {
    const durationSec = readPositiveNumberEnv('CHUNK_DURATION_SEC', DEFAULT_CHUNK_DURATION_SEC);
    let overlapSec = readNonNegativeNumberEnv('CHUNK_OVERLAP_SEC', DEFAULT_CHUNK_OVERLAP_SEC);
    if (overlapSec >= durationSec) {
        overlapSec = DEFAULT_CHUNK_OVERLAP_SEC < durationSec ? DEFAULT_CHUNK_OVERLAP_SEC : 0;
    }

    return {
        durationSec,
        overlapSec,
        stepSec: durationSec - overlapSec,
        concurrency: Math.max(1, Math.floor(readPositiveNumberEnv('CHUNK_CONCURRENCY', DEFAULT_CHUNK_CONCURRENCY))),
    };
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function timeStringToMs(value) {
    if (typeof value !== 'string') return null;
    const parts = value.split(':');
    if (parts.length !== 3) return null;

    const minutes = Number.parseInt(parts[0], 10);
    const seconds = Number.parseInt(parts[1], 10);
    const milliseconds = Number.parseInt(parts[2], 10);
    if (![minutes, seconds, milliseconds].every(Number.isFinite)) return null;

    return ((minutes * 60) + seconds) * 1000 + milliseconds;
}

function msToTimeString(totalMs) {
    const safeMs = Math.max(0, Math.round(totalMs));
    const minutes = Math.floor(safeMs / 60000);
    const seconds = Math.floor((safeMs % 60000) / 1000);
    const milliseconds = safeMs % 1000;

    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}:${String(milliseconds).padStart(3, '0')}`;
}

async function getAudioDurationSec(mp3Path, { transcriptId, jobType }) {
    const result = await runTrackedCommand({
        transcriptId,
        jobType,
        phase: 'probe-audio-duration',
        command: `ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${shellQuote(mp3Path)}`,
    });
    const duration = Number.parseFloat(result.stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error('Could not read MP3 duration.');
    }
    return duration;
}

async function splitAudio(mp3Path, outDir, { durationSec, stepSec, totalDurationSec, transcriptId, jobType }) {
    await fs.promises.mkdir(outDir, { recursive: true });

    const chunkCount = Math.max(1, Math.ceil((totalDurationSec - (durationSec - stepSec)) / stepSec));
    const chunks = [];

    for (let index = 0; index < chunkCount; index += 1) {
        const startSec = index * stepSec;
        const remainingDuration = Math.max(0, totalDurationSec - startSec);
        const clipDurationSec = Math.min(durationSec, remainingDuration);
        if (clipDurationSec <= 0) break;

        const chunkPath = path.join(outDir, `chunk_${index}.mp3`);
        await runTrackedCommand({
            transcriptId,
            jobType,
            phase: 'split-audio',
            command: `ffmpeg -y -ss ${startSec.toFixed(3)} -t ${clipDurationSec.toFixed(3)} -i ${shellQuote(mp3Path)} -c copy ${shellQuote(chunkPath)}`,
        });
        chunks.push({ index, path: chunkPath, startSec });
    }

    return chunks;
}

function getPromotedModelOrder(modelOrder, attempts) {
    if (!Array.isArray(modelOrder) || modelOrder.length < 2 || !Array.isArray(attempts)) {
        return modelOrder;
    }

    const firstModel = modelOrder[0];
    const successfulFallback = attempts.find((attempt) => attempt?.success && attempt.model !== firstModel);
    if (!successfulFallback) {
        return modelOrder;
    }

    const firstModelFailedBothAttempts = [1, 2].every((attemptNumber) => attempts.some((attempt) => (
        attempt?.model === firstModel
        && attempt.attempt === attemptNumber
        && attempt.success === false
    )));

    if (!firstModelFailedBothAttempts) {
        return modelOrder;
    }

    return [
        successfulFallback.model,
        ...modelOrder.filter((model) => model !== successfulFallback.model),
    ];
}

function logGeminiAttemptEvent({ transcriptId, jobType, chunkIndex, chunkCount, event }) {
    const baseMetadata = {
        jobType,
        phase: 'transcribe',
        chunkIndex,
        chunkCount,
    };

    if (event.event === 'attempt_started') {
        logVideoProcessing(transcriptId, 'running', 'Gemini transcription attempt started', {
            ...baseMetadata,
            model: event.model,
            attempt: event.attempt,
        });
    } else if (event.event === 'attempt_failed') {
        logVideoProcessing(transcriptId, 'warning', 'Gemini transcription attempt failed', {
            ...baseMetadata,
            model: event.model,
            attempt: event.attempt,
            status: event.status,
            code: event.code,
            retryable: event.retryable,
            message: event.message,
        });
    } else if (event.event === 'retry_sleep') {
        logVideoProcessing(transcriptId, 'running', 'Gemini transcription retry scheduled', {
            ...baseMetadata,
            model: event.model,
            attempt: event.attempt,
            delayMs: event.delayMs,
        });
    } else if (event.event === 'model_switch') {
        logVideoProcessing(transcriptId, 'running', 'Gemini transcription model switch', {
            ...baseMetadata,
            exhaustedModel: event.exhaustedModel,
            nextModel: event.nextModel,
        });
    } else if (event.event === 'attempt_succeeded') {
        logVideoProcessing(transcriptId, 'completed', 'Gemini transcription attempt succeeded', {
            ...baseMetadata,
            model: event.model,
            attempt: event.attempt,
        });
    }
}

async function transcribeChunk({ genAI, fileManager, chunkPath, transcriptId, logLabel, modelCandidates, onAttemptEvent }) {
    const uploadResult = await fileManager.uploadFile(chunkPath, {
        mimeType: 'audio/mpeg',
        displayName: path.basename(chunkPath),
    });
    const audioPart = { fileData: { mimeType: uploadResult.file.mimeType, fileUri: uploadResult.file.uri } };
    const { data, model, attempts } = await generateJsonContent({
        genAI,
        logLabel,
        modelCandidates,
        onAttemptEvent,
        contents: [{
            role: 'user',
            parts: [
                { text: TRANSCRIPTION_PROMPT },
                audioPart,
            ],
        }],
        responseSchema: TRANSCRIPTION_SCHEMA,
    });

    if (!Array.isArray(data)) {
        throw new Error(`Gemini returned a non-array transcript for ${transcriptId}.`);
    }

    return { words: data, model, attempts };
}

function offsetAndFilterWords(words, chunkIndex, isLast, stepMs) {
    const offsetMs = chunkIndex * stepMs;
    const ownershipStartMs = offsetMs;
    const ownershipEndMs = isLast ? Infinity : (chunkIndex + 1) * stepMs;

    return words
        .map((word) => {
            const startMs = timeStringToMs(word?.start);
            const endMs = timeStringToMs(word?.end);
            if (startMs === null || endMs === null) return null;

            const absoluteStartMs = startMs + offsetMs;
            const absoluteEndMs = endMs + offsetMs;
            if (absoluteStartMs < ownershipStartMs || absoluteStartMs >= ownershipEndMs) return null;

            return {
                ...word,
                start: msToTimeString(absoluteStartMs),
                end: msToTimeString(absoluteEndMs),
            };
        })
        .filter(Boolean);
}

async function runChunksWithLimit(chunks, limit, fn) {
    const results = new Array(chunks.length);
    let nextIndex = 0;
    let firstError = null;

    const workers = Array.from({ length: Math.min(limit, chunks.length) }, async () => {
        while (!firstError) {
            const currentIndex = nextIndex;
            nextIndex += 1;
            if (currentIndex >= chunks.length) return;

            try {
                results[currentIndex] = await fn(chunks[currentIndex], currentIndex);
            } catch (error) {
                firstError = error;
                return;
            }
        }
    });

    await Promise.allSettled(workers);
    if (firstError) throw firstError;
    return results;
}

async function removeFile(filePath) {
    await fs.promises.rm(filePath, { force: true }).catch(() => {});
}

async function transcribeAudioFile({
    mp3Path,
    transcriptId,
    jobType,
    logLabel,
    onPhaseChange,
}) {
    const config = getChunkConfig();
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);
    const chunkDir = path.join(path.dirname(mp3Path), `${path.basename(mp3Path, path.extname(mp3Path))}-chunks-${Date.now()}-${process.pid}`);
    let chunks = [];

    try {
        await assertTranscriptNotCancelled(transcriptId, jobType);
        await onPhaseChange?.('probe-audio-duration', 'Reading audio duration.');
        const durationSec = await getAudioDurationSec(mp3Path, { transcriptId, jobType });

        if (durationSec <= config.durationSec) {
            await assertTranscriptNotCancelled(transcriptId, jobType);
            await onPhaseChange?.('upload-gemini', 'Uploading audio to Gemini.', {
                mp3FileName: path.basename(mp3Path),
            });
            await onPhaseChange?.('transcribe', 'Transcribing audio with Gemini.', {
                mp3FileName: path.basename(mp3Path),
            });
            const { words, model } = await transcribeChunk({
                genAI,
                fileManager,
                chunkPath: mp3Path,
                transcriptId,
                logLabel,
            });

            await assertTranscriptNotCancelled(transcriptId, jobType);
            return { transcript: words, model };
        }

        await assertTranscriptNotCancelled(transcriptId, jobType);
        const expectedChunkCount = Math.max(1, Math.ceil((durationSec - config.overlapSec) / config.stepSec));
        await onPhaseChange?.('split-audio', `Splitting audio into ${expectedChunkCount} chunks.`);
        chunks = await splitAudio(mp3Path, chunkDir, {
            durationSec: config.durationSec,
            stepSec: config.stepSec,
            totalDurationSec: durationSec,
            transcriptId,
            jobType,
        });

        await assertTranscriptNotCancelled(transcriptId, jobType);
        await onPhaseChange?.('transcribe', `Transcribing ${chunks.length} audio chunks with Gemini.`);
        const stepMs = config.stepSec * 1000;
        let modelOrder = getModelCandidates();
        const chunkResults = await runChunksWithLimit(chunks, config.concurrency, async (chunk) => {
            await assertTranscriptNotCancelled(transcriptId, jobType);
            const chunkModelOrder = [...modelOrder];
            try {
                logVideoProcessing(transcriptId, 'running', 'Gemini chunk transcription started', {
                    jobType,
                    phase: 'transcribe',
                    chunkIndex: chunk.index,
                    chunkCount: chunks.length,
                    modelCandidates: chunkModelOrder,
                });
                const result = await transcribeChunk({
                    genAI,
                    fileManager,
                    chunkPath: chunk.path,
                    transcriptId,
                    logLabel: `${logLabel} chunk ${chunk.index + 1}/${chunks.length}`,
                    modelCandidates: chunkModelOrder,
                    onAttemptEvent: (event) => logGeminiAttemptEvent({
                        transcriptId,
                        jobType,
                        chunkIndex: chunk.index,
                        chunkCount: chunks.length,
                        event,
                    }),
                });
                const promotedModelOrder = getPromotedModelOrder(chunkModelOrder, result.attempts);
                if (promotedModelOrder[0] !== chunkModelOrder[0] && modelOrder[0] === chunkModelOrder[0]) {
                    logVideoProcessing(transcriptId, 'running', 'Gemini transcription model promoted', {
                        jobType,
                        phase: 'transcribe',
                        chunkIndex: chunk.index,
                        chunkCount: chunks.length,
                        previousFirstModel: chunkModelOrder[0],
                        promotedModel: promotedModelOrder[0],
                        modelCandidates: promotedModelOrder,
                    });
                    modelOrder = promotedModelOrder;
                }
                logVideoProcessing(transcriptId, 'completed', 'Gemini chunk transcription completed', {
                    jobType,
                    phase: 'transcribe',
                    chunkIndex: chunk.index,
                    chunkCount: chunks.length,
                    wordCount: result.words.length,
                    model: result.model,
                });
                return result;
            } catch (error) {
                const wrapped = new Error(`Gemini transcription failed for chunk ${chunk.index + 1}/${chunks.length}: ${error.message}`);
                wrapped.cause = error;
                wrapped.code = error.code;
                throw wrapped;
            } finally {
                await removeFile(chunk.path);
            }
        });

        await assertTranscriptNotCancelled(transcriptId, jobType);
        await onPhaseChange?.('merge-transcript', 'Merging chunk transcripts.');
        const transcript = chunkResults
            .flatMap((result, index) => offsetAndFilterWords(result.words, index, index === chunkResults.length - 1, stepMs))
            .sort((a, b) => timeStringToMs(a.start) - timeStringToMs(b.start));
        const model = [...new Set(chunkResults.map((result) => result.model).filter(Boolean))].join(', ');

        return { transcript, model };
    } finally {
        await Promise.all(chunks.map((chunk) => removeFile(chunk.path)));
        await fs.promises.rm(chunkDir, { recursive: true, force: true }).catch(() => {});
    }
}

module.exports = {
    TRANSCRIPTION_PROMPT,
    TRANSCRIPTION_SCHEMA,
    getAudioDurationSec,
    getPromotedModelOrder,
    offsetAndFilterWords,
    runChunksWithLimit,
    splitAudio,
    transcribeAudioFile,
    transcribeChunk,
};
