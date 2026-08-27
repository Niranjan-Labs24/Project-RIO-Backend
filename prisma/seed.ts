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

// v1 — kept exactly as originally seeded, immutable (see the comment on the
// upsert block below for why: a policy's already-recorded acceptances
// snapshot the wording their user actually saw, so this text can never be
// edited in place, only superseded by a new version).
const DATA_SHARING_TEXT = `Data Sharing Policy

We value your privacy and are committed to handling your information responsibly.

Information entered into this Rio application is used only for demonstration, testing, and evaluation purposes.
We do not sell or share your information with third parties for marketing purposes.
Data may be accessed by authorized administrators or support personnel solely to maintain and improve the application.
Aggregated and anonymized information may be used to evaluate system performance and enhance user experience.
Users should avoid entering confidential, personal, financial, or regulated information into this demonstration environment.
Appropriate security measures are implemented to help protect data; however, no electronic system can guarantee absolute security.
By using this application, you acknowledge and consent to the collection and processing of information as described in this policy.`;

// v2 (RIO-RBAC-002, RIO-DATA-001 dependency, 2026-08-23) — adds the
// Center/NCNP Supervisor's cross-entity supervisory scope, previously
// undocumented in this policy despite RBAC-002 depending on it being
// captured here. Re-acceptance is a hard block on version bump (client-
// confirmed) — every user re-accepts on next login once this activates.
const DATA_SHARING_TEXT_V2 = `Data Sharing Policy

We value your privacy and are committed to handling your information responsibly.

Information entered into this Rio application is used only for demonstration, testing, and evaluation purposes.
We do not sell or share your information with third parties for marketing purposes.
Data may be accessed by authorized administrators or support personnel solely to maintain and improve the application.
The Center/NCNP Supervisor role holds cross-entity supervisory visibility — it may view studies, data, and reports across every entity on the platform for oversight purposes, but cannot edit an entity's data unless a specific, time-limited permission grant for that action has been approved by a System Administrator. Every such view and every granted edit is recorded in the audit trail.
Aggregated and anonymized information may be used to evaluate system performance and enhance user experience.
Users should avoid entering confidential, personal, financial, or regulated information into this demonstration environment.
Appropriate security measures are implemented to help protect data; however, no electronic system can guarantee absolute security.
By using this application, you acknowledge and consent to the collection and processing of information as described in this policy.`;

// RIO-RBAC-002 (Round 5, client-confirmed 2026-08-24) — v3 corrects v2's
// "every such view... is recorded in the audit trail" claim, which stopped
// being true once Supervisor view-access logging was removed per this
// answer: "under the consent NGOs approve when joining the platform, the
// Center/NCNP already has the right to see and preview their data —
// Supervisor read/view access does not require separate logging." v3 makes
// that consent basis explicit and drops the no-longer-true logging claim
// for views (edits are still logged, unchanged).
const DATA_SHARING_TEXT_V3 = `Data Sharing Policy

We value your privacy and are committed to handling your information responsibly.

Information entered into this Rio application is used only for demonstration, testing, and evaluation purposes.
We do not sell or share your information with third parties for marketing purposes.
Data may be accessed by authorized administrators or support personnel solely to maintain and improve the application.
By agreeing to this policy, you acknowledge and agree that the Center/NCNP Supervisor role holds cross-entity supervisory visibility under this consent — it may view and preview studies, data, and reports across every entity on the platform for oversight purposes. The Supervisor cannot edit an entity's data unless a specific, time-limited permission grant for that action has been approved by a System Administrator; every granted edit is recorded in the audit trail.
Aggregated and anonymized information may be used to evaluate system performance and enhance user experience.
Users should avoid entering confidential, personal, financial, or regulated information into this demonstration environment.
Appropriate security measures are implemented to help protect data; however, no electronic system can guarantee absolute security.
By using this application, you acknowledge and consent to the collection and processing of information as described in this policy.`;

