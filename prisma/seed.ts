import * as fs from 'node:fs';
import * as path from 'node:path';
import { ROLE_MATRIX } from '../src/rbac/role-matrix';
import { prisma, seedOrg, disconnectAll } from './seed-helpers';

// Core reference/config data only — the platform-wide accounts and lookup
// tables every real deployment needs, safe to run against a genuine
// client's environment ("renting a seat"). Fake demo organizations/studies/
// surveys/reports live in prisma/seed-demo.ts instead, local dev + QA only
// — see that file's header for why they were split out.

// The "OPEN"/General entry in question-bank-v1.json's hierarchy is a
// pseudo-domain for open-ended questions, not a real methodology Domain —
// _meta.counts.domains is 9, not 10, so it's excluded from this seed.
const QUESTION_BANK_EXCLUDED_DOMAIN_CODE = 'OPEN';

interface QuestionBankHierarchyEntry {
  code: string;
  name: string;
  subDomains: Array<{ code: string; name: string }>;
}

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

  // RIO-RBAC-002 (client-confirmed, 2026-08-27 round) — System Admin and
  // System Reviewer are platform-wide, cross-entity roles; they must not be
  // tied to a real NGO tenant. `User.orgId` is a required, non-nullable
  // column (schema-wide RLS and every service that reads it assume a real
  // org), so "no organisation" isn't achievable without a much larger
  // migration — this dedicated, obviously-non-operational org is the home
  // row the schema requires, while the real fix for "act on behalf of any
  // organisation" is the `X-Act-As-Org` mechanism in JwtAuthGuard
  // (crossEntity-only, validated server-side), not this org's identity.
  // This org has no real governorates/centers linked and is never a
  // Study's owner in practice. Real deployments still need this: it's the
  // only way a System Admin/Reviewer account can exist at all, not a demo
  // fixture — unlike Demo NGO/Riverside (see seed-demo.ts).
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

  console.log(`Seeded ${ROLE_MATRIX.length} roles, consent placeholders, 9 domains from question-bank-v1.json, and Study/Target Sector/Decision/Gap Type options.`);
  console.log(`Seeded Platform Administration: ${platformOrgId} (sysadmin@platform.local, sysreviewer@platform.local — home org only, not a real tenant; both roles are crossEntity and act platform-wide via X-Act-As-Org)`);
  console.log('No demo organizations seeded here — run `pnpm seed:demo` for local dev/QA fixtures (Demo NGO, Riverside Community Trust, sample studies/needs/reports).');
}

main()
  .then(disconnectAll)
  .catch(async (e) => { console.error(e); await disconnectAll(); process.exit(1); });
