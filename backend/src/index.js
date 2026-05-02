const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// The application will now use Application Default Credentials (ADC) in all environments.
// For local development, authenticate by running `gcloud auth application-default login`.
// In Cloud Run, the attached service account's identity is used automatically.

const logger = require('./utils/logger');
const mainRoutes = require('./routes/index');
const { cleanupLocalMedia, getCleanupConfig } = require('./utils/mediaStorage');

const app = express();
const port = process.env.PORT || 8080;
const allowedOrigins = ['http://localhost:3000', 'http://localhost:3001'];

app.use((req, res, next) => {

  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {

    res.header('Access-Control-Allow-Origin', origin);

  }

  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {

    return res.status(200).end();

  }

  next();

});

app.use(cors({
    origin: ['http://localhost:3000', 'http://localhost:3001', 'https://vinci-clips-frontend-382403086889.us-central1.run.app','https://clips.tryvinci.com'],
    credentials: true,
    exposedHeaders: ['Content-Length', 'X-Content-Length', 'Content-Disposition']
}));
app.use(express.json());

// Add request logging middleware
app.use(logger.requestMiddleware);

// Mount routes
app.use('/clips', mainRoutes);

// Serve static files from the 'uploads' directory
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

async function startServer() {
    try {
        app.listen(port, () => {
            logger.info(`Server started successfully on port ${port}`);
        });
        startMediaCleanupScheduler();
    } catch (error) {
        logger.logError(error, { context: 'server_startup' });
        process.exit(1);
    }
}

function startMediaCleanupScheduler() {
    const config = getCleanupConfig();
    if (!config.enabled) {
        logger.info('Local media cleanup scheduler disabled.');
        return;
    }

    const runCleanup = async () => {
        try {
            const result = await cleanupLocalMedia({
                tempRetentionHours: config.tempRetentionHours,
                unreferencedRetentionHours: config.unreferencedRetentionHours,
            });
            logger.info('Local media cleanup completed.', result.summary);
        } catch (error) {
            logger.warn(`Local media cleanup failed: ${error.message}`);
        }
    };

    setImmediate(runCleanup);
    const intervalMs = config.intervalHours * 60 * 60 * 1000;
    if (intervalMs > 0) {
        setInterval(runCleanup, intervalMs).unref();
    }
}

startServer();
