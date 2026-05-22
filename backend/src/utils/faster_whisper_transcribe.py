#!/usr/bin/env python3
import sys
import json
import subprocess
from faster_whisper import WhisperModel


def get_duration(audio_path):
    result = subprocess.run(
        ['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
         '-of', 'default=noprint_wrappers=1:nokey=1', audio_path],
        capture_output=True, text=True
    )
    try:
        return float(result.stdout.strip())
    except Exception:
        return 0


def main():
    if len(sys.argv) < 6:
        print('Usage: faster_whisper_transcribe.py <audio> <model_path> <language> <threads> <out_json>', file=sys.stderr)
        sys.exit(1)

    audio_path, model_path, language, threads, out_path = sys.argv[1:6]
    language = None if language == 'auto' else language
    cpu_threads = int(threads) if threads and threads.isdigit() else 4

    duration = get_duration(audio_path)

    # faster-whisper accepts either a directory path or a model ID string.
    # If model_path doesn't exist on disk it's treated as a HuggingFace model ID
    # and auto-downloaded to ~/.cache/huggingface/hub/ — works transparently in dev.
    model = WhisperModel(model_path, device='cpu', compute_type='int8',
                         cpu_threads=cpu_threads)

    segments, _ = model.transcribe(
        audio_path,
        language=language,
        word_timestamps=True,
        vad_filter=True,
    )

    transcription = []
    last_pct = -1

    for segment in segments:
        if duration > 0:
            pct = min(99, int((segment.end / duration) * 100))
            if pct >= last_pct + 5:
                last_pct = pct
                print(f'progress = {pct}%', file=sys.stderr, flush=True)

        if segment.words:
            for word in segment.words:
                text = word.word.strip()
                if text:
                    transcription.append({
                        'offsets': {
                            'from': int(word.start * 1000),
                            'to': int(word.end * 1000),
                        },
                        'text': text,
                    })

    with open(out_path, 'w') as f:
        json.dump({'transcription': transcription}, f)

    print('progress = 100%', file=sys.stderr, flush=True)


if __name__ == '__main__':
    main()
