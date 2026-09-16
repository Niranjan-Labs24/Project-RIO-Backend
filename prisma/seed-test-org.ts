/**
 * One test organisation with a login for every role that has one.
 *
 * Run AFTER `pnpm prisma:seed`, which creates the role matrix, the consent
 * placeholders and the two platform-wide accounts this script deliberately
 * does not duplicate (see PLATFORM_ACCOUNTS below).
 *
 *   pnpm tsx prisma/seed-test-org.ts [orgName] [password]
 *
 * Defaults to "RIO Test Organisation" and a password read from
 * SEED_TEST_PASSWORD, so a real environment never has to put its password in
 * shell history. Falls back to a generated one, printed once, if neither is
 * given — a weak shared default is how a test account becomes a way in.
 *
 * Writes through the OWNER connection with the RLS org context set, the same
 * way seed-helpers.ts does: `users` and `organisations` are FORCE ROW LEVEL
 * SECURITY, so an insert without `app.current_org_id` matches no policy and is
 * refused rather than silently dropped.
 *
 * Idempotent. Re-running updates the password, name and role of each existing
 * user instead of failing on the unique email, so it is safe to run again to
 * rotate the test password.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { UserStatus } from '../src/generated/prisma';
import { prisma, supervisor, setOrg, disconnectAll } from './seed-helpers';

const ORG_NAME = process.argv[2] ?? 'RIO Test Organisation';
const ORG_REGISTRATION = '8000000001'; // 8000000000 is the platform org (seed.ts)

/**
 * citizen_guest is absent on purpose: it has no password login at all. A
 * citizen reaches the public survey through an OTP sent to their phone, which
 * is why LOGIN_ROLE_KEYS in role-matrix.ts excludes it. Seeding a password for
 * it would create an account that cannot be used and implies a login path that
 * does not exist.
 */
const TENANT_ROLES: Array<{ roleId: string; name: string; local: string }> = [
  { roleId: 'role_ngo_admin', name: 'Test NGO Admin', local: 'ngo-admin' },
  { roleId: 'role_ngo_research_officer', name: 'Test Research Officer', local: 'research-officer' },
  { roleId: 'role_field_researcher', name: 'Test Field Researcher', local: 'field-researcher' },
  { roleId: 'role_human_reviewer', name: 'Test Human Reviewer', local: 'human-reviewer' },
  { roleId: 'role_data_analyst', name: 'Test Data Analyst', local: 'data-analyst' },
  { roleId: 'role_read_only_viewer', name: 'Test Read-only Viewer', local: 'read-only-viewer' },
  // crossEntity: sees across organisations, but still needs a home org row.
  { roleId: 'role_center_supervisor', name: 'Test Center Supervisor', local: 'center-supervisor' },
];

/**
 * Created by prisma/seed.ts on the "Platform Administration" org, not here.
 * Both are crossEntity and act platform-wide via X-Act-As-Org, so putting a
 * second copy inside a tenant would be a different account with the same
 * authority — listed only so the printed summary is the whole login set.
 */
const PLATFORM_ACCOUNTS = [
  { role: 'System Admin', email: 'sysadmin@platform.local' },
  { role: 'System Reviewer', email: 'sysreviewer@platform.local' },
];

function resolvePassword(): { password: string; generated: boolean } {
  const given = process.argv[3] ?? process.env.SEED_TEST_PASSWORD;
  if (given && given.length >= 8) return { password: given, generated: false };
  return { password: `Rio-${randomBytes(9).toString('base64url')}!`, generated: true };
}

async function main(): Promise<void> {
  const { password, generated } = resolvePassword();
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  const emailDomain = ORG_NAME.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  // organisations_isolation gates even a plain SELECT on the owner connection,
  // so the existence check goes through the cross-org read-only role.
  const existing = await supervisor.organisation.findUnique({
    where: { registrationNumber: ORG_REGISTRATION },
    select: { id: true },
  });
  const orgId =
    existing?.id ??
    (await prisma.$queryRaw<{ uuidv7: string }[]>`SELECT uuidv7() AS uuidv7`)[0]!.uuidv7;

  await prisma.$transaction(async (tx) => {
    await setOrg(tx as never, orgId);
    await tx.organisation.upsert({
      where: { registrationNumber: ORG_REGISTRATION },
      update: { name: ORG_NAME, isActive: true },
      create: {
        id: orgId,
        registrationNumber: ORG_REGISTRATION,
        name: ORG_NAME,
        purpose: 'Test tenant — one login per role, for manual verification of a deployment.',
        region: [],
        email: `admin@${emailDomain}.test`,
        sector: 'other',
        villages: [],
        isActive: true,
      },
    });

    for (const role of TENANT_ROLES) {
      const email = `${role.local}@${emailDomain}.test`;
      await tx.user.upsert({
        where: { email },
        // Pre-consented: these accounts exist to be logged into immediately.
        // A real admin-invited user has genuinely not consented and must meet
        // the consent gate on first login.
        update: {
          orgId,
          name: role.name,
          roleId: role.roleId,
          status: UserStatus.active,
          passwordHash,
          consentedAt: new Date(),
        },
        create: {
          orgId,
          roleId: role.roleId,
          name: role.name,
          email,
          status: UserStatus.active,
          passwordHash,
          consentedAt: new Date(),
        },
      });
    }
  });

  console.log(`\n${ORG_NAME}  [${ORG_REGISTRATION}]  org=${orgId}\n`);
  console.log('Tenant logins (this org):');
  for (const role of TENANT_ROLES) {
    console.log(`  ${role.name.padEnd(24)} ${role.local}@${emailDomain}.test`);
  }
  console.log('\nPlatform-wide logins (created by `pnpm prisma:seed`):');
  for (const a of PLATFORM_ACCOUNTS) {
    console.log(`  ${a.role.padEnd(24)} ${a.email}`);
  }
  console.log(
    `\nPassword for the ${TENANT_ROLES.length} tenant accounts above: ${password}` +
      (generated ? '  (generated — store it now, it is not recoverable)' : ''),
  );
  console.log(
    'The two platform accounts keep whatever password prisma:seed set for them.\n' +
      'citizen_guest has no password login — citizens reach the survey by phone OTP.\n',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(disconnectAll);
