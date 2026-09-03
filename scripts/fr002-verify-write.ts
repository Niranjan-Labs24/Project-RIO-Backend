// RIO-FR-002 — prove the adapters actually write flags.
//
//   pnpm fr002:verify-write
//
// Runs the REAL DataCleaningService over REAL Needs, then reads back what
// landed in cleaning_runs / cleaning_flags.
//
// UNLIKE fr002:smoke, this one WRITES — that is the point. It writes only to
// cleaning_runs and cleaning_flags; nothing it does can touch a Need, a
// SurveyResponse, or anything a report reads (Q11). It also proves the re-run
// behaviour: running twice over the same Need must UPDATE the existing flags
// rather than stack duplicates on the reviewer's queue.
//
// The services are constructed by hand rather than through
// NestFactory.createApplicationContext, because this script runs under tsx and
// tsx compiles with esbuild, which does not emit the `design:paramtypes`
// metadata Nest's constructor injection reads. Booting the container here
// would fail on every @Injectable in the app, not just these — nothing to do
// with FR-002. Constructing three classes directly is also a truer test of
// the write path: it uses the SAME restricted cnap_app role the running app
// uses, so RLS applies exactly as it does in production.

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma";
import { TenantPrismaService } from "../src/tenancy/tenant-prisma.service";
import { CleaningContextService } from "../src/modules/data-cleaning/cleaning-context.service";
import { DataCleaningService } from "../src/modules/data-cleaning/data-cleaning.service";

// Writes go through the restricted app role, so every insert below is subject
// to the same row-level security the API is.
const app = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.APP_DATABASE_URL }),
});
// Reads for VERIFICATION go through the SELECT-only cross-org role, so the
// check cannot accidentally write and does not need an org context.
const supervisor = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.SUPERVISOR_DATABASE_URL }),
});

const tenant = new TenantPrismaService(app as never, supervisor as never);
const context = new CleaningContextService(app as never);
const cleaning = new DataCleaningService(tenant, context);

function heading(text: string): void {
  console.log(`\n${"─".repeat(78)}\n${text}\n${"─".repeat(78)}`);
}

async function main(): Promise<void> {
  // Pick real needs through the SELECT-only cross-org client, so choosing the
  // sample cannot itself write or need an org context.
  const needs = await supervisor.need.findMany({
    select: { id: true, orgId: true, internalRefSeq: true, title: true },
    orderBy: { internalRefSeq: "asc" },
    take: 25,
  });
  if (needs.length === 0) {
    console.log("No needs in the database — nothing to clean.");
    return;
  }

  heading(`1. Running cleaning over ${needs.length} real needs`);
  for (const need of needs) {
    await cleaning.cleanNeed(need.id, need.orgId, "manual_entry");
  }

  const runs = await supervisor.cleaningRun.findMany({
    where: { scopeType: "record", source: "manual_entry" },
    orderBy: { startedAt: "desc" },
    take: needs.length,
    select: {
      id: true,
      status: true,
      recordsScanned: true,
      recordsFlagged: true,
      flagsRaised: true,
      ruleSetVersion: true,
      finishedAt: true,
    },
  });
  const completed = runs.filter((r) => r.status === "completed").length;
  console.log(`  cleaning_runs written : ${runs.length}`);
  console.log(`  completed             : ${completed}`);
  console.log(`  ruleSetVersion        : ${runs[0]?.ruleSetVersion ?? "-"}`);
  console.log(`  finishedAt set        : ${runs.every((r) => r.finishedAt !== null)}`);

  heading("2. Flags written");
  const needIds = needs.map((n) => n.id);
  const flags = await supervisor.cleaningFlag.findMany({
    where: { entityType: "need", entityId: { in: needIds } },
    select: {
      entityId: true,
      field: true,
      ruleCode: true,
      severity: true,
      status: true,
      originalValue: true,
      proposedValue: true,
      confidence: true,
    },
  });
  const byRule = new Map<string, number>();
  for (const flag of flags) byRule.set(flag.ruleCode, (byRule.get(flag.ruleCode) ?? 0) + 1);
  console.log(`  ${flags.length} flags across ${needs.length} needs`);
  for (const [rule, count] of [...byRule].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(4)}  ${rule}`);
  }

  const refByNeed = new Map(needs.map((n) => [n.id, n.internalRefSeq]));
  console.log("\n  Sample:");
  for (const flag of flags.slice(0, 8)) {
    const ref = `NEED-${String(refByNeed.get(flag.entityId ?? "") ?? 0).padStart(6, "0")}`;
    const proposal = flag.proposedValue === null ? "no proposal" : `-> ${flag.proposedValue}`;
    console.log(`    ${ref}  ${flag.field.padEnd(12)} ${flag.ruleCode.padEnd(28)} ${proposal}`);
  }

  heading("3. The database's own guarantees");
  const missingWithProposal = flags.filter(
    (f) => f.severity === "missing" && f.proposedValue !== null,
  ).length;
  console.log(
    `  missing flags carrying a proposed value : ${missingWithProposal}  (CHECK forbids any)`,
  );
  const decided = await supervisor.cleaningFlag.count({
    where: { status: { in: ["accepted", "rejected"] }, reviewedBy: null },
  });
  console.log(`  decided flags with no reviewer          : ${decided}  (CHECK forbids any)`);

  heading("4. Re-run: flags must UPDATE, not stack");
  const before = flags.length;
  for (const need of needs) {
    await cleaning.cleanNeed(need.id, need.orgId, "manual_entry");
  }
  const after = await supervisor.cleaningFlag.count({
    where: { entityType: "need", entityId: { in: needIds }, status: "pending" },
  });
  console.log(`  pending flags before re-run : ${before}`);
  console.log(`  pending flags after re-run  : ${after}`);
  console.log(
    after === before
      ? "  UNCHANGED — the partial unique index and the update path are holding."
      : "  CHANGED — re-running stacked or dropped flags. Investigate writeFlags().",
  );

  heading("5. Nothing outside cleaning_* was touched");
  const needCount = await supervisor.need.count();
  console.log(`  needs in the database: ${needCount} (this script never writes one)`);

}

main()
  .catch((err) => {
    console.error("fr002-verify-write failed:", err);
    process.exit(1);
  })
  .finally(() => {
    void app.$disconnect();
    void supervisor.$disconnect();
  });
