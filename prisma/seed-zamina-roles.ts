/**
 * Adds one user per role to an existing organisation, for manual testing.
 *
 * Writes through the OWNER connection with the RLS org context set, the same
 * way seed.ts does — `users` is a tenant table with FORCE ROW LEVEL SECURITY,
 * so an insert with no `app.current_org_id` matches no policy and is refused.
 *
 * Passwords are hashed with argon2id through the same call PasswordService
 * uses, so these accounts log in through the normal path with no special
 * casing anywhere.
 *
 * Idempotent: re-running updates the password and role of an existing user
 * rather than failing on the unique email.
 *
 *   pnpm tsx prisma/seed-zamina-roles.ts "Zamina NGO Foundation" "Passw0rds!"
 */
import 'dotenv/config';
import * as argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma';
import { pgSslFromEnv } from '../src/prisma/pg-ssl';

const ORG_NAME = process.argv[2] ?? 'Zamina NGO Foundation';
const PASSWORD = process.argv[3] ?? 'Passw0rds!';

// The four roles a single NGO actually operates with. System Admin and System
// Reviewer are platform-wide and deliberately not created inside a tenant.
const ROLES: Array<{ roleId: string; name: string; local: string }> = [
  { roleId: 'role_ngo_admin', name: 'Zamina Admin', local: 'admin' },
  { roleId: 'role_ngo_research_officer', name: 'Zamina Officer', local: 'officer' },
  { roleId: 'role_human_reviewer', name: 'Zamina Reviewer', local: 'reviewer' },
  { roleId: 'role_data_analyst', name: 'Zamina Analyst', local: 'analyst' },
];

async function main() {
  const owner = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, ssl: pgSslFromEnv() }),
  });
  const supervisor = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.SUPERVISOR_DATABASE_URL, ssl: pgSslFromEnv() }),
  });

  // Read cross-org through the SELECT-only supervisor connection — the owner
  // cannot see organisations without a policy match either.
  const org = await supervisor.organisation.findFirst({
    where: { name: { contains: ORG_NAME, mode: 'insensitive' } },
    select: { id: true, name: true, registrationNumber: true, isActive: true },
  });

  if (!org) {
    const all = await supervisor.organisation.findMany({ select: { name: true } });
    throw new Error(
      `No organisation matching "${ORG_NAME}". Existing: ${all.map((o) => o.name).join(', ')}`,
    );
  }

  const emailDomain = org.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });

  console.log(`\n${org.name}  [${org.registrationNumber}]  active=${org.isActive}`);
  console.log(`  ${org.id}\n`);

  for (const role of ROLES) {
    const email = `${role.local}@${emailDomain}.org`;

    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.current_org_id = '${org.id}'`);

      const existing = await tx.user.findFirst({ where: { email } });
      if (existing) {
        await tx.user.update({
          where: { id: existing.id },
          // mustChangePassword false on purpose: these exist to be logged into
          // immediately, not to rehearse the first-login password change.
          data: { passwordHash, roleId: role.roleId, status: 'active', mustChangePassword: false },
        });
        console.log(`  updated  ${email.padEnd(38)} ${role.roleId}`);
        return;
      }

      await tx.user.create({
        data: {
          orgId: org.id,
          roleId: role.roleId,
          name: role.name,
          email,
          passwordHash,
          status: 'active',
          mustChangePassword: false,
          // Stamped so the consent screen does not block the first login. The
          // real consent flow is exercised by the signup path, not here.
          consentedAt: new Date(),
          consentedPolicyVersion: 'v1',
        },
      });
      console.log(`  created  ${email.padEnd(38)} ${role.roleId}`);
    });
  }

  console.log(`\n  password for all four: ${PASSWORD}\n`);

  await owner.$disconnect();
  await supervisor.$disconnect();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
