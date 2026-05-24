const { v4: uuidv4 } = require('uuid');
const prisma = require('./db/prisma');
const { publicFailureReasonForTranscript, publicProcessingJob } = require('./utils/failureMessages');

// Fields stored as scalar columns in Postgres
const SCALAR_FIELDS = new Set([
    'title', 'originalFilename', 'videoUrl', 'mp3Url', 'thumbnailUrl', 'duration',
    'status', 'failureReason', 'failedStage', 'platform', 'externalVideoId', 'importUrl', 'userId',
]);

// Prisma select for list endpoints — returns all scalar metadata + processingJob,
// but omits the heavy JSONB columns (transcript, clips, analysisMetadata, reframeAssets).
const LIST_SELECT = {
    id: true, createdAt: true, updatedAt: true,
    userId: true, title: true, originalFilename: true, videoUrl: true, mp3Url: true,
    thumbnailUrl: true, duration: true, status: true, failureReason: true,
    failedAt: true, failedStage: true, platform: true, externalVideoId: true,
    importUrl: true, processingJob: true,
};

// Prisma select for /clips/primary — needs clips JSONB but not the transcription text.
const PRIMARY_SELECT = {
    ...LIST_SELECT,
    clips: true,
};

// Fields stored as DateTime columns — convert string → Date for writes
const DATETIME_FIELDS = new Set(['failedAt']);

// Fields stored as JSONB columns
const JSON_FIELDS = new Set([
    'transcript', 'clips', 'processingJob', 'analysisMetadata', 'reframeAssets',
]);

// Fields that must never be written to the DB (metadata, methods, etc.)
const SKIP_FIELDS = new Set(['_id', 'id', 'createdAt', 'updatedAt', 'save', 'user']);

function toUpdateData(data) {
    const result = {};
    for (const [key, value] of Object.entries(data)) {
        if (SKIP_FIELDS.has(key)) continue;
        if (SCALAR_FIELDS.has(key)) {
            result[key] = value;
        } else if (DATETIME_FIELDS.has(key)) {
            result[key] = value ? new Date(value) : null;
        } else if (JSON_FIELDS.has(key)) {
            // Explicitly include undefined as deletion is not intended; null clears the field
            result[key] = value === undefined ? undefined : (value ?? null);
        }
        // Unknown keys are silently ignored
    }
    return result;
}

function toDoc(record) {
    if (!record) return null;
    const doc = {
        _id: record.id,
        createdAt: record.createdAt instanceof Date ? record.createdAt.toISOString() : record.createdAt,
        title: record.title,
        originalFilename: record.originalFilename,
        videoUrl: record.videoUrl,
        mp3Url: record.mp3Url,
        thumbnailUrl: record.thumbnailUrl,
        duration: record.duration,
        status: record.status,
        failureReason: publicFailureReasonForTranscript(record),
        failedStage: record.failedStage,
        failedAt: record.failedAt instanceof Date ? record.failedAt.toISOString() : record.failedAt,
        platform: record.platform,
        externalVideoId: record.externalVideoId,
        importUrl: record.importUrl,
        userId: record.userId,
        transcript: record.transcript,
        clips: record.clips,
        processingJob: publicProcessingJob(record.processingJob),
        analysisMetadata: record.analysisMetadata,
        reframeAssets: record.reframeAssets,
    };
    doc.save = async function () {
        return Transcript.findByIdAndUpdate(this._id, this);
    };
    return doc;
}

const Transcript = {
    find: async (query = {}, opts = {}) => {
        const where = {};
        if (query.userId) where.userId = query.userId;
        const records = await prisma.transcript.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            ...(opts.select ? { select: opts.select } : {}),
        });
        return records.map(toDoc);
    },

    findById: async (id, opts = {}) => {
        const record = await prisma.transcript.findUnique({ where: { id } });
        if (!record) return null;
        if (opts.userId && record.userId !== opts.userId) return null;
        return toDoc(record);
    },

    create: async (data) => {
        const createData = toUpdateData(data);
        if (!createData.userId) {
            throw new Error('userId is required when creating a transcript');
        }
        const record = await prisma.transcript.create({ data: createData });
        return toDoc(record);
    },

    findByIdAndUpdate: async (id, data) => {
        const updateData = toUpdateData(data);
        if (Object.keys(updateData).length === 0) {
            return Transcript.findById(id);
        }
        try {
            const record = await prisma.transcript.update({
                where: { id },
                data: updateData,
            });
            return toDoc(record);
        } catch (err) {
            if (err.code === 'P2025') return null;
            throw err;
        }
    },

    findByIdAndDelete: async (id) => {
        try {
            const record = await prisma.transcript.delete({ where: { id } });
            return toDoc(record);
        } catch (err) {
            if (err.code === 'P2025') return null;
            throw err;
        }
    },
};

// Mongoose-like constructor — creates an in-memory instance with a .save() method.
// Used by code that does `new TranscriptModel(data)` then awaits `.save()`.
const newTranscript = (data) => {
    const instance = {
        ...data,
        _id: uuidv4(),
        createdAt: new Date().toISOString(),
    };
    instance.save = async function () {
        const existing = await Transcript.findById(this._id);
        if (existing) {
            return Transcript.findByIdAndUpdate(this._id, this);
        }
        const createData = toUpdateData(this);
        const record = await prisma.transcript.create({
            data: { ...createData, id: this._id },
        });
        return toDoc(record);
    };
    return instance;
};

module.exports = { Transcript, newTranscript, LIST_SELECT, PRIMARY_SELECT };
