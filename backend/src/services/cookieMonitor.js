const fs = require('fs');
const axios = require('axios');

const CRITICAL_COOKIES = new Set([
    '__Secure-3PSID',
    '__Secure-1PSID',
    'SID',
    'SAPISID',
    'LOGIN_INFO',
]);

const DEFAULT_WARN_DAYS = 3;
const DEFAULT_INTERVAL_HOURS = 12;

/**
 * @typedef {Object} CookieStatus
 * @property {'disabled'|'missing'|'expired'|'expiring'|'valid'} state
 * @property {Date|null} expiresAt
 * @property {number|null} daysRemaining
 * @property {string[]} criticalCookiesFound
 */

/**
 * Parse a Netscape cookie file and return status of critical YouTube auth cookies.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {CookieStatus}
 */
function getCookieStatus(env = process.env) {
    const cookiesPath = env.YTDLP_COOKIES_PATH;
    if (!cookiesPath) return { state: 'disabled', expiresAt: null, daysRemaining: null, criticalCookiesFound: [] };

    let content;
    try {
        content = fs.readFileSync(cookiesPath, 'utf8');
    } catch {
        return { state: 'missing', expiresAt: null, daysRemaining: null, criticalCookiesFound: [] };
    }

    const warnDays = parseInt(env.COOKIE_WARN_DAYS || DEFAULT_WARN_DAYS, 10);
    const nowSec = Math.floor(Date.now() / 1000);
    const found = [];
    let minExpiry = null;

    for (const line of content.split('\n')) {
        if (!line || line.startsWith('#')) continue;
        const parts = line.split('\t');
        if (parts.length < 7) continue;
        const name = parts[5];
        if (!CRITICAL_COOKIES.has(name)) continue;
        const expiry = parseInt(parts[4], 10);
        if (!expiry || isNaN(expiry)) continue;
        found.push(name);
        if (minExpiry === null || expiry < minExpiry) minExpiry = expiry;
    }

    if (minExpiry === null) {
        return { state: 'missing', expiresAt: null, daysRemaining: null, criticalCookiesFound: found };
    }

    const daysRemaining = Math.floor((minExpiry - nowSec) / 86400);
    const expiresAt = new Date(minExpiry * 1000);

    let state;
    if (daysRemaining <= 0) {
        state = 'expired';
    } else if (daysRemaining <= warnDays) {
        state = 'expiring';
    } else {
        state = 'valid';
    }

    return { state, expiresAt, daysRemaining, criticalCookiesFound: found };
}

/**
 * Fire-and-forget webhook POST when cookies are expiring or expired.
 * @param {CookieStatus} status
 * @param {NodeJS.ProcessEnv} [env]
 */
async function sendAlertWebhook(status, env = process.env) {
    const webhookUrl = env.COOKIE_ALERT_WEBHOOK;
    if (!webhookUrl) return;
    try {
        await axios.post(webhookUrl, {
            state: status.state,
            daysRemaining: status.daysRemaining,
            expiresAt: status.expiresAt?.toISOString() || null,
            host: require('os').hostname(),
        }, { timeout: 5000 });
    } catch {
        // fire-and-forget; caller logs if needed
    }
}

/**
 * @returns {{ intervalHours: number, enabled: boolean }}
 */
function getMonitorConfig(env = process.env) {
    const cookiesPath = env.YTDLP_COOKIES_PATH;
    const enabled = env.COOKIE_MONITOR_ENABLED !== 'false' && !!cookiesPath;
    const intervalHours = parseFloat(env.COOKIE_MONITOR_INTERVAL_HOURS || DEFAULT_INTERVAL_HOURS);
    return { enabled, intervalHours };
}

module.exports = { getCookieStatus, sendAlertWebhook, getMonitorConfig };
