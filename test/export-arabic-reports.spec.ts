// RIO-NFR-007 — generate every priority report from REAL, ARABIC-AUTHORED data,
// export it as an Arabic PDF, and audit what English is left.
//
// Run:  pnpm export:arabic-reports
//
// ## Which data
//
// It targets the organisation whose own content is Arabic — currently
// مؤسسة زمينة للتنمية, with the study تقييم خدمات الرعاية الصحية الأولية and the
// village قرية العمارية — discovered at runtime rather than hardcoded, so the
// run follows the data instead of the other way round. That matters: the demo
// seed is English throughout, so exporting it in Arabic measures the
// localisation layer against content that was never Arabic to begin with. Real
// Arabic input is the honest test.
//
// ## Why it calls the service instead of HTTP
//
// The Arabic organisation's users were created through the UI, so their
// passwords are not the seed's. Rather than invent credentials, this establishes
// the org context directly and calls ReportsService — the same code path the
// controller reaches after its guards. Generation, translation, master-data
// resolution and rendering are all exercised; only the HTTP auth layer is
// skipped, and that is not what this is testing.
//
// ## Why it is a spec and not a script
//
// The Nest container cannot boot under tsx: esbuild does not emit the
// `design:paramtypes` metadata Nest's constructor injection reads (the same
// reason scripts/fr002-verify-write.ts builds its services by hand). Vitest
// compiles through unplugin-swc, which does. It is gated on the npm lifecycle
// event so `pnpm test` never spends AI budget on it.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { TranslationService } from '../src/modules/translation/translation.service';
import { TenantPrismaService } from '../src/tenancy/tenant-prisma.service';
import { ReportsService } from '../src/modules/reports/reports.service';
import { orgContext } from '../src/tenancy/org-context';
import { buildReportDoc, type DocSection } from '../src/modules/reports/report-doc';
import { translateReportContent } from '../src/modules/reports/i18n/translate-content';
import {
  loadMasterDataAliases,
  localizeDataValues,
} from '../src/modules/reports/i18n/master-data-names';
import { sweepRemainingEnglish } from '../src/modules/reports/i18n/sweep-english';
import type { CreateReportPayload } from '../src/modules/reports/reports.types';

const OUT = resolve(__dirname, '..', '..', 'arabic-report-exports');

const ENABLED =
  process.env.npm_lifecycle_event === 'export:arabic-reports' ||
  process.env.RIO_ARABIC_EXPORT === '1';

const ARABIC = /[؀-ۿ]/;
/** Four or more Latin letters is a real word, not a code or a unit. */
const ENGLISH_WORDS = /[A-Za-z]{4,}/;

interface Spec {
  code: string;
  label: string;
  needsSurvey?: boolean;
  body: (ids: { studyId: string; surveyId?: string; village?: string }) => CreateReportPayload;
}

const SPECS: Spec[] = [
  { code: 'RPT01', label: 'Individual Survey', needsSurvey: true, body: ({ studyId, surveyId, village }) => ({ reportType: 'RPT01', studyId, surveyId, filters: village ? { villageId: village } : {} }) },
  { code: 'RPT13', label: 'Executive Summary', body: ({ studyId }) => ({ reportType: 'RPT13', studyId }) },
  { code: 'RPT16', label: 'Combined Evidence & Score', body: ({ studyId }) => ({ reportType: 'RPT16', studyId }) },
  { code: 'RPT17', label: 'Evidence Document-Based', body: ({ studyId }) => ({ reportType: 'RPT17', studyId }) },
  { code: 'RPT14', label: 'Village', body: ({ studyId, village }) => ({ reportType: 'RPT14', studyId, filters: { villageId: village ?? '' } }) },
  { code: 'RPT04', label: 'Domain-wise Needs', body: ({ studyId }) => ({ reportType: 'RPT04', studyId }) },
  { code: 'RPT06', label: 'Region / Governorate', body: ({ studyId }) => ({ reportType: 'RPT06', studyId }) },
  { code: 'RPT03', label: 'Top-Priority', body: ({ studyId }) => ({ reportType: 'RPT03', studyId }) },
  { code: 'RPT09', label: 'Priority Ranking', body: ({ studyId }) => ({ reportType: 'RPT09', studyId }) },
  { code: 'RPT10', label: 'Data-Quality', body: ({ studyId }) => ({ reportType: 'RPT10', studyId }) },
];

/** Every string the document prints, tagged by where it sits. */
function slots(s: DocSection): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [];
  const add = (where: string, v?: string) => {
    if (typeof v === 'string' && v.trim()) out.push({ where, text: v });
  };
  if ('heading' in s) add('heading', s.heading);
  switch (s.kind) {
    case 'keyvalue':
      s.rows.forEach((r) => { add('kv.label', r.label); add('kv.value', r.value); });
      break;
    case 'table':
      s.columns.forEach((c) => add('column', c));
      s.rows.forEach((row) => row.forEach((c) => add('cell', c)));
      break;
    case 'list': s.items.forEach((i) => add('list', i)); break;
    case 'note': add('note', s.text); break;
    case 'stats':
      s.tiles.forEach((t) => { add('tile.label', t.label); add('tile.value', t.value); add('tile.sub', t.sub); });
      break;
    case 'bars': s.bars.forEach((b) => add('bar', b.label)); break;
    case 'pie': s.slices.forEach((x) => add('slice', x.label)); break;
    case 'radar':
      s.axes.forEach((a) => add('radar.axis', a));
      s.series.forEach((x) => add('radar.series', x.name));
      break;
    case 'groupedBars':
      s.groups.forEach((g) => add('group', g));
      s.series.forEach((x) => add('series', x.name));
      break;
    case 'gauge': add('gauge.sub', s.sub); break;
    case 'navGrid': s.tiles.forEach((t) => { add('tile.label', t.label); add('tile.sub', t.sub); }); break;
    case 'breadcrumb': s.trail.forEach((t) => add('breadcrumb', t.label)); break;
    case 'columns': s.children.forEach((c) => out.push(...slots(c))); break;
    default: break;
  }
  return out;
}

