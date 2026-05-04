const fs = require('fs');
const path = require('path');
const Transcript = require('../models/Transcript');
const logger = require('./logger');

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const MEDIA_ROOTS = {
    uploads: path.join(BACKEND_ROOT, 'uploads'),
    uploadsClips: path.join(BACKEND_ROOT, 'uploads', 'clips'),
    uploadsCaptioned: path.join(BACKEND_ROOT, 'uploads', 'captioned'),
    uploadsPreviews: path.join(BACKEND_ROOT, 'uploads', 'previews'),
    uploadsTemp: path.join(BACKEND_ROOT, 'uploads', 'temp'),
    temp: path.join(BACKEND_ROOT, 'temp'),
    cache: path.join(BACKEND_ROOT, 'cache'),
};

const SCAN_ROOTS = [
    MEDIA_ROOTS.uploads,
    MEDIA_ROOTS.temp,
    MEDIA_ROOTS.cache,
];

const DISPOSABLE_ROOTS = [
    path.join(BACKEND_ROOT, 'uploads', 'temp'),
    path.join(BACKEND_ROOT, 'uploads', 'imports'),
    MEDIA_ROOTS.temp,
    MEDIA_ROOTS.cache,
];

function toHours(value, fallback) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function getCleanupConfig(env = process.env) {
    return {
        enabled: String(env.MEDIA_CLEANUP_ENABLED ?? 'true').toLowerCase() !== 'false',
        intervalHours: toHours(env.MEDIA_CLEANUP_INTERVAL_HOURS, 6),
        tempRetentionHours: toHours(env.MEDIA_TEMP_RETENTION_HOURS, 24),
        unreferencedRetentionHours: toHours(env.MEDIA_UNREFERENCED_RETENTION_HOURS, 1),
    };
}

