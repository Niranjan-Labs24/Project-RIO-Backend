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
    // Prisma 7 moved the seed command here from package.json's `prisma.seed`
    // field, which the CLI now silently ignores — `npx prisma db seed` and
    // `npx prisma migrate dev` (which auto-seeds) failed with "No seed
    // command configured" without this, even though `pnpm prisma:seed` (a
    // direct `tsx prisma/seed.ts` call bypassing the CLI's seed detection)
    // always worked. Same script both ways now.
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
