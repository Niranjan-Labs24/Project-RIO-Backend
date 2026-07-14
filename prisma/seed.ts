import 'dotenv/config';
import * as argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Sector, UserStatus } from '../src/generated/prisma';
import { ROLE_MATRIX } from '../src/rbac/role-matrix';
import { pgSslFromEnv } from '../src/prisma/pg-ssl';

// Dev-only credential seeded on every demo account so login is testable.
const DEV_PASSWORD = 'Passw0rd!';

// Seed runs as cnap_owner (DATABASE_URL) — reference tables have no RLS; tenant
// tables are FORCE-RLS even for the owner, so tenant inserts set org context.
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, ssl: pgSslFromEnv() }) });

// `organisations_isolation` requires id = app.current_org_id for every
// operation — including a plain SELECT — so cnap_owner can't look up
// "does an org with this registration number already exist" without
// already knowing its id first. The supervisor connection has its own
// cross-org read policy (`organisations_supervisor_read USING (true)`,
// same one TenantPrismaService.runAsSupervisor uses at runtime) — reused
// here purely to make re-running this seed idempotent.
const supervisor = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.SUPERVISOR_DATABASE_URL, ssl: pgSslFromEnv() }) });

async function setOrg(tx: { $executeRawUnsafe: (s: string) => Promise<number> }, orgId: string) {
  await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', '${orgId}', true)`);
}

/**
 * Idempotent org + user seeding, keyed by the org's `registrationNumber`
 * and each user's `email` (both unique) — re-running the seed (e.g. after
 * a local DB reset) converges back to the same fixtures instead of
 * throwing a duplicate-key error on the second run.
 */
async function seedOrg(input: {
  registrationNumber: string;
  name: string;
  purpose: string;
  region: string;
  email: string;
  sector: Sector;
  villages: string[];
  users: Array<{ roleId: string; name: string; email: string }>;
}): Promise<string> {
  const passwordHash = await argon2.hash(DEV_PASSWORD, { type: argon2.argon2id });
  const existing = await supervisor.organisation.findUnique({
    where: { registrationNumber: input.registrationNumber },
  });
  const orgId = existing?.id ?? (await prisma.$queryRaw<{ uuidv7: string }[]>`SELECT uuidv7() AS uuidv7`)[0]!.uuidv7;

  await prisma.$transaction(async (tx) => {
    await setOrg(tx as never, orgId);
    await tx.organisation.upsert({
      where: { registrationNumber: input.registrationNumber },
      update: {
        name: input.name, purpose: input.purpose, region: input.region, email: input.email,
        sector: input.sector, villages: input.villages, isActive: true,
      },
      create: {
        id: orgId, registrationNumber: input.registrationNumber, name: input.name,
        purpose: input.purpose, region: input.region, email: input.email, sector: input.sector,
        villages: input.villages, isActive: true,
      },
    });
    for (const user of input.users) {
      // Seeded demo accounts start pre-consented — they're meant to be
      // immediately usable for local testing/demos, unlike a real
      // admin-invited user, who genuinely hasn't consented yet and must
      // hit the consent gate on their first login.
      await tx.user.upsert({
        where: { email: user.email },
        update: {
          name: user.name, roleId: user.roleId, status: UserStatus.active,
          passwordHash, consentedAt: new Date(),
        },
        create: {
          orgId, roleId: user.roleId, name: user.name, email: user.email,
          status: UserStatus.active, passwordHash, consentedAt: new Date(),
        },
      });
    }
  });

  return orgId;
}

async function main(): Promise<void> {
  for (const role of ROLE_MATRIX) {
    await prisma.role.upsert({
      where: { id: role.id },
      update: { key: role.key, name: role.name, description: role.description, crossEntity: role.crossEntity },
      create: { id: role.id, key: role.key, name: role.name, description: role.description, crossEntity: role.crossEntity },
    });
    for (const p of role.permissions) {
      await prisma.rolePermission.upsert({
        where: { roleId_module: { roleId: role.id, module: p.module } },
        update: { read: p.read, write: p.write, create: p.create, approve: p.approve, export: p.export, share: p.share },
        create: { roleId: role.id, module: p.module, read: p.read, write: p.write, create: p.create, approve: p.approve, export: p.export, share: p.share },
      });
    }
  }

  await prisma.consentPolicy.upsert({
    where: { version: 'v1' },
    update: { active: true },
    create: { version: 'v1', active: true, text: 'Buyer-supplied data-use & consent policy — placeholder text seeded until the real copy is provided.' },
  });

  // Two orgs, each with an NGO Admin — needed to prove entity separation
  // (RIO-NFR-003 / RIO-RBAC-001's "cross-entity access prevented"), plus a
  // Research Officer in the first org — a role with no entityTeam/
  // rolesPermissions access, needed to prove "unauthorized roles blocked".
  const demoOrgId = await seedOrg({
    registrationNumber: 'REG-DEMO-0001',
    name: 'Demo NGO',
    purpose: 'Water, sanitation, and hygiene access for underserved villages.',
    region: 'North',
    email: 'admin@demo-ngo.org',
    sector: Sector.wash,
    villages: ['Village A', 'Village B'],
    users: [
      { roleId: 'role_ngo_admin', name: 'Demo Admin', email: 'admin@demo-ngo.org' },
      { roleId: 'role_ngo_research_officer', name: 'Demo Research Officer', email: 'officer@demo-ngo.org' },
    ],
  });
  const riversideOrgId = await seedOrg({
    registrationNumber: 'REG-DEMO-0002',
    name: 'Riverside Community Trust',
    purpose: 'Livelihoods and economic development along the riverside communities.',
    region: 'South',
    email: 'admin@riverside-ngo.org',
    sector: Sector.livelihoods,
    villages: ['Riverside Village'],
    users: [{ roleId: 'role_ngo_admin', name: 'Riverside Admin', email: 'admin@riverside-ngo.org' }],
  });

  // Platform-wide System Admin — not scoped to either org above.
  const passwordHash = await argon2.hash(DEV_PASSWORD, { type: argon2.argon2id });
  await prisma.$transaction(async (tx) => {
    await setOrg(tx as never, demoOrgId);
    await tx.user.upsert({
      where: { email: 'sysadmin@platform.local' },
      update: {
        name: 'System Admin', roleId: 'role_system_admin', status: UserStatus.active,
        passwordHash, consentedAt: new Date(),
      },
      create: {
        orgId: demoOrgId, roleId: 'role_system_admin', name: 'System Admin',
        email: 'sysadmin@platform.local', status: UserStatus.active, passwordHash,
        consentedAt: new Date(),
      },
    });
  });

  console.log(`Seeded ${ROLE_MATRIX.length} roles, consent v1.`);
  console.log(`Seeded Demo NGO: ${demoOrgId} (admin@demo-ngo.org, officer@demo-ngo.org)`);
  console.log(`Seeded Riverside Community Trust: ${riversideOrgId} (admin@riverside-ngo.org)`);
  console.log(`Dev login password for all seeded accounts: ${DEV_PASSWORD}`);
  console.log('Also seeded: sysadmin@platform.local (system_admin, platform-wide)');
}

async function disconnectAll(): Promise<void> {
  await Promise.all([prisma.$disconnect(), supervisor.$disconnect()]);
}

main()
  .then(disconnectAll)
  .catch(async (e) => { console.error(e); await disconnectAll(); process.exit(1); });
