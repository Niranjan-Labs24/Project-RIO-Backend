import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma';
import { hashPassword } from '../src/common/password.util';

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

const DEMO_PASSWORD = 'password123';

/**
 * users carries FORCE ROW LEVEL SECURITY, so even the owner role must set
 * the org context (transaction-local) before it can insert/select a row —
 * same pattern the notes seeding below already uses.
 */
async function upsertUser(input: {
  orgId: string;
  name: string;
  email: string;
  role: string;
}): Promise<void> {
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${input.orgId}, true)`;
    await tx.user.upsert({
      where: { email: input.email },
      create: {
        orgId: input.orgId,
        name: input.name,
        email: input.email,
        passwordHash,
        role: input.role,
        // Demo accounts already "know" their password (password123) —
        // unlike a real signup-issued temp password, there's nothing to
        // force a change on.
        mustChangePassword: false,
      },
      // Password/role/name may have drifted from a previous seed run — keep
      // the seed idempotent and always converge back to these values.
      update: { name: input.name, passwordHash, role: input.role, mustChangePassword: false },
    });
  });
}

async function main(): Promise<void> {
  // Mirrors the frontend's mock demo data (src/mocks/data/organizations.ts,
  // users.ts) exactly — same orgs, same accounts, same `password123` — so
  // the e2e suite (Project-RIO-Frontend/e2e/auth-flows.spec.ts) can log in
  // against the real backend with the credentials it already hardcodes.
  const demoOrg = await prisma.organisation.upsert({
    where: { registrationNumber: 'REG-DEMO-0001' },
    create: {
      name: 'Demo Nonprofit Alliance',
      purpose: 'Livelihoods and economic development across rural communities.',
      registrationNumber: 'REG-DEMO-0001',
    },
    update: {},
  });
  const riversideOrg = await prisma.organisation.upsert({
    where: { registrationNumber: 'REG-DEMO-0002' },
    create: {
      name: 'Riverside Community Trust',
      purpose: 'Water, sanitation, and hygiene access for riverside villages.',
      registrationNumber: 'REG-DEMO-0002',
    },
    update: {},
  });

  await upsertUser({
    orgId: demoOrg.id,
    name: 'Alex Morgan',
    email: 'admin@demo.org',
    role: 'ngo_admin',
  });
  await upsertUser({
    orgId: demoOrg.id,
    name: 'Ryan Fernandes',
    email: 'officer@demo.org',
    role: 'ngo_research_officer',
  });
  await upsertUser({
    orgId: riversideOrg.id,
    name: 'Devika Menon',
    email: 'admin@riverside.org',
    role: 'ngo_admin',
  });

  console.log(
    `Seeded demo org=${demoOrg.id} (admin@demo.org, officer@demo.org), riverside org=${riversideOrg.id} (admin@riverside.org)`,
  );

  // Sample orgs for the notes module (unrelated to the auth demo accounts
  // above) — kept idempotent the same way.
  const orgA = await prisma.organisation.upsert({
    where: { registrationNumber: 'REG-NOTES-A' },
    create: { name: 'Org A', purpose: 'Notes module sample data', registrationNumber: 'REG-NOTES-A' },
    update: {},
  });
  const orgB = await prisma.organisation.upsert({
    where: { registrationNumber: 'REG-NOTES-B' },
    create: { name: 'Org B', purpose: 'Notes module sample data', registrationNumber: 'REG-NOTES-B' },
    update: {},
  });

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgA.id}, true)`;
    const existing = await tx.note.findFirst({ where: { orgId: orgA.id } });
    if (!existing) {
      await tx.$executeRaw`INSERT INTO notes (org_id, body) VALUES (${orgA.id}::uuid, 'A-note-1')`;
    }
  });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgB.id}, true)`;
    const existing = await tx.note.findFirst({ where: { orgId: orgB.id } });
    if (!existing) {
      await tx.$executeRaw`INSERT INTO notes (org_id, body) VALUES (${orgB.id}::uuid, 'B-note-1')`;
    }
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
