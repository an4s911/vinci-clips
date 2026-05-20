const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { msToTimeString } = require('./audioTranscription');
const {
    activeTranscriptJobs,
    assertTranscriptNotCancelled,
    logVideoProcessing,
    runTrackedCommand,
} = require('./backgroundJobs');

const DEFAULT_WHISPER_BIN = '/usr/local/bin/whisper-cli';
const DEFAULT_WHISPER_MODEL = '/app/models/ggml-large-v3-turbo.bin';

function getWhisperConfig() {
    return {
        bin: process.env.WHISPER_BIN || DEFAULT_WHISPER_BIN,
        model: process.env.WHISPER_MODEL || DEFAULT_WHISPER_MODEL,
        threads: Math.max(1, Number.parseInt(process.env.WHISPER_THREADS, 10) || os.cpus().length),
        language: process.env.WHISPER_LANGUAGE || 'auto',
    };
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function spawnWhisper({ bin, args, transcriptId, jobType, phase, onProgress, onLog }) {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args);
        let stdout = '';
        let stderr = '';

        const activeJob = activeTranscriptJobs.get(transcriptId);
        if (activeJob) activeJob.child = child;

        child.on('close', () => {
            const job = activeTranscriptJobs.get(transcriptId);
            if (job?.child === child) job.child = null;
        });

        function parseLine(line) {
            const match = line.match(/progress\s*=\s*(\d+)%/);
            if (match) onProgress?.(Number(match[1]));
        }

        function makeLineReader(onChunk) {
            let buf = '';
            return (chunk) => {
                buf += chunk.toString();
                const lines = buf.split('\n');
                buf = lines.pop();
                for (const line of lines) {
                    onChunk(line);
                }
            };
        }

        child.stdout.on('data', makeLineReader((line) => {
            stdout += line + '\n';
        }));

        child.stderr.on('data', makeLineReader((line) => {
            stderr += line + '\n';
            parseLine(line);
            if (line.trim() && !line.includes('progress =')) onLog?.('stderr', line);
        }));

        child.on('close', (code) => {
            if (code === 0) {
                resolve(stdout);
            } else {
                const err = new Error(`whisper-cli exited with code ${code}\n${stderr.slice(0, 2000)}`);
                err.stderr = stderr;
                err.exitCode = code;
                reject(err);
            }
        });

        child.on('error', reject);
    });
}

async function transcribeAudioFile({
    mp3Path,
    transcriptId,
    jobType,
    logLabel,
    onPhaseChange,
}) {
    const config = getWhisperConfig();
    const workDir = path.join(path.dirname(mp3Path), `whisper-${Date.now()}-${process.pid}`);
    const wavPath = path.join(workDir, 'audio.wav');
    const outPrefix = path.join(workDir, 'out');
    await fs.promises.mkdir(workDir, { recursive: true });

    try {
        await assertTranscriptNotCancelled(transcriptId, jobType);
        await onPhaseChange?.('transcribe', 'Converting audio for transcription.');

        await runTrackedCommand({
            transcriptId,
            jobType,
            phase: 'transcribe',
            command: `ffmpeg -y -i ${shellQuote(mp3Path)} -ar 16000 -ac 1 -c:a pcm_s16le ${shellQuote(wavPath)}`,
            options: { maxBuffer: 20 * 1024 * 1024 },
        });

        await assertTranscriptNotCancelled(transcriptId, jobType);
        await onPhaseChange?.('transcribe', 'Transcribing audio... 0%');

        const langArgs = config.language && config.language !== 'auto'
            ? ['-l', config.language]
            : [];

        const whisperArgs = [
            '-m', config.model,
            '-f', wavPath,
            '-ml', '1',
            '--split-on-word',
            '-pp',
            '-oj',
            '-of', outPrefix,
            '-t', String(config.threads),
            ...langArgs,
        ];

        logVideoProcessing(transcriptId, 'running', 'whisper.cpp transcription started', {
            jobType,
            phase: 'transcribe',
            logLabel,
            model: path.basename(config.model),
            threads: config.threads,
        });

        let lastReportedPct = 0;
        await spawnWhisper({
            bin: config.bin,
            args: whisperArgs,
            transcriptId,
            jobType,
            phase: 'transcribe',
            onProgress: (pct) => {
                if (pct <= lastReportedPct) return;
                lastReportedPct = pct;
                logVideoProcessing(transcriptId, 'running', `Transcribing audio... ${pct}%`, {
                    jobType,
                    phase: 'transcribe',
                    pct,
                });
                onPhaseChange?.('transcribe', `Transcribing audio... ${pct}%`).catch(() => {});
            },
        });

        await assertTranscriptNotCancelled(transcriptId, jobType);

        const jsonPath = `${outPrefix}.json`;
        const raw = await fs.promises.readFile(jsonPath, 'utf8');
        const parsed = JSON.parse(raw);

        const entries = Array.isArray(parsed?.transcription) ? parsed.transcription : [];
        const transcript = entries
            .map((entry) => {
                const from = entry?.offsets?.from;
                const to = entry?.offsets?.to;
                const text = typeof entry?.text === 'string' ? entry.text.trim() : '';
                if (!Number.isFinite(from) || !Number.isFinite(to) || !text) return null;
                return { start: msToTimeString(from), end: msToTimeString(to), text };
            })
            .filter(Boolean);

        if (transcript.length === 0) {
            throw new Error('whisper.cpp produced an empty transcript.');
        }

        const modelName = path.basename(config.model, '.bin');
        logVideoProcessing(transcriptId, 'completed', 'whisper.cpp transcription completed', {
            jobType,
            phase: 'transcribe',
            logLabel,
            wordCount: transcript.length,
            model: modelName,
        });

        return { transcript, model: modelName };
    } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
}

module.exports = { transcribeAudioFile };
