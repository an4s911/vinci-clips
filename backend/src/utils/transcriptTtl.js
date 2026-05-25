function getTtlMs() {
    return parseInt(process.env.TRANSCRIPT_TTL_HOURS || '24', 10) * 3600_000;
}

function nextExpiry() {
    return new Date(Date.now() + getTtlMs());
}

async function bumpTranscriptExpiry(transcriptId) {
    try {
        // Lazy-require to avoid circular dependency (models → localdb → this)
        const Transcript = require('../models/Transcript');
        await Transcript.findByIdAndUpdate(transcriptId, { expiresAt: nextExpiry() });
    } catch {
        // Non-fatal — never block a job enqueue over a TTL write
    }
}

module.exports = { getTtlMs, nextExpiry, bumpTranscriptExpiry };
