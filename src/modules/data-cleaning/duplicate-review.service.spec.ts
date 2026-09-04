import { describe, expect, it, vi } from "vitest";
import { orgContext } from "../../tenancy/org-context";
import { DuplicateReviewService } from "./duplicate-review.service";

/**
 * RIO-AI-004 / Q9 — which connection a duplicate decision is written on.
 *
 * A cross-entity pair carries org_id NULL, so an UPDATE issued under the
 * reviewer's own org GUC matches no row and the reviewer sees a 404 on a pair
 * that is plainly on their screen. That is the bug these tests pin: the choice
 * of write path is decided by who OWNS the pair, not by who is deciding it.
 *
 * The policy itself is verified against a real database by
 * `pnpm ai004:verify-tenancy`, which proves the supervisor path reaches the
 * cross-entity rows and cannot touch anyone's org-owned ones.
 */

const CTX = { requestId: "t", orgId: "org-1", actorId: "user-1", role: "system_admin" };

function serviceWith(candidate: Record<string, unknown> | null) {
  const calls: string[] = [];
  const tx = {
    duplicateCandidate: {
      findUnique: vi.fn(async () => candidate),
      update: vi.fn(async () => ({ ...candidate, status: "not_duplicate" })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    need: { findMany: vi.fn(async () => []) },
  };
  const tenant = {
    runAsSupervisor: <T>(fn: (t: unknown) => Promise<T>) => {
      calls.push("supervisor");
      return fn(tx);
    },
    runAsSupervisorWrite: <T>(fn: (t: unknown) => Promise<T>) => {
      calls.push("supervisorWrite");
      return fn(tx);
    },
    runAsOrg: <T>(_org: string, fn: (t: unknown) => Promise<T>) => {
      calls.push("org");
      return fn(tx);
    },
    runInOrgContext: <T>(fn: (t: unknown) => Promise<T>) => fn(tx),
  };
  const audit = {
    record: vi.fn(async (_input: { organizationId?: string | null }) => undefined),
  };
  const service = new DuplicateReviewService(
    tenant as never,
    audit as unknown as ConstructorParameters<typeof DuplicateReviewService>[1],
  );
  return { service, calls, audit, tx };
}

const pair = (orgId: string | null) => ({
  id: "cand-1",
  orgId,
  scope: orgId === null ? "cross_org" : "within_org",
  method: "literal",
  score: 1,
  threshold: 0.85,
  status: "pending",
  note: null,
  reviewedAt: null,
  detectedAt: new Date(),
  needAId: "need-a",
  needBId: "need-b",
});

describe("DuplicateReviewService.decide — which connection the write runs on", () => {
  it("writes a cross-entity decision on the supervisor path", async () => {
    const { service, calls, audit } = serviceWith(pair(null));

    await orgContext.run(CTX, () =>
      service.decide("cand-1", "not_duplicate", "different villages"),
    );

    expect(calls).toContain("supervisorWrite");
    // The reviewer's own org must not be used: the row is not in it, and the
    // policy would match nothing.
    expect(calls).not.toContain("org");
    // Q9 — a cross-entity decision belongs to no single entity, so it is not
    // filed under the reviewer's.
    // Explicitly null, NOT undefined: the audit writer falls back to the
    // caller's org on undefined, which would file an oversight decision about
    // two other entities under the reviewer's own.
    expect(audit.record.mock.calls[0]?.[0].organizationId).toBeNull();
  });

  it("writes an org-owned decision in that entity's context", async () => {
    const { service, calls, audit } = serviceWith(pair("org-2"));

    await orgContext.run(CTX, () => service.decide("cand-1", "confirmed_duplicate", undefined));

    expect(calls).toContain("org");
    expect(calls).not.toContain("supervisorWrite");
    expect(audit.record.mock.calls[0]?.[0]).toMatchObject({ organizationId: "org-2" });
  });

  it("still requires a note to dismiss a pair", async () => {
    const { service } = serviceWith(pair(null));

    await expect(
      orgContext.run(CTX, () => service.decide("cand-1", "not_duplicate", "  ")),
    ).rejects.toMatchObject({
      response: { error: { code: "NOTE_REQUIRED" } },
    });
  });
});
