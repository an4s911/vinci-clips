#!/usr/bin/env node
/**
 * CLI tool to create or reset an application user.
 *
 * Usage:
 *   node src/scripts/create-user.js --email admin@example.com --password 'secret'
 *   node src/scripts/create-user.js --email admin@example.com --password 'secret' --reset
 */

require('dotenv').config();
const argon2 = require('argon2');
const prisma = require('../db/prisma');

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { email: null, password: null, reset: false };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--email') opts.email = args[++i];
        else if (args[i] === '--password') opts.password = args[++i];
        else if (args[i] === '--reset') opts.reset = true;
    }
    return opts;
}

async function main() {
    const { email, password, reset } = parseArgs();

    if (!email || !password) {
        console.error('Usage: node src/scripts/create-user.js --email <email> --password <password> [--reset]');
        process.exit(1);
    }

    const normalizedEmail = email.toLowerCase().trim();

    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });

    if (existing && !reset) {
        console.error(`User "${normalizedEmail}" already exists. Use --reset to update the password.`);
        process.exit(1);
    }

    const passwordHash = await argon2.hash(password);

    if (existing && reset) {
        await prisma.user.update({
            where: { email: normalizedEmail },
            data: { passwordHash, isActive: true },
        });
        console.log(`Password updated for "${normalizedEmail}".`);
    } else {
        const user = await prisma.user.create({
            data: { email: normalizedEmail, passwordHash, role: 'admin' },
        });
        console.log(`User created: ${user.email} (id: ${user.id})`);
    }

    await prisma.$disconnect();
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
