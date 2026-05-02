const express = require('express');
const {
    cleanupLocalMedia,
    getStorageUsage,
} = require('../utils/mediaStorage');

const router = express.Router();

function requireAdmin(req, res, next) {
    const expectedToken = process.env.MEDIA_ADMIN_TOKEN;
    if (!expectedToken) return next();

    const authHeader = req.get('authorization') || '';
    const bearerToken = authHeader.replace(/^Bearer\s+/i, '');
    const headerToken = req.get('x-admin-token');
    if (bearerToken === expectedToken || headerToken === expectedToken) {
        return next();
    }

    return res.status(401).json({ error: 'Admin token is required.' });
}

router.use(requireAdmin);

router.get('/usage', async (req, res) => {
    try {
        res.json(await getStorageUsage());
    } catch (error) {
        res.status(500).json({
            error: 'Failed to read storage usage.',
            details: error.message,
        });
    }
});

router.post('/cleanup', async (req, res) => {
    try {
        const dryRun = String(req.query.dryRun || '').toLowerCase() === 'true';
        res.json(await cleanupLocalMedia({ dryRun }));
    } catch (error) {
        res.status(500).json({
            error: 'Failed to cleanup local storage.',
            details: error.message,
        });
    }
});

module.exports = router;
