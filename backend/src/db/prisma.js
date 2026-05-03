const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

function createClient() {
    const adapter = new PrismaPg(process.env.DATABASE_URL);
    return new PrismaClient({ adapter });
}

// Singleton — reuse across hot-reload cycles in dev
if (!global.__prismaClient) {
    global.__prismaClient = createClient();
}

module.exports = global.__prismaClient;
