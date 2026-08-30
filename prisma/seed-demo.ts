import { randomBytes } from 'node:crypto';
import { Prisma } from '../src/generated/prisma';
import { buildPlaceholderReport, PLACEHOLDER_REPORT_TYPES, type PlaceholderReportType } from '../src/modules/reports/reports.placeholder';
import { prisma, setOrg, seedOrg, disconnectAll } from './seed-helpers';

// Fake org/study/survey/report fixtures — local dev + QA only. NEVER run
// this against a real client's deployment ("renting a seat"): none of this
// is real reference data, it's throwaway demo content so a fresh local
// database has something to click through immediately. Run `pnpm seed`
// (prisma/seed.ts) first — this assumes the role matrix, consent
// placeholders, and domains already exist.

// Realistic-looking generation criteria per report type, stored in Report.filters
// — same fields a real "generate report" form would collect (region/village/
// date range), not used for any actual query since content is placeholder.
// RPT06/RPT12/RPT13 used to be handled here too, back when they were still
// placeholder types — they've since graduated to real generators (see
// reports.placeholder.ts's PlaceholderReportType exclusion list) and are no
// longer reachable through this function; `studyId` is accordingly unused
// now (it was only ever read for the since-removed RPT13 case).
function buildPlaceholderReportFilters(reportType: PlaceholderReportType): Record<string, unknown> {
  const dateFrom = '2026-01-01';
  const dateTo = '2026-06-30';
  switch (reportType) {
    case 'RPT05':
      return { region: 'North', village: 'Village A', dateFrom, dateTo };
    case 'RPT07':
    case 'RPT11':
      return { dateFrom, dateTo };
    default:
      return { dateFrom, dateTo };
  }
}

