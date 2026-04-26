const express = require('express');
const path = require('path');
const fs = require('fs');
const Transcript = require('../models/Transcript');
const {
    getCaptionStylesForClient,
    moveFileSafe,
    renderCaptionedVideo
} = require('../utils/captioning');

const router = express.Router();

router.get('/styles', (req, res) => {
    res.json({
        success: true,
        styles: getCaptionStylesForClient()
    });
});

router.post('/generate/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { style = 'bold-center', startTime, endTime } = req.body;

        const transcript = await Transcript.findById(id);
        if (!transcript) {
            return res.status(404).json({
                success: false,
                error: 'Transcript not found'
            });
        }

        if (transcript.status !== 'completed') {
            return res.status(400).json({
                success: false,
                error: 'Transcript not ready for caption generation'
            });
        }

        const tempDir = path.join(__dirname, '../../temp');
        fs.mkdirSync(tempDir, { recursive: true });

        const outputFileName = `${transcript._id}_captioned_${style}_${Date.now()}.mp4`;
        const outputPath = path.join(tempDir, outputFileName);
        const inputPath = path.join(__dirname, '..', '..', 'uploads', path.basename(transcript.videoUrl));

        const result = await renderCaptionedVideo({
            inputPath,
            outputPath,
            transcriptSegments: transcript.transcript,
            styleId: style,
            startTime,
            endTime,
            logger: console
        });

        const destDir = path.join(__dirname, '..', '..', 'uploads', 'captioned');
        fs.mkdirSync(destDir, { recursive: true });
        const destPath = path.join(destDir, outputFileName);
        moveFileSafe(outputPath, destPath);

        res.json({
            success: true,
            captionedVideoUrl: `/uploads/captioned/${outputFileName}`,
            style: {
                id: result.resolvedStyle.id,
                name: result.resolvedStyle.name,
                description: result.resolvedStyle.description,
                layout: result.resolvedStyle.layout
            },
            wordCount: result.wordCount,
            message: 'Captioned video generated successfully'
        });
    } catch (error) {
        console.error('Caption generation error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to generate captioned video',
            details: error.message
        });
    }
});

module.exports = router;
