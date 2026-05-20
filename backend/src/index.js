const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const { RedisStore } = require('connect-redis');
const { createClient } = require('redis');
require('dotenv').config();

const logger = require('./utils/logger');
const mainRoutes = require('./routes/index');
const authRoutes = require('./routes/auth');
const { loadUser, requireAuth } = require('./middleware/auth');
const { cleanupLocalMedia, getCleanupConfig } = require('./utils/mediaStorage');
const { getCookieStatus, sendAlertWebhook, getMonitorConfig } = require('./services/cookieMonitor');
const { startPipelineWorkers } = require('./queue/workers');
const { reconcileQueue, startReconcileScheduler } = require('./queue/reconcile');

const app = express();
const port = process.env.PORT || 8080;

if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}

const configuredCorsOrigins = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
    'https://vinci-clips-frontend-382403086889.us-central1.run.app',
    'https://clips.tryvinci.com',
    ...configuredCorsOrigins,
];

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

app.use(cors({
    origin: allowedOrigins,
    credentials: true,
    exposedHeaders: ['Content-Length', 'X-Content-Length', 'Content-Disposition'],
}));
app.use(express.json());
app.use(logger.requestMiddleware);

function validateEnv() {
    if (!process.env.YOUTUBE_API_KEY) {
        logger.warn('YOUTUBE_API_KEY is not set — YouTube metadata extraction will fail.');
    }
    const provider = (process.env.VIDEO_DOWNLOAD_PROVIDER || 'ytdlp').toLowerCase();
    if (provider === 'savenow' && !process.env.VIDEO_DOWNLOAD_API_KEY) {
        logger.error('VIDEO_DOWNLOAD_PROVIDER=savenow but VIDEO_DOWNLOAD_API_KEY is not set. Exiting.');
        process.exit(1);
    }
}

async function startServer() {
    validateEnv();
    // Connect Redis for session store
    const redisClient = createClient({
        socket: {
            host: process.env.REDIS_HOST || 'localhost',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
        },
        password: process.env.REDIS_PASSWORD || undefined,
    });

    redisClient.on('error', (err) => logger.warn(`Redis session client error: ${err.message}`));
    await redisClient.connect();
    logger.info('Redis session client connected.');

    app.use(session({
        store: new RedisStore({ client: redisClient }),
        secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
        name: 'vc.sid',
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: 'lax',
            secure: process.env.NODE_ENV === 'production',
            maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        },
    }));

    // Attach req.user on every request
    app.use(loadUser);

    app.get('/health', (req, res) => {
        res.status(200).json({
            status: 'healthy',
            service: 'backend',
            uptime: process.uptime(),
        });
    });

    // Auth routes (login is public; logout/me/change-password check auth internally)
    app.use('/clips/auth', authRoutes);

    app.use('/clips', (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });

    // All other /clips/* routes require authentication
    app.use('/clips', requireAuth, mainRoutes);

    // Protected media files
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    app.use('/uploads', requireAuth, express.static(uploadsDir));

    try {
        app.listen(port, () => {
            logger.info(`Server started successfully on port ${port}`);
        });
        startPipelineWorkers();
        await reconcileQueue();
        startReconcileScheduler();
        startMediaCleanupScheduler();
        startCookieMonitor();
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

function startCookieMonitor() {
    const config = getMonitorConfig();
    if (!config.enabled) {
        logger.info('Cookie monitor disabled (YTDLP_COOKIES_PATH not set or COOKIE_MONITOR_ENABLED=false).');
        return;
    }

    const runCheck = async () => {
        const status = getCookieStatus();
        if (status.state === 'expired') {
            logger.warn('YouTube cookies have EXPIRED. URL imports will fail until re-exported.', {
                expiresAt: status.expiresAt,
                criticalCookiesFound: status.criticalCookiesFound,
            });
            await sendAlertWebhook(status).catch(() => {});
        } else if (status.state === 'expiring') {
            logger.warn(`YouTube cookies expire in ${status.daysRemaining} day(s). Re-export soon to avoid import failures.`, {
                expiresAt: status.expiresAt,
                daysRemaining: status.daysRemaining,
            });
            await sendAlertWebhook(status).catch(() => {});
        } else if (status.state === 'missing') {
            logger.warn('YouTube cookie file configured but not found or contains no recognised auth cookies.', {
                path: process.env.YTDLP_COOKIES_PATH,
            });
        } else if (status.state === 'valid') {
            logger.info(`YouTube cookies valid for ${status.daysRemaining} day(s).`, {
                expiresAt: status.expiresAt,
            });
        }
    };

    setImmediate(runCheck);
    const intervalMs = config.intervalHours * 60 * 60 * 1000;
    if (intervalMs > 0) {
        setInterval(runCheck, intervalMs).unref();
    }
}

startServer();