// The same two consents in Arabic (RIO-NFR-007). Same row, same version — a
// translation is not a separate policy, so these travel with the English copy
// above rather than as their own `v1-ar`, and the signup screen picks between
// them by the reader's locale.
const USE_POLICY_TEXT_AR = `شروط الاستخدام

مرحبًا بك في تطبيق RIO. بدخولك إلى هذه المنصة أو استخدامك لها، فإنك توافق على الشروط التالية:

يُقدَّم هذا التطبيق لأغراض العرض التوضيحي والاختبار والتقييم فقط.
يجب أن تكون أي معلومات تُدخل في التطبيق وهمية أو غير حساسة ما لم يُصرَّح بغير ذلك صراحةً.
يتحمل المستخدمون مسؤولية التأكد من أن أي محتوى يقدمونه يمتثل للأنظمة المعمول بها وسياسات الجهة.
يُحظر الوصول غير المصرح به إلى التطبيق أو إساءة استخدامه أو محاولة تعطيله.
يجوز لمالك التطبيق تعديل أي ميزة أو تعليقها أو إيقافها دون إشعار مسبق.
قد لا تمثل الميزات وسير العمل والتقارير المعروضة في هذا العرض التوضيحي النسخة الإنتاجية النهائية.
يشير استمرارك في استخدام التطبيق إلى قبولك لهذه الشروط.`;

// v1 Arabic — kept exactly as originally seeded, immutable (see
// DATA_SHARING_TEXT's comment above).
const DATA_SHARING_TEXT_AR = `سياسة مشاركة البيانات

نحن نقدّر خصوصيتك ونلتزم بالتعامل مع معلوماتك بمسؤولية.

تُستخدم المعلومات المُدخلة في تطبيق Rio لأغراض العرض التوضيحي والاختبار والتقييم فقط.
لا نبيع معلوماتك ولا نشاركها مع أطراف ثالثة لأغراض تسويقية.
قد يطّلع على البيانات مسؤولون مصرَّح لهم أو موظفو الدعم لغرض صيانة التطبيق وتحسينه فقط.
قد تُستخدم المعلومات المجمّعة ومجهولة الهوية لتقييم أداء النظام وتحسين تجربة المستخدم.
ينبغي على المستخدمين تجنب إدخال معلومات سرية أو شخصية أو مالية أو خاضعة للتنظيم في هذه البيئة التجريبية.
تُطبَّق تدابير أمنية مناسبة للمساعدة في حماية البيانات؛ ومع ذلك، لا يمكن لأي نظام إلكتروني أن يضمن أمانًا مطلقًا.
باستخدامك هذا التطبيق، فإنك تقر وتوافق على جمع المعلومات ومعالجتها على النحو الموضح في هذه السياسة.`;

// v2 Arabic (RIO-RBAC-002, RIO-DATA-001 dependency, 2026-08-23).
const DATA_SHARING_TEXT_AR_V2 = `سياسة مشاركة البيانات

نحن نقدّر خصوصيتك ونلتزم بالتعامل مع معلوماتك بمسؤولية.

تُستخدم المعلومات المُدخلة في تطبيق Rio لأغراض العرض التوضيحي والاختبار والتقييم فقط.
لا نبيع معلوماتك ولا نشاركها مع أطراف ثالثة لأغراض تسويقية.
قد يطّلع على البيانات مسؤولون مصرَّح لهم أو موظفو الدعم لغرض صيانة التطبيق وتحسينه فقط.
يتمتع دور مشرف المركز/الهيئة الوطنية للأعمال الخيرية (NCNP) بصلاحية إشراف عابرة للكيانات — يجوز له الاطلاع على الدراسات والبيانات والتقارير عبر جميع الكيانات في المنصة لأغراض الرقابة، لكن لا يجوز له تعديل بيانات أي كيان إلا بموجب إذن صلاحية محدد ومحدود المدة يوافق عليه مسؤول النظام لذلك الإجراء تحديدًا. يُسجَّل كل اطلاع وكل تعديل ممنوح في سجل التدقيق.
قد تُستخدم المعلومات المجمّعة ومجهولة الهوية لتقييم أداء النظام وتحسين تجربة المستخدم.
ينبغي على المستخدمين تجنب إدخال معلومات سرية أو شخصية أو مالية أو خاضعة للتنظيم في هذه البيئة التجريبية.
تُطبَّق تدابير أمنية مناسبة للمساعدة في حماية البيانات؛ ومع ذلك، لا يمكن لأي نظام إلكتروني أن يضمن أمانًا مطلقًا.
باستخدامك هذا التطبيق، فإنك تقر وتوافق على جمع المعلومات ومعالجتها على النحو الموضح في هذه السياسة.`;

