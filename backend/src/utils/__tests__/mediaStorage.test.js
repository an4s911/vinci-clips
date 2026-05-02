jest.mock('../../models/Transcript', () => ({
    find: jest.fn(async () => []),
}));
jest.mock('../logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    logError: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const {
    BACKEND_ROOT,
    cleanupLocalMedia,
    collectTranscriptMediaReferences,
    resolveLocalMediaPath,
} = require('../mediaStorage');

const testRoot = path.join('/tmp', 'vinci-clips-media-storage-tests');

async function writeOldFile(relativePath, contents = 'test') {
    const filePath = path.join(testRoot, relativePath);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, contents);
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.promises.utimes(filePath, oldTime, oldTime);
    return filePath;
}

describe('mediaStorage', () => {
    beforeEach(async () => {
        await fs.promises.rm(testRoot, { recursive: true, force: true });
        await fs.promises.mkdir(testRoot, { recursive: true });
    });

    afterEach(async () => {
        await fs.promises.rm(testRoot, { recursive: true, force: true });
    });

    test('safe path resolution accepts local media paths and blocks traversal or external paths', () => {
        expect(resolveLocalMediaPath('/uploads/temp/example.mp4')).toBe(path.join(BACKEND_ROOT, 'uploads', 'temp', 'example.mp4'));
        expect(resolveLocalMediaPath('uploads/clips/example.mp4')).toBe(path.join(BACKEND_ROOT, 'uploads', 'clips', 'example.mp4'));
        expect(resolveLocalMediaPath('https://example.com/video.mp4')).toBeNull();
        expect(() => resolveLocalMediaPath('/uploads/../../package.json')).toThrow(/outside allowed roots/);
        expect(() => resolveLocalMediaPath('/etc/passwd')).toThrow(/outside allowed roots/);
    });

    test('collects transcript media references from originals, clips, captions, reframes, and previews', () => {
        const references = collectTranscriptMediaReferences([{
            _id: 'transcript-1',
            videoUrl: '/uploads/source.mp4',
            mp3Url: '/uploads/source.mp3',
            thumbnailUrl: '/uploads/source.jpg',
            captionedVideoUrl: '/uploads/captioned/source_captioned.mp4',
            clips: [{
                videos: [
                    { url: '/uploads/clips/generated.mp4' },
                    { url: '/uploads/clips/reframed/reframed.mp4' },
                ],
                generation: { activeOutputUrl: '/uploads/clips/active.mp4' },
            }],
            reframeAssets: {
                '/uploads/source.mp4': {
                    analyses: {
                        tiktok: { previewUrl: '/uploads/previews/preview.jpg' },
                    },
                },
            },
        }]);

        const expected = [
            'uploads/source.mp4',
            'uploads/source.mp3',
            'uploads/source.jpg',
            'uploads/captioned/source_captioned.mp4',
            'uploads/clips/generated.mp4',
            'uploads/clips/reframed/reframed.mp4',
            'uploads/clips/active.mp4',
            'uploads/previews/preview.jpg',
            'uploads/clips/transcript-1_clip_0.mp4',
        ].map((item) => path.join(BACKEND_ROOT, item));

        expected.forEach((item) => expect(references.has(item)).toBe(true));
    });

    test('dry-run cleanup reports stale files without deleting them', async () => {
        const staleFile = await writeOldFile('dry-run.mp4');

        const result = await cleanupLocalMedia({
            dryRun: true,
            scanRoots: [testRoot],
            references: new Set(),
            tempRetentionHours: 24,
            unreferencedRetentionHours: 1,
        });

        expect(result.summary.staleFiles).toBe(1);
        expect(result.summary.deletedFiles).toBe(0);
        expect(result.stale[0].path).toBe(staleFile);
        await expect(fs.promises.access(staleFile)).resolves.toBeUndefined();
    });

    test('cleanup preserves referenced files and deletes expired unreferenced files', async () => {
        const referencedFile = await writeOldFile('referenced.mp4');
        const staleFile = await writeOldFile('stale.mp4');

        const result = await cleanupLocalMedia({
            dryRun: false,
            scanRoots: [testRoot],
            references: new Set([referencedFile]),
            tempRetentionHours: 24,
            unreferencedRetentionHours: 1,
        });

        expect(result.summary.deletedFiles).toBe(1);
        expect(result.deleted[0].path).toBe(staleFile);
        await expect(fs.promises.access(referencedFile)).resolves.toBeUndefined();
        await expect(fs.promises.access(staleFile)).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
