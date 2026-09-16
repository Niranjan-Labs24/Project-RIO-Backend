// How long does an Arabic export actually take? Gated like the other manual
// specs. Times a cold-cache and a warm-cache export of the same report.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { TenantPrismaService } from '../src/tenancy/tenant-prisma.service';
import { ReportsService } from '../src/modules/reports/reports.service';
import { orgContext } from '../src/tenancy/org-context';
import { TranslationService } from '../src/modules/translation/translation.service';
import { translateReportContent } from '../src/modules/reports/i18n/translate-content';
import { sweepRemainingEnglish } from '../src/modules/reports/i18n/sweep-english';
import { loadMasterDataAliases, localizeDataValues } from '../src/modules/reports/i18n/master-data-names';
import { buildReportDoc } from '../src/modules/reports/report-doc';
import { renderReportPdf } from '../src/modules/reports/pdf-builder';

const ENABLED =
  process.env.npm_lifecycle_event === 'time:arabic-export' ||
  process.env.RIO_TIME_EXPORT === '1';

const ARABIC = /[؀-ۿ]/;

describe.skipIf(!ENABLED)('Arabic export timing', () => {
  it(
    'times an Arabic export against an English one',
    async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      const app = moduleRef.createNestApplication();
      await app.init();
      const tenant = app.get(TenantPrismaService);
      const reports = app.get(ReportsService);
      const translation = app.get(TranslationService);

      const t = await tenant.runAsSupervisor(async (tx) => {
        const orgs = await tx.organisation.findMany({ select: { id: true, name: true } });
        const org = orgs.find((o) => ARABIC.test(o.name))!;
        const studies = await tx.study.findMany({ where: { orgId: org.id }, select: { id: true } });
        const scored = await tx.villagePriorityAssessment.groupBy({ by: ['studyId'], _count: true });
        const study = studies.find((s) => scored.some((r) => r.studyId === s.id)) ?? studies[0]!;
        const surveys = await tx.survey.findMany({ where: { studyId: study.id }, select: { id: true } });
        const users = await tx.user.findMany({ where: { orgId: org.id }, select: { id: true } });
        return { orgId: org.id, studyId: study.id, surveyId: surveys[0]?.id, actorId: users[0]!.id };
      });

      await orgContext.run(
        { requestId: 'timing', orgId: t.orgId, actorId: t.actorId, role: 'researcher' },
        async () => {
          const created = await reports.create({
            reportType: 'RPT01',
            studyId: t.studyId,
            surveyId: t.surveyId,
          });
          await reports.confirm(created.id);
          await reports.approve(created.id, 'timing');

          const timings: string[] = [];
          const stored = await reports.getById(created.id);
          const aliases = await tenant.runAsSupervisor((tx) =>
            loadMasterDataAliases(tx as never, 'ar'),
          );

          // Phase breakdown, twice: the second run sees a fully warm cache.
          for (const pass of ['cold', 'warm']) {
            let t0 = Date.now();
            const { content, requested } = await translateReportContent(
              stored.content,
              'ar',
              translation,
            );
            const tContent = Date.now() - t0;

            t0 = Date.now();
            const doc = localizeDataValues(
              buildReportDoc(stored.title, content, [], 'ar'),
              aliases,
            );
            const tBuild = Date.now() - t0;

            t0 = Date.now();
            const swept = await sweepRemainingEnglish(doc, 'ar', {
              aliases,
              translator: translation,
            });
            const tSweep = Date.now() - t0;

            t0 = Date.now();
            renderReportPdf(swept.doc, 'pages', 'ar');
            const tRender = Date.now() - t0;

            timings.push(
              `${pass.padEnd(5)} content ${String(tContent).padStart(6)}ms (${requested} sent) | ` +
                `build ${String(tBuild).padStart(4)}ms | sweep ${String(tSweep).padStart(6)}ms ` +
                `(cache ${swept.stats.byCache} ai ${swept.stats.byTranslator} timedOut ${swept.stats.timedOut}) | ` +
                `render ${String(tRender).padStart(5)}ms`,
            );
          }
          writeFileSync(
            resolve(__dirname, '..', '..', 'arabic-report-exports', 'timing.txt'),
            timings.join('\n'),
            'utf8',
          );
        },
      );

      await app.close();
    },
    30 * 60 * 1000,
  );
});
