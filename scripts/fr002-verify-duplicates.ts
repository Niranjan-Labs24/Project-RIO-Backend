// RIO-FR-002 — prove the literal duplicate pass proposes real pairs, and that
// a reviewer decision on one is recorded without merging anything.
//
//   pnpm fr002:verify-duplicates
//
// THIS WRITES to duplicate_candidates. It cannot write anywhere else: Q11
// makes "propose only" a property of the schema, and the last section of this
// script checks that both needs in a decided pair are byte-for-byte unchanged.
//
// Services are constructed by hand for the reason given in
// fr002-verify-write.ts — tsx compiles with esbuild, which does not emit the
// decorator metadata Nest constructor injection reads.

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma";
import { orgContext } from "../src/tenancy/org-context";
import { TenantPrismaService } from "../src/tenancy/tenant-prisma.service";
import { AuditService } from "../src/modules/audit/audit.service";
import { CleaningContextService } from "../src/modules/data-cleaning/cleaning-context.service";
import { DuplicateDetectionService } from "../src/modules/data-cleaning/duplicate-detection.service";
import { DuplicateReviewService } from "../src/modules/data-cleaning/duplicate-review.service";

const app = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.APP_DATABASE_URL }),
});
const supervisor = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.SUPERVISOR_DATABASE_URL }),
});

const tenant = new TenantPrismaService(app as never, supervisor as never);
const context = new CleaningContextService(app as never);
const audit = new AuditService(tenant as never);
const detection = new DuplicateDetectionService(tenant, context);
const review = new DuplicateReviewService(tenant, audit);

function heading(text: string): void {
  console.log(`\n${"─".repeat(78)}\n${text}\n${"─".repeat(78)}`);
}

async function main(): Promise<void> {
  const { settings } = await context.load();

  heading("1. Detector settings (Q23 — start conservative, tune later)");
  console.log(`  threshold : ${settings.literalDuplicateThreshold}`);
  console.log(`  scopes    : ${JSON.stringify(settings.duplicateScopes)}`);

  const needs = await supervisor.need.findMany({
    select: { id: true, orgId: true, internalRefSeq: true },
    orderBy: { internalRefSeq: "asc" },
    take: 60,
  });

  heading(`2. Running the literal pass over ${needs.length} real needs`);
  let proposed = 0;
  for (const need of needs) {
    proposed += await detection.detectForNeed(need.id, need.orgId);
  }
  console.log(`  new candidates proposed: ${proposed}`);

  const all = await supervisor.duplicateCandidate.groupBy({
    by: ["method", "scope", "status"],
    _count: { _all: true },
  });
  for (const row of all) {
    console.log(
      `    ${String(row._count._all).padStart(4)}  ${row.method} · ${row.scope} · ${row.status}`,
    );
  }

  heading("3. Pair invariants the database enforces");
  const unordered = await supervisor.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count FROM duplicate_candidates WHERE need_a_id >= need_b_id
  `;
  console.log(`  pairs stored out of order      : ${unordered[0]?.count ?? 0n}  (CHECK forbids any)`);
  const selfPairs = await supervisor.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count FROM duplicate_candidates WHERE need_a_id = need_b_id
  `;
  console.log(`  needs paired with themselves   : ${selfPairs[0]?.count ?? 0n}`);
  const crossOrgLeak = await supervisor.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count FROM duplicate_candidates
    WHERE (scope = 'cross_org') <> (org_id IS NULL)
  `;
  console.log(`  cross-org rows with an owner   : ${crossOrgLeak[0]?.count ?? 0n}  (CHECK forbids any)`);

  const candidate = await supervisor.duplicateCandidate.findFirst({
    where: { status: "pending" },
    orderBy: { score: "desc" },
  });
  if (!candidate) {
    console.log("\nNo pending candidate to decide on — stopping here.");
    return;
  }

  const [needA, needB] = await Promise.all([
    supervisor.need.findUnique({
      where: { id: candidate.needAId },
      select: { internalRefSeq: true, title: true, statement: true, updatedAt: true },
    }),
    supervisor.need.findUnique({
      where: { id: candidate.needBId },
      select: { internalRefSeq: true, title: true, statement: true, updatedAt: true },
    }),
  ]);

  heading("4. Deciding the strongest pending pair");
  console.log(`  similarity : ${Number(candidate.score).toFixed(3)} (${candidate.method})`);
  console.log(`  A          : NEED-${String(needA?.internalRefSeq).padStart(6, "0")} "${needA?.title}"`);
  console.log(`  B          : NEED-${String(needB?.internalRefSeq).padStart(6, "0")} "${needB?.title}"`);

  const actor = await supervisor.user.findFirst({
    where: { orgId: candidate.orgId ?? undefined },
    select: { id: true, email: true },
  });
  const decided = await orgContext.run(
    { requestId: "verify-duplicates", orgId: candidate.orgId!, actorId: actor!.id },
    () => review.decide(candidate.id, "confirmed_duplicate", undefined),
  );
  console.log(`  decided as : ${decided.status} by ${actor?.email}`);

  heading("5. Confirming a duplicate must NOT change either need (Q11)");
  const [afterA, afterB] = await Promise.all([
    supervisor.need.findUnique({
      where: { id: candidate.needAId },
      select: { title: true, statement: true, updatedAt: true },
    }),
    supervisor.need.findUnique({
      where: { id: candidate.needBId },
      select: { title: true, statement: true, updatedAt: true },
    }),
  ]);
  const unchanged =
    afterA?.title === needA?.title &&
    afterA?.statement === needA?.statement &&
    afterA?.updatedAt.getTime() === needA?.updatedAt.getTime() &&
    afterB?.title === needB?.title &&
    afterB?.statement === needB?.statement &&
    afterB?.updatedAt.getTime() === needB?.updatedAt.getTime();
  console.log(
    unchanged
      ? "  BOTH UNCHANGED — including updatedAt. Nothing was merged, as intended."
      : "  A NEED CHANGED — confirming a duplicate must never touch a record.",
  );

  heading("6. Audit trail (AC 4)");
  const entries = await supervisor.auditLog.findMany({
    where: { action: "review_duplicate_candidate" },
    orderBy: { createdAt: "desc" },
    take: 1,
    select: { action: true, entityType: true, entityLabel: true, metadata: true },
  });
  for (const entry of entries) {
    console.log(`  ${entry.action} · ${entry.entityType} · ${entry.entityLabel}`);
    console.log(`    ${JSON.stringify((entry.metadata as { changes?: unknown })?.changes ?? {})}`);
  }

  heading("7. Re-deciding the same pair must be refused");
  try {
    await orgContext.run(
      { requestId: "verify-duplicates", orgId: candidate.orgId!, actorId: actor!.id },
      () => review.decide(candidate.id, "not_duplicate", "second decision"),
    );
    console.log("  ACCEPTED A SECOND DECISION — the already-decided guard is not holding.");
  } catch (err) {
    console.log(`  Refused, as it should be: ${err instanceof Error ? err.message : String(err)}`);
  }
}

main()
  .catch((err) => {
    console.error("fr002-verify-duplicates failed:", err);
    process.exit(1);
  })
  .finally(() => {
    void app.$disconnect();
    void supervisor.$disconnect();
  });
