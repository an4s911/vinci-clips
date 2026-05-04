const { generateJsonContent } = require('../gemini');

function responseWithText(text) {
    return {
        response: Promise.resolve({
            text: () => text,
        }),
    };
}

function geminiError(message, status) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function createGenAI(handlers) {
    const calls = [];

    return {
        calls,
        getGenerativeModel: jest.fn(({ model }) => ({
            generateContent: jest.fn(async (request) => {
                calls.push({ model, request });
                const handler = handlers[model];
                if (!handler || handler.length === 0) {
                    throw geminiError(`No mock response for ${model}`, 404);
                }

                const next = handler.shift();
                if (next instanceof Error) {
                    throw next;
                }
                return responseWithText(next);
            }),
        })),
    };
}

describe('generateJsonContent', () => {
    let warnSpy;

    beforeEach(() => {
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    test('honors caller-provided modelCandidates', async () => {
        const genAI = createGenAI({
            custom_model: ['[]'],
        });

        const result = await generateJsonContent({
            genAI,
            contents: [],
            responseSchema: {},
            modelCandidates: ['custom_model'],
        });

        expect(result.model).toBe('custom_model');
        expect(genAI.calls.map((call) => call.model)).toEqual(['custom_model']);
    });

    test('returns attempt metadata', async () => {
        const genAI = createGenAI({
            first_model: [geminiError('busy', 503), '[]'],
        });

        const result = await generateJsonContent({
            genAI,
            contents: [],
            responseSchema: {},
            modelCandidates: ['first_model'],
            retryDelayMs: 0,
        });

        expect(result.attempts).toEqual([
            expect.objectContaining({
                event: 'attempt_failed',
                model: 'first_model',
                attempt: 1,
                success: false,
                status: 503,
                retryable: true,
                message: 'busy',
            }),
            expect.objectContaining({
                event: 'attempt_succeeded',
                model: 'first_model',
                attempt: 2,
                success: true,
            }),
        ]);
    });

    test('emits logging callback events for attempt start, retry, switch, success and failure', async () => {
        const genAI = createGenAI({
            first_model: [geminiError('rate limited', 429), geminiError('still limited', 429)],
            fallback_model: ['[]'],
        });
        const events = [];

        const result = await generateJsonContent({
            genAI,
            contents: [],
            responseSchema: {},
            modelCandidates: ['first_model', 'fallback_model'],
            onAttemptEvent: (event) => events.push(event),
            retryDelayMs: 0,
        });

        expect(result.model).toBe('fallback_model');
        expect(events).toEqual([
            expect.objectContaining({ event: 'attempt_started', model: 'first_model', attempt: 1 }),
            expect.objectContaining({ event: 'attempt_failed', model: 'first_model', attempt: 1, status: 429, retryable: true }),
            expect.objectContaining({ event: 'retry_sleep', model: 'first_model', attempt: 1, delayMs: 0 }),
            expect.objectContaining({ event: 'attempt_started', model: 'first_model', attempt: 2 }),
            expect.objectContaining({ event: 'attempt_failed', model: 'first_model', attempt: 2, status: 429, retryable: true }),
            expect.objectContaining({ event: 'model_switch', exhaustedModel: 'first_model', nextModel: 'fallback_model' }),
            expect.objectContaining({ event: 'attempt_started', model: 'fallback_model', attempt: 1 }),
            expect.objectContaining({ event: 'attempt_succeeded', model: 'fallback_model', attempt: 1, success: true }),
        ]);
    });
});
