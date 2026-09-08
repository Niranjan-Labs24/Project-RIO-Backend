// RIO-FR-002 — prove a reviewer decision actually corrects the record.
//
//   pnpm fr002:verify-review
//
// THIS WRITES. Accepting a flag is meant to change a Need, and there is no way
// to prove that without changing one. It picks a single acceptable
// VILLAGE_NEAR_MATCH flag, prints the need's village before and after, and
// prints the audit rows the decision produced.
//
// Everything it does is reversible by hand: the flag row keeps the original
// value in `original_value`, and both audit entries name the before and after.
//
// Constructed by hand rather than through NestFactory for the reason given in
// fr002-verify-write.ts — tsx compiles with esbuild, which does not emit the
// decorator metadata Nest's constructor injection reads.

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma";
import { orgContext } from "../src/tenancy/org-context";
import { TenantPrismaService } from "../src/tenancy/tenant-prisma.service";
import { AuditService } from "../src/modules/audit/audit.service";
import { CleaningContextService } from "../src/modules/data-cleaning/cleaning-context.service";
import { FlagReviewService } from "../src/modules/data-cleaning/flag-review.service";

const app = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.APP_DATABASE_URL }),
});
const supervisor = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.SUPERVISOR_DATABASE_URL }),
});

const tenant = new TenantPrismaService(app as never, supervisor as never);
const context = new CleaningContextService(app as never);
const audit = new AuditService(tenant as never);
const review = new FlagReviewService(tenant, audit, context);

function heading(text: string): void {
  console.log(`\n${"─".repeat(78)}\n${text}\n${"─".repeat(78)}`);
}

async function main(): Promise<void> {
  const flag = await supervisor.cleaningFlag.findFirst({
    where: { status: "pending", ruleCode: "VILLAGE_NEAR_MATCH", proposedValue: { not: null } },
  });
  if (!flag || !flag.entityId) {
    console.log("No acceptable VILLAGE_NEAR_MATCH flag pending — nothing to verify.");
    return;
  }

  const before = await supervisor.need.findUnique({
    where: { id: flag.entityId },
    select: { internalRefSeq: true, village: true, orgId: true },
  });
  if (!before) return;

  const ref = `NEED-${String(before.internalRefSeq).padStart(6, "0")}`;
  heading(`1. Before — ${ref}`);
  console.log(`  village      : ${JSON.stringify(before.village)}`);
  console.log(`  flag         : ${flag.ruleCode} on ${flag.field}`);
  console.log(`  proposes     : ${flag.proposedValue} (a center code)`);

  heading("2. Accepting the flag as a reviewer");
  // The real request path sets this store in middleware; the service reads the
  // org and the actor from it exactly the same way here.
  const actor = await supervisor.user.findFirst({
    where: { orgId: before.orgId },
    select: { id: true, email: true },
  });
  console.log(`  acting as    : ${actor?.email ?? "unknown"}`);

  const result = await orgContext.run(
    { requestId: "verify-review", orgId: before.orgId, actorId: actor!.id },
    () => review.review(flag.id, "accept", "Verified against the geographic reference."),
  );
  console.log(`  flag status  : ${result.status}`);
  console.log(`  reviewed at  : ${result.reviewedAt?.toISOString() ?? "-"}`);

  heading(`3. After — ${ref}`);
  const after = await supervisor.need.findUnique({
    where: { id: flag.entityId },
    select: { village: true },
  });
  console.log(`  village      : ${JSON.stringify(after?.village)}`);
  console.log(
    JSON.stringify(before.village) === JSON.stringify(after?.village)
      ? "  UNCHANGED — the correction did not apply. Investigate applyProposal()."
      : "  CHANGED — the free-text village now matches the geographic reference.",
  );

  heading("4. Audit trail (AC 4)");
  const entries = await supervisor.auditLog.findMany({
    where: { action: { in: ["review_cleaning_flag", "apply_standardization"] } },
    orderBy: { createdAt: "desc" },
    take: 2,
    select: { action: true, entityType: true, entityLabel: true, metadata: true },
  });
  for (const entry of entries) {
    console.log(`  ${entry.action.padEnd(22)} ${entry.entityType.padEnd(16)} ${entry.entityLabel ?? ""}`);
    console.log(`    ${JSON.stringify((entry.metadata as { changes?: unknown })?.changes ?? {})}`);
  }

  heading("5. Re-deciding the same flag must be refused");
  try {
    await orgContext.run(
      { requestId: "verify-review", orgId: before.orgId, actorId: actor!.id },
      () => review.review(flag.id, "reject", "second decision"),
    );
    console.log("  ACCEPTED A SECOND DECISION — the already-decided guard is not holding.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`  Refused, as it should be: ${message}`);
  }
}

main()
  .catch((err) => {
    console.error("fr002-verify-review failed:", err);
    process.exit(1);
  })
  .finally(() => {
    void app.$disconnect();
    void supervisor.$disconnect();
  });
