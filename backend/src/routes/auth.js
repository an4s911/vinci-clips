const express = require('express');
const argon2 = require('argon2');
const prisma = require('../db/prisma');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Simple in-process rate limiter using a Map (Redis-backed in prod is fine for now too).
// Tracks failed attempts per IP+email key, resets after 15 minutes.
const loginAttempts = new Map();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

function getRateLimitKey(ip, email) {
    return `${ip}:${String(email).toLowerCase()}`;
}

function checkRateLimit(ip, email) {
    const key = getRateLimitKey(ip, email);
    const entry = loginAttempts.get(key);
    if (!entry) return false;
    if (Date.now() > entry.resetAt) {
        loginAttempts.delete(key);
        return false;
    }
    return entry.count >= MAX_ATTEMPTS;
}

function recordFailedAttempt(ip, email) {
    const key = getRateLimitKey(ip, email);
    const existing = loginAttempts.get(key);
    if (!existing || Date.now() > existing.resetAt) {
        loginAttempts.set(key, { count: 1, resetAt: Date.now() + WINDOW_MS });
    } else {
        existing.count += 1;
    }
}

function clearAttempts(ip, email) {
    loginAttempts.delete(getRateLimitKey(ip, email));
}

// POST /clips/auth/login
router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
    }

    const ip = req.ip || req.connection.remoteAddress || 'unknown';

    if (checkRateLimit(ip, email)) {
        return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
    }

    try {
        const user = await prisma.user.findUnique({
            where: { email: email.toLowerCase().trim() },
        });

        if (!user || !user.isActive) {
            recordFailedAttempt(ip, email);
            return res.status(401).json({ error: 'Invalid credentials.' });
        }

        const valid = await argon2.verify(user.passwordHash, password);
        if (!valid) {
            recordFailedAttempt(ip, email);
            return res.status(401).json({ error: 'Invalid credentials.' });
        }

        clearAttempts(ip, email);

        req.session.userId = user.id;
        await new Promise((resolve, reject) => {
            req.session.save((err) => (err ? reject(err) : resolve()));
        });

        res.json({ user: { id: user.id, email: user.email, role: user.role } });
    } catch (err) {
        res.status(500).json({ error: 'Login failed.' });
    }
});

// POST /clips/auth/logout
router.post('/logout', requireAuth, (req, res) => {
    req.session.destroy((err) => {
        if (err) return res.status(500).json({ error: 'Logout failed.' });
        res.clearCookie('vc.sid');
        res.json({ message: 'Logged out.' });
    });
});

// GET /clips/auth/me
router.get('/me', requireAuth, (req, res) => {
    res.json({ user: { id: req.user.id, email: req.user.email, role: req.user.role } });
});

// POST /clips/auth/change-password
router.post('/change-password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'currentPassword and newPassword are required.' });
    }

    if (newPassword.length < 8) {
        return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }

    try {
        const user = await prisma.user.findUnique({ where: { id: req.user.id } });
        const valid = await argon2.verify(user.passwordHash, currentPassword);
        if (!valid) {
            return res.status(401).json({ error: 'Current password is incorrect.' });
        }

        const passwordHash = await argon2.hash(newPassword);
        await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash } });

        res.json({ message: 'Password changed.' });
    } catch (err) {
        res.status(500).json({ error: 'Password change failed.' });
    }
});

module.exports = router;
