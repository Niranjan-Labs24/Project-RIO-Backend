import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma';

// Runs via `tsx prisma/seed.ts` (see package.json "prisma".seed), so env
// vars aren't guaranteed to already be loaded — `dotenv/config` above pulls
// in .env the same way test/setup-env.ts does for the test suite.
//
// Prisma 7 removed `datasourceUrl` from the client constructor; an explicit
// driver adapter is required (mirrors src/prisma/prisma.service.ts). Seeding
// uses the owner role (DATABASE_URL / cnap_owner) — the same role the CLI
// uses for migrations — since it needs to create organisations rows, which
// are unprivileged for cnap_app (SELECT-only).
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main(): Promise<void> {
  const orgA = await prisma.organisation.create({ data: { name: 'Org A' } });
  const orgB = await prisma.organisation.create({ data: { name: 'Org B' } });

  // notes carries FORCE ROW LEVEL SECURITY, so even the owner role must set
  // the org context (transaction-local) before it can insert a row.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgA.id}, true)`;
    await tx.$executeRaw`INSERT INTO notes (org_id, body) VALUES (${orgA.id}::uuid, 'A-note-1')`;
  });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgB.id}, true)`;
    await tx.$executeRaw`INSERT INTO notes (org_id, body) VALUES (${orgB.id}::uuid, 'B-note-1')`;
  });

  console.log(`Seeded Org A=${orgA.id} Org B=${orgB.id}`);
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
