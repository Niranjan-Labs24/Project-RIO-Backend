// RIO-FR-002 — run the normalizer library against REAL data and print what it
// would flag.
//
//   pnpm fr002:smoke
//
// There is no reviewer UI yet (Week 3) and no adapter writing rows yet
// (Week 2), so this is how you check the rules actually behave on this
// platform's own data rather than on unit-test fixtures.
//
// READ-ONLY BY CONSTRUCTION: it connects with SUPERVISOR_DATABASE_URL, the
// cnap_supervisor role, which holds SELECT and nothing else. It cannot write a
// cleaning_flags row even if it tried, which is the point — Q11 says nothing
// is changed without a human, and a diagnostic script is not a human.

// Same env convention as prisma.config.ts — this runs outside Nest.
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma";
import {
  foldText,
  matchPlace,
  normalizeDomain,
  normalizeSubDomain,
  trigramSimilarity,
  type MethodologyVocabulary,
  type NormalizerFlag,
  type PlaceReference,
} from "../src/modules/data-cleaning/normalizers";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.SUPERVISOR_DATABASE_URL }),
});

interface CleaningSettings {
  ruleSetVersion?: string;
  dontKnowTreatment?: "excluded_answer" | "missing_value";
  requiredNeedFields?: string[];
  villageMatchAcceptThreshold?: number;
  villageMatchProposeThreshold?: number;
  villageMatchMaxCandidates?: number;
  literalDuplicateThreshold?: number;
}

function heading(text: string): void {
  console.log(`\n${"─".repeat(78)}\n${text}\n${"─".repeat(78)}`);
}

function describeFlag(flag: NormalizerFlag): string {
  const confidence = flag.confidence === null ? "" : ` (${flag.confidence.toFixed(2)})`;
  const proposal = flag.proposedValue === null ? "no proposal" : `-> ${flag.proposedValue}`;
  return `${flag.ruleCode}${confidence} ${proposal}`;
}

/** A missing field has no original value; print that as "(empty)", not "null". */
function describeOriginal(flag: NormalizerFlag): string {
  return flag.originalValue === null ? "(empty)" : `"${flag.originalValue}"`;
}

