import { defineConfig } from 'prisma/config';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

function buildDatasourceUrlFromPostgresEnv() {
  const user = process.env.POSTGRES_USER;
  const password = process.env.POSTGRES_PASSWORD;
  const database = process.env.POSTGRES_DB;

  if (!user || !password || !database) {
    return undefined;
  }

  const host = process.env.POSTGRES_HOST || 'localhost';
  const port = process.env.POSTGRES_PORT || '5432';
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}?schema=public`;
}

export default defineConfig({
  datasource: {
    url: process.env.DATABASE_URL || buildDatasourceUrlFromPostgresEnv(),
  },
});
