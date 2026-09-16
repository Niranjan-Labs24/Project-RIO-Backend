/**
 * import-methodology.ts — RIO-AI-005 (legacy FR-19)
 * "Approved methodology implementation baseline"
 *
 * Imports one signed-off methodology version — domain/sub-domain hierarchy,
 * question bank, and the option-to-severity scoring lookup — from the artifacts
 * produced by `scripts/extract-methodology-v5.py`.
 *
 *   pnpm import:methodology                    # import v5.0 as a DRAFT version
 *   pnpm import:methodology --publish          # ...and publish it (change control)
 *   pnpm import:methodology --version "v5.0 - Approved methodology baseline"
 *   pnpm import:methodology --dry-run          # validate only, write nothing
 *
 * Supersedes import-questions.ts + import-scoring-lookups.ts, which read the
 * pre-v5.0 CSVs and had three defects this script exists to not repeat:
 *
 *   1. They never set `methodologyVersionId`, so every bank shared one flat
 *      namespace and a second import produced indistinguishable duplicates.
 *   2. import-scoring-lookups.ts hardcoded the version label AND created the
 *      version with status 'PUBLISHED' — so an import *was* a publish, with no
 *      review step. Publishing is now an explicit, separate opt-in.
 *   3. It read the numeric floor/ceiling from the SEVERITY column. In v5.0 the
 *      bound value lives in the option label ("Floor=0" / "Ceiling=120") and the
 *      severity column holds the severity AT that bound — reading the wrong one
 *      inverts every reversed scale (antenatal visits, growth-monitoring visits,
 *      attendance days, months of income) and flattens INF-09's real floor of 2.
 *
 * The old scripts are left in place, unchanged, so the v1.0 baseline stays
 * reproducible; nothing should call them for v5.0 or later.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '../src/generated/prisma';

dotenv.config();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not defined in the environment.');
  process.exit(1);
}

const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

// ── Artifact shapes (mirror the extractor's output) ─────────────────────────

interface BankQuestion {
  questionId: string;
  formerCode: string | null;
  domain: string;
  subDomain: string;
  indicator: string | null;
  kpi: string | null;
  questionText: string;
  answerTypeRaw: string;
  measurementMode: string;
  rosterScope: string | null;
  isCompound: boolean;
  isAdminRecord: boolean;
  answerOptions: string[] | null;
  analyticalCategory: string | null;
  targetRespondent: string | null;
  requiredOptional: string;
  usedInMvp: boolean;
  reportMapping: string | null;
  isFielded: boolean;
  isScoreable: boolean;
  isHouseholdFielded: boolean;
  excludedFromNineDomainIndex: boolean;
  feedsKpiAnchor: string | null;
  conditionalRule: unknown | null;
  rosterLoop: string | null;
  gates: string[] | null;
  notes: string | null;
}

interface BankFile {
  _meta: { versionLabel: string; counts: Record<string, number>; extractedFrom: string };
  hierarchy: Array<{ name: string; subDomains: string[] }>;
  questions: BankQuestion[];
}

interface LookupRow {
  questionId: string;
  lookupType: string;
  optionId: string | null;
  optionLabel: string;
  optionOrder: number;
  severityScore: number | null;
  numericFloor: number | null;
  numericCeiling: number | null;
  severityDirection: string | null;
  isExcluded: boolean;
  exclusionReason: string | null;
  isComposite: boolean;
  scoreTypeRaw: string;
}

interface LookupFile {
  _meta: { versionLabel: string; rows: number; questions: number };
  lookups: LookupRow[];
}

/**
 * The workbook's own stated figures. Validated before a single row is written —
 * a mismatch means the artifacts and the signed-off methodology have diverged,
 * and importing anyway would silently configure the platform against something
 * nobody approved.
 */
const EXPECTED_COUNTS: Record<string, number> = {
  totalQuestions: 193,
  fieldItems: 186,
  severityScoredItems: 166,
  householdFieldedItems: 184,
  domains: 9,
  subDomains: 44,
  indicators: 172,
  feederItems: 20,
  diagnosticItems: 18,
};

