jest.mock('../backgroundJobs', () => ({
    TRANSCRIPTION_PROMPT: 'prompt',
    TRANSCRIPTION_SCHEMA: {},
    assertTranscriptNotCancelled: jest.fn(),
    logVideoProcessing: jest.fn(),
    runTrackedCommand: jest.fn(),
}));

const {
    offsetAndFilterWords,
    runChunksWithLimit,
} = require('../audioTranscription');

describe('audioTranscription', () => {
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
