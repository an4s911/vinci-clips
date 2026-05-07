const {
    buildWordsForClip,
    clipWordToSegment,
    convertToSRTTime,
    filterWordsByRange,
    timeToSeconds,
} = require('../captioning');

describe('captioning timing helpers', () => {
    test('converts long minute timestamps into valid SRT hour timestamps', () => {
        expect(convertToSRTTime('75:12:345')).toBe('01:15:12,345');
    });

    test('maps source transcript words onto generated clip media timeline', () => {
        const words = [
            { start: '00:10:000', end: '00:11:000', text: 'first' },
            { start: '01:40:000', end: '01:41:000', text: 'second' },
            { start: '02:00:000', end: '02:01:000', text: 'outside' },
        ];
        const clipDefinition = {
            segments: [
                { start: 10, end: 20 },
                { start: 100, end: 110 },
            ],
        };
        const clipTimeline = [
            { sourceStart: 10, sourceEnd: 20, outputStart: 0, outputEnd: 10 },
            { sourceStart: 100, sourceEnd: 110, outputStart: 10, outputEnd: 20 },
        ];

        expect(buildWordsForClip(words, clipDefinition, clipTimeline)).toEqual([
            { start: '00:00:000', end: '00:01:000', text: 'first' },
            { start: '00:10:000', end: '00:11:000', text: 'second' },
        ]);
    });

    test('preserves and clips a word that straddles the segment boundary', () => {
        const words = [{ start: '00:09:500', end: '00:10:500', text: 'mid' }];
        const clipTimeline = [{ sourceStart: 10, sourceEnd: 20, outputStart: 0, outputEnd: 10 }];
        const result = buildWordsForClip(words, {}, clipTimeline);
        expect(result).toEqual([{ start: '00:00:000', end: '00:00:500', text: 'mid' }]);
    });

    test('maps source word by offset only — no scaling even when outputDuration != sourceDuration', () => {
        // source duration 10s, output duration 12s — old code would scale by 1.2x
        const words = [{ start: '00:15:000', end: '00:15:500', text: 'word' }];
        const clipTimeline = [{ sourceStart: 10, sourceEnd: 20, outputStart: 0, outputEnd: 12 }];
        const result = buildWordsForClip(words, {}, clipTimeline);
        // expected: offset-only => (15 - 10) + 0 = 5s
        expect(result).toEqual([{ start: '00:05:000', end: '00:05:500', text: 'word' }]);
    });

    test('returns input words unchanged when clipDefinition is undefined', () => {
        const words = [{ start: '00:00:000', end: '00:01:000', text: 'a' }];
        expect(buildWordsForClip(words, undefined, undefined)).toBe(words);
    });

    test('convertToSRTTime handles 4-component hour-prefixed string', () => {
        expect(convertToSRTTime('01:15:12:345')).toBe('01:15:12,345');
    });

    test('filterWordsByRange keeps a word that overlaps the range boundary', () => {
        const words = [{ start: '00:09:500', end: '00:10:500', text: 'straddle' }];
        // range [10, 20] — word end > 10 && word start < 20 => should be kept
        const result = filterWordsByRange(words, 10, 20);
        expect(result).toHaveLength(1);
        expect(result[0].text).toBe('straddle');
    });

    test('filterWordsByRange drops a word fully outside the range', () => {
        const words = [{ start: '00:05:000', end: '00:09:500', text: 'before' }];
        const result = filterWordsByRange(words, 10, 20);
        expect(result).toHaveLength(0);
    });
});
