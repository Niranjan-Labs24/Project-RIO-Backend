import 'dotenv/config';
import * as argon2 from 'argon2';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient, UserStatus } from '../src/generated/prisma';
import { ROLE_MATRIX } from '../src/rbac/role-matrix';
import { pgSslFromEnv } from '../src/prisma/pg-ssl';
import { buildPlaceholderReport, PLACEHOLDER_REPORT_TYPES, type PlaceholderReportType } from '../src/modules/reports/reports.placeholder';

// The "OPEN"/General entry in question-bank-v1.json's hierarchy is a
// pseudo-domain for open-ended questions, not a real methodology Domain —
// _meta.counts.domains is 9, not 10, so it's excluded from this seed.
const QUESTION_BANK_EXCLUDED_DOMAIN_CODE = 'OPEN';

interface QuestionBankHierarchyEntry {
  code: string;
  name: string;
  subDomains: Array<{ code: string; name: string }>;
}

// Dev-only credential seeded on every demo account so login is testable.
const DEV_PASSWORD = 'Passw0rd!';

// RIO-DATA-001 — the copy of the two consents a registrant accepts. Kept here
// (and mirrored by the migration that backfills deployed environments) so the
// policy table is the single source of truth: the signup screen, the
// post-login re-prompt, and every immutable ConsentAcceptance snapshot all
// read this same text rather than carrying their own copy in the UI bundle.
const USE_POLICY_TEXT = `Terms of Use

Welcome to this RIO application. By accessing or using this platform, you agree to the following terms:

This application is provided solely for demonstration, testing, and evaluation purposes.
Any information entered into the application should be fictitious or non-sensitive unless explicitly authorized.
Users are responsible for ensuring that any content they submit complies with applicable laws and organizational policies.
Unauthorized access, misuse, or attempts to disrupt the application are prohibited.
The application owner may modify, suspend, or discontinue any feature without prior notice.
Features, workflows, and reports displayed in this demo may not represent the final production version.
Continued use of the application indicates your acceptance of these terms.`;

const DATA_SHARING_TEXT = `Data Sharing Policy

We value your privacy and are committed to handling your information responsibly.

Information entered into this Rio application is used only for demonstration, testing, and evaluation purposes.
We do not sell or share your information with third parties for marketing purposes.
Data may be accessed by authorized administrators or support personnel solely to maintain and improve the application.
Aggregated and anonymized information may be used to evaluate system performance and enhance user experience.
Users should avoid entering confidential, personal, financial, or regulated information into this demonstration environment.
Appropriate security measures are implemented to help protect data; however, no electronic system can guarantee absolute security.
By using this application, you acknowledge and consent to the collection and processing of information as described in this policy.`;

// Seed runs as cnap_owner (DATABASE_URL) — reference tables have no RLS; tenant
// tables are FORCE-RLS even for the owner, so tenant inserts set org context.
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, ssl: pgSslFromEnv() }) });

// `organisations_isolation` requires id = app.current_org_id for every
// operation — including a plain SELECT — so cnap_owner can't look up
// "does an org with this registration number already exist" without
// already knowing its id first. The supervisor connection has its own
// cross-org read policy (`organisations_supervisor_read USING (true)`,
// same one TenantPrismaService.runAsSupervisor uses at runtime) — reused
// here purely to make re-running this seed idempotent.
const supervisor = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.SUPERVISOR_DATABASE_URL, ssl: pgSslFromEnv() }) });

async function setOrg(tx: { $executeRawUnsafe: (s: string) => Promise<number> }, orgId: string) {
  await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', '${orgId}', true)`);
}

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

/**
 * Idempotent org + user seeding, keyed by the org's `registrationNumber`
 * and each user's `email` (both unique) — re-running the seed (e.g. after
 * a local DB reset) converges back to the same fixtures instead of
 * throwing a duplicate-key error on the second run.
 */
async function seedOrg(input: {
  registrationNumber: string;
  name: string;
  purpose: string;
  region: string[];
  email: string;
  sector: string;
  villages: string[];
  users: Array<{ roleId: string; name: string; email: string }>;
}): Promise<string> {
  const passwordHash = await argon2.hash(DEV_PASSWORD, { type: argon2.argon2id });
  const existing = await supervisor.organisation.findUnique({
    where: { registrationNumber: input.registrationNumber },
  });
  const orgId = existing?.id ?? (await prisma.$queryRaw<{ uuidv7: string }[]>`SELECT uuidv7() AS uuidv7`)[0]!.uuidv7;

  await prisma.$transaction(async (tx) => {
    await setOrg(tx as never, orgId);
    await tx.organisation.upsert({
      where: { registrationNumber: input.registrationNumber },
      update: {
        name: input.name, purpose: input.purpose, region: input.region, email: input.email,
        sector: input.sector, villages: input.villages, isActive: true,
      },
      create: {
        id: orgId, registrationNumber: input.registrationNumber, name: input.name,
        purpose: input.purpose, region: input.region, email: input.email, sector: input.sector,
        villages: input.villages, isActive: true,
      },
    });
    for (const user of input.users) {
      // Seeded demo accounts start pre-consented — they're meant to be
      // immediately usable for local testing/demos, unlike a real
      // admin-invited user, who genuinely hasn't consented yet and must
      // hit the consent gate on their first login.
      await tx.user.upsert({
        where: { email: user.email },
        update: {
          name: user.name, roleId: user.roleId, status: UserStatus.active,
          passwordHash, consentedAt: new Date(),
        },
        create: {
          orgId, roleId: user.roleId, name: user.name, email: user.email,
          status: UserStatus.active, passwordHash, consentedAt: new Date(),
        },
      });
    }
  });

  return orgId;
}

