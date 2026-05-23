const crypto = require('crypto');
const prisma = require('../db/prisma');

const AUTH_KEY = 'googleDriveAuth';
const FOLDERS_KEY = 'googleDriveFolders';

async function getAuth() {
    const row = await prisma.appSetting.findUnique({ where: { key: AUTH_KEY } });
    if (!row || !row.value) return null;
    const v = row.value;
    if (!v.refreshToken) return null;
    return { refreshToken: v.refreshToken, email: v.email || null, connectedAt: v.connectedAt || null };
}

async function setAuth({ refreshToken, email }) {
    const value = { refreshToken, email: email || null, connectedAt: new Date().toISOString() };
    await prisma.appSetting.upsert({
        where: { key: AUTH_KEY },
        update: { value },
        create: { key: AUTH_KEY, value },
    });
    return value;
}

async function clearAuth() {
    await prisma.appSetting.delete({ where: { key: AUTH_KEY } }).catch(() => {});
}

async function getFolders() {
    const row = await prisma.appSetting.findUnique({ where: { key: FOLDERS_KEY } });
    const folders = row?.value?.folders;
    return Array.isArray(folders) ? folders : [];
}

async function addFolder({ driveFolderId, name }) {
    const folders = await getFolders();
    if (folders.some(f => f.driveFolderId === driveFolderId)) {
        return folders; // already saved — idempotent
    }
    const next = [
        ...folders,
        { id: crypto.randomUUID(), driveFolderId, name, addedAt: new Date().toISOString() },
    ];
    await prisma.appSetting.upsert({
        where: { key: FOLDERS_KEY },
        update: { value: { folders: next } },
        create: { key: FOLDERS_KEY, value: { folders: next } },
    });
    return next;
}

async function removeFolder(id) {
    const folders = await getFolders();
    const next = folders.filter(f => f.id !== id);
    await prisma.appSetting.upsert({
        where: { key: FOLDERS_KEY },
        update: { value: { folders: next } },
        create: { key: FOLDERS_KEY, value: { folders: next } },
    });
    return next;
}

module.exports = { getAuth, setAuth, clearAuth, getFolders, addFolder, removeFolder };
