// RIO-FR-002 — prove the numeric adapter finds answers that scoring drops.
//
//   pnpm fr002:verify-numeric
//
// Runs the real cleanSurveyResponse over real survey responses, then reports
// what the numeric rule flagged, alongside the answers whose stored
// ResponseAnswer came out entirely null — the ones the severity score never
// saw, because parseRawAnswerValue does Number(raw) and got NaN.
//
// Services are constructed by hand for the reason given in
// fr002-verify-write.ts (tsx compiles with esbuild, which emits no decorator
// metadata for Nest constructor injection).

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma";
import { TenantPrismaService } from "../src/tenancy/tenant-prisma.service";
import { CleaningContextService } from "../src/modules/data-cleaning/cleaning-context.service";
import { DataCleaningService } from "../src/modules/data-cleaning/data-cleaning.service";
import { DuplicateDetectionService } from "../src/modules/data-cleaning/duplicate-detection.service";

const app = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.APP_DATABASE_URL }),
});
const supervisor = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.SUPERVISOR_DATABASE_URL }),
});
const tenant = new TenantPrismaService(app as never, supervisor as never);
const context = new CleaningContextService(app as never);
const detection = new DuplicateDetectionService(tenant, context);
const cleaning = new DataCleaningService(tenant, context, detection);

function heading(text: string): void {
  console.log(`\n${"─".repeat(78)}\n${text}\n${"─".repeat(78)}`);
}

async function main(): Promise<void> {
  const ctx = await context.load();

  heading("1. Numeric questions loaded from the question bank");
  console.log(`  numeric questions  : ${ctx.numericQuestions.size}`);
  const specs = [...ctx.numericQuestions.values()];
  const withUnit = specs.filter((q) => q.expectedUnit !== null);
  console.log(`  with a stated unit : ${withUnit.length}`);
  for (const q of withUnit.slice(0, 8)) {
    console.log(
      `    ${q.questionCode.padEnd(8)} unit=${String(q.expectedUnit).padEnd(8)} scoring scale ${q.scoringFloor}..${q.scoringCeiling}`,
    );
  }
  const noUnit = specs.filter((q) => q.expectedUnit === null);
  if (noUnit.length > 0) {
    console.log(`\n  No unit stated in the question text (client question):`);
    for (const q of noUnit) {
      console.log(`    ${q.questionCode.padEnd(8)} ${q.questionText.slice(0, 66)}`);
    }
  }

  heading("2. Answers already lost to scoring (Number(raw) -> NaN -> null)");
  const dropped = await supervisor.$queryRaw<{ question_id: string; count: bigint }[]>`
    SELECT question_id, count(*) AS count
    FROM response_answers
    WHERE answer_numeric_value IS NULL
      AND answer_option_id IS NULL
      AND answer_text IS NULL
      AND answer_option_ids IS NULL
    GROUP BY question_id
    ORDER BY count DESC
    LIMIT 10
  `;
  if (dropped.length === 0) {
    console.log("  none in this database — the seeded answers are all plain numbers.");
  }
  for (const row of dropped) {
    console.log(`    ${row.question_id.padEnd(10)} ${row.count}`);
  }

  heading("3. Running cleaning over real survey responses");
  const responses = await supervisor.surveyResponse.findMany({
    select: { id: true, orgId: true },
    take: 40,
  });
  for (const r of responses) await cleaning.cleanSurveyResponse(r.id, r.orgId);
  console.log(`  responses cleaned: ${responses.length}`);

  const flags = await supervisor.cleaningFlag.findMany({
    where: { source: "survey_response", field: { startsWith: "answers[" } },
    select: { field: true, ruleCode: true, originalValue: true, proposedValue: true },
  });
  console.log(`  numeric answer flags: ${flags.length}`);
  const byRule = new Map<string, number>();
  for (const f of flags) byRule.set(f.ruleCode, (byRule.get(f.ruleCode) ?? 0) + 1);
  for (const [rule, count] of byRule) console.log(`    ${String(count).padStart(4)}  ${rule}`);
  for (const f of flags.slice(0, 8)) {
    console.log(
      `    ${f.field.padEnd(18)} "${f.originalValue}" -> ${f.proposedValue ?? "no proposal"}`,
    );
  }

  heading("4. All survey-response flags, by rule");
  const all = await supervisor.cleaningFlag.groupBy({
    by: ["ruleCode"],
    where: { source: "survey_response" },
    _count: { _all: true },
  });
  for (const row of all.sort((a, b) => b._count._all - a._count._all)) {
    console.log(`    ${String(row._count._all).padStart(4)}  ${row.ruleCode}`);
  }
}

main()
  .catch((e) => {
    console.error("fr002-verify-numeric failed:", e);
    process.exit(1);
  })
  .finally(() => {
    void app.$disconnect();
    void supervisor.$disconnect();
  });
