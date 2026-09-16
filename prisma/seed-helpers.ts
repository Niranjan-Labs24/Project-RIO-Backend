import 'dotenv/config';
import * as argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, UserStatus } from '../src/generated/prisma';
import { pgSslFromEnv } from '../src/prisma/pg-ssl';

// Shared between prisma/seed.ts (core reference/config data, safe to run
// against any real deployment) and prisma/seed-demo.ts (fake org/study/
// survey/report fixtures, local dev + QA only) — kept in one place so the
// two scripts never drift on how an org/user gets created.

// Dev-only credential seeded on every demo account so login is testable.
export const DEV_PASSWORD = 'Passw0rd!';

// Seed runs as cnap_owner (DATABASE_URL) — reference tables have no RLS; tenant
// tables are FORCE-RLS even for the owner, so tenant inserts set org context.
export const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, ssl: pgSslFromEnv() }) });

// `organisations_isolation` requires id = app.current_org_id for every
// operation — including a plain SELECT — so cnap_owner can't look up
// "does an org with this registration number already exist" without
// already knowing its id first. The supervisor connection has its own
// cross-org read policy (`organisations_supervisor_read USING (true)`,
// same one TenantPrismaService.runAsSupervisor uses at runtime) — reused
// here purely to make re-running this seed idempotent.
export const supervisor = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.SUPERVISOR_DATABASE_URL, ssl: pgSslFromEnv() }) });

export async function setOrg(tx: { $executeRawUnsafe: (s: string) => Promise<number> }, orgId: string) {
  await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', '${orgId}', true)`);
}

/**
 * Idempotent org + user seeding, keyed by the org's `registrationNumber`
 * and each user's `email` (both unique) — re-running the seed (e.g. after
 * a local DB reset) converges back to the same fixtures instead of
 * throwing a duplicate-key error on the second run.
 */
export async function seedOrg(input: {
  registrationNumber: string;
  name: string;
  purpose: string;
  region: string[];
  email: string;
  sector: string;
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
        // `orgId` is in the update branch too, not just create: an existing
        // dev database re-seeded after this file moves a user to a
        // different org (e.g. sysadmin@platform.local off Demo NGO onto its
        // own platform org) needs that move to actually apply, not
        // silently leave the row on its old org forever.
        update: {
          orgId, name: user.name, roleId: user.roleId, status: UserStatus.active,
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

export async function disconnectAll(): Promise<void> {
  await Promise.all([prisma.$disconnect(), supervisor.$disconnect()]);
}
