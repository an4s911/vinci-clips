const crypto = require('crypto');
const prisma = require('../db/prisma');

const KEY_SETTING = 'externalApiKey';

function hashKey(plaintext) {
    return crypto.createHash('sha256').update(plaintext).digest('hex');
}

async function generateApiKey() {
    const plaintext = 'vc_' + crypto.randomBytes(32).toString('base64url');
    const hash = hashKey(plaintext);
    const createdAt = new Date().toISOString();
    await prisma.appSetting.upsert({
        where: { key: KEY_SETTING },
        update: { value: { hash, createdAt } },
        create: { key: KEY_SETTING, value: { hash, createdAt } },
    });
    return { key: plaintext, createdAt };
}

async function getApiKeyMeta() {
    const row = await prisma.appSetting.findUnique({ where: { key: KEY_SETTING } });
    if (!row) return null;
    return { configured: true, createdAt: row.value.createdAt };
}

async function revokeApiKey() {
    await prisma.appSetting.deleteMany({ where: { key: KEY_SETTING } });
}

async function verifyApiKey(presented) {
    if (!presented) return false;
    const row = await prisma.appSetting.findUnique({ where: { key: KEY_SETTING } });
    if (!row?.value?.hash) return false;
    const stored = Buffer.from(row.value.hash, 'utf8');
    const candidate = Buffer.from(hashKey(presented), 'utf8');
    if (stored.length !== candidate.length) return false;
    return crypto.timingSafeEqual(stored, candidate);
}

async function resolveAdminUser() {
    return prisma.user.findFirst({
        where: { role: 'admin', isActive: true },
        orderBy: { createdAt: 'asc' },
        select: { id: true, email: true, role: true, isActive: true },
    });
}

module.exports = { generateApiKey, getApiKeyMeta, revokeApiKey, verifyApiKey, resolveAdminUser };
