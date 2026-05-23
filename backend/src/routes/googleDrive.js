const crypto = require('crypto');
const express = require('express');
const prisma = require('../db/prisma');
const {
    isConfigured,
    isConnected,
    getAuthUrl,
    exchangeCode,
    searchFolders,
    getFolder,
} = require('../utils/googleDrive');
const {
    getAuth,
    setAuth,
    clearAuth,
    getFolders,
    addFolder,
    removeFolder,
} = require('../utils/googleDriveSettings');
const { createExport, resolveClipFilePath } = require('../utils/driveExports');
const { enqueueDriveExportItem } = require('../queue/driveExportJobs');
const logger = require('../utils/logger');

const router = express.Router();

function requireAdmin(req, res, next) {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.' });
    }
    next();
}

// Where to send the browser back to after the OAuth dance. Prefer an explicit
// env; otherwise derive the frontend origin from CORS_ORIGIN (first entry).
function successRedirectBase() {
    if (process.env.GOOGLE_OAUTH_SUCCESS_REDIRECT) return process.env.GOOGLE_OAUTH_SUCCESS_REDIRECT;
    const corsFirst = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean)[0];
    return (corsFirst || '') + '/clips/settings/google-drive';
}

router.use(requireAdmin);

// ─── Auth ───────────────────────────────────────────────────────────────────

router.get('/auth/status', async (req, res) => {
    try {
        const configured = isConfigured();
        const auth = configured ? await getAuth() : null;
        res.json({ configured, connected: Boolean(auth), email: auth?.email || null });
    } catch (error) {
        res.status(500).json({ error: 'Failed to read Drive auth status.', details: error.message });
    }
});

router.get('/auth/url', async (req, res) => {
    try {
        if (!isConfigured()) {
            return res.status(400).json({ error: 'Google Drive OAuth is not configured on the server.' });
        }
        const state = crypto.randomBytes(16).toString('hex');
        req.session.driveOauthState = state;
        res.json({ url: getAuthUrl(state) });
    } catch (error) {
        res.status(500).json({ error: 'Failed to build Drive auth URL.', details: error.message });
    }
});

router.get('/auth/callback', async (req, res) => {
    const base = successRedirectBase();
    try {
        const { code, state } = req.query;
        if (!code || !state || state !== req.session.driveOauthState) {
            return res.redirect(`${base}?drive_error=${encodeURIComponent('Invalid OAuth state.')}`);
        }
        delete req.session.driveOauthState;

        const { refreshToken, email } = await exchangeCode(code);
        await setAuth({ refreshToken, email });
        res.redirect(`${base}?connected=1`);
    } catch (error) {
        logger.error('Drive OAuth callback failed', { error: error.message });
        res.redirect(`${base}?drive_error=${encodeURIComponent(error.message)}`);
    }
});

router.post('/auth/disconnect', async (req, res) => {
    try {
        await clearAuth();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to disconnect Drive.', details: error.message });
    }
});

// ─── Folders ──────────────────────────────────────────────────────────────────

router.get('/folders/search', async (req, res) => {
    try {
        if (!(await isConnected())) {
            return res.status(409).json({ error: 'Google Drive is not connected.' });
        }
        const folders = await searchFolders(req.query.q || '');
        res.json({ folders });
    } catch (error) {
        res.status(500).json({ error: 'Drive folder search failed.', details: error.message });
    }
});

router.get('/folders', async (req, res) => {
    try {
        res.json({ folders: await getFolders() });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load saved folders.', details: error.message });
    }
});

router.post('/folders', async (req, res) => {
    try {
        const driveFolderId = String(req.body.driveFolderId || '').trim();
        if (!driveFolderId) {
            return res.status(400).json({ error: 'driveFolderId is required.' });
        }
        if (!(await isConnected())) {
            return res.status(409).json({ error: 'Google Drive is not connected.' });
        }
        // Validate the folder exists / is accessible and capture its real name.
        const folder = await getFolder(driveFolderId);
        const name = String(req.body.name || folder.name || '').trim() || folder.name;
        const folders = await addFolder({ driveFolderId, name });
        res.status(201).json({ folders });
    } catch (error) {
        res.status(400).json({ error: 'Failed to add folder.', details: error.message });
    }
});

router.delete('/folders/:id', async (req, res) => {
    try {
        const folders = await removeFolder(req.params.id);
        res.json({ folders });
    } catch (error) {
        res.status(500).json({ error: 'Failed to remove folder.', details: error.message });
    }
});

// ─── Export ─────────────────────────────────────────────────────────────────

router.post('/export', async (req, res) => {
    try {
        if (!(await isConnected())) {
            return res.status(409).json({ error: 'Google Drive is not connected.' });
        }

        const { folderId, clips } = req.body;
        if (!folderId || !Array.isArray(clips) || clips.length === 0) {
            return res.status(400).json({ error: 'folderId and a non-empty clips array are required.' });
        }

        // Validate the target folder and resolve its display name.
        const saved = (await getFolders()).find(f => f.driveFolderId === folderId);
        const folderName = saved?.name || (await getFolder(folderId)).name;

        // Validate every clip up front (existence + file on disk) so a bad payload
        // fails fast rather than partway through the queue.
        const normalized = [];
        for (const c of clips) {
            const clipIndex = Number.parseInt(c.clipIndex, 10);
            if (!c.transcriptId || !c.videoId || !Number.isInteger(clipIndex)) {
                return res.status(400).json({ error: 'Invalid clip in payload.' });
            }
            await resolveClipFilePath({ transcriptId: c.transcriptId, clipIndex, videoId: c.videoId });
            normalized.push({ transcriptId: c.transcriptId, clipIndex, videoId: c.videoId });
        }

        const exp = await createExport({ userId: req.user.id, folderId, folderName, clips: normalized });

        for (let i = 0; i < normalized.length; i++) {
            const item = normalized[i];
            await enqueueDriveExportItem({
                exportId: exp.id,
                itemIndex: i,
                transcriptId: item.transcriptId,
                clipIndex: item.clipIndex,
                videoId: item.videoId,
                folderId,
                name: `${item.videoId}.mp4`,
            });
        }

        res.status(202).json({ exportId: exp.id });
    } catch (error) {
        res.status(400).json({ error: 'Failed to start Drive export.', details: error.message });
    }
});

router.get('/exports', async (req, res) => {
    try {
        const where = req.query.status === 'active' ? { status: 'running' } : {};
        const exports = await prisma.driveExport.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: 50,
        });
        res.json({ exports });
    } catch (error) {
        res.status(500).json({ error: 'Failed to list exports.', details: error.message });
    }
});

router.get('/exports/:id', async (req, res) => {
    try {
        const exp = await prisma.driveExport.findUnique({ where: { id: req.params.id } });
        if (!exp) return res.status(404).json({ error: 'Export not found.' });
        res.json({ export: exp });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load export.', details: error.message });
    }
});

module.exports = router;
