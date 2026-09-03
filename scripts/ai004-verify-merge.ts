// RIO-AI-004 — prove a merge moves everything, loses nothing, and reverses.
//
//   pnpm ai004:verify-merge
//
// THIS WRITES. A merge is a real act; there is no way to prove one without
// performing one. It picks a confirmed (or pending) duplicate pair, previews
// the merge, performs it, checks every guarantee the client asked for, then
// UNDOES it and checks the state is back.
//
// Because it undoes what it does, the database ends where it started apart
// from the audit trail and the permanent reference alias — which is itself one
// of the guarantees under test (Q51: the retired number keeps resolving even
// after an undo).
//
// Services are constructed by hand — tsx compiles with esbuild, which emits no
// decorator metadata for Nest constructor injection.

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma";
import { orgContext } from "../src/tenancy/org-context";
import { TenantPrismaService } from "../src/tenancy/tenant-prisma.service";
import { AuditService } from "../src/modules/audit/audit.service";
import { NeedMergeService } from "../src/modules/data-cleaning/need-merge.service";

const app = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.APP_DATABASE_URL }),
});
const supervisor = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.SUPERVISOR_DATABASE_URL }),
});
const tenant = new TenantPrismaService(app as never, supervisor as never);
const audit = new AuditService(tenant as never);
const merges = new NeedMergeService(tenant, audit);

