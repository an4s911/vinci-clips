const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_MODEL_CANDIDATES = [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite'
];

const getModelCandidates = () => {
    const configured = [
        process.env.LLM_MODEL,
        ...(process.env.LLM_FALLBACK_MODELS || '').split(',').map((value) => value.trim())
    ].filter(Boolean);

    return [...new Set([...configured, ...DEFAULT_MODEL_CANDIDATES])];
};

const shouldRetryModel = (error) => [429, 500, 503].includes(error?.status);
const shouldTryNextModel = (error) => [400, 404, 429, 500, 503].includes(error?.status);
const isParseFailure = (error) => error?.code === 'TRANSCRIPTION_PARSE_FAILED';

function buildJsonParseError(rawText, reason) {
    const error = new Error(reason);
    error.code = 'TRANSCRIPTION_PARSE_FAILED';
    error.rawTextPreview = typeof rawText === 'string' ? rawText.slice(0, 200) : '';
    return error;
}

function parseJsonResponse(rawText) {
    if (typeof rawText !== 'string' || rawText.trim().length === 0) {
        throw buildJsonParseError(rawText, 'Transcription parse failed: Gemini returned an empty response.');
    }

    try {
        return JSON.parse(rawText);
    } catch (error) {
        throw buildJsonParseError(rawText, 'Transcription parse failed: Gemini returned invalid or truncated JSON.');
    }
}

async function generateJsonContent({ genAI, contents, responseSchema, safetySettings, logLabel = 'Gemini request' }) {
    const attemptedModels = [];
    let lastError = null;

    for (const modelName of getModelCandidates()) {
        attemptedModels.push(modelName);

        for (let attempt = 1; attempt <= 2; attempt += 1) {
            try {
                const model = genAI.getGenerativeModel({ model: modelName });
                const result = await model.generateContent({
                    contents,
                    generationConfig: {
                        responseMimeType: 'application/json',
                        responseSchema,
                        maxOutputTokens: 65536,
                    },
                    ...(safetySettings ? { safetySettings } : {})
                });

                const response = await result.response;
                return {
                    data: parseJsonResponse(response.text()),
                    model: modelName,
                };
            } catch (error) {
                lastError = error;
                console.warn(`${logLabel} failed with model ${modelName} on attempt ${attempt}:`, error.message);

                if ((shouldRetryModel(error) || isParseFailure(error)) && attempt < 2) {
                    await sleep(1500 * attempt);
                    continue;
                }

                if (shouldTryNextModel(error) || isParseFailure(error)) {
                    break;
                }

                throw error;
            }
        }
    }

    const error = new Error(`All Gemini models failed: ${attemptedModels.join(', ')}`);
    error.cause = lastError;
    throw error;
}

module.exports = {
    buildJsonParseError,
    generateJsonContent,
    getModelCandidates,
    parseJsonResponse,
};
