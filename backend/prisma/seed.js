// Runs after migrate deploy on container startup. Idempotent — skips existing rows.
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { DEFAULT_PROMPTS } = require('../src/utils/promptStore');

const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL) });

async function main() {
    for (const [kind, body] of Object.entries(DEFAULT_PROMPTS)) {
        const existing = await prisma.promptTemplate.findFirst({ where: { kind } });
        if (!existing) {
            await prisma.promptTemplate.create({
                data: { kind, name: 'Default', body, isActive: true },
            });
            console.log(`[seed] Seeded ${kind} prompt`);
        } else {
            console.log(`[seed] ${kind} prompt already exists, skipping`);
        }
    }
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
