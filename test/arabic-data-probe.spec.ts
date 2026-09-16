// Throwaway discovery: which organisation actually holds Arabic-authored data,
// and which of its studies can produce reports. Gated like the export spec so
// it never runs in the ordinary suite. Writes JSON rather than logging, because
// vitest swallows stdout from inside a test.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { TenantPrismaService } from '../src/tenancy/tenant-prisma.service';
import { AppModule } from '../src/app.module';

const ENABLED =
  process.env.npm_lifecycle_event === 'probe:arabic-data' ||
  process.env.RIO_ARABIC_PROBE === '1';

const OUT = resolve(__dirname, '..', '..', 'arabic-report-exports');
const ARABIC = /[؀-ۿ]/;

describe.skipIf(!ENABLED)('Arabic data probe', () => {
  it(
    'lists organisations, users and studies with Arabic content',
    async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      const app = moduleRef.createNestApplication();
      await app.init();
      const tenant = app.get(TenantPrismaService);

      const report: Record<string, unknown> = {};

      await tenant.runAsSupervisor(async (tx) => {
        const orgs = await tx.organisation.findMany({ select: { id: true, name: true } });
        report.organisations = orgs.map((o) => ({
          id: o.id,
          name: o.name,
          arabic: ARABIC.test(o.name),
        }));

        const studies = await tx.study.findMany({
          select: { id: true, title: true, orgId: true, cycleNumber: true },
          orderBy: { createdAt: 'desc' },
          take: 60,
        });
        report.studies = studies.map((s) => ({
          id: s.id,
          title: s.title,
          arabic: ARABIC.test(s.title),
          org: orgs.find((o) => o.id === s.orgId)?.name ?? '?',
        }));

        const users = await tx.user.findMany({ select: { email: true, orgId: true } });
        report.usersByOrg = orgs
          .map((o) => ({
            org: o.name,
            users: users.filter((u) => u.orgId === o.id).map((u) => u.email),
          }))
          .filter((x) => x.users.length > 0);

        // Which studies actually have scoring behind them — the thing that
        // decides whether a report can be generated at all.
        const rollups = await tx.villagePriorityAssessment.groupBy({
          by: ['studyId'],
          _count: true,
        });
        report.scoredStudies = rollups.map((r) => ({
          studyId: r.studyId,
          assessments: r._count,
          title: studies.find((x) => x.id === r.studyId)?.title ?? '(older than the list above)',
        }));

        const needs = await tx.need.findMany({
          select: { village: true, studyId: true, statement: true },
          take: 400,
        });
        report.villages = [...new Set(needs.flatMap((n) => n.village ?? []))].filter(Boolean).slice(0, 40);
        report.arabicNeedStatements = needs.filter((n) => n.statement && ARABIC.test(n.statement)).length;
        report.totalNeeds = needs.length;

        // Where does English prose actually live in a stored report's content?
        // Walk the JSON and record the PATH of every English string, so the
        // declared translation paths can be extended to the right places
        // instead of guessed at.
        const stored = await tx.report.findMany({
          where: { reportType: { in: ['RPT01'] } },
          select: { reportType: true, content: true },
          orderBy: { generatedAt: 'desc' },
          take: 1,
        });
        const paths: Record<string, string[]> = {};
        const walk = (node: unknown, path: string, into: string[]): void => {
          if (typeof node === 'string') {
            if (/[A-Za-z]{4,}/.test(node) && !ARABIC.test(node)) into.push(path + '  ::  ' + node.slice(0, 70));
            return;
          }
          if (Array.isArray(node)) { node.forEach((v) => walk(v, path + '[]', into)); return; }
          if (node && typeof node === 'object') {
            for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, path ? path + '.' + k : k, into);
          }
        };
        for (const r of stored) {
          const into: string[] = [];
          walk(r.content, '', into);
          paths[r.reportType] = [...new Set(into)];
        }
        report.englishPaths = paths;
      });

      mkdirSync(OUT, { recursive: true });
      writeFileSync(resolve(OUT, 'db-probe.json'), JSON.stringify(report, null, 2), 'utf8');
      await app.close();
    },
    5 * 60 * 1000,
  );
});
