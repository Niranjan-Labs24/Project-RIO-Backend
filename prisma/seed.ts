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

// RIO-DATA-001 + client-confirmed (2026-08-27) — consent wording is NOT
// defined here any more.
//
// The client's answer was "dynamically managed and versioned consent policies
// in V2, not hard-coded", with a System Reviewer signing each version off
// before it reaches signup. Real policy text sitting in this file broke that
// twice over: it was authored by whoever edited the repo rather than by the
// System Admin, and — because the old upserts passed `text` in `update:` as
// well as `create:` — every `prisma:seed` run silently overwrote whatever had
// been published through Methodology Configuration → Consent Policies, and
// reset which version was active. A reviewer-approved policy could be
// reverted by a routine reseed, with nothing in the audit log to show it.
//
// What remains below is a placeholder, not a policy: enough for an empty
// database to have *something* active (signup 404s outright without one, so a
// fresh dev/CI environment could not register anyone at all), and worded so
// nobody could mistake it for real terms. It is written once, only when a
// kind has no rows whatsoever — see bootstrapConsentPolicies(). Existing
// environments, including every deployed one, keep exactly the text they
// already have, and from here on the only way any of it changes is through
// the Consent Policies tab.
const CONSENT_BOOTSTRAP = {
  use_policy: {
    version: 'v0-placeholder',
    heading: 'Terms of Use',
    headingAr: 'شروط الاستخدام',
  },
  data_sharing: {
    version: 'v0-placeholder',
    heading: 'Data Sharing Policy',
    headingAr: 'سياسة مشاركة البيانات',
  },
  // RIO-NFR-002 — the citizen survey notice. In practice this branch never
  // fires: the 20260828010001 migration inserts the real notice (lifted out
  // of the frontend's message catalogues) on every database, fresh ones
  // included. It exists so a kind can never be silently missing — a citizen
  // policy that does not exist blocks every public survey submission.
  citizen_consent: {
    version: 'v0-placeholder',
    heading: 'Citizen Consent',
    headingAr: 'موافقة المواطن',
  },
} as const;

function bootstrapText(heading: string): string {
  return `${heading} — not yet published.

No ${heading} has been published on this platform yet. A System Admin drafts one under Settings → Methodology Configuration → Consent Policies, a System Reviewer approves it, and the System Admin then publishes it. Until that happens, this placeholder is what the signup screen shows.

This placeholder is not a legal agreement and confers no rights or obligations on anyone.`;
}