describe.skipIf(!ENABLED)('Arabic report exports (manual, spends AI budget)', () => {
  it(
    'exports every priority report from Arabic-authored data and audits the result',
    async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      const app = moduleRef.createNestApplication();
      await app.init();

      const tenant = app.get(TenantPrismaService);
      const translation = app.get(TranslationService);
      const reports = app.get(ReportsService);

      // Find the Arabic-authored organisation and its scored study.
      const target = await tenant.runAsSupervisor(async (tx) => {
        const orgs = await tx.organisation.findMany({ select: { id: true, name: true } });
        const org = orgs.find((o) => ARABIC.test(o.name));
        if (!org) throw new Error('No organisation with an Arabic name in this database.');

        const studies = await tx.study.findMany({
          where: { orgId: org.id },
          select: { id: true, title: true },
        });
        const scored = await tx.villagePriorityAssessment.groupBy({ by: ['studyId'], _count: true });
        const study =
          studies.find((s) => scored.some((r) => r.studyId === s.id)) ?? studies[0];
        if (!study) throw new Error(`Organisation "${org.name}" has no studies.`);

        const surveys = await tx.survey.findMany({
          where: { studyId: study.id },
          select: { id: true, title: true, status: true },
        });
        const needs = await tx.need.findMany({
          where: { studyId: study.id },
          select: { village: true },
        });
        const villages = [...new Set(needs.flatMap((n) => n.village ?? []))].filter(Boolean);

        const users = await tx.user.findMany({
          where: { orgId: org.id },
          select: { id: true, email: true },
        });

        return {
          orgId: org.id,
          orgName: org.name,
          studyId: study.id,
          studyTitle: study.title,
          surveyId: surveys[0]?.id,
          village: villages[0],
          actorId: users[0]?.id,
        };
      });

      if (!target.actorId) throw new Error(`No user in "${target.orgName}" to act as.`);

      mkdirSync(OUT, { recursive: true });
      const aliases = await tenant.runAsSupervisor((tx) => loadMasterDataAliases(tx as never, 'ar'));

      const summary: Array<Record<string, unknown>> = [];

      // One org context for the whole run — the same store the auth middleware
      // would have populated for a request from a member of this organisation.
      await orgContext.run(
        {
          requestId: 'arabic-export',
          orgId: target.orgId,
          actorId: target.actorId,
          role: 'researcher',
        },
        async () => {
          for (const spec of SPECS) {
            if (spec.needsSurvey && !target.surveyId) {
              summary.push({ report: spec.code, status: 'skipped', error: 'study has no survey' });
              continue;
            }
            try {
              const created = await reports.create(
                spec.body({ studyId: target.studyId, surveyId: target.surveyId, village: target.village }),
              );
              await reports.confirm(created.id);
              await reports.approve(created.id, 'Arabic export verification.');

              const pdf = await reports.export(created.id, 'pdf', 'ar');
              const file = resolve(OUT, `${spec.code}-${spec.label.replace(/[^\w]+/g, '-')}-ar.pdf`);
              writeFileSync(file, pdf.body);

              // Audit by re-running the same three passes the export just ran —
              // a PDF's bytes cannot be inspected for leftover English.
              const stored = await reports.getById(created.id);
              const { content, requested, failed } = await translateReportContent(
                stored.content,
                'ar',
                translation,
              );
              // Same four passes the export just ran, in the same order —
              // including the final sweep. Measuring only the first three
              // reports the pre-sweep state, which is not what is in the PDF.
              const swept = await sweepRemainingEnglish(
                localizeDataValues(buildReportDoc(stored.title, content, [], 'ar'), aliases),
                'ar',
                { aliases, translator: translation },
              );
              const doc = swept.doc;

              const all = [
                { where: 'title', text: doc.title },
                ...doc.headerBand.flatMap((r) => [
                  { where: 'header.label', text: r.label },
                  { where: 'header.value', text: r.value },
                ]),
                ...doc.sections.flatMap(slots),
                ...(doc.chapters ?? []).flatMap((c) => [
                  { where: 'chapter.name', text: c.name },
                  { where: 'chapter.summary', text: c.summary },
                ]),
              ];
              const english = all.filter((x) => ENGLISH_WORDS.test(x.text) && !ARABIC.test(x.text));

              summary.push({
                report: spec.code,
                arabicPct: all.length ? Math.round(((all.length - english.length) / all.length) * 100) : 100,
                englishSlots: english.length,
                totalSlots: all.length,
                aiTranslated: requested - failed,
                aiFallback: failed,
                sweep: {
                  catalogue: swept.stats.byCatalogue,
                  masterData: swept.stats.byMasterData,
                  translated: swept.stats.byTranslator,
                  keptAsIs: swept.stats.keptAsIs,
                  rejectedForDigits: swept.stats.rejectedForDigits.length,
                  unresolved: swept.stats.unresolved.length,
                },
                sizeKb: pdf.body.length >> 10,
                remaining: [...new Set(english.map((e) => `${e.where}: ${e.text.slice(0, 70)}`))].slice(0, 20),
              });
            } catch (err) {
              summary.push({
                report: spec.code,
                status: 'failed',
                error: (err as Error).message.slice(0, 200),
              });
            }
          }
        },
      );

      writeFileSync(
        resolve(OUT, 'audit.json'),
        JSON.stringify({ source: target, reports: summary }, null, 2),
        'utf8',
      );
      await app.close();
    },
    30 * 60 * 1000,
  );
});
