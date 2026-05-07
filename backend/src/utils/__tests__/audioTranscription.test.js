jest.mock('../backgroundJobs', () => ({
    buildTranscriptionPrompt: jest.fn(() => 'prompt'),
    TRANSCRIPTION_PROMPT: 'prompt',
    TRANSCRIPTION_SCHEMA: {},
    assertTranscriptNotCancelled: jest.fn(),
    logVideoProcessing: jest.fn(),
    runTrackedCommand: jest.fn(),
}));

const {
    getPromotedModelOrder,
    mergeChunkTranscripts,
    offsetAndFilterWords,
    runChunksWithLimit,
} = require('../audioTranscription');

describe('audioTranscription', () => {
    describe('getPromotedModelOrder', () => {
        test('promotes fallback only after two failed attempts from the current first model', () => {
            const order = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];
            const attempts = [
                { model: 'gemini-2.5-flash', attempt: 1, success: false },
                { model: 'gemini-2.5-flash', attempt: 2, success: false },
                { model: 'gemini-2.5-flash-lite', attempt: 1, success: true },
            ];

            expect(getPromotedModelOrder(order, attempts)).toEqual([
                'gemini-2.5-flash-lite',
                'gemini-2.5-flash',
                'gemini-2.0-flash',
            ]);
        });

        test('does not promote after one failure', () => {
            const order = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
            const attempts = [
                { model: 'gemini-2.5-flash', attempt: 1, success: false },
                { model: 'gemini-2.5-flash-lite', attempt: 1, success: true },
            ];

            expect(getPromotedModelOrder(order, attempts)).toBe(order);
        });

        test('does not duplicate models when promoting', () => {
            const order = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
            const attempts = [
                { model: 'gemini-2.5-flash', attempt: 1, success: false },
                { model: 'gemini-2.5-flash', attempt: 2, success: false },
                { model: 'gemini-2.5-flash-lite', attempt: 1, success: true },
            ];

            expect(getPromotedModelOrder(order, attempts)).toEqual(['gemini-2.5-flash-lite', 'gemini-2.5-flash']);
        });

        test('preserves configured model order when no promotion condition is met', () => {
            const order = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
            const attempts = [
                { model: 'gemini-2.5-flash', attempt: 1, success: true },
            ];

            expect(getPromotedModelOrder(order, attempts)).toBe(order);
        });
    });

    describe('offsetAndFilterWords', () => {
        test('keeps only words owned by a half-open chunk range and offsets timestamps', () => {
            const stepMs = 270000;
            const words = [
                { start: '00:00:000', end: '00:00:200', text: 'owned', speaker: 'Speaker 1' },
                { start: '04:29:999', end: '04:30:200', text: 'also-owned', speaker: 'Speaker 1' },
                { start: '04:30:000', end: '04:30:200', text: 'next-chunk', speaker: 'Speaker 1' },
            ];

            expect(offsetAndFilterWords(words, 0, false, stepMs)).toEqual([
                { start: '00:00:000', end: '00:00:200', text: 'owned', speaker: 'Speaker 1' },
                { start: '04:29:999', end: '04:30:200', text: 'also-owned', speaker: 'Speaker 1' },
            ]);
        });

        test('lets the last chunk own everything from its start onward', () => {
            const stepMs = 270000;
            const words = [
                { start: '00:00:000', end: '00:00:200', text: 'first', speaker: 'Speaker 1' },
                { start: '05:10:500', end: '05:11:000', text: 'tail', speaker: 'Speaker 1' },
            ];

            expect(offsetAndFilterWords(words, 2, true, stepMs)).toEqual([
                { start: '09:00:000', end: '09:00:200', text: 'first', speaker: 'Speaker 1' },
                { start: '14:10:500', end: '14:11:000', text: 'tail', speaker: 'Speaker 1' },
            ]);
        });

        test('formats long absolute timestamps with wider minute fields', () => {
            const words = [
                { start: '00:00:000', end: '00:00:500', text: 'long', speaker: 'Speaker 1' },
            ];

            expect(offsetAndFilterWords(words, 26, true, 270000)[0]).toMatchObject({
                start: '117:00:000',
                end: '117:00:500',
            });
        });
    });

    describe('mergeChunkTranscripts', () => {
        const STEP_MS = 270000;
        const OVERLAP_MS = 30000;

        function w(start, end, text, speaker) {
            return speaker !== undefined ? { start, end, text, speaker } : { start, end, text };
        }

        test('rescues boundary word that chunk 1 head misses', () => {
            // chunk 0 has 'foo' at absolute 04:55:000 (within tail overlap window [04:00, 04:30+30s=05:00))
            // chunk 1 head emits nothing resembling 'foo'
            const chunkResults = [
                { words: [w('04:55:000', '04:55:300', 'foo', 'Speaker 1')], model: 'm' },
                { words: [w('00:02:000', '00:02:400', 'bar', 'Speaker 1')], model: 'm' },
            ];
            const { transcript } = mergeChunkTranscripts(chunkResults, {
                stepMs: STEP_MS,
                overlapMs: OVERLAP_MS,
                totalDurationSec: 600,
            });
            expect(transcript.map((t) => t.text)).toContain('foo');
        });

        test('deduplicates word appearing in both tail and head', () => {
            // chunk 0 tail 'hello' at absolute 269900ms; chunk 1 head 'hello' at absolute 270050ms (50ms drift — same word)
            const chunkResults = [
                { words: [w('04:29:900', '04:30:200', 'hello', 'S1')], model: 'm' },
                { words: [w('00:00:050', '00:00:350', 'hello', 'S1'), w('00:01:000', '00:01:300', 'world', 'S1')], model: 'm' },
            ];
            const { transcript, stats } = mergeChunkTranscripts(chunkResults, {
                stepMs: STEP_MS,
                overlapMs: OVERLAP_MS,
                totalDurationSec: 600,
            });
            const helloCount = transcript.filter((t) => t.text === 'hello').length;
            expect(helloCount).toBe(1);
            expect(stats.perChunk[1].droppedDuplicate).toBe(1);
        });

        test('produces monotonically non-decreasing timestamps', () => {
            // chunks with words out of order within each chunk
            const chunkResults = [
                { words: [w('01:00:000', '01:00:200', 'b'), w('00:30:000', '00:30:200', 'a')], model: 'm' },
                { words: [w('01:00:000', '01:00:200', 'c')], model: 'm' },
            ];
            const { transcript } = mergeChunkTranscripts(chunkResults, {
                stepMs: STEP_MS,
                overlapMs: OVERLAP_MS,
                totalDurationSec: 1200,
            });
            for (let i = 1; i < transcript.length; i += 1) {
                const prev = transcript[i - 1].start.split(':').reduce((acc, v, idx) => acc + Number(v) * [60000, 1000, 1][idx], 0);
                const curr = transcript[i].start.split(':').reduce((acc, v, idx) => acc + Number(v) * [60000, 1000, 1][idx], 0);
                expect(curr).toBeGreaterThanOrEqual(prev);
            }
        });

        test('logs and reports a gap above the threshold', () => {
            const warnCalls = [];
            const logger = { info() {}, warn(msg, meta) { warnCalls.push({ msg, meta }); } };
            // 5s gap between last word of chunk 0 and first of chunk 1
            const chunkResults = [
                { words: [w('00:00:000', '00:00:200', 'start')], model: 'm' },
                { words: [w('00:05:200', '00:05:500', 'after')], model: 'm' },
            ];
            const { stats } = mergeChunkTranscripts(chunkResults, {
                stepMs: STEP_MS,
                overlapMs: OVERLAP_MS,
                totalDurationSec: 600,
                gapWarnSec: 3,
                logger,
            });
            expect(stats.gaps.length).toBe(1);
            expect(stats.gaps[0].gapSec).toBeGreaterThanOrEqual(5);
            expect(warnCalls.some((c) => c.msg === 'Transcript gap detected')).toBe(true);
        });

        test('logs malformed timestamps and excludes word from output', () => {
            const warnCalls = [];
            const logger = { info() {}, warn(msg, meta) { warnCalls.push({ msg, meta }); } };
            const chunkResults = [
                { words: [{ start: 'bad', end: '00:01:000', text: 'broken' }, w('00:00:100', '00:00:300', 'good')], model: 'm' },
            ];
            const { transcript, stats } = mergeChunkTranscripts(chunkResults, {
                stepMs: STEP_MS,
                overlapMs: OVERLAP_MS,
                totalDurationSec: 600,
                logger,
            });
            expect(transcript.map((t) => t.text)).not.toContain('broken');
            expect(transcript.map((t) => t.text)).toContain('good');
            expect(stats.perChunk[0].droppedMalformed).toBe(1);
            expect(warnCalls.some((c) => c.msg === 'Dropping word with malformed timestamp')).toBe(true);
        });

        test('accepts words without speaker field', () => {
            const chunkResults = [
                { words: [w('00:00:000', '00:00:200', 'a'), w('00:00:500', '00:00:700', 'b')], model: 'm' },
            ];
            const { transcript } = mergeChunkTranscripts(chunkResults, {
                stepMs: STEP_MS,
                overlapMs: OVERLAP_MS,
                totalDurationSec: 600,
            });
            expect(transcript).toHaveLength(2);
            expect(transcript[0].speaker).toBeUndefined();
        });

        test('drops and logs word with end before start', () => {
            const warnCalls = [];
            const logger = { info() {}, warn(msg, meta) { warnCalls.push({ msg, meta }); } };
            const chunkResults = [
                { words: [{ start: '00:01:000', end: '00:00:500', text: 'inverted' }], model: 'm' },
            ];
            const { transcript } = mergeChunkTranscripts(chunkResults, {
                stepMs: STEP_MS,
                overlapMs: OVERLAP_MS,
                totalDurationSec: 600,
                logger,
            });
            expect(transcript.map((t) => t.text)).not.toContain('inverted');
            expect(warnCalls.some((c) => c.msg === 'Dropping word with end before start')).toBe(true);
        });

        test('drops and logs word starting past total duration', () => {
            const warnCalls = [];
            const logger = { info() {}, warn(msg, meta) { warnCalls.push({ msg, meta }); } };
            const chunkResults = [
                { words: [w('10:01:000', '10:01:500', 'beyond')], model: 'm' },
            ];
            const { transcript } = mergeChunkTranscripts(chunkResults, {
                stepMs: STEP_MS,
                overlapMs: OVERLAP_MS,
                totalDurationSec: 600,
                logger,
            });
            expect(transcript.map((t) => t.text)).not.toContain('beyond');
            expect(warnCalls.some((c) => c.msg === 'Dropping word past audio duration')).toBe(true);
        });
    });

    describe('runChunksWithLimit', () => {
        test('preserves result order while limiting concurrent work', async () => {
            let active = 0;
            let maxActive = 0;

            const results = await runChunksWithLimit([3, 1, 2], 2, async (value) => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await new Promise((resolve) => setTimeout(resolve, value));
                active -= 1;
                return value * 10;
            });

            expect(results).toEqual([30, 10, 20]);
            expect(maxActive).toBeLessThanOrEqual(2);
        });
    });
});