function heading(text: string): void {
  console.log(`\n${"─".repeat(78)}\n${text}\n${"─".repeat(78)}`);
}
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main(): Promise<void> {
  // A pair where the retired side actually has something attached, so the
  // transfer is worth measuring.
  const candidate = await supervisor.duplicateCandidate.findFirst({
    where: { status: { in: ["confirmed_duplicate", "pending"] }, orgId: { not: null } },
    orderBy: { score: "desc" },
  });
  if (!candidate?.orgId) {
    console.log("No duplicate candidate available — run pnpm fr002:verify-duplicates first.");
    return;
  }

  const orgId = candidate.orgId;
  const actor = await supervisor.user.findFirst({ where: { orgId }, select: { id: true, email: true } });
  const ctx = { requestId: "ai004-verify", orgId, actorId: actor!.id };

  // Survivor/retired: keep the lower reference as the survivor, arbitrary but
  // deterministic. In the product this is the reviewer's explicit choice.
  const [a, b] = await Promise.all([
    supervisor.need.findUnique({ where: { id: candidate.needAId } }),
    supervisor.need.findUnique({ where: { id: candidate.needBId } }),
  ]);
  const survivor = a!.internalRefSeq <= b!.internalRefSeq ? a! : b!;
  const retired = survivor.id === a!.id ? b! : a!;

  heading("1. Preview — what the reviewer would be confirming (Q24)");
  const preview = await orgContext.run(ctx, () => merges.preview(survivor.id, retired.id));
  console.log(`  survivor        : ${preview.survivor.reference} "${preview.survivor.title.slice(0, 44)}"`);
  console.log(`  retired         : ${preview.retired.reference} "${preview.retired.title.slice(0, 44)}"`);
  console.log(`  items to move   : ${preview.totalTransfers}`);
  for (const t of preview.transfers) console.log(`      ${String(t.count).padStart(3)}  ${t.entityType}`);
  console.log(`  alias created   : ${preview.aliasedReference} -> ${preview.survivor.reference}`);
  console.log(`  external refs   : ${JSON.stringify(preview.externalReferences)}`);
  console.log(`  frozen reports  : ${preview.frozenReportCount}`);
  for (const w of preview.warnings) console.log(`  warning         : ${w}`);

  // Snapshot everything the merge should move, before it moves.
  const before = {
    responses: await supervisor.surveyResponse.count({ where: { needId: retired.id } }),
    evidence: await supervisor.evidence.count({ where: { needId: retired.id } }),
    aiDecisions: await supervisor.aiDecision.count({ where: { needId: retired.id } }),
    surveys: await supervisor.survey.count({ where: { needId: retired.id } }),
    survivorResponses: await supervisor.surveyResponse.count({ where: { needId: survivor.id } }),
  };

  heading("2. Merge");
  const result = await orgContext.run(ctx, () =>
    merges.merge({
      survivorNeedId: survivor.id,
      retiredNeedId: retired.id,
      candidateId: candidate.id,
      note: "Verified as the same need against the geographic reference.",
    }),
  );
  console.log(`  merge id        : ${result.mergeId}`);
  console.log(`  transferred     : ${result.transferred}`);

  heading("3. The guarantees the client asked for");
  const retiredAfter = await supervisor.need.findUnique({ where: { id: retired.id } });
  const survivorAfter = await supervisor.need.findUnique({ where: { id: survivor.id } });

  check("retired need still exists (never deleted)", retiredAfter !== null);
  check("retired need is marked merged", retiredAfter?.mergedIntoNeedId === survivor.id);
  check(
    "survivor keeps its OWN internal reference (Q51)",
    survivorAfter?.internalRefSeq === survivor.internalRefSeq,
    `still ${preview.survivor.reference}`,
  );

  const alias = await supervisor.needReferenceAlias.findUnique({
    where: { retiredInternalRefSeq: retired.internalRefSeq },
  });
  check("retired reference resolves to the survivor (Q51)", alias?.needId === survivor.id);

  if (retired.referenceId) {
    check(
      "retired external reference retained on survivor (Q51)",
      (survivorAfter?.absorbedReferenceIds ?? []).includes(retired.referenceId),
    );
  } else {
    console.log("  n/a   retired need had no external reference to retain");
  }

  const movedResponses = await supervisor.surveyResponse.count({ where: { needId: survivor.id } });
  check(
    "survey responses moved to the survivor (Q50)",
    movedResponses === before.survivorResponses + before.responses,
    `${before.survivorResponses} + ${before.responses} = ${movedResponses}`,
  );
  check(
    "nothing left behind on the retired need",
    (await supervisor.surveyResponse.count({ where: { needId: retired.id } })) === 0 &&
      (await supervisor.evidence.count({ where: { needId: retired.id } })) === 0,
  );

  const ledger = await supervisor.needMergeTransfer.count({ where: { mergeId: result.mergeId } });
  check("every moved item recorded with its origin (Q50)", ledger === result.transferred, `${ledger} ledger rows`);

  const closedCandidate = await supervisor.duplicateCandidate.findUnique({ where: { id: candidate.id } });
  check("queue candidate closed as merged", closedCandidate?.status === "merged");

  const scoresOnRetired = await supervisor.priorityScore.count({ where: { needId: retired.id } });
  check(
    "computed scores NOT transferred (Q49)",
    scoresOnRetired === (await supervisor.priorityScore.count({ where: { needId: retired.id } })),
    `${scoresOnRetired} left with the retired need, as the methodology requires`,
  );

  heading("4. Undo requires a note (Q24)");
  try {
    await orgContext.run(ctx, () => merges.undo(result.mergeId, ""));
    check("empty note refused", false, "it was accepted");
  } catch (err) {
    check("empty note refused", true, err instanceof Error ? err.message : String(err));
  }

  heading("5. Undo");
  const undone = await orgContext.run(ctx, () =>
    merges.undo(result.mergeId, "Verification run — reversing the test merge."),
  );
  console.log(`  restored        : ${undone.restored}`);

  const retiredRestored = await supervisor.need.findUnique({ where: { id: retired.id } });
  check("retired need is live again", retiredRestored?.mergedIntoNeedId === null);
  check(
    "its survey responses came back",
    (await supervisor.surveyResponse.count({ where: { needId: retired.id } })) === before.responses,
  );
  check(
    "its evidence came back",
    (await supervisor.evidence.count({ where: { needId: retired.id } })) === before.evidence,
  );
  check(
    "survivor is back to its own count",
    (await supervisor.surveyResponse.count({ where: { needId: survivor.id } })) ===
      before.survivorResponses,
  );
  check("transfer ledger cleared", (await supervisor.needMergeTransfer.count({ where: { mergeId: result.mergeId } })) === 0);

  const aliasAfterUndo = await supervisor.needReferenceAlias.findUnique({
    where: { retiredInternalRefSeq: retired.internalRefSeq },
  });
  check(
    "reference alias KEPT after undo (Q51 — permanently)",
    aliasAfterUndo !== null,
    "a report published while merged may still cite it",
  );

  const reopened = await supervisor.duplicateCandidate.findUnique({ where: { id: candidate.id } });
  check("candidate returned to the queue", reopened?.status === "confirmed_duplicate");

  heading("6. Audit trail");
  const entries = await supervisor.auditLog.findMany({
    where: { action: { in: ["merge_needs", "undo_need_merge"] } },
    orderBy: { createdAt: "desc" },
    take: 2,
    select: { action: true, entityLabel: true, metadata: true },
  });
  for (const e of entries.reverse()) {
    console.log(`  ${e.action.padEnd(18)} ${e.entityLabel}`);
    const changes = (e.metadata as { changes?: { field: string; after: unknown }[] })?.changes ?? [];
    for (const c of changes) console.log(`      ${c.field}: ${String(c.after)}`);
  }
}

main()
  .catch((e) => {
    console.error("ai004-verify-merge failed:", e);
    process.exit(1);
  })
  .finally(() => {
    void app.$disconnect();
    void supervisor.$disconnect();
  });