async function main(): Promise<void> {
  // Two orgs, each with an NGO Admin — needed to prove entity separation
  // (RIO-NFR-003 / RIO-RBAC-001's "cross-entity access prevented"), plus a
  // Research Officer in the first org — a role with no entityTeam/
  // rolesPermissions access, needed to prove "unauthorized roles blocked".
  // The two registration numbers below are real NIC numbers from
  // `nic_registry` (see prisma/import-nic-registry.ts), not the old
  // REG-DEMO-000n placeholders: signup only accepts a number the registry
  // knows, so demo orgs carrying a shape no registrant could ever submit made
  // the fixtures misleading — and e2e coverage of the duplicate-registration
  // path needs a seeded org whose number can actually be typed into the form.
  //
  // NOTE for existing dev databases: seedOrg is idempotent on
  // registrationNumber, so changing it leaves any previously seeded
  // "Demo NGO"/"Riverside Community Trust" row behind rather than renaming
  // it. Drop those two orgs (or re-create the database) before re-seeding.
  const demoOrgId = await seedOrg({
    registrationNumber: '8000005890',
    name: 'Demo NGO',
    purpose: 'Water, sanitation, and hygiene access for underserved villages.',
    region: ['North'],
    email: 'admin@demo-ngo.org',
    sector: 'Water & Sanitation',
    villages: ['Village A', 'Village B'],
    users: [
      { roleId: 'role_ngo_admin', name: 'Sarah', email: 'admin@demo-ngo.org' },
      { roleId: 'role_ngo_research_officer', name: 'Amira', email: 'officer@demo-ngo.org' },
      { roleId: 'role_human_reviewer', name: 'Priya', email: 'reviewer@demo-ngo.org' },
      // RIO-FR-003 — Data Analyst is the only role holding priorityScoring
      // write/create/approve, so without a seeded one the whole scoring path
      // (run, override, sign off) cannot be exercised on a fresh database.
      { roleId: 'role_data_analyst', name: 'Rashid', email: 'analyst@demo-ngo.org' },
    ],
  });
  const riversideOrgId = await seedOrg({
    registrationNumber: '8000005887',
    name: 'Riverside Community Trust',
    purpose: 'Livelihoods and economic development along the riverside communities.',
    region: ['South'],
    email: 'admin@riverside-ngo.org',
    sector: 'Livelihood',
    villages: ['Riverside Village'],
    users: [{ roleId: 'role_ngo_admin', name: 'Riverside Admin', email: 'admin@riverside-ngo.org' }],
  });

  // RIO-FR-001 demo fixtures: one Study + its Need per demo org, so the
  // frontend isn't blocked waiting on manual data entry. Idempotent by
  // title (Study has no other natural key) — skip creation if it's
  // already there from a prior seed run.
  let demoStudyId: string | undefined;
  let demoNeedId: string | undefined;
  await prisma.$transaction(async (tx) => {
    await setOrg(tx as never, demoOrgId);
    const officer = await tx.user.findUnique({ where: { email: 'officer@demo-ngo.org' } });
    const title = 'Village A water access assessment';
    const existingStudy = await tx.study.findFirst({ where: { title } });
    if (existingStudy) {
      demoStudyId = existingStudy.id;
      const existingNeed = await tx.need.findFirst({ where: { studyId: existingStudy.id } });
      demoNeedId = existingNeed?.id;
    } else if (officer) {
      const study = await tx.study.create({
        data: {
          orgId: demoOrgId,
          title,
          createdBy: officer.id,
          // First Study ever seeded for this demo org.
          cycleNumber: 1,
        },
      });
      const need = await tx.need.create({
        data: {
          studyId: study.id,
          orgId: demoOrgId,
          title: 'Unreliable dry-season water access in Village A',
          statement: 'Households in Village A report unreliable access to safe drinking water during the dry season.',
          village: ['Village A'],
          source: 'manual_entry',
          createdBy: officer.id,
        },
      });
      demoStudyId = study.id;
      demoNeedId = need.id;
    }
  });

  // Demo Survey Links — labelled per the Public Survey module's plan
  // examples, so Manage Survey Links / Study Insights have more than one
  // link to distinguish between locally. Idempotent by (studyId, label),
  // the same uniqueness the DB itself enforces.
  await prisma.$transaction(async (tx) => {
    await setOrg(tx as never, demoOrgId);
    if (!demoStudyId || !demoNeedId) return;
    const officer = await tx.user.findUnique({ where: { email: 'officer@demo-ngo.org' } });
    if (!officer) return;
    for (const label of ['Baseline Survey', 'Village A Outreach']) {
      const existing = await tx.publicSurveyLink.findFirst({ where: { needId: demoNeedId, label } });
      if (existing) continue;
      await tx.publicSurveyLink.create({
        data: {
          orgId: demoOrgId,
          needId: demoNeedId,
          studyId: demoStudyId,
          label,
          token: randomBytes(24).toString('base64url'),
          createdBy: officer.id,
        },
      });
    }
  });

  // RPT-02..13 placeholder reports (RPT-01 excluded — it gets its own table
  // in a future task) so the approve/reject review workflow has something
  // to work against before the real AI report generation engine lands. One
  // DRAFT report per type, idempotent by (orgId, reportType) — re-running
  // the seed doesn't pile up duplicates.
  await prisma.$transaction(async (tx) => {
    await setOrg(tx as never, demoOrgId);
    const officer = await tx.user.findUnique({ where: { email: 'officer@demo-ngo.org' } });
    if (!officer) return;
    for (const reportType of PLACEHOLDER_REPORT_TYPES) {
      const existing = await tx.report.findFirst({ where: { orgId: demoOrgId, reportType } });
      if (existing) continue;
      const { title, content } = buildPlaceholderReport(reportType);
      await tx.report.create({
        data: {
          orgId: demoOrgId,
          reportType,
          status: 'draft',
          title,
          studyId: null,
          filters: buildPlaceholderReportFilters(reportType) as Prisma.InputJsonValue,
          content: content as Prisma.InputJsonValue,
          generatedBy: officer.id,
        },
      });
    }
  });

  console.log(`Seeded Demo NGO: ${demoOrgId} (admin@demo-ngo.org, officer@demo-ngo.org, reviewer@demo-ngo.org, analyst@demo-ngo.org)`);
  console.log(`Seeded Riverside Community Trust: ${riversideOrgId} (admin@riverside-ngo.org)`);
  console.log('These are local dev/QA fixtures only — never run this script against a real client deployment.');
}

main()
  .then(disconnectAll)
  .catch(async (e) => { console.error(e); await disconnectAll(); process.exit(1); });
