import path from 'node:path';
import { defineConfig } from 'prisma/config';

const sqliteUrl = process.env.DATABASE_URL ?? `file:${path.join(process.cwd(), 'data', 'bot.db')}`;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: sqliteUrl,
  },
});
