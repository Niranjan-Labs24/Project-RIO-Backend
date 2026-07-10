import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Prisma 7: the CLI (generate/migrate/seed) no longer reads a datasource url
// from schema.prisma. This config supplies the owner-role connection
// (cnap_owner, via DATABASE_URL) used only by the Prisma CLI. The running
// app never reads this file — PrismaService connects at runtime with the
// restricted cnap_app role via a driver adapter built from APP_DATABASE_URL.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