function isInside(candidate, root) {
    const relative = path.relative(root, candidate);
    return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeMediaInput(input) {
    if (!input || typeof input !== 'string') return null;
    const trimmed = input.trim();
    if (!trimmed) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return null;

    const withoutQuery = trimmed.split(/[?#]/)[0];
    let decoded;
    try {
        decoded = decodeURIComponent(withoutQuery);
    } catch (error) {
        decoded = withoutQuery;
    }

    if (path.isAbsolute(decoded) && !decoded.startsWith('/uploads/')) {
        return decoded;
    }

    return decoded.replace(/^\/+/, '');
}

function resolveLocalMediaPath(input) {
    const normalized = normalizeMediaInput(input);
    if (!normalized) return null;

    const resolved = path.resolve(BACKEND_ROOT, normalized);
    const allowed = Object.values(MEDIA_ROOTS).some((root) => isInside(resolved, root));
    if (!allowed) {
        throw new Error(`Media path resolves outside allowed roots: ${input}`);
    }

    return resolved;
}

function mediaUrlForPath(filePath) {
    const resolved = path.resolve(filePath);
    if (isInside(resolved, MEDIA_ROOTS.uploads)) {
        return `/uploads/${path.relative(MEDIA_ROOTS.uploads, resolved).split(path.sep).join('/')}`;
    }
    if (isInside(resolved, MEDIA_ROOTS.temp)) {
        return `temp/${path.relative(MEDIA_ROOTS.temp, resolved).split(path.sep).join('/')}`;
    }
    if (isInside(resolved, MEDIA_ROOTS.cache)) {
        return `cache/${path.relative(MEDIA_ROOTS.cache, resolved).split(path.sep).join('/')}`;
    }
    return path.relative(BACKEND_ROOT, resolved).split(path.sep).join('/');
}

async function deleteLocalMedia(input, options = {}) {
    const missingOk = options.missingOk !== false;
    const mediaPath = resolveLocalMediaPath(input);
    if (!mediaPath) {
        return { input, path: null, deleted: false, reason: 'not-local-media' };
    }

    try {
        await fs.promises.unlink(mediaPath);
        return { input, path: mediaPath, deleted: true };
    } catch (error) {
        if (missingOk && error.code === 'ENOENT') {
            return { input, path: mediaPath, deleted: false, reason: 'missing' };
        }
        logger.warn(`Failed to delete media file: ${error.message}`, { input, path: mediaPath });
        if (options.throwOnError) throw error;
        return { input, path: mediaPath, deleted: false, reason: error.message };
    }
}

function addReference(referenceSet, value) {
    try {
        const resolved = resolveLocalMediaPath(value);
        if (resolved) referenceSet.add(resolved);
    } catch (error) {
        logger.warn(`Ignoring unsafe media reference: ${error.message}`);
    }
}

function collectStringReferences(value, referenceSet) {
    if (!value) return;
    if (typeof value === 'string') {
        if (/^(\/?uploads\/|\/?temp\/|\/?cache\/)/.test(value.trim())) {
            addReference(referenceSet, value);
        }
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item) => collectStringReferences(item, referenceSet));
        return;
    }
    if (typeof value === 'object') {
        Object.values(value).forEach((item) => collectStringReferences(item, referenceSet));
    }
}

function collectTranscriptMediaReferences(transcripts) {
    const referenceSet = new Set();
    const list = Array.isArray(transcripts) ? transcripts : [transcripts].filter(Boolean);

    for (const transcript of list) {
        collectStringReferences(transcript, referenceSet);

        const clips = Array.isArray(transcript?.clips) ? transcript.clips : [];
        clips.forEach((clip, index) => {
            if (transcript?._id) {
                addReference(referenceSet, `uploads/clips/${transcript._id}_clip_${index}.mp4`);
            }
            collectStringReferences(clip, referenceSet);
        });
    }

    return referenceSet;
}

async function collectAllTranscriptMediaReferences() {
    const transcripts = await Transcript.find({});
    return collectTranscriptMediaReferences(transcripts);
}

async function walkFiles(root) {
    const files = [];
    try {
        const entries = await fs.promises.readdir(root, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = path.join(root, entry.name);
            if (entry.isDirectory()) {
                files.push(...await walkFiles(entryPath));
            } else if (entry.isFile()) {
                files.push(entryPath);
            }
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            logger.warn(`Failed to scan media root ${root}: ${error.message}`);
        }
    }
    return files;
}

function classifyPath(filePath) {
    const resolved = path.resolve(filePath);
    if (isInside(resolved, MEDIA_ROOTS.uploadsTemp)) return 'uploads/temp';
    if (isInside(resolved, path.join(BACKEND_ROOT, 'uploads', 'imports'))) return 'uploads/imports';
    if (isInside(resolved, MEDIA_ROOTS.uploadsClips)) return 'uploads/clips';
    if (isInside(resolved, MEDIA_ROOTS.uploadsCaptioned)) return 'uploads/captioned';
    if (isInside(resolved, MEDIA_ROOTS.uploadsPreviews)) return 'uploads/previews';
    if (isInside(resolved, MEDIA_ROOTS.uploads)) return 'uploads';
    if (isInside(resolved, MEDIA_ROOTS.temp)) return 'temp';
    if (isInside(resolved, MEDIA_ROOTS.cache)) return 'cache';
    return 'unknown';
}

function isDisposablePath(filePath) {
    return DISPOSABLE_ROOTS.some((root) => isInside(path.resolve(filePath), root));
}

async function getStorageUsage() {
    const usage = {};
    const files = [];

    for (const root of SCAN_ROOTS) {
        files.push(...await walkFiles(root));
    }

    for (const filePath of files) {
        const stat = await fs.promises.stat(filePath);
        const type = classifyPath(filePath);
        usage[type] = usage[type] || { files: 0, bytes: 0 };
        usage[type].files += 1;
        usage[type].bytes += stat.size;
    }

    return {
        root: BACKEND_ROOT,
        totals: Object.values(usage).reduce((acc, item) => ({
            files: acc.files + item.files,
            bytes: acc.bytes + item.bytes,
        }), { files: 0, bytes: 0 }),
        byType: usage,
    };
}

async function cleanupLocalMedia(options = {}) {
    const now = options.now || Date.now();
    const dryRun = Boolean(options.dryRun);
    const references = options.references || await collectAllTranscriptMediaReferences();
    const tempRetentionMs = (options.tempRetentionHours ?? getCleanupConfig().tempRetentionHours) * 60 * 60 * 1000;
    const unreferencedRetentionMs = (options.unreferencedRetentionHours ?? getCleanupConfig().unreferencedRetentionHours) * 60 * 60 * 1000;
    const scanned = [];
    const stale = [];
    const deleted = [];
    const errors = [];

    const scanRoots = options.scanRoots || SCAN_ROOTS;

    for (const root of scanRoots) {
        scanned.push(...await walkFiles(root));
    }

    for (const filePath of scanned) {
        const resolved = path.resolve(filePath);
        let stat;
        try {
            stat = await fs.promises.stat(resolved);
        } catch (error) {
            continue;
        }

        const referenced = references.has(resolved);
        if (referenced) continue;

        const disposable = isDisposablePath(resolved);
        const ageMs = now - stat.mtimeMs;
        const retentionMs = disposable ? tempRetentionMs : unreferencedRetentionMs;
        if (ageMs < retentionMs) continue;

        const item = {
            path: resolved,
            url: mediaUrlForPath(resolved),
            type: classifyPath(resolved),
            bytes: stat.size,
            mtime: stat.mtime.toISOString(),
            ageHours: ageMs / (60 * 60 * 1000),
            reason: disposable ? 'expired-disposable' : 'expired-unreferenced',
        };
        stale.push(item);

        if (!dryRun) {
            try {
                await fs.promises.unlink(resolved);
                deleted.push(item);
            } catch (error) {
                errors.push({ ...item, error: error.message });
                logger.warn(`Failed to cleanup stale media ${resolved}: ${error.message}`);
            }
        }
    }

    return {
        dryRun,
        scanned: scanned.length,
        stale,
        deleted,
        errors,
        summary: {
            staleFiles: stale.length,
            deletedFiles: deleted.length,
            staleBytes: stale.reduce((sum, item) => sum + item.bytes, 0),
            deletedBytes: deleted.reduce((sum, item) => sum + item.bytes, 0),
            errors: errors.length,
        },
    };
}

async function deleteTranscriptMedia(transcript) {
    const references = collectTranscriptMediaReferences([transcript]);
    const results = [];

    for (const mediaPath of references) {
        results.push(await deleteLocalMedia(mediaPath, { missingOk: true }));
    }

    return results;
}

async function deleteTranscriptTransientMedia(transcriptId, options = {}) {
    const id = String(transcriptId || '').trim();
    if (!id || id.includes('/') || id.includes('\\')) return [];

    const importsRoot = options.importsRoot || path.join(BACKEND_ROOT, 'uploads', 'imports');
    const prefixes = [`${id}.`, `${id}_`];
    const results = [];

    let entries;
    try {
        entries = await fs.promises.readdir(importsRoot, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return results;
        throw error;
    }

    for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!prefixes.some((prefix) => entry.name.startsWith(prefix))) continue;

        const mediaPath = path.join(importsRoot, entry.name);
        try {
            await fs.promises.unlink(mediaPath);
            results.push({ input: mediaPath, path: mediaPath, deleted: true });
        } catch (error) {
            if (error.code === 'ENOENT') {
                results.push({ input: mediaPath, path: mediaPath, deleted: false, reason: 'missing' });
            } else {
                logger.warn(`Failed to delete transient media file: ${error.message}`, { transcriptId: id, path: mediaPath });
                results.push({ input: mediaPath, path: mediaPath, deleted: false, reason: error.message });
            }
        }
    }

    const deletedCount = results.filter((item) => item.deleted).length;
    if (deletedCount > 0) {
        logger.info('Deleted transient transcript media files.', {
            transcriptId: id,
            deletedCount,
            paths: results.filter((item) => item.deleted).map((item) => item.path),
        });
    }

    return results;
}

module.exports = {
    BACKEND_ROOT,
    MEDIA_ROOTS,
    cleanupLocalMedia,
    collectAllTranscriptMediaReferences,
    collectTranscriptMediaReferences,
    deleteLocalMedia,
    deleteTranscriptMedia,
    deleteTranscriptTransientMedia,
    getCleanupConfig,
    getStorageUsage,
    mediaUrlForPath,
    resolveLocalMediaPath,
};
