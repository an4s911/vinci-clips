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

function normalizeFolder(f) {
    return { ...f, overlays: Array.isArray(f.overlays) ? f.overlays : [] };
}

async function getFolders() {
    const row = await prisma.appSetting.findUnique({ where: { key: FOLDERS_KEY } });
    const folders = row?.value?.folders;
    return Array.isArray(folders) ? folders.map(normalizeFolder) : [];
}

async function getFolderById(id) {
    const folders = await getFolders();
    return folders.find(f => f.id === id) || null;
}

async function _saveFolders(folders) {
    await prisma.appSetting.upsert({
        where: { key: FOLDERS_KEY },
        update: { value: { folders } },
        create: { key: FOLDERS_KEY, value: { folders } },
    });
}

async function addFolder({ driveFolderId, name }) {
    const folders = await getFolders();
    if (folders.some(f => f.driveFolderId === driveFolderId)) {
        return folders; // already saved — idempotent
    }
    const next = [
        ...folders,
        { id: crypto.randomUUID(), driveFolderId, name, addedAt: new Date().toISOString(), overlays: [] },
    ];
    await _saveFolders(next);
    return next;
}

async function removeFolder(id) {
    const folders = await getFolders();
    const folder = folders.find(f => f.id === id);
    const next = folders.filter(f => f.id !== id);
    await _saveFolders(next);
    return { folders: next, removed: folder || null };
}

async function addOverlay(folderId, { id, path, filename, width, height }) {
    const folders = await getFolders();
    const idx = folders.findIndex(f => f.id === folderId);
    if (idx === -1) throw new Error('Folder not found.');
    const overlay = { id, path, filename, width, height, addedAt: new Date().toISOString() };
    folders[idx] = { ...folders[idx], overlays: [...folders[idx].overlays, overlay] };
    await _saveFolders(folders);
    return folders[idx];
}

async function removeOverlay(folderId, overlayId) {
    const folders = await getFolders();
    const idx = folders.findIndex(f => f.id === folderId);
    if (idx === -1) throw new Error('Folder not found.');
    const removed = folders[idx].overlays.find(o => o.id === overlayId);
    folders[idx] = { ...folders[idx], overlays: folders[idx].overlays.filter(o => o.id !== overlayId) };
    await _saveFolders(folders);
    return { folder: folders[idx], removed: removed || null };
}

module.exports = { getAuth, setAuth, clearAuth, getFolders, getFolderById, addFolder, removeFolder, addOverlay, removeOverlay };
