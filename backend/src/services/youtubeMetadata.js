const axios = require('axios');

const VIDEO_ID_RE = /(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

function parseIsoDuration(iso) {
    const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!m) return 0;
    return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

async function extractYouTubeMetadata(url) {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) throw new Error('YOUTUBE_API_KEY is not configured.');

    const match = url.match(VIDEO_ID_RE);
    if (!match) throw new Error(`Could not extract video ID from URL: ${url}`);
    const videoId = match[1];

    let response;
    try {
        response = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
            params: { part: 'snippet,contentDetails', id: videoId, key: apiKey },
            timeout: 15000,
        });
    } catch (err) {
        const status = err.response?.status;
        const reason = err.response?.data?.error?.errors?.[0]?.reason;
        if (status === 403 && reason === 'quotaExceeded') throw new Error('YouTube Data API quota exceeded. Try again tomorrow or increase quota.');
        throw new Error(`YouTube Data API request failed: ${err.message}`);
    }

    const items = response.data.items;
    if (!items || items.length === 0) throw new Error('Video not found or is private/unavailable.');

    const snippet = items[0].snippet;
    const contentDetails = items[0].contentDetails;
    const thumbnails = snippet.thumbnails || {};
    const thumbnail = thumbnails.maxres?.url || thumbnails.high?.url || thumbnails.medium?.url || null;

    return {
        title: snippet.title || 'youtube-import',
        description: snippet.description || '',
        duration: parseIsoDuration(contentDetails.duration || ''),
        thumbnail,
        platform: 'youtube',
        originalUrl: url,
        videoId,
    };
}

module.exports = { extractYouTubeMetadata };
