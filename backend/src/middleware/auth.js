const prisma = require('../db/prisma');

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

module.exports = { loadUser, requireAuth };