async function main(): Promise<void> {
  // ── The rule set in force ────────────────────────────────────────────────
  heading("1. Rule set (methodology_configs.data_cleaning_settings)");
  const config = await prisma.methodologyConfig.findFirst({
    select: { version: true, status: true, dataCleaningSettings: true },
  });
  if (!config) {
    console.log("  NO METHODOLOGY CONFIG ROW — the migration's seed had nothing to update.");
    return;
  }
  const settings = (config.dataCleaningSettings ?? {}) as CleaningSettings;
  console.log(`  methodology version : ${config.version} (${config.status})`);
  console.log(`  ruleSetVersion      : ${settings.ruleSetVersion ?? "(unset)"}`);
  console.log(`  dontKnowTreatment   : ${settings.dontKnowTreatment ?? "(unset)"}   <- Q13`);
  console.log(`  requiredNeedFields  : ${(settings.requiredNeedFields ?? []).join(", ") || "(unset)"}`);
  console.log(`  village accept/propose: ${settings.villageMatchAcceptThreshold} / ${settings.villageMatchProposeThreshold}`);
  console.log(`  literalDuplicate    : ${settings.literalDuplicateThreshold}   <- Q23, tune later`);

  const dontKnowTreatment = settings.dontKnowTreatment ?? "excluded_answer";
  const acceptThreshold = settings.villageMatchAcceptThreshold ?? 0.92;
  const proposeThreshold = settings.villageMatchProposeThreshold ?? 0.75;
  const maxCandidates = settings.villageMatchMaxCandidates ?? 5;
  const duplicateThreshold = settings.literalDuplicateThreshold ?? 0.85;

  // ── Folding agrees with the database ─────────────────────────────────────
  heading("2. foldText() vs rio_fold_text() on live rows");
  const sampleNames = await prisma.center.findMany({ select: { name: true }, take: 200 });
  let mismatches = 0;
  for (const { name } of sampleNames) {
    const rows = await prisma.$queryRaw<{ folded: string }[]>`
      SELECT rio_fold_text(${name}) AS folded
    `;
    if ((rows[0]?.folded ?? "") !== foldText(name)) mismatches++;
  }
  console.log(
    mismatches === 0
      ? `  ${sampleNames.length} real center names: TypeScript and Postgres agree on every one.`
      : `  ${mismatches}/${sampleNames.length} MISMATCHED — apply 20260902010000_fr002_deterministic_fold, then reindex.`,
  );

  // ── Missing core fields ──────────────────────────────────────────────────
  heading("3. Missing core fields across real needs (AC 1)");
  const needs = await prisma.need.findMany({
    select: {
      id: true,
      internalRefSeq: true,
      title: true,
      statement: true,
      village: true,
      domain: true,
      subDomain: true,
      affectedPopulation: true,
    },
    orderBy: { internalRefSeq: "asc" },
  });
  const required = settings.requiredNeedFields ?? ["title", "statement", "domain", "geography"];
  const missingCounts = new Map<string, number>();
  const bump = (field: string) => missingCounts.set(field, (missingCounts.get(field) ?? 0) + 1);

  for (const need of needs) {
    if (required.includes("title") && !need.title?.trim()) bump("title");
    if (required.includes("statement") && !need.statement?.trim()) bump("statement");
    if (required.includes("domain") && !need.domain?.trim()) bump("domain");
    if (required.includes("geography") && need.village.length === 0) bump("geography (village)");
    if (need.affectedPopulation === null) bump("affectedPopulation (soft)");
  }
  console.log(`  ${needs.length} needs scanned.`);
  if (missingCounts.size === 0) {
    console.log("  No required core field is missing on any need.");
  } else {
    for (const [field, count] of [...missingCounts].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(count).padStart(4)}  ${field}`);
    }
  }

  // ── Village resolution against the real geographic reference ─────────────
  heading("4. Village names vs the geographic reference (Q12)");
  const centers = await prisma.center.findMany({
    select: { code: true, name: true, governorate: { select: { name: true } } },
  });
  const reference: PlaceReference[] = centers.map((c) => ({
    code: c.code,
    name: c.name,
    governorate: c.governorate?.name,
  }));
  console.log(`  ${reference.length} centers in the reference.`);

  const villageOutcomes = new Map<string, number>();
  const villageExamples: string[] = [];
  for (const need of needs) {
    for (const village of need.village) {
      const result = matchPlace(village, {
        field: "village",
        required: true,
        dontKnowTreatment,
        reference,
        acceptThreshold,
        proposeThreshold,
        maxCandidates,
      });
      const code = result.flag?.ruleCode ?? "OK";
      villageOutcomes.set(code, (villageOutcomes.get(code) ?? 0) + 1);
      if (result.flag && villageExamples.length < 12) {
        villageExamples.push(
          `    NEED-${String(need.internalRefSeq).padStart(6, "0")}  "${village}"  ${describeFlag(result.flag)}`,
        );
      }
    }
  }
  for (const [code, count] of [...villageOutcomes].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(4)}  ${code}`);
  }
  if (villageExamples.length > 0) {
    console.log("\n  Examples:");
    villageExamples.forEach((line) => console.log(line));
  }

  // ── Domain / sub-domain vocabulary ───────────────────────────────────────
  heading("5. Domain / sub-domain vs the approved methodology list (Q12)");
  const domains = await prisma.domain.findMany({ select: { name: true } });
  const subDomains = await prisma.subDomain.findMany({
    select: { name: true, domain: { select: { name: true } } },
  });
  const vocabulary: MethodologyVocabulary[] = domains.map((d) => ({
    domain: d.name,
    subDomains: subDomains.filter((s) => s.domain?.name === d.name).map((s) => s.name),
  }));
  console.log(
    `  ${vocabulary.length} domains, ${subDomains.length} sub-domains in the approved list.`,
  );

  const classificationFindings: string[] = [];
  const classificationCounts = new Map<string, number>();
  for (const need of needs) {
    const domainResult = normalizeDomain(need.domain, {
      field: "domain",
      required: true,
      dontKnowTreatment,
      vocabulary,
      nearMatchThreshold: 0.5,
    });
    const resolvedDomain = domainResult.value ?? null;
    const subResult = normalizeSubDomain(need.subDomain, {
      field: "subDomain",
      required: false,
      dontKnowTreatment,
      vocabulary,
      nearMatchThreshold: 0.5,
      resolvedDomain,
    });
    for (const flag of [domainResult.flag, subResult.flag]) {
      if (!flag) continue;
      classificationCounts.set(flag.ruleCode, (classificationCounts.get(flag.ruleCode) ?? 0) + 1);
      if (classificationFindings.length < 12) {
        classificationFindings.push(
          `    NEED-${String(need.internalRefSeq).padStart(6, "0")}  ${describeOriginal(flag)}  ${describeFlag(flag)}`,
        );
      }
    }
  }
  if (classificationCounts.size === 0) {
    console.log("  Every need's domain and sub-domain is an approved value.");
  } else {
    for (const [code, count] of [...classificationCounts].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(count).padStart(4)}  ${code}`);
    }
    console.log("\n  Examples:");
    classificationFindings.forEach((line) => console.log(line));
  }

  // ── Literal duplicate candidates ─────────────────────────────────────────
  heading(`6. Literal duplicate candidates at threshold ${duplicateThreshold} (Q11 — proposals only)`);
  const folded = needs.map((n) => ({
    ref: `NEED-${String(n.internalRefSeq).padStart(6, "0")}`,
    title: n.title,
    key: foldText(`${n.title} ${n.statement}`),
    titleKey: foldText(n.title),
  }));

  const pairs: { a: string; b: string; score: number; aTitle: string; bTitle: string }[] = [];
  for (let i = 0; i < folded.length; i++) {
    for (let j = i + 1; j < folded.length; j++) {
      const left = folded[i]!;
      const right = folded[j]!;
      const score = Math.max(
        trigramSimilarity(left.key, right.key),
        trigramSimilarity(left.titleKey, right.titleKey),
      );
      if (score >= duplicateThreshold) {
        pairs.push({ a: left.ref, b: right.ref, score, aTitle: left.title, bTitle: right.title });
      }
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  const identical = pairs.filter((p) => p.score >= 0.999).length;
  console.log(
    `  ${((folded.length * (folded.length - 1)) / 2).toLocaleString()} pairs compared, ${pairs.length} above threshold.`,
  );
  console.log(
    `    ${identical} are byte-identical after folding; ${pairs.length - identical} are near-matches.`,
  );
  if (identical > pairs.length / 2) {
    console.log(
      "    NOTE: this database is largely e2e fixtures with repeated titles, so the candidate",
    );
    console.log(
      "    count here says more about the seed data than about the threshold. Q23 has the",
    );
    console.log("    threshold tuned once real field data exists.");
  }
  for (const pair of pairs.slice(0, 15)) {
    console.log(`    ${pair.score.toFixed(3)}  ${pair.a} / ${pair.b}`);
    console.log(`             "${pair.aTitle}"`);
    console.log(`             "${pair.bTitle}"`);
  }

  heading("Nothing was written. 0 rows inserted, 0 updated — this role holds SELECT only.");
}

main()
  .catch((err) => {
    console.error("fr002-smoke failed:", err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
