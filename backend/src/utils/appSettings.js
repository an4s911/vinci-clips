const prisma = require('../db/prisma');

const AUTO_BULK_EDIT_KEY = 'autoBulkEdit';

const AUTO_BULK_EDIT_DEFAULTS = {
    enabled: false,
    reframe: { enabled: true, platform: 'tiktok', reframeStyleId: 'fullscreen' },
    captions: { enabled: true, styleId: null },
    hook: { enabled: true, styleId: null, timeoutSeconds: null },
};

async function getAutoBulkEditConfig() {
    const row = await prisma.appSetting.findUnique({ where: { key: AUTO_BULK_EDIT_KEY } });
    if (!row) return { ...AUTO_BULK_EDIT_DEFAULTS };
    const stored = row.value;
    return {
        enabled: Boolean(stored.enabled),
        reframe: {
            enabled: stored.reframe?.enabled !== false,
            platform: stored.reframe?.platform || AUTO_BULK_EDIT_DEFAULTS.reframe.platform,
            reframeStyleId: stored.reframe?.reframeStyleId || AUTO_BULK_EDIT_DEFAULTS.reframe.reframeStyleId,
        },
        captions: {
            enabled: stored.captions?.enabled !== false,
            styleId: stored.captions?.styleId || null,
        },
        hook: {
            enabled: stored.hook?.enabled !== false,
            styleId: stored.hook?.styleId || null,
            timeoutSeconds: stored.hook?.timeoutSeconds ?? null,
        },
    };
}

async function setAutoBulkEditConfig(config) {
    await prisma.appSetting.upsert({
        where: { key: AUTO_BULK_EDIT_KEY },
        update: { value: config },
        create: { key: AUTO_BULK_EDIT_KEY, value: config },
    });
}

module.exports = { getAutoBulkEditConfig, setAutoBulkEditConfig };
