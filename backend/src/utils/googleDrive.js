const fs = require('fs');
const { google } = require('googleapis');
const { getAuth } = require('./googleDriveSettings');

const DRIVE_SCOPES = [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/userinfo.email',
];

const FOLDER_MIME = 'application/vnd.google-apps.folder';

function isConfigured() {
    return Boolean(
        process.env.GOOGLE_CLIENT_ID &&
        process.env.GOOGLE_CLIENT_SECRET &&
        process.env.GOOGLE_OAUTH_REDIRECT_URI
    );
}

function baseClient() {
    if (!isConfigured()) {
        throw new Error('Google Drive OAuth is not configured (set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI).');
    }
    return new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_OAUTH_REDIRECT_URI
    );
}

function getAuthUrl(state) {
    return baseClient().generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent', // force a refresh_token every time
        scope: DRIVE_SCOPES,
        state,
    });
}

// Exchange an auth code for tokens; returns { refreshToken, email }.
async function exchangeCode(code) {
    const client = baseClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
        throw new Error('Google did not return a refresh token. Revoke prior access at myaccount.google.com and reconnect.');
    }
    client.setCredentials(tokens);

    let email = null;
    try {
        const oauth2 = google.oauth2({ version: 'v2', auth: client });
        const info = await oauth2.userinfo.get();
        email = info.data.email || null;
    } catch {
        // email is best-effort; not fatal
    }
    return { refreshToken: tokens.refresh_token, email };
}

// Build an authorized OAuth2 client from the stored refresh token.
// Throws if Drive is not connected. googleapis auto-refreshes the access token.
async function getAuthorizedClient() {
    const auth = await getAuth();
    if (!auth) throw new Error('Google Drive is not connected.');
    const client = baseClient();
    client.setCredentials({ refresh_token: auth.refreshToken });
    return client;
}

async function isConnected() {
    if (!isConfigured()) return false;
    return Boolean(await getAuth());
}

// Search the user's Drive for folders by name (substring match).
async function searchFolders(query) {
    const client = await getAuthorizedClient();
    const drive = google.drive({ version: 'v3', auth: client });

    const clauses = [`mimeType = '${FOLDER_MIME}'`, 'trashed = false'];
    const term = String(query || '').trim();
    if (term) {
        clauses.push(`name contains '${term.replace(/'/g, "\\'")}'`);
    }

    const res = await drive.files.list({
        q: clauses.join(' and '),
        fields: 'files(id, name)',
        pageSize: 50,
        orderBy: 'name',
        spaces: 'drive',
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
    });
    return (res.data.files || []).map(f => ({ id: f.id, name: f.name }));
}

// Verify a folder exists and is accessible; returns { id, name }.
async function getFolder(folderId) {
    const client = await getAuthorizedClient();
    const drive = google.drive({ version: 'v3', auth: client });
    const res = await drive.files.get({
        fileId: folderId,
        fields: 'id, name, mimeType',
        supportsAllDrives: true,
    });
    if (res.data.mimeType !== FOLDER_MIME) {
        throw new Error('Selected Drive item is not a folder.');
    }
    return { id: res.data.id, name: res.data.name };
}

// Stream a local file into a Drive folder. Returns the created file id.
async function uploadFile({ filePath, name, folderId }) {
    const client = await getAuthorizedClient();
    const drive = google.drive({ version: 'v3', auth: client });
    const res = await drive.files.create({
        requestBody: { name, parents: [folderId] },
        media: { body: fs.createReadStream(filePath) },
        fields: 'id',
        supportsAllDrives: true,
    });
    return res.data.id;
}

module.exports = {
    isConfigured,
    isConnected,
    getAuthUrl,
    exchangeCode,
    searchFolders,
    getFolder,
    uploadFile,
};
