import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Sector, UserStatus } from '../src/generated/prisma';
import { ROLE_MATRIX } from '../src/rbac/role-matrix';

// Seed runs as cnap_owner (DATABASE_URL) — reference tables have no RLS; tenant
// tables are FORCE-RLS even for the owner, so tenant inserts set org context.
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

async function setOrg(tx: { $executeRawUnsafe: (s: string) => Promise<number> }, orgId: string) {
  await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', '${orgId}', true)`);
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

  const rows = await prisma.$queryRaw<{ uuidv7: string }[]>`SELECT uuidv7() AS uuidv7`;
  const orgId = rows[0]!.uuidv7;
  await prisma.$transaction(async (tx) => {
    await setOrg(tx as never, orgId);
    await tx.organisation.create({
      data: { id: orgId, name: 'Demo NGO', region: 'North', email: 'admin@demo-ngo.org', sector: Sector.wash, villages: ['Village A', 'Village B'], isActive: true },
    });
    await tx.user.create({ data: { orgId, roleId: 'role_ngo_admin', name: 'Demo Admin', email: 'admin@demo-ngo.org', status: UserStatus.active } });
    await tx.user.create({ data: { orgId, roleId: 'role_system_admin', name: 'System Admin', email: 'sysadmin@platform.local', status: UserStatus.active } });
  });
  console.log(`Seeded ${ROLE_MATRIX.length} roles, consent v1, org Demo NGO: ${orgId} (+ NGO Admin, System Admin)`);
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
