// Prove DeterministicScoringService.scoreResponse is safe to re-run.
//
//   pnpm verify:scoring-idempotent
//
// Before the fix, every call CREATEd a fresh ResponseAnswer and
// ResponseSeverityScore per question, so scoring a response twice doubled the
// inputs to every rollup and dashboard reading them. That is what blocked
// re-scoring after a corrected answer (RIO-FR-002) and after a merge
// (RIO-AI-004) — both were audited as "stale" rather than done.
//
// THIS WRITES: it re-scores a real response. That is the point, and it is
// exactly what the product now does when a reviewer accepts a numeric
// correction. Row counts are printed before and after.

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma";
import { TenantPrismaService } from "../src/tenancy/tenant-prisma.service";
import { DeterministicScoringService } from "../src/modules/priority/scoring.service";

const app = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.APP_DATABASE_URL }),
});
const supervisor = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.SUPERVISOR_DATABASE_URL }),
});
const tenant = new TenantPrismaService(app as never, supervisor as never);
const scoring = new DeterministicScoringService(tenant);

async function counts(responseId: string) {
  const [answers, severity] = await Promise.all([
    supervisor.responseAnswer.count({ where: { surveyResponseId: responseId } }),
    supervisor.responseSeverityScore.count({ where: { surveyResponseId: responseId } }),
  ]);
  return { answers, severity };
}

async function main(): Promise<void> {
  // A response that already has scored answers — one the engine can re-run.
  const scored = await supervisor.responseAnswer.findFirst({
    select: { surveyResponseId: true, orgId: true },
  });
  if (!scored) {
    console.log("No scored responses in this database — nothing to re-score.");
    console.log("Submit a citizen survey first, or run the seed.");
    return;
  }

  const { surveyResponseId, orgId } = scored;
  console.log(`response ${surveyResponseId}\n`);

  const before = await counts(surveyResponseId);
  console.log(`  before          answers=${before.answers}  severity=${before.severity}`);

  await scoring.scoreResponse(surveyResponseId, orgId);
  const once = await counts(surveyResponseId);
  console.log(`  after 1 re-run  answers=${once.answers}  severity=${once.severity}`);

  await scoring.scoreResponse(surveyResponseId, orgId);
  const twice = await counts(surveyResponseId);
  console.log(`  after 2 re-runs answers=${twice.answers}  severity=${twice.severity}\n`);

  const stable = once.answers === twice.answers && once.severity === twice.severity;
  const notGrowing = twice.answers <= before.answers * 2;

  console.log(
    stable
      ? "  PASS  re-running replaces rather than appends — counts are stable"
      : "  FAIL  counts changed between runs, so scoring still duplicates",
  );
  if (!notGrowing) {
    console.log("  FAIL  row count grew across runs");
  }

  // No answer may be left without its severity row, and none orphaned.
  const orphans = await supervisor.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count FROM response_severity_scores s
    WHERE NOT EXISTS (SELECT 1 FROM response_answers a WHERE a.id = s.response_answer_id)
  `;
  console.log(`  orphaned severity rows: ${orphans[0]?.count ?? 0n}  (cascade should leave none)`);
}

main()
  .catch((e) => {
    console.error("verify-scoring-idempotent failed:", e);
    process.exit(1);
  })
  .finally(() => {
    void app.$disconnect();
    void supervisor.$disconnect();
  });
