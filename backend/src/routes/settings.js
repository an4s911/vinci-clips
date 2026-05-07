const express = require('express');
const prisma = require('../db/prisma');

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

module.exports = router;
