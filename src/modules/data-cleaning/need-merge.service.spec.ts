import { describe, expect, it, vi } from "vitest";
import { orgContext } from "../../tenancy/org-context";
import { NeedMergeService } from "./need-merge.service";

/**
 * RIO-AI-004 — the guards that stop a merge losing data.
 *
 * The happy path is covered end-to-end against a real database by
 * `pnpm ai004:verify-merge`, which performs a merge, asserts every guarantee
 * the client asked for in Q49/Q50/Q51/Q24, and then undoes it. These tests
 * cover the refusals — the cases where merging would quietly strand rows on a
 * need nothing can see.
 */

const CTX = { requestId: "t", orgId: "org-1", actorId: "user-1" };

function needRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "need-a",
    orgId: "org-1",
    studyId: "study-1",
    internalRefSeq: 1,
    title: "A",
    referenceId: null,
    absorbedReferenceIds: [],
    mergedIntoNeedId: null,
    ...over,
  };
}

/** A tx stub whose need.findUnique answers from a map of id -> row. */
function serviceWith(rows: Record<string, ReturnType<typeof needRow> | null>) {
  const tx = {
    need: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows[where.id] ?? null),
    },
  };
  const tenant = {
    runInOrgContext: <T>(fn: (t: unknown) => Promise<T>) => fn(tx),
  };
  const audit = { record: vi.fn(async () => undefined) };
  // Q24's re-score of the surviving need. Best-effort in the service and
  // covered end-to-end by ai004:verify-merge — the stub only has to resolve,
  // since these tests are about the refusals.
  const priority = { score: vi.fn(async () => undefined) };
  return new NeedMergeService(tenant as never, audit as never, priority as never);
}

async function expectRefusal(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({
    response: { error: { code } },
  });
}

describe("NeedMergeService guards", () => {
  it("refuses to merge a need into itself", async () => {
    const service = serviceWith({ "need-a": needRow() });
    await orgContext.run(CTX, () =>
      expectRefusal(service.preview("need-a", "need-a"), "SAME_NEED"),
    );
  });

  it("refuses when either need is gone", async () => {
    const service = serviceWith({ "need-a": needRow(), "need-b": null });
    await orgContext.run(CTX, () =>
      expectRefusal(service.preview("need-a", "need-b"), "NEED_NOT_FOUND"),
    );
  });

  it("refuses to merge INTO a need that has itself been merged away", async () => {
    // Otherwise the rows land on a need that every list already hides, which
    // is exactly how data goes quietly missing.
    const service = serviceWith({
      "need-a": needRow({ id: "need-a", mergedIntoNeedId: "need-c" }),
      "need-b": needRow({ id: "need-b", internalRefSeq: 2 }),
    });
    await orgContext.run(CTX, () =>
      expectRefusal(service.preview("need-a", "need-b"), "SURVIVOR_ALREADY_MERGED"),
    );
  });

  it("refuses to merge a need that is already merged", async () => {
    const service = serviceWith({
      "need-a": needRow({ id: "need-a" }),
      "need-b": needRow({ id: "need-b", internalRefSeq: 2, mergedIntoNeedId: "need-c" }),
    });
    await orgContext.run(CTX, () =>
      expectRefusal(service.preview("need-a", "need-b"), "ALREADY_MERGED"),
    );
  });

  it("refuses to merge across entities", async () => {
    // Q9 confines cross-entity visibility to the Center/NCNP role, and nothing
    // in the client's answers authorises moving one entity's data into
    // another's.
    const service = serviceWith({
      "need-a": needRow({ id: "need-a" }),
      "need-b": needRow({ id: "need-b", internalRefSeq: 2, orgId: "org-2" }),
    });
    await orgContext.run(CTX, () =>
      expectRefusal(service.preview("need-a", "need-b"), "CROSS_ORG_MERGE"),
    );
  });

  it("requires a note to undo (Q24)", async () => {
    const service = serviceWith({});
    await orgContext.run(CTX, () => expectRefusal(service.undo("merge-1", "   "), "NOTE_REQUIRED"));
  });
});

/**
 * RIO-AI-004 — closing pairs stranded by a merge is NOT unit-tested here, and
 * that is deliberate.
 *
 * The behaviour is: retiring a need closes every other open pair that mentions
 * it, and undo reopens them. Exercising that needs the real merge transaction,
 * which spans eleven models — stubbing all of them produces a test that asserts
 * the shape of its own mock rather than what the service does. A first attempt
 * at exactly that was written and deleted: every assertion passed against
 * hand-built literals and would have passed with the service removed.
 *
 * It IS verified, against a real database, by `pnpm ai004:verify-merge`:
 *
 *   "no open duplicate pair still references the retired need"
 *   "pairs superseded by the merge are open again after undo"
 *
 * plus the cross-entity half, which an org-scoped stub could not reach at all
 * because those rows carry org_id NULL and live behind row-level security.
 */