function bootstrapTextAr(headingAr: string): string {
  return `${headingAr} — لم تُنشر بعد.

لم يتم نشر «${headingAr}» على هذه المنصة بعد. يقوم مسؤول النظام بصياغتها ضمن الإعدادات ← إعدادات المنهجية ← سياسات الموافقة، ويعتمدها مراجع النظام، ثم ينشرها مسؤول النظام. وإلى أن يحدث ذلك، يعرض هذا النص المؤقت في شاشة التسجيل.

هذا النص المؤقت ليس اتفاقية قانونية ولا يترتب عليه أي حقوق أو التزامات.`;
}

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
        // `orgId` is in the update branch too, not just create: an existing
        // dev database re-seeded after this file moves a user to a
        // different org (e.g. sysadmin@platform.local off Demo NGO onto its
        // own platform org, below) needs that move to actually apply, not
        // silently leave the row on its old org forever.
        update: {
          orgId, name: user.name, roleId: user.roleId, status: UserStatus.active,
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
/**
 * Creates the placeholder consent policies, and only on a database that has
 * none — the one-time bootstrap described on CONSENT_BOOTSTRAP.
 *
 * The guard is per kind and deliberately checks for ANY row, not for the
 * placeholder's own version: an environment whose policies were published
 * through Methodology Configuration → Consent Policies has rows this seed has
 * never seen, and re-inserting a placeholder beside them (worse, an active
 * one) would put "not yet published" back in front of registrants whose terms
 * were signed off weeks earlier.
 *
 * Nothing is ever updated here. That is the whole point: after this runs once,
 * consent wording is owned by the two roles the client named, and a reseed
 * cannot touch it.
 */
async function bootstrapConsentPolicies(): Promise<void> {
  for (const kind of ['use_policy', 'data_sharing', 'citizen_consent'] as const) {
    const existing = await prisma.consentPolicy.findFirst({ where: { kind }, select: { id: true } });
    if (existing) continue;
    const bootstrap = CONSENT_BOOTSTRAP[kind];
    await prisma.consentPolicy.create({
      data: {
        kind,
        version: bootstrap.version,
        text: bootstrapText(bootstrap.heading),
        textAr: bootstrapTextAr(bootstrap.headingAr),
        // Published + active so signup works out of the box, but with no
        // publishedBy/reviewedBy: nobody approved this, and the Consent
        // Policies tab shows those columns as "—" accordingly, which is the
        // honest record and a visible prompt to publish something real.
        status: 'published',
        active: true,
      },
    });
    console.log(`Seeded placeholder ${kind} consent policy (${bootstrap.version}) — publish a real one via Methodology Configuration.`);
  }
}


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

// RIO-FR-012/FR-005 (Q3/Q4/Q35, Q10) — PLACEHOLDER values, not client-
// confirmed. Only Study Type and Target Sector are genuinely pending
// (Q35); Decision Type's three values ARE the client's confirmed answer
// (Q10) and aren't placeholder. Kept in one function since all three are
// the same StudyConfigOption-shaped table. Upsert by name (not create),
// same reasoning as the consent policies above — re-seeding an existing
// environment must not duplicate rows or wipe a name that's already in use
// elsewhere (e.g. on a Study), just refresh displayOrder/isActive.
async function seedStudyConfigOptions(): Promise<void> {
  const studyTypes = [
    'Baseline Assessment',
    'Rapid Needs Assessment',
    'Follow-up Assessment',
    'Thematic Study',
  ];
  for (const [index, name] of studyTypes.entries()) {
    await prisma.studyTypeOption.upsert({
      where: { name },
      update: { displayOrder: index, isActive: true },
      create: { name, displayOrder: index, isActive: true },
    });
  }

  const targetSectors = [
    'Health',
    'Education',
    'WASH (Water, Sanitation & Hygiene)',
    'Livelihoods',
    'Protection',
    'Multi-Sector',
  ];
  for (const [index, name] of targetSectors.entries()) {
    await prisma.targetSectorOption.upsert({
      where: { name },
      update: { displayOrder: index, isActive: true },
      create: { name, displayOrder: index, isActive: true },
    });
  }

  const decisionTypes = ['Intervention', 'Escalation', 'Follow-up'];
  for (const [index, name] of decisionTypes.entries()) {
    await prisma.decisionTypeOption.upsert({
      where: { name },
      update: { displayOrder: index, isActive: true },
      create: { name, displayOrder: index, isActive: true },
    });
  }

  // The 5 original RIO-FR-005 Q12 values — seeded here (rather than left
  // empty like Study Type/Target Sector) since they're already real,
  // in-use data (existing Need.gapType values, frontend i18n keys), not
  // placeholders. This just makes the existing list editable going
  // forward; it isn't a data migration.
  const gapTypes = ['acute', 'chronic', 'structural', 'seasonal', 'equity'];
  for (const [index, name] of gapTypes.entries()) {
    await prisma.gapTypeOption.upsert({
      where: { name },
      update: { displayOrder: index, isActive: true },
      create: { name, displayOrder: index, isActive: true },
    });
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

  // RIO-DATA-001 — signup validates the submitted version against the active
  // policy of each kind and 404s when a kind has none, so BOTH must exist for
  // any registration to succeed. Bootstrapped, never re-imposed: see
  // CONSENT_BOOTSTRAP's note above for why this stopped being an upsert.
  await bootstrapConsentPolicies();
  await seedDomainsAndSubdomains();
  await seedStudyConfigOptions();

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

  // RIO-RBAC-002 (client-confirmed, 2026-08-27 round) — System Admin and
  // System Reviewer are platform-wide, cross-entity roles; they must not be
  // tied to a real NGO tenant. Previously both were seeded under Demo NGO
  // (`demoOrgId`) despite a comment on that very code claiming otherwise —
  // that meant every geography-scope check on Study/Need creation silently
  // restricted them to Demo NGO's own governorates/centers. `User.orgId` is
  // a required, non-nullable column (schema-wide RLS and every service
  // that reads it assume a real org), so "no organisation" isn't
  // achievable without a much larger migration — this dedicated,
  // obviously-non-operational org is the home row the schema requires,
  // while the real fix for "act on behalf of any organisation" is the new
  // `X-Act-As-Org` mechanism in JwtAuthGuard (crossEntity-only, validated
  // server-side), not this org's identity. This org has no real
  // governorates/centers linked and is never a Study's owner in practice.
  const platformOrgId = await seedOrg({
    registrationNumber: '8000000000',
    name: 'Platform Administration (System Accounts Only)',
    purpose: 'Technical home organisation for platform-wide system accounts — not a real NGO tenant.',
    region: [],
    email: 'platform-admin@rio.internal',
    sector: 'other',
    villages: [],
    users: [
      { roleId: 'role_system_admin', name: 'System Admin', email: 'sysadmin@platform.local' },
      { roleId: 'role_system_reviewer', name: 'System Reviewer', email: 'sysreviewer@platform.local' },
    ],
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

  console.log(`Seeded ${ROLE_MATRIX.length} roles, consent v1, 9 domains from question-bank-v1.json.`);
  console.log(`Seeded Demo NGO: ${demoOrgId} (admin@demo-ngo.org, officer@demo-ngo.org)`);
  console.log(`Seeded Riverside Community Trust: ${riversideOrgId} (admin@riverside-ngo.org)`);
  console.log(`Seeded Platform Administration: ${platformOrgId} (sysadmin@platform.local, sysreviewer@platform.local — home org only, not a real tenant; both roles are crossEntity and act platform-wide via X-Act-As-Org)`);
  console.log(`Dev login password for all seeded accounts: ${DEV_PASSWORD}`);
}

async function disconnectAll(): Promise<void> {
  await Promise.all([prisma.$disconnect(), supervisor.$disconnect()]);
}

main()
  .then(disconnectAll)
  .catch(async (e) => { console.error(e); await disconnectAll(); process.exit(1); });
