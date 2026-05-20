// BullMQ Redis connection options.
// Kept separate from the session Redis client (which uses the 'redis' package).
const connectionOptions = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: false,
};

module.exports = connectionOptions;
