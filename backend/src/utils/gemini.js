const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function throwIfAborted(signal) {
    if (signal?.aborted) {
        const error = new Error('Gemini request cancelled.');
        error.code = 'JOB_CANCELLED';
        throw error;
    }
}

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
const shortErrorMessage = (error) => String(error?.message || 'Unknown Gemini error.').slice(0, 300);

function buildAttemptFailure(modelName, attempt, error) {
    return {
        event: 'attempt_failed',
        model: modelName,
        attempt,
        success: false,
        status: error?.status,
        code: error?.code,
        retryable: shouldRetryModel(error) || isParseFailure(error),
        message: shortErrorMessage(error),
    };
}

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

async function generateJsonContent({
    genAI,
    contents,
    responseSchema,
    safetySettings,
    logLabel = 'Gemini request',
    modelCandidates,
    onAttemptEvent,
    retryDelayMs = 1500,
    signal,
}) {
    const providedCandidates = Array.isArray(modelCandidates)
        ? [...new Set(modelCandidates.filter(Boolean))]
        : [];
    const candidates = providedCandidates.length > 0 ? providedCandidates : getModelCandidates();
    const attemptedModels = [];
    const attempts = [];
    let lastError = null;

    for (const modelName of candidates) {
        attemptedModels.push(modelName);

        for (let attempt = 1; attempt <= 2; attempt += 1) {
            throwIfAborted(signal);
            onAttemptEvent?.({
                event: 'attempt_started',
                model: modelName,
                attempt,
            });

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

                throwIfAborted(signal);
                const response = await result.response;
                throwIfAborted(signal);
                const data = parseJsonResponse(response.text());
                const success = {
                    event: 'attempt_succeeded',
                    model: modelName,
                    attempt,
                    success: true,
                };
                attempts.push(success);
                onAttemptEvent?.(success);
                return {
                    data,
                    model: modelName,
                    attempts,
                };
            } catch (error) {
                lastError = error;
                const failure = buildAttemptFailure(modelName, attempt, error);
                attempts.push(failure);
                onAttemptEvent?.(failure);
                console.warn(`${logLabel} failed with model ${modelName} on attempt ${attempt}:`, error.message);

                if ((shouldRetryModel(error) || isParseFailure(error)) && attempt < 2) {
                    const delayMs = retryDelayMs * attempt;
                    onAttemptEvent?.({
                        event: 'retry_sleep',
                        model: modelName,
                        attempt,
                        delayMs,
                    });
                    await sleep(delayMs);
                    throwIfAborted(signal);
                    continue;
                }

                if (shouldTryNextModel(error) || isParseFailure(error)) {
                    const nextModel = candidates[candidates.indexOf(modelName) + 1];
                    if (nextModel) {
                        onAttemptEvent?.({
                            event: 'model_switch',
                            exhaustedModel: modelName,
                            nextModel,
                        });
                    }
                    break;
                }

                error.attempts = attempts;
                throw error;
            }
        }
    }

    const error = new Error(`All Gemini models failed: ${attemptedModels.join(', ')}`);
    error.cause = lastError;
    error.attempts = attempts;
    throw error;
}

module.exports = {
    buildJsonParseError,
    generateJsonContent,
    getModelCandidates,
    parseJsonResponse,
};
