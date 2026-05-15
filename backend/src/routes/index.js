const express = require('express');
const router = express.Router();

const uploadRoutes = require('./upload');
const analyzeRoutes = require('./analyze');
const transcriptsRoutes = require('./transcripts');
const clipsRoutes = require('./clips');
const captionsRoutes = require('./captions');
const captionTemplatesRoutes = require('./captionTemplates');
const fixStatusRoutes = require('./fix-status');
const importRoutes = require('./import');
const retryRoutes = require('./retry-transcription');
const reframeRoutes = require('./reframe');
const streamerRoutes = require('./streamer');
const storageRoutes = require('./storage');
const settingsRoutes = require('./settings');
const promptsRoutes = require('./prompts');

router.use('/upload', uploadRoutes);
router.use('/import', importRoutes);
router.use('/transcripts', transcriptsRoutes);
router.use('/analyze', analyzeRoutes);
router.use('/clips', clipsRoutes);
router.use('/captions', captionsRoutes);
router.use('/caption-templates', captionTemplatesRoutes);
router.use('/reframe', reframeRoutes);
router.use('/streamer', streamerRoutes);
router.use('/retry', retryRoutes);
router.use('/storage', storageRoutes);
router.use('/settings', settingsRoutes);
router.use('/prompts', promptsRoutes);
router.use('/admin', fixStatusRoutes);

module.exports = router;
