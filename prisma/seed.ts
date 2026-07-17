import 'dotenv/config';
import * as argon2 from 'argon2';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient, Sector, UserStatus } from '../src/generated/prisma';
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
function buildPlaceholderReportFilters(reportType: PlaceholderReportType, studyId?: string): Record<string, unknown> {
  const dateFrom = '2026-01-01';
  const dateTo = '2026-06-30';
  switch (reportType) {
    case 'RPT05':
    case 'RPT06':
      return { region: 'North', village: 'Village A', dateFrom, dateTo };
    case 'RPT07':
      return { dateFrom, dateTo };
    case 'RPT11':
      return { dateFrom, dateTo };
    case 'RPT12':
      return {};
    case 'RPT13':
      return { studyId, dateFrom, dateTo };
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
  sector: Sector;
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

  await prisma.consentPolicy.upsert({
    where: { version: 'v1' },
    update: { active: true },
    create: { version: 'v1', active: true, text: 'Buyer-supplied data-use & consent policy — placeholder text seeded until the real copy is provided.' },
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
    sector: Sector.wash,
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
    sector: Sector.livelihoods,
    villages: ['Riverside Village'],
    users: [{ roleId: 'role_ngo_admin', name: 'Riverside Admin', email: 'admin@riverside-ngo.org' }],
  });

  // RIO-FR-001 demo fixtures: one Study + its Need per demo org, so the
  // frontend isn't blocked waiting on manual data entry. Idempotent by
  // title (Study has no other natural key) — skip creation if it's
  // already there from a prior seed run.
  let demoStudyId: string | undefined;
  await prisma.$transaction(async (tx) => {
    await setOrg(tx as never, demoOrgId);
    const officer = await tx.user.findUnique({ where: { email: 'officer@demo-ngo.org' } });
    const reviewer = await tx.user.findUnique({ where: { email: 'reviewer@demo-ngo.org' } });
    const title = 'Village A water access assessment';
    const existingStudy = await tx.study.findFirst({ where: { title } });
    if (existingStudy) {
      demoStudyId = existingStudy.id;
    } else if (officer) {
      const study = await tx.study.create({
        // Assigned to the demo Reviewer/Approver (human_reviewer) — makes
        // Reviewer Alerts show a real name instead of "Unassigned" out of
        // the box, and matches the role Study.assignedReviewerId is
        // validated against.
        data: {
          orgId: demoOrgId,
          title,
          createdBy: officer.id,
          status: 'need_captured',
          assignedReviewerId: reviewer?.id ?? null,
        },
      });
      await tx.need.create({
        data: {
          studyId: study.id,
          orgId: demoOrgId,
          statement: 'Households in Village A report unreliable access to safe drinking water during the dry season.',
          village: ['Village A'],
          source: 'Field interview, June 2026',
          createdBy: officer.id,
        },
      });
      demoStudyId = study.id;
    }
  });

  // Demo Survey Links — labelled per the Public Survey module's plan
  // examples, so Manage Survey Links / Study Insights have more than one
  // link to distinguish between locally. Idempotent by (studyId, label),
  // the same uniqueness the DB itself enforces.
  await prisma.$transaction(async (tx) => {
    await setOrg(tx as never, demoOrgId);
    if (!demoStudyId) return;
    const officer = await tx.user.findUnique({ where: { email: 'officer@demo-ngo.org' } });
    if (!officer) return;
    for (const label of ['Baseline Survey', 'Village A Outreach']) {
      const existing = await tx.publicSurveyLink.findFirst({ where: { studyId: demoStudyId, label } });
      if (existing) continue;
      await tx.publicSurveyLink.create({
        data: {
          orgId: demoOrgId,
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
          studyId: reportType === 'RPT13' ? (demoStudyId ?? null) : null,
          filters: buildPlaceholderReportFilters(reportType, demoStudyId) as Prisma.InputJsonValue,
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

  console.log(`Seeded ${ROLE_MATRIX.length} roles, consent v1, 9 domains from question-bank-v1.json.`);
  console.log(`Seeded Demo NGO: ${demoOrgId} (admin@demo-ngo.org, officer@demo-ngo.org)`);
  console.log(`Seeded Riverside Community Trust: ${riversideOrgId} (admin@riverside-ngo.org)`);
  console.log(`Dev login password for all seeded accounts: ${DEV_PASSWORD}`);
  console.log('Also seeded: sysadmin@platform.local (system_admin, platform-wide)');
}

async function disconnectAll(): Promise<void> {
  await Promise.all([prisma.$disconnect(), supervisor.$disconnect()]);
}

main()
  .then(disconnectAll)
  .catch(async (e) => { console.error(e); await disconnectAll(); process.exit(1); });
