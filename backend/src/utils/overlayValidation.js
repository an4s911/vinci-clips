const ffmpeg = require('fluent-ffmpeg');

const ALPHA_PIX_FMTS = new Set([
    'rgba', 'rgba64be', 'rgba64le',
    'argb', 'abgr', 'bgra',
    'ya8', 'ya16be', 'ya16le',
    'yuva420p', 'yuva422p', 'yuva444p',
    'yuva420p9be', 'yuva420p9le', 'yuva420p10be', 'yuva420p10le',
    'yuva420p16be', 'yuva420p16le',
    'yuva422p9be', 'yuva422p9le', 'yuva422p10be', 'yuva422p10le',
    'yuva422p16be', 'yuva422p16le',
    'yuva444p9be', 'yuva444p9le', 'yuva444p10be', 'yuva444p10le',
    'yuva444p16be', 'yuva444p16le',
]);

const TARGET_RATIO = 9 / 16;
const RATIO_TOLERANCE = 1e-3;

function validateOverlayImage(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(new Error('Failed to probe image file.'));

            const stream = metadata.streams?.find(s => s.codec_type === 'video');
            if (!stream) return reject(new Error('File has no video/image stream.'));

            const { pix_fmt, width, height } = stream;

            if (!ALPHA_PIX_FMTS.has(pix_fmt)) {
                return reject(new Error(
                    `PNG must have a transparent (alpha) channel. Detected pixel format: ${pix_fmt || 'unknown'}. ` +
                    'Export as RGBA PNG from your image editor.'
                ));
            }

            if (!width || !height) return reject(new Error('Could not read image dimensions.'));
            const ratio = width / height;
            if (Math.abs(ratio - TARGET_RATIO) > RATIO_TOLERANCE) {
                return reject(new Error(
                    `Overlay must be exactly 9:16 (e.g. 1080×1920). Got ${width}×${height}.`
                ));
            }

            resolve({ width, height });
        });
    });
}

module.exports = { validateOverlayImage };
