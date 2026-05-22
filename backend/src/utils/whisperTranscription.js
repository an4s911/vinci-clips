const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { msToTimeString } = require('./audioTranscription');
const {
    activeTranscriptJobs,
    assertTranscriptNotCancelled,
    logVideoProcessing,
} = require('./backgroundJobs');

const TRANSCRIBE_SCRIPT = path.join(__dirname, 'faster_whisper_transcribe.py');
const DEFAULT_WHISPER_MODEL = '/app/models/faster-whisper-large-v3-turbo';

function getWhisperConfig() {
    return {
        model: process.env.WHISPER_MODEL || DEFAULT_WHISPER_MODEL,
        threads: Math.max(1, Number.parseInt(process.env.WHISPER_THREADS, 10) || os.cpus().length),
        language: process.env.WHISPER_LANGUAGE || 'auto',
    };
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
    const outJson = path.join(workDir, 'out.json');
    await fs.promises.mkdir(workDir, { recursive: true });

    try {
        await assertTranscriptNotCancelled(transcriptId, jobType);
        await onPhaseChange?.('transcribe', 'Transcribing audio... 0%');

        const args = [
            TRANSCRIBE_SCRIPT,
            mp3Path,
            config.model,
            config.language,
            String(config.threads),
            outJson,
        ];

        logVideoProcessing(transcriptId, 'running', 'faster-whisper transcription started', {
            jobType,
            phase: 'transcribe',
            logLabel,
            model: path.basename(config.model),
            threads: config.threads,
            command: ['python3', ...args].join(' '),
        });

        let lastReportedPct = 0;

        await new Promise((resolve, reject) => {
            const child = spawn('python3', args);
            let stderr = '';

            const activeJob = activeTranscriptJobs.get(transcriptId);
            if (activeJob) activeJob.child = child;

            child.on('close', () => {
                const job = activeTranscriptJobs.get(transcriptId);
                if (job?.child === child) job.child = null;
            });

            function makeLineReader(onLine) {
                let buf = '';
                return (chunk) => {
                    buf += chunk.toString();
                    const lines = buf.split('\n');
                    buf = lines.pop();
                    for (const line of lines) onLine(line);
                };
            }

            child.stderr.on('data', makeLineReader((line) => {
                stderr += line + '\n';
                const match = line.match(/progress\s*=\s*(\d+)%/);
                if (match) {
                    const pct = Number(match[1]);
                    if (pct > lastReportedPct) {
                        lastReportedPct = pct;
                        logVideoProcessing(transcriptId, 'running', `Transcribing audio... ${pct}%`, {
                            jobType,
                            phase: 'transcribe',
                            pct,
                        });
                        onPhaseChange?.('transcribe', `Transcribing audio... ${pct}%`).catch(() => {});
                    }
                } else if (line.trim()) {
                    logVideoProcessing(transcriptId, 'running', line.trim(), { jobType, phase: 'transcribe' });
                }
            }));

            child.stdout.on('data', () => {});

            child.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`faster-whisper exited with code ${code}\n${stderr.slice(0, 2000)}`));
            });

            child.on('error', reject);
        });

        await assertTranscriptNotCancelled(transcriptId, jobType);

        const raw = await fs.promises.readFile(outJson, 'utf8');
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
            throw new Error('faster-whisper produced an empty transcript.');
        }

        const modelName = path.basename(config.model);
        logVideoProcessing(transcriptId, 'completed', 'faster-whisper transcription completed', {
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
