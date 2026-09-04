import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma";
import { orgContext } from "../src/tenancy/org-context";
import { TenantPrismaService } from "../src/tenancy/tenant-prisma.service";
import { CleaningContextService } from "../src/modules/data-cleaning/cleaning-context.service";
import { DuplicateDetectionService } from "../src/modules/data-cleaning/duplicate-detection.service";

/**
 * RIO-AI-004 — proves the cross-entity pass covers EVERY need.
 *
 * The defect: `runCrossOrgPass` took `limit = 200`, the controller called it
 * with no argument, and the query was `orderBy internalRefSeq asc, take: 200`.
 * Past 200 needs it compared the oldest 200 only and reported success — a
 * reviewer saw "0 proposed" and concluded there were no cross-entity
 * duplicates.
 *
 * A unit test cannot catch this: the cap looked deliberate, the function
 * returned cleanly, and every assertion about its behaviour on a small fixture
 * passed. It is only visible when the number of needs exceeds the cap, which is
 * exactly the condition that never occurs in a dev database.
 *
 * So this asserts the property directly against the real database:
 *
 *   scanned == the number of unmerged needs
 *
 * Read-only. It proposes candidates as any scan would, which is idempotent —
 * an existing pair is updated, not duplicated, and a decided pair is never
 * revisited.
 */

// Constructed by hand, as every verification script in this repo is:
// NestFactory.createApplicationContext does not work under tsx (esbuild emits
// no design:paramtypes, so constructor injection fails).
const app = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.APP_DATABASE_URL }),
});
const supervisor = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.SUPERVISOR_DATABASE_URL ?? process.env.DATABASE_URL,
  }),
});

async function main(): Promise<void> {
  console.log("\nRIO-AI-004 — cross-entity scan coverage\n");
  let failures = 0;
  const check = (label: string, ok: boolean, detail = ""): void => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures++;
  };

  const tenant = new TenantPrismaService(app as never, supervisor as never);
  // CleaningContextService only reads the methodology config, which is
  // platform-wide reference data — the supervisor client reads it fine.
  const context = new CleaningContextService(supervisor as never);
  const detection = new DuplicateDetectionService(tenant, context);

  const totalNeeds = await supervisor.need.count({ where: { mergedIntoNeedId: null } });
  const orgsWithNeeds = await supervisor.need.groupBy({
    by: ["orgId"],
    where: { mergedIntoNeedId: null },
  });
  console.log(
    `  ${totalNeeds} unmerged need(s) across ${orgsWithNeeds.length} organisation(s)\n`,
  );

  const settings = await supervisor.methodologyConfig.findFirst({
    select: { dataCleaningSettings: true },
  });
  const scopes = (settings?.dataCleaningSettings as { duplicateScopes?: { crossOrg?: boolean } })
    ?.duplicateScopes;
  if (scopes?.crossOrg !== true) {
    console.log(
      "  SKIP  cross-entity matching is switched off (duplicateScopes.crossOrg).\n" +
        "        Turn it on under Data Quality -> Cross-entity, then re-run.\n",
    );
    await Promise.all([app.$disconnect(), supervisor.$disconnect()]);
    return;
  }

  // Any org context will do: the pass reads through the supervisor path.
  const ctx = {
    requestId: "crossorg-coverage",
    orgId: orgsWithNeeds[0]?.orgId ?? "00000000-0000-0000-0000-000000000000",
    actorId: "00000000-0000-0000-0000-000000000000",
    role: "system_admin",
  };

  const started = Date.now();
  const result = await orgContext.run(ctx, () => detection.runCrossOrgPass());
  const elapsed = Date.now() - started;

  console.log(
    `  scanned ${result.scanned}, proposed ${result.proposed}, truncated ${result.truncated} (${elapsed}ms)\n`,
  );

  // The assertion the old implementation would have failed on any database
  // holding more than 200 needs.
  check(
    "every unmerged need was scanned",
    result.scanned === totalNeeds,
    `${result.scanned} of ${totalNeeds}`,
  );
  check("the run reports itself complete", result.truncated === false);

  // And that a bounded run says so, rather than looking like a clean sweep.
  if (totalNeeds > 1) {
    const bounded = await orgContext.run(ctx, () =>
      detection.runCrossOrgPass({ maxNeeds: 1 }),
    );
    check(
      "a bounded run reports truncated rather than success",
      bounded.truncated === true && bounded.scanned === 1,
      `scanned ${bounded.scanned}, truncated ${bounded.truncated}`,
    );
  } else {
    console.log("  SKIP  need more than one need to test the bounded case");
  }

  console.log(
    failures === 0
      ? "\n  Coverage verified.\n"
      : `\n  ${failures} check(s) FAILED.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
  await Promise.all([app.$disconnect(), supervisor.$disconnect()]);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