// v3 Arabic — see DATA_SHARING_TEXT_V3's comment above.
const DATA_SHARING_TEXT_AR_V3 = `سياسة مشاركة البيانات

نحن نقدّر خصوصيتك ونلتزم بالتعامل مع معلوماتك بمسؤولية.

تُستخدم المعلومات المُدخلة في تطبيق Rio لأغراض العرض التوضيحي والاختبار والتقييم فقط.
لا نبيع معلوماتك ولا نشاركها مع أطراف ثالثة لأغراض تسويقية.
قد يطّلع على البيانات مسؤولون مصرَّح لهم أو موظفو الدعم لغرض صيانة التطبيق وتحسينه فقط.
بموافقتك على هذه السياسة، فإنك تقرّ وتوافق على أن دور مشرف المركز/الهيئة الوطنية للأعمال الخيرية (NCNP) يتمتع بصلاحية إشراف عابرة للكيانات بموجب هذه الموافقة — يجوز له الاطلاع على الدراسات والبيانات والتقارير ومعاينتها عبر جميع الكيانات في المنصة لأغراض الرقابة. لا يجوز للمشرف تعديل بيانات أي كيان إلا بموجب إذن صلاحية محدد ومحدود المدة يوافق عليه مسؤول النظام لذلك الإجراء تحديدًا؛ ويُسجَّل كل تعديل ممنوح في سجل التدقيق.
قد تُستخدم المعلومات المجمّعة ومجهولة الهوية لتقييم أداء النظام وتحسين تجربة المستخدم.
ينبغي على المستخدمين تجنب إدخال معلومات سرية أو شخصية أو مالية أو خاضعة للتنظيم في هذه البيئة التجريبية.
تُطبَّق تدابير أمنية مناسبة للمساعدة في حماية البيانات؛ ومع ذلك، لا يمكن لأي نظام إلكتروني أن يضمن أمانًا مطلقًا.
باستخدامك هذا التطبيق، فإنك تقر وتوافق على جمع المعلومات ومعالجتها على النحو الموضح في هذه السياسة.`;

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
    update: { active: true, text: USE_POLICY_TEXT, textAr: USE_POLICY_TEXT_AR },
    create: { kind: 'use_policy', version: 'v1', active: true, text: USE_POLICY_TEXT, textAr: USE_POLICY_TEXT_AR },
  });
  // RIO-RBAC-002 (2026-08-23) — v2 supersedes v1 as the active data-sharing
  // policy (adds the Center/NCNP Supervisor supervisory-scope clause). v1
  // stays in place, deactivated, not deleted or edited in place —
  // ConsentService only ever reads `where: { kind, active: true }`, so
  // exactly one row per kind must carry active:true at a time.
  await prisma.consentPolicy.upsert({
    where: { kind_version: { kind: 'data_sharing', version: 'v1' } },
    update: { active: false, text: DATA_SHARING_TEXT, textAr: DATA_SHARING_TEXT_AR },
    create: { kind: 'data_sharing', version: 'v1', active: false, text: DATA_SHARING_TEXT, textAr: DATA_SHARING_TEXT_AR },
  });
  await prisma.consentPolicy.upsert({
    where: { kind_version: { kind: 'data_sharing', version: 'v2' } },
    update: { active: false, text: DATA_SHARING_TEXT_V2, textAr: DATA_SHARING_TEXT_AR_V2 },
    create: { kind: 'data_sharing', version: 'v2', active: false, text: DATA_SHARING_TEXT_V2, textAr: DATA_SHARING_TEXT_AR_V2 },
  });
  // RIO-RBAC-002 (Round 5, 2026-08-24) — v3 supersedes v2: drops the
  // "every view is logged" claim (no longer true) and makes explicit that
  // this consent is the basis for the Supervisor's view/preview right.
  await prisma.consentPolicy.upsert({
    where: { kind_version: { kind: 'data_sharing', version: 'v3' } },
    update: { active: true, text: DATA_SHARING_TEXT_V3, textAr: DATA_SHARING_TEXT_AR_V3 },
    create: { kind: 'data_sharing', version: 'v3', active: true, text: DATA_SHARING_TEXT_V3, textAr: DATA_SHARING_TEXT_AR_V3 },
  });

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
