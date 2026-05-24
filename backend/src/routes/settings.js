const express = require('express');
const prisma = require('../db/prisma');
const { getAutoBulkEditConfig, setAutoBulkEditConfig } = require('../utils/appSettings');
const { getCaptionStylesForClient, templateAllowsCaptions, templateAllowsHooks } = require('../utils/captioning');
const { generateApiKey, getApiKeyMeta, revokeApiKey } = require('../utils/apiKeySettings');

const router = express.Router();

function requireAdmin(req, res, next) {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.' });
    }
    next();
}

function normalizeTerm(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

router.use(requireAdmin);

router.get('/blocked-words', async (req, res) => {
    try {
        const blockedWords = await prisma.blockedWord.findMany({
            orderBy: { term: 'asc' },
        });
        res.json({ blockedWords });
    } catch (error) {
        res.status(500).json({
            error: 'Failed to load blocked words.',
            details: error.message,
        });
    }
});

router.post('/blocked-words', async (req, res) => {
    try {
        const rawTerms = Array.isArray(req.body.terms) ? req.body.terms : [req.body.term];
        const terms = [...new Set(rawTerms.map(normalizeTerm).filter(Boolean))];
        if (terms.length === 0) {
            return res.status(400).json({ error: 'At least one blocked word is required.' });
        }

        await Promise.all(terms.map(term => prisma.blockedWord.upsert({
            where: { term },
            update: {},
            create: { term },
        })));

        const blockedWords = await prisma.blockedWord.findMany({
            orderBy: { term: 'asc' },
        });
        res.status(201).json({ blockedWords });
    } catch (error) {
        res.status(500).json({
            error: 'Failed to save blocked words.',
            details: error.message,
        });
    }
});

router.delete('/blocked-words/:id', async (req, res) => {
    try {
        await prisma.blockedWord.delete({
            where: { id: req.params.id },
        });
        res.json({ success: true });
    } catch (error) {
        if (error.code === 'P2025') {
            return res.status(404).json({ error: 'Blocked word not found.' });
        }
        res.status(500).json({
            error: 'Failed to delete blocked word.',
            details: error.message,
        });
    }
});

router.get('/auto-bulk-edit', async (req, res) => {
    try {
        const config = await getAutoBulkEditConfig();
        res.json({ config });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load auto bulk-edit config.', details: error.message });
    }
});

router.put('/auto-bulk-edit', async (req, res) => {
    try {
        const { enabled, reframe, captions, hook } = req.body;

        const VALID_PLATFORMS = ['tiktok', 'instagram', 'youtube'];
        const VALID_REFRAME_STYLES = ['fullscreen', 'blurred'];

        if (reframe?.enabled) {
            if (!VALID_PLATFORMS.includes(reframe.platform)) {
                return res.status(400).json({ error: `Invalid platform. Must be one of: ${VALID_PLATFORMS.join(', ')}.` });
            }
            if (!VALID_REFRAME_STYLES.includes(reframe.reframeStyleId)) {
                return res.status(400).json({ error: `Invalid reframe style. Must be one of: ${VALID_REFRAME_STYLES.join(', ')}.` });
            }
            if (reframe.reframeStyleId === 'blurred' && reframe.platform !== 'tiktok') {
                return res.status(400).json({ error: 'Blurred style is only available for TikTok/Shorts (9:16).' });
            }
        }

        if (captions?.enabled && captions.styleId) {
            const styles = await getCaptionStylesForClient();
            const template = styles.find(s => s.id === captions.styleId);
            if (template && !templateAllowsCaptions(template)) {
                return res.status(400).json({ error: `Template "${template.name}" cannot be used for captions.` });
            }
        }

        if (hook?.enabled && hook.styleId) {
            const styles = await getCaptionStylesForClient();
            const template = styles.find(s => s.id === hook.styleId);
            if (template && !templateAllowsHooks(template)) {
                return res.status(400).json({ error: `Template "${template.name}" cannot be used for hooks.` });
            }
        }

        if (hook?.timeoutSeconds !== null && hook?.timeoutSeconds !== undefined) {
            const t = Number(hook.timeoutSeconds);
            if (!Number.isFinite(t) || t <= 0) {
                return res.status(400).json({ error: 'Hook timeout must be a positive number or null.' });
            }
        }

        const config = {
            enabled: Boolean(enabled),
            reframe: {
                enabled: Boolean(reframe?.enabled),
                platform: reframe?.platform || 'tiktok',
                reframeStyleId: reframe?.reframeStyleId || 'fullscreen',
            },
            captions: {
                enabled: Boolean(captions?.enabled),
                styleId: captions?.styleId || null,
            },
            hook: {
                enabled: Boolean(hook?.enabled),
                styleId: hook?.styleId || null,
                timeoutSeconds: hook?.timeoutSeconds ?? null,
            },
        };

        await setAutoBulkEditConfig(config);
        res.json({ config });
    } catch (error) {
        res.status(500).json({ error: 'Failed to save auto bulk-edit config.', details: error.message });
    }
});

router.post('/api-key', async (req, res) => {
    try {
        const result = await generateApiKey();
        res.status(201).json(result);
    } catch (error) {
        res.status(500).json({ error: 'Failed to generate API key.', details: error.message });
    }
});

router.get('/api-key', async (req, res) => {
    try {
        const meta = await getApiKeyMeta();
        res.json(meta ? meta : { configured: false });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load API key status.', details: error.message });
    }
});

router.delete('/api-key', async (req, res) => {
    try {
        await revokeApiKey();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to revoke API key.', details: error.message });
    }
});

module.exports = router;
