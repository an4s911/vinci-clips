const prisma = require('../db/prisma');
const { verifyApiKey, resolveAdminUser } = require('../utils/apiKeySettings');

// Attach req.user from session on every request. Does not block unauthenticated requests.
async function loadUser(req, res, next) {
    if (!req.session?.userId) {
        return next();
    }
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.session.userId },
            select: { id: true, email: true, role: true, isActive: true },
        });
        if (user?.isActive) {
            req.user = user;
        } else {
            req.session.destroy(() => {});
        }
        next();
    } catch (err) {
        next(err);
    }
}

// Block unauthenticated requests with 401.
function requireAuth(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'Authentication required.' });
    }
    next();
}

async function requireApiKey(req, res, next) {
    const authHeader = req.get('authorization') || '';
    const bearer = authHeader.replace(/^Bearer\s+/i, '');
    const presented = req.get('x-api-key') || bearer || '';
    const valid = await verifyApiKey(presented);
    if (!valid) {
        return res.status(401).json({ error: 'Invalid API key.' });
    }
    const admin = await resolveAdminUser();
    if (!admin) {
        return res.status(503).json({ error: 'No active admin user found.' });
    }
    req.user = admin;
    next();
}

module.exports = { loadUser, requireAuth, requireApiKey };
