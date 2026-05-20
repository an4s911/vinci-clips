const fs = require('fs');
const { getCookieStatus } = require('../cookieMonitor');

jest.mock('fs');

const farExpiry = Math.floor(Date.now() / 1000) + 30 * 86400; // 30 days
const soonExpiry = Math.floor(Date.now() / 1000) + 2 * 86400; // 2 days
const pastExpiry = Math.floor(Date.now() / 1000) - 86400;     // yesterday

function netscapeLine(name, expiry) {
    return `.youtube.com\tTRUE\t/\tTRUE\t${expiry}\t${name}\tsome_value`;
}

const VALID_FILE = [
    '# Netscape HTTP Cookie File',
    netscapeLine('__Secure-3PSID', farExpiry),
    netscapeLine('SAPISID', farExpiry),
    netscapeLine('SID', farExpiry),
].join('\n');

const EXPIRING_FILE = [
    '# Netscape HTTP Cookie File',
    netscapeLine('__Secure-3PSID', soonExpiry),
    netscapeLine('SAPISID', farExpiry),
].join('\n');

const EXPIRED_FILE = [
    '# Netscape HTTP Cookie File',
    netscapeLine('__Secure-3PSID', pastExpiry),
    netscapeLine('SAPISID', farExpiry),
].join('\n');

const NO_CRITICAL_FILE = [
    '# Netscape HTTP Cookie File',
    netscapeLine('SOME_OTHER_COOKIE', farExpiry),
].join('\n');

describe('getCookieStatus', () => {
    afterEach(() => jest.resetAllMocks());

    it('returns disabled when YTDLP_COOKIES_PATH unset', () => {
        const status = getCookieStatus({});
        expect(status.state).toBe('disabled');
        expect(status.criticalCookiesFound).toEqual([]);
    });

    it('returns missing when file does not exist', () => {
        fs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
        const status = getCookieStatus({ YTDLP_COOKIES_PATH: '/cookies.txt' });
        expect(status.state).toBe('missing');
    });

    it('returns missing when no critical cookies in file', () => {
        fs.readFileSync.mockReturnValue(NO_CRITICAL_FILE);
        const status = getCookieStatus({ YTDLP_COOKIES_PATH: '/cookies.txt' });
        expect(status.state).toBe('missing');
        expect(status.criticalCookiesFound).toEqual([]);
    });

    it('returns valid when cookies expire far in future', () => {
        fs.readFileSync.mockReturnValue(VALID_FILE);
        const status = getCookieStatus({ YTDLP_COOKIES_PATH: '/cookies.txt', COOKIE_WARN_DAYS: '3' });
        expect(status.state).toBe('valid');
        expect(status.daysRemaining).toBeGreaterThan(3);
        expect(status.criticalCookiesFound.length).toBeGreaterThan(0);
    });

    it('returns expiring when within warn window', () => {
        fs.readFileSync.mockReturnValue(EXPIRING_FILE);
        const status = getCookieStatus({ YTDLP_COOKIES_PATH: '/cookies.txt', COOKIE_WARN_DAYS: '3' });
        expect(status.state).toBe('expiring');
        expect(status.daysRemaining).toBeLessThanOrEqual(3);
    });

    it('returns expired when past expiry', () => {
        fs.readFileSync.mockReturnValue(EXPIRED_FILE);
        const status = getCookieStatus({ YTDLP_COOKIES_PATH: '/cookies.txt', COOKIE_WARN_DAYS: '3' });
        expect(status.state).toBe('expired');
        expect(status.daysRemaining).toBeLessThanOrEqual(0);
    });

    it('uses minimum expiry across critical cookies', () => {
        // EXPIRING_FILE has one at soonExpiry (2d) and one at farExpiry (30d) — min wins
        fs.readFileSync.mockReturnValue(EXPIRING_FILE);
        const status = getCookieStatus({ YTDLP_COOKIES_PATH: '/cookies.txt', COOKIE_WARN_DAYS: '3' });
        expect(status.state).toBe('expiring');
    });
});
