const express = require('express');
const prisma = require('../db/prisma');

const router = express.Router();

router.post('/fix-statuses', async (req, res) => {
    try {
        // Find transcripts stuck in processing that already have media + transcript data
        const stuckStatuses = ['uploading', 'converting', 'transcribing'];

        const stuck = await prisma.transcript.findMany({
            where: {
                status: { in: stuckStatuses },
                videoUrl: { not: null },
                mp3Url: { not: null },
            },
        });

        // Filter those that actually have transcript content
        const toFix = stuck.filter((t) => {
            const data = t.transcript;
            return Array.isArray(data) && data.length > 0;
        });

        let fixed = 0;
        for (const t of toFix) {
            await prisma.transcript.update({
                where: { id: t.id },
                data: { status: 'completed' },
            });
            fixed++;
        }

        res.status(200).json({
            message: 'Status fix completed successfully',
            totalFixed: fixed,
        });
    } catch (error) {
        console.error('Error fixing transcript statuses:', error);
        res.status(500).json({ error: 'Failed to fix transcript statuses' });
    }
});

module.exports = router;
