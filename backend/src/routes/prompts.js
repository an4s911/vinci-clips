const express = require('express');
const prisma = require('../db/prisma');
const { VALID_KINDS, PROMPT_KINDS, DEFAULT_PROMPTS, invalidateCache } = require('../utils/promptStore');

const router = express.Router();

router.get('/meta', (req, res) => {
    res.json({ success: true, kinds: PROMPT_KINDS });
});

router.get('/', async (req, res) => {
    try {
        const { kind } = req.query;
        const where = kind ? { kind } : {};
        const prompts = await prisma.promptTemplate.findMany({
            where,
            orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
        });
        res.json({ success: true, prompts });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const prompt = await prisma.promptTemplate.findUnique({ where: { id: req.params.id } });
        if (!prompt) return res.status(404).json({ success: false, error: 'Prompt not found' });
        res.json({ success: true, prompt });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/', async (req, res) => {
    try {
        const { kind, name, body } = req.body;
        if (!VALID_KINDS.includes(kind)) {
            return res.status(400).json({ success: false, error: `kind must be one of: ${VALID_KINDS.join(', ')}` });
        }
        if (!name || typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ success: false, error: 'name is required' });
        }
        if (!body || typeof body !== 'string' || !body.trim()) {
            return res.status(400).json({ success: false, error: 'body is required' });
        }
        const prompt = await prisma.promptTemplate.create({
            data: { kind, name: name.trim(), body: body.trim(), isActive: false },
        });
        res.json({ success: true, prompt });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.put('/:id', async (req, res) => {
    try {
        const existing = await prisma.promptTemplate.findUnique({ where: { id: req.params.id } });
        if (!existing) return res.status(404).json({ success: false, error: 'Prompt not found' });

        const { name, body } = req.body;
        const data = {};
        if (name !== undefined) {
            if (!name.trim()) return res.status(400).json({ success: false, error: 'name cannot be empty' });
            data.name = name.trim();
        }
        if (body !== undefined) {
            if (!body.trim()) return res.status(400).json({ success: false, error: 'body cannot be empty' });
            data.body = body.trim();
        }
        const prompt = await prisma.promptTemplate.update({ where: { id: req.params.id }, data });
        if (existing.isActive) invalidateCache(existing.kind);
        res.json({ success: true, prompt });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const existing = await prisma.promptTemplate.findUnique({ where: { id: req.params.id } });
        if (!existing) return res.status(404).json({ success: false, error: 'Prompt not found' });
        await prisma.promptTemplate.delete({ where: { id: req.params.id } });
        if (existing.isActive) invalidateCache(existing.kind);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/:id/activate', async (req, res) => {
    try {
        const existing = await prisma.promptTemplate.findUnique({ where: { id: req.params.id } });
        if (!existing) return res.status(404).json({ success: false, error: 'Prompt not found' });

        await prisma.$transaction([
            prisma.promptTemplate.updateMany({ where: { kind: existing.kind }, data: { isActive: false } }),
            prisma.promptTemplate.update({ where: { id: req.params.id }, data: { isActive: true } }),
        ]);
        invalidateCache(existing.kind);
        const prompt = await prisma.promptTemplate.findUnique({ where: { id: req.params.id } });
        res.json({ success: true, prompt });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