/**
 * Domain/Sub-Domain Master Module seed: sourced only from
 * question-bank-v1.json's Domain/Sub-Domain hierarchy (never its
 * Indicators/KPIs/Questions — those are out of scope per the Question Bank
 * Baseline rule). Global reference table, no org context needed. Idempotent
 * upsert keyed by each row's unique `code`; `displayOrder` follows the
 * dataset's own array order.
 */
async function seedDomainsAndSubdomains(): Promise<void> {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'question-bank-v1.json'), 'utf-8');
  const bank = JSON.parse(raw) as { hierarchy: QuestionBankHierarchyEntry[] };
  const domains = bank.hierarchy.filter((d) => d.code !== QUESTION_BANK_EXCLUDED_DOMAIN_CODE);

  for (const [domainIndex, domain] of domains.entries()) {
    const domainRow = await prisma.domain.upsert({
      where: { code: domain.code },
      update: { name: domain.name, displayOrder: domainIndex },
      create: { code: domain.code, name: domain.name, displayOrder: domainIndex },
    });
    for (const [subIndex, sub] of domain.subDomains.entries()) {
      await prisma.subDomain.upsert({
        where: { code: sub.code },
        update: { name: sub.name, displayOrder: subIndex, domainId: domainRow.id },
        create: { code: sub.code, name: sub.name, displayOrder: subIndex, domainId: domainRow.id },
      });
    }
  }
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

  // RIO-DATA-001 — two separately-versioned consents, both active. Signup
  // validates the submitted version against the active policy of each kind,
  // so BOTH must exist or every registration fails its consent check.
  //
  // `text` is in `update` as well as `create`: re-seeding an existing
  // environment has to pick up revised copy, otherwise the first seed run
  // would pin the wording forever. Acceptance rows are unaffected either way
  // — each snapshots the text it was accepted under (ConsentAcceptance
  // .policyText), so already-recorded consents keep the wording their user
  // actually saw.
  await prisma.consentPolicy.upsert({
    where: { kind_version: { kind: 'use_policy', version: 'v1' } },
    update: { active: true, text: USE_POLICY_TEXT },
    create: { kind: 'use_policy', version: 'v1', active: true, text: USE_POLICY_TEXT },
  });
  await prisma.consentPolicy.upsert({
    where: { kind_version: { kind: 'data_sharing', version: 'v1' } },
    update: { active: true, text: DATA_SHARING_TEXT },
    create: { kind: 'data_sharing', version: 'v1', active: true, text: DATA_SHARING_TEXT },
  });

  await seedDomainsAndSubdomains();

  // Two orgs, each with an NGO Admin — needed to prove entity separation
  // (RIO-NFR-003 / RIO-RBAC-001's "cross-entity access prevented"), plus a
  // Research Officer in the first org — a role with no entityTeam/
  // rolesPermissions access, needed to prove "unauthorized roles blocked".
  const demoOrgId = await seedOrg({
    registrationNumber: 'REG-DEMO-0001',
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
    ],
  });
  const riversideOrgId = await seedOrg({
    registrationNumber: 'REG-DEMO-0002',
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

  // Platform-wide System Admin — not scoped to either org above.
  const passwordHash = await argon2.hash(DEV_PASSWORD, { type: argon2.argon2id });
  await prisma.$transaction(async (tx) => {
    await setOrg(tx as never, demoOrgId);
    await tx.user.upsert({
      where: { email: 'sysadmin@platform.local' },
      update: {
        name: 'System Admin', roleId: 'role_system_admin', status: UserStatus.active,
        passwordHash, consentedAt: new Date(),
      },
      create: {
        orgId: demoOrgId, roleId: 'role_system_admin', name: 'System Admin',
        email: 'sysadmin@platform.local', status: UserStatus.active, passwordHash,
        consentedAt: new Date(),
      },
    });
  });

  // Platform-wide System Reviewer — the NCNP Compiled Report's approve/
  // reject counterpart to System Admin above, same "not scoped to either
  // org" shape.
  await prisma.$transaction(async (tx) => {
    await setOrg(tx as never, demoOrgId);
    await tx.user.upsert({
      where: { email: 'sysreviewer@platform.local' },
      update: {
        name: 'System Reviewer', roleId: 'role_system_reviewer', status: UserStatus.active,
        passwordHash, consentedAt: new Date(),
      },
      create: {
        orgId: demoOrgId, roleId: 'role_system_reviewer', name: 'System Reviewer',
        email: 'sysreviewer@platform.local', status: UserStatus.active, passwordHash,
        consentedAt: new Date(),
      },
    });
  });

  console.log(`Seeded ${ROLE_MATRIX.length} roles, consent v1, 9 domains from question-bank-v1.json.`);
  console.log(`Seeded Demo NGO: ${demoOrgId} (admin@demo-ngo.org, officer@demo-ngo.org)`);
  console.log(`Seeded Riverside Community Trust: ${riversideOrgId} (admin@riverside-ngo.org)`);
  console.log(`Dev login password for all seeded accounts: ${DEV_PASSWORD}`);
  console.log('Also seeded: sysadmin@platform.local (system_admin, platform-wide)');
  console.log('Also seeded: sysreviewer@platform.local (system_reviewer, platform-wide)');
}

async function disconnectAll(): Promise<void> {
  await Promise.all([prisma.$disconnect(), supervisor.$disconnect()]);
}

main()
  .then(disconnectAll)
  .catch(async (e) => { console.error(e); await disconnectAll(); process.exit(1); });
