import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Sector, UserStatus } from '../src/generated/prisma';
import { pgSslFromEnv } from '../src/prisma/pg-ssl';

/**
 * Pilot-volume seed for the RIO-NFR-006 load test. Creates ORGS entities, each
 * with USERS_PER_ORG NGO-Admin accounts, so the read paths exercised by the load
 * test (list/pagination + per-request RLS) operate over realistic row counts.
 *
 * All accounts share one password (hashed once, reused) — fine for load testing.
 * Emails + password are written to load-test/users.csv for Artillery to sample.
 *
 * Runs as cnap_owner (DATABASE_URL). Tenant tables are FORCE-RLS even for the
 * owner, so each org's inserts run inside a transaction that sets app.current_org_id.
 */
const ORGS = 50;
const USERS_PER_ORG = 10;
const LOAD_PASSWORD = 'LoadTest123!';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, ssl: pgSslFromEnv() }),
});

async function setOrg(tx: { $executeRawUnsafe: (s: string) => Promise<number> }, orgId: string): Promise<void> {
  await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', '${orgId}', true)`);
}

async function main(): Promise<void> {
  // role_ngo_admin must already be seeded (pnpm prisma:seed). Fail loudly if not.
  const role = await prisma.role.findUnique({ where: { id: 'role_ngo_admin' } });
  if (!role) throw new Error('role_ngo_admin not found — run `pnpm prisma:seed` first.');

  const passwordHash = await argon2.hash(LOAD_PASSWORD, { type: argon2.argon2id });
  const csv: string[] = ['email,password'];

  for (let o = 0; o < ORGS; o++) {
    const [{ uuidv7: orgId }] = await prisma.$queryRaw<{ uuidv7: string }[]>`SELECT uuidv7() AS uuidv7`;
    await prisma.$transaction(async (tx) => {
      await setOrg(tx as never, orgId);
      await tx.organisation.create({
        data: {
          id: orgId,
          name: `Load Org ${o}`,
          region: 'LoadRegion',
          email: `load-o${o}@load.test`,
          sector: Sector.other,
          villages: ['V1', 'V2', 'V3'],
          isActive: true,
        },
      });
      for (let u = 0; u < USERS_PER_ORG; u++) {
        const email = `load-o${o}-u${u}@load.test`;
        await tx.user.create({
          data: {
            orgId,
            roleId: 'role_ngo_admin',
            name: `Load User ${o}-${u}`,
            email,
            status: UserStatus.active,
            passwordHash,
            consentedAt: new Date(),
          },
        });
        csv.push(`${email},${LOAD_PASSWORD}`);
      }
    });
  }

  const csvPath = join(process.cwd(), 'load-test', 'users.csv');
  writeFileSync(csvPath, csv.join('\n') + '\n', 'utf8');
  console.log(`Seeded ${ORGS} orgs x ${USERS_PER_ORG} users = ${ORGS * USERS_PER_ORG} accounts.`);
  console.log(`Wrote ${csvPath} (${csv.length - 1} login rows), password: ${LOAD_PASSWORD}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
