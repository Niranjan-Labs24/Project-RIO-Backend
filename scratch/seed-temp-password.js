require('dotenv/config');
const argon2 = require('argon2');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('../src/generated/prisma');
const adapter = new PrismaPg({ connectionString: process.env.APP_DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const userId = process.argv[2];
const orgId = process.argv[3];
const plainPassword = process.argv[4];

(async () => {
  const hash = await argon2.hash(plainPassword, { type: argon2.argon2id });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
    await tx.user.update({ where: { id: userId }, data: { passwordHash: hash } });
  });
  console.log('password hash set for', userId);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