/** Upper-snake slug; mirrors normalizeDomainKey / toOptionId elsewhere. */
function slug(name: string): string {
  return name.toUpperCase().trim().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

function readJson<T>(p: string, label: string): T {
  if (!fs.existsSync(p)) {
    console.error(`${label} not found: ${p}`);
    console.error('Run:  python scripts/extract-methodology-v5.py');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
}

async function main(): Promise<void> {
  const dir = path.join(__dirname, 'methodology');
  const bank = readJson<BankFile>(arg('bank') ?? path.join(dir, 'question-bank-v5.json'), 'Question bank');
  const lookupFile = readJson<LookupFile>(arg('lookups') ?? path.join(dir, 'scoring-lookup-v5.json'), 'Scoring lookup');
  const versionLabel = arg('version') ?? bank._meta.versionLabel;
  const dryRun = has('dry-run');
  const publish = has('publish');

  console.log(`\nMethodology import — ${versionLabel}`);
  console.log(`  source workbook : ${bank._meta.extractedFrom}`);
  console.log(`  questions       : ${bank.questions.length}`);
  console.log(`  lookup rows     : ${lookupFile.lookups.length}`);
  console.log(`  mode            : ${dryRun ? 'DRY RUN (no writes)' : publish ? 'IMPORT + PUBLISH' : 'IMPORT AS DRAFT'}`);

  // ══ 1. Validation gates — before any write ═══════════════════════════════
  const problems: string[] = [];

  for (const [key, expected] of Object.entries(EXPECTED_COUNTS)) {
    const actual = bank._meta.counts[key];
    if (actual !== expected) problems.push(`counts.${key}: expected ${expected}, artifact says ${actual}`);
  }
  if (lookupFile._meta.versionLabel !== bank._meta.versionLabel) {
    problems.push(`version mismatch: bank "${bank._meta.versionLabel}" vs lookups "${lookupFile._meta.versionLabel}"`);
  }

  const byCode = new Map(bank.questions.map((q) => [q.questionId, q]));
  if (byCode.size !== bank.questions.length) problems.push('duplicate questionId in the bank artifact');

  const lookupCodes = new Set(lookupFile.lookups.map((l) => l.questionId));
  for (const code of lookupCodes) {
    if (!byCode.has(code)) problems.push(`lookup references unknown question ${code}`);
  }
  // Every scoreable question must be resolvable at scoring time, or a real
  // survey response silently lands as ERROR instead of a severity score.
  const missingLookups = bank.questions
    .filter((q) => q.isScoreable && !lookupCodes.has(q.questionId))
    .map((q) => q.questionId);
  if (missingLookups.length) problems.push(`scoreable questions with no lookup: ${missingLookups.join(', ')}`);

  // Both numeric bounds, or the floor/ceiling map degenerates to 0..100.
  for (const l of lookupFile.lookups) {
    if (l.lookupType === 'NUMERIC') {
      if (l.numericFloor === null || l.numericCeiling === null) {
        problems.push(`${l.questionId}: NUMERIC lookup missing a bound`);
      } else if (l.numericCeiling === l.numericFloor) {
        problems.push(`${l.questionId}: NUMERIC floor == ceiling (${l.numericFloor})`);
      }
      if (l.severityDirection !== 'WORSENING_HIGHER' && l.severityDirection !== 'WORSENING_LOWER') {
        problems.push(`${l.questionId}: NUMERIC lookup has no severity direction`);
      }
    }
    if (l.severityScore !== null && (l.severityScore < 0 || l.severityScore > 100)) {
      problems.push(`${l.questionId} / ${l.optionLabel}: severity ${l.severityScore} outside 0-100`);
    }
  }

  // Feeder items must point at a real anchor in the same bank.
  for (const q of bank.questions) {
    if (q.feedsKpiAnchor && !byCode.has(q.feedsKpiAnchor)) {
      problems.push(`${q.questionId}: feedsKpiAnchor "${q.feedsKpiAnchor}" is not in this bank`);
    }
    if (
      q.conditionalRule &&
      typeof q.conditionalRule === 'object' &&
      'dependsOn' in q.conditionalRule &&
      typeof (q.conditionalRule as { dependsOn: unknown }).dependsOn === 'string' &&
      !byCode.has((q.conditionalRule as { dependsOn: string }).dependsOn)
    ) {
      problems.push(`${q.questionId}: conditional rule depends on unknown question`);
    }
  }

  const hierarchyPairs = new Set(
    bank.hierarchy.flatMap((d) => d.subDomains.map((s) => `${d.name}||${s}`)),
  );
  for (const q of bank.questions) {
    // XDM cross-cutting items sit outside the nine-domain hierarchy by design.
    if (q.domain.startsWith('Cross-Domain')) continue;
    if (!hierarchyPairs.has(`${q.domain}||${q.subDomain}`)) {
      problems.push(`${q.questionId}: (${q.domain} / ${q.subDomain}) missing from the hierarchy`);
    }
  }

  if (problems.length) {
    console.error(`\nREJECTED — ${problems.length} validation problem(s), nothing written:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`\n  validation: all ${Object.keys(EXPECTED_COUNTS).length} workbook counts + ` +
              `${lookupFile.lookups.length} lookup rows OK`);

  if (dryRun) {
    console.log('\nDry run complete — artifacts are valid. Re-run without --dry-run to import.');
    return;
  }

  // ══ 2. Resolve the methodology version ═══════════════════════════════════
  // Imported as DRAFT: an import is not an approval. Publishing is a separate,
  // audited decision (--publish here, or POST /methodology-config/publish).
  const systemUser = await prisma.user.findFirst({ select: { id: true } });
  const createdBy = systemUser?.id ?? '00000000-0000-0000-0000-000000000000';

  let mv = await prisma.methodologyVersion.findUnique({ where: { version: versionLabel } });
  if (!mv) {
    mv = await prisma.methodologyVersion.create({
      data: {
        name: `Village Needs Methodology ${versionLabel}`,
        version: versionLabel,
        status: 'DRAFT',
        description:
          `Imported from ${bank._meta.extractedFrom} via prisma/import-methodology.ts. ` +
          `${bank._meta.counts.totalQuestions} items / ${bank._meta.counts.domains} domains / ` +
          `${bank._meta.counts.subDomains} sub-domains / ${bank._meta.counts.indicators} indicators.`,
        createdBy,
      },
    });
    console.log(`  created methodology version (DRAFT): ${mv.id}`);
  } else {
    console.log(`  reusing methodology version: ${mv.id} (status ${mv.status})`);
  }

  // ── Immutability guard ─────────────────────────────────────────────────
  // Same rule as import-domain-priority-config.ts: once real responses have been
  // scored against a version, its definition is frozen. Re-importing would
  // change what an already-published report claims it was measured against.
  const recordedScores = await prisma.responseSeverityScore.count({
    where: { methodologyVersionId: mv.id },
  });
  if (recordedScores > 0) {
    console.error(
      `\nREJECTED: "${versionLabel}" already has ${recordedScores} recorded severity score(s). ` +
      `A scored methodology version is immutable — create a new version instead.`,
    );
    process.exit(1);
  }

  // ══ 3. Domain / sub-domain hierarchy ═════════════════════════════════════
  // Domains and sub-domains are deliberately NOT version-scoped: they are the
  // classification vocabulary for Needs, which exist independently of any
  // survey, and Need.domain/NeedDomain.domain store the NAME (not an id). So
  // this is an additive merge keyed on name, never a replace — otherwise a
  // second "Health" row would appear and Need classification would be
  // ambiguous. All nine v5.0 domain names match v1.0's exactly, so in practice
  // the existing rows are reused and only sub-domains grow.
  let domCreated = 0;
  let domUpdated = 0;
  let subCreated = 0;
  let subUpdated = 0;
  const v5SubDomainIds = new Set<string>();

  for (const [i, d] of bank.hierarchy.entries()) {
    let domainRow = await prisma.domain.findFirst({ where: { name: d.name } });
    if (domainRow) {
      // Keep the existing `code` — it is the unique key and may be referenced.
      await prisma.domain.update({
        where: { id: domainRow.id },
        data: { displayOrder: i, isActive: true },
      });
      domUpdated++;
    } else {
      domainRow = await prisma.domain.create({
        data: { code: slug(d.name), name: d.name, displayOrder: i, isActive: true },
      });
      domCreated++;
    }

    for (const [j, subName] of d.subDomains.entries()) {
      // Look up by (domainId, name), not name alone: "Emergency Preparedness"
      // legitimately exists under BOTH Health and Energy & Environment in v5.0,
      // and SubDomain.code is globally unique — so codes are domain-qualified.
      const existing = await prisma.subDomain.findFirst({
        where: { domainId: domainRow.id, name: subName },
      });
      if (existing) {
        await prisma.subDomain.update({
          where: { id: existing.id },
          data: { displayOrder: j, isActive: true },
        });
        v5SubDomainIds.add(existing.id);
        subUpdated++;
      } else {
        const created = await prisma.subDomain.create({
          data: {
            domainId: domainRow.id,
            code: `${slug(d.name)}__${slug(subName)}`,
            name: subName,
            displayOrder: j,
            isActive: true,
          },
        });
        v5SubDomainIds.add(created.id);
        subCreated++;
      }
    }
  }
  console.log(`  hierarchy: domains +${domCreated}/~${domUpdated}, sub-domains +${subCreated}/~${subUpdated}`);

  // ══ 4. Questions (version-scoped) ════════════════════════════════════════
  let qCreated = 0;
  let qUpdated = 0;

  for (const q of bank.questions) {
    // `answerType` is the coarse render hint the Survey Builder and the citizen
    // form already consume; `measurementMode` is what the scoring engine reads.
    const answerType =
      q.measurementMode === 'NUMERIC' ? 'numeric'
      : q.measurementMode === 'MULTI_SELECT' ? 'multiselect'
      : q.measurementMode === 'CHECKLIST_MATRIX' ? 'checklist'
      : q.measurementMode === 'SINGLE_SELECT' || q.measurementMode === 'LIKERT_5' ? 'select'
      : 'text';

    const data = {
      domain: q.domain,
      subDomain: q.subDomain,
      indicator: q.indicator,
      kpi: q.kpi,
      questionText: q.questionText,
      answerType,
      // Prisma.DbNull, not JS null: a nullable Json column distinguishes SQL
      // NULL (DbNull) from the JSON value `null` (JsonNull), and plain `null`
      // is not assignable to either.
      answerOptions: q.answerOptions ?? Prisma.DbNull,
      requiredOptional: q.requiredOptional,
      usedInMvp: q.usedInMvp,
      reportMapping: q.reportMapping,
      analyticalCategory: q.analyticalCategory,
      measurementMode: q.measurementMode,
      isScoreable: q.isScoreable,
      // Direction lives on the NUMERIC lookup row (derived from which bound
      // carries severity 0); mirrored here so a reader of the question alone
      // still sees it.
      severityDirection:
        lookupFile.lookups.find((l) => l.questionId === q.questionId && l.lookupType === 'NUMERIC')
          ?.severityDirection ?? null,
      conditionalRule: (q.conditionalRule as Prisma.InputJsonValue) ?? Prisma.DbNull,
      scoringLookupKey: q.questionId,
      answerTypeRaw: q.answerTypeRaw,
      rosterScope: q.rosterScope,
      isCompound: q.isCompound,
      isAdminRecord: q.isAdminRecord,
      isFielded: q.isFielded,
      isHouseholdFielded: q.isHouseholdFielded,
      excludedFromNineDomainIndex: q.excludedFromNineDomainIndex,
      feedsKpiAnchor: q.feedsKpiAnchor,
      formerCode: q.formerCode,
      targetRespondent: q.targetRespondent,
      rosterLoop: q.rosterLoop,
    };

    const existing = await prisma.question.findUnique({
      where: {
        methodologyVersionId_questionId_version: {
          methodologyVersionId: mv.id,
          questionId: q.questionId,
          version: 1,
        },
      },
    });
    if (existing) {
      await prisma.question.update({ where: { id: existing.id }, data });
      qUpdated++;
    } else {
      await prisma.question.create({
        data: { ...data, questionId: q.questionId, methodologyVersionId: mv.id },
      });
      qCreated++;
    }
  }
  console.log(`  questions: +${qCreated} created / ~${qUpdated} updated`);

  // ══ 5. Scoring lookups (version-scoped, replace-in-place) ════════════════
  // A clean replace rather than an upsert: the guard above proves nothing has
  // been scored against this version yet, and v5.0 changes option sets (not
  // just severities), so leftover rows from an earlier import of the SAME
  // version would resolve real answers against retired options.
  const deleted = await prisma.scoringLookup.deleteMany({ where: { methodologyVersionId: mv.id } });
  await prisma.scoringLookup.createMany({
    data: lookupFile.lookups.map((l) => ({
      methodologyVersionId: mv.id,
      questionId: l.questionId,
      lookupType: l.lookupType,
      optionId: l.optionId,
      optionOrder: l.optionOrder,
      severityScore: l.severityScore,
      numericFloor: l.numericFloor,
      numericCeiling: l.numericCeiling,
      severityDirection: l.severityDirection,
      isExcluded: l.isExcluded,
      exclusionReason: l.exclusionReason,
      isActive: true,
    })),
  });
  console.log(`  scoring lookups: -${deleted.count} replaced with ${lookupFile.lookups.length}`);

  // ══ 6. Publish (explicit only) ═══════════════════════════════════════════
  if (publish) {
    await prisma.methodologyVersion.update({
      where: { id: mv.id },
      data: { status: 'PUBLISHED', approvedBy: createdBy, approvedAt: new Date() },
    });
    console.log(`  status: PUBLISHED`);
  } else {
    console.log(`  status: left as ${mv.status} — re-run with --publish, or publish from Settings`);
  }

  // ══ 7. Report what a human still has to decide ═══════════════════════════
  // Sub-domains that exist but are not part of this version's hierarchy are
  // usually v1.0 names that v5.0 renamed ("Access to Basic Healthcare" ->
  // "Primary Healthcare Access"). They are NOT auto-deactivated: existing Needs
  // may be classified under them, and deactivating a sub-domain is a curation
  // decision that belongs to a Methodology admin through the existing
  // PATCH /domains/:id/subdomains/:subId/deactivate endpoint.
  const orphanSubs = await prisma.subDomain.findMany({
    where: { id: { notIn: [...v5SubDomainIds] }, isActive: true },
    select: { name: true, domain: { select: { name: true } } },
    orderBy: [{ domain: { name: 'asc' } }, { name: 'asc' }],
  });
  if (orphanSubs.length) {
    console.log(
      `\n  ${orphanSubs.length} active sub-domain(s) are not in ${versionLabel} ` +
      `(likely renamed by this version). NOT deactivated automatically — review and ` +
      `deactivate via Settings > Methodology if they are genuinely retired:`,
    );
    for (const s of orphanSubs) console.log(`    - ${s.domain.name} / ${s.name}`);
  }

  const otherVersions = await prisma.methodologyVersion.findMany({
    where: { id: { not: mv.id } },
    select: { version: true, status: true, _count: { select: { questions: true } } },
  });
  if (otherVersions.length) {
    console.log(`\n  other methodology versions present:`);
    for (const v of otherVersions) {
      console.log(`    - ${v.version} (${v.status}, ${v._count.questions} questions)`);
    }
    console.log(
      `    Each is isolated: a question's identity is (methodologyVersionId, questionId), ` +
      `and every Question Bank read filters by version.`,
    );
  }

  console.log('\nDone.');
}

main()
  .catch((e) => {
    console.error('\nImport failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
