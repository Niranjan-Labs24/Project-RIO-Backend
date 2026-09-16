/**
 * One-off: recompute every VillagePriorityAssessment from the existing
 * ScoreRollups after the v5 nine-domain DomainPriorityConfig import.
 *
 * Rollups are NOT touched — only the domain weights changed, so this just
 * re-runs PriorityV2Service.recalculateAll for every already-scored survey.
 * Constructs the service by hand (tsx does not emit the decorator metadata
 * Nest DI needs, so NestFactory can't be used from a script).
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma';
import { pgSslFromEnv } from '../src/prisma/pg-ssl';
import { PriorityV2Service } from '../src/modules/priority/priority-v2.service';
import type { TenantPrismaService } from '../src/tenancy/tenant-prisma.service';
import { orgContext, requireOrgId } from '../src/tenancy/org-context';

const ssl = pgSslFromEnv();
const appClient = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.APP_DATABASE_URL, ssl }),
});
const supClient = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.SUPERVISOR_DATABASE_URL, ssl }),
});

// Mirrors TenantPrismaService exactly (same set_config + transaction shape).
const runAsOrg = (orgId: string, fn: (tx: any) => Promise<any>) =>
  appClient.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
    return fn(tx);
  });

const tenant = {
  runInOrgContext: (fn: (tx: any) => Promise<any>) => runAsOrg(requireOrgId(), fn),
  runAsOrg,
  runAsSupervisor: (fn: (tx: any) => Promise<any>) => supClient.$transaction(fn),
  runAsSupervisorWrite: (fn: (tx: any) => Promise<any>) => appClient.$transaction(fn),
} as unknown as TenantPrismaService;

const svc = new PriorityV2Service(tenant);

async function main() {
  const triples = await supClient.scoreRollup.findMany({
    where: { rollupLevel: 'DOMAIN' },
    select: { orgId: true, studyId: true, surveyId: true },
    distinct: ['orgId', 'studyId', 'surveyId'],
  });

  console.log(`Scored surveys to recalculate: ${triples.length}\n`);
  for (const t of triples) {
    await orgContext.run({ requestId: randomUUID(), orgId: t.orgId }, () =>
      svc.recalculateAll(t.studyId, t.surveyId),
    );
    console.log(`  ok  org=${t.orgId.slice(0, 8)} study=${t.studyId.slice(0, 8)} survey=${t.surveyId.slice(0, 8)}`);
  }

  await appClient.$disconnect();
  await supClient.$disconnect();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
