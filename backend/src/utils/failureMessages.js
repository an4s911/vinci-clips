const FAILURE_MESSAGES = {
    YOUTUBE_AUTH_REQUIRED: 'YouTube blocked this import request. Try another video or try again later.',
    IMPORT_SOURCE_UNAVAILABLE: 'Video import failed before transcription could start. The video may be private, unavailable, age-restricted, or blocked by the source site.',
    UPLOAD_PROCESSING_FAILED: 'Video processing failed before transcription could start. Try another video file.',
    TRANSCRIPTION_PARSE_FAILED: 'Video import/download succeeded, but transcription failed while reading the generated transcript. Retry transcription to try again.',
    TRANSCRIPTION_FAILED: 'Video import/download succeeded, but transcription failed. Retry transcription to try again.',
    IMPORT_CANCELLED: 'Import was cancelled.',
    JOB_CANCELLED: 'Processing was cancelled.',
};

function messageForFailureCode(code) {
    return FAILURE_MESSAGES[code] || null;
}

function isYouTubeAuthChallengeText(value) {
    const text = String(value || '').toLowerCase();
    return text.includes('sign in to confirm') || text.includes('not a bot') || text.includes('--cookies');
}

function isRawCommandFailure(value) {
    const text = String(value || '').toLowerCase();
    return text.includes('command failed:') || text.includes('yt-dlp');
}

function mentionsTranscriptionProvider(value) {
    return String(value || '').toLowerCase().includes('gemini');
}

function publicProgressMessage(value) {
    if (!value) return value;
    return String(value)
        .replace(/Uploading audio to Gemini\./gi, 'Uploading audio for transcription.')
        .replace(/Transcribing audio with Gemini\./gi, 'Transcribing audio.')
        .replace(/with Gemini/gi, '')
        .replace(/to Gemini/gi, 'for transcription')
        .replace(/\s+\./g, '.')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function publicProcessingJob(job) {
    if (!job || typeof job !== 'object') return job;
    return {
        ...job,
        progressMessage: publicProgressMessage(job.progressMessage),
        error: messageForFailureCode(job.errorCode) || publicProgressMessage(job.error),
    };
}

function classifyImportFailure(error) {
    if (error?.code === 'JOB_CANCELLED') {
        return {
            code: 'IMPORT_CANCELLED',
            message: FAILURE_MESSAGES.IMPORT_CANCELLED,
        };
    }

    if (isYouTubeAuthChallengeText(`${error?.stderr || ''}\n${error?.message || ''}`)) {
        return {
            code: 'YOUTUBE_AUTH_REQUIRED',
            message: FAILURE_MESSAGES.YOUTUBE_AUTH_REQUIRED,
        };
    }

    return {
        code: 'IMPORT_SOURCE_UNAVAILABLE',
        message: FAILURE_MESSAGES.IMPORT_SOURCE_UNAVAILABLE,
    };
}

function classifyTranscriptionFailure(error) {
    if (error?.code === 'TRANSCRIPTION_PARSE_FAILED') {
        return {
            code: 'TRANSCRIPTION_PARSE_FAILED',
            message: FAILURE_MESSAGES.TRANSCRIPTION_PARSE_FAILED,
        };
    }

    if (error?.code === 'JOB_CANCELLED') {
        return {
            code: 'JOB_CANCELLED',
            message: FAILURE_MESSAGES.JOB_CANCELLED,
        };
    }

    return {
        code: 'TRANSCRIPTION_FAILED',
        message: FAILURE_MESSAGES.TRANSCRIPTION_FAILED,
    };
}

function classifyUploadFailure(error, record = null) {
    if (error?.code === 'JOB_CANCELLED') {
        return {
            code: 'JOB_CANCELLED',
            message: FAILURE_MESSAGES.JOB_CANCELLED,
        };
    }

    if (record?.mp3Url) {
        return classifyTranscriptionFailure(error);
    }

    return {
        code: 'UPLOAD_PROCESSING_FAILED',
        message: FAILURE_MESSAGES.UPLOAD_PROCESSING_FAILED,
    };
}

function publicFailureReasonForTranscript(record) {
    const codeMessage = messageForFailureCode(record?.processingJob?.errorCode);
    if (codeMessage) return codeMessage;

    const reason = record?.failureReason;
    if (!reason) return reason;

    if (isYouTubeAuthChallengeText(reason)) {
        return FAILURE_MESSAGES.YOUTUBE_AUTH_REQUIRED;
    }

    if (isRawCommandFailure(reason) && !record?.mp3Url) {
        return record?.importUrl
            ? FAILURE_MESSAGES.IMPORT_SOURCE_UNAVAILABLE
            : FAILURE_MESSAGES.UPLOAD_PROCESSING_FAILED;
    }

    if (mentionsTranscriptionProvider(reason)) {
        if (record?.mp3Url) return FAILURE_MESSAGES.TRANSCRIPTION_FAILED;
        return record?.importUrl
            ? FAILURE_MESSAGES.IMPORT_SOURCE_UNAVAILABLE
            : FAILURE_MESSAGES.UPLOAD_PROCESSING_FAILED;
    }

    return reason;
}

module.exports = {
    classifyImportFailure,
    classifyUploadFailure,
    classifyTranscriptionFailure,
    messageForFailureCode,
    publicProcessingJob,
    publicFailureReasonForTranscript,
};
