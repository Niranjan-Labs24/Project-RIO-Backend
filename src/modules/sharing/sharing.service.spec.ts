import { orgContext } from "../../tenancy/org-context";
import { SharingService } from "./sharing.service";

interface FakeStudy {
  id: string;
  orgId: string;
  title: string;
}
interface FakeOrg {
  id: string;
  name: string;
}
interface FakeRow {
  id: string;
  ownerOrgId: string;
  requestingOrgId: string;
  studyId: string;
  status: "pending" | "approved" | "rejected" | "expired";
  requestedBy: string;
  requestedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  note: string | null;
  decisionNote: string | null;
}

// A single fake tenant now backs every call the service makes — create(),
// decide(), findVisibleOrThrow(), and list() all go through
// runInOrgContext/runAsSupervisor, not a separate PrismaService.
function fakeTenant(studies: FakeStudy[], orgs: FakeOrg[], initialRows: FakeRow[] = []) {
  const rows = [...initialRows];
  let seq = 0;
  const tx = {
    study: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        studies.find((s) => s.id === where.id) ?? null,
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        studies.filter((s) => where.id.in.includes(s.id)),
    },
    organisation: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        orgs.find((o) => o.id === where.id) ?? null,
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        orgs.filter((o) => where.id.in.includes(o.id)),
    },
    sharingRequest: {
      create: async ({ data }: { data: Partial<FakeRow> }) => {
        const row: FakeRow = {
          id: `sr-${++seq}`,
          ownerOrgId: data.ownerOrgId!,
          requestingOrgId: data.requestingOrgId!,
          studyId: data.studyId!,
          status: "pending",
          requestedBy: data.requestedBy!,
          requestedAt: new Date(),
          decidedBy: null,
          decidedAt: null,
          note: data.note ?? null,
          decisionNote: null,
        };
        rows.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        rows.find((r) => r.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeRow> }) => {
        const idx = rows.findIndex((r) => r.id === where.id);
        rows[idx] = { ...rows[idx], ...data } as FakeRow;
        return rows[idx];
      },
      findMany: async () => rows,
    },
  };
  return {
    rows,
    runAsSupervisor: async (fn: (tx: unknown) => unknown) => fn(tx),
    runAsOrg: async (_orgId: string, fn: (tx: unknown) => unknown) => fn(tx),
    runInOrgContext: async (fn: (tx: unknown) => unknown) => fn(tx),
  };
}

function fakeAudit() {
  const calls: Array<{ organizationId?: string; action: string; entityLabel: string; changes?: unknown }> = [];
  return { calls, record: async (input: (typeof calls)[number]) => { calls.push(input); } };
}

const STUDY = { id: "study-1", orgId: "org-owner", title: "Water Access Study" };
const ORGS = [
  { id: "org-owner", name: "Owner NGO" },
  { id: "org-requester", name: "Requester NGO" },
];

function runAsOrg<T>(orgId: string, actorId: string, fn: () => Promise<T>): Promise<T> {
  return orgContext.run({ requestId: "r", orgId, actorId }, fn);
}

describe("SharingService.create", () => {
  it("rejects requesting your own org's study", async () => {
    const svc = new SharingService(fakeTenant([STUDY], ORGS) as never, fakeAudit() as never);
    await expect(
      runAsOrg("org-owner", "user-1", () =>
        svc.create({ ownerOrgId: "org-owner", studyId: STUDY.id, note: "why" }),
      ),
    ).rejects.toMatchObject({ response: { error: { code: "CANNOT_REQUEST_OWN_STUDY" } } });
  });

  it("rejects when the study doesn't belong to the claimed owner org", async () => {
    // STUDY actually belongs to org-owner — claiming it belongs to a
    // different org must 404, not silently resolve to the real owner.
    const svc = new SharingService(fakeTenant([STUDY], ORGS) as never, fakeAudit() as never);
    await expect(
      runAsOrg("org-requester", "user-1", () =>
        svc.create({ ownerOrgId: "org-third-party", studyId: STUDY.id, note: "why" }),
      ),
    ).rejects.toMatchObject({ response: { error: { code: "STUDY_NOT_FOUND" } } });
  });

  it("creates a pending request and writes one audit entry per org (FR-014: logs maintained)", async () => {
    const audit = fakeAudit();
    const svc = new SharingService(fakeTenant([STUDY], ORGS) as never, audit as never);
    const result = await runAsOrg("org-requester", "user-1", () =>
      svc.create({ ownerOrgId: "org-owner", studyId: STUDY.id, note: "For a similar assessment" }),
    );

    // Never auto-approved — FR-014's "no report shared without owner approval".
    expect(result.status).toBe("pending");

    expect(audit.calls).toHaveLength(2);
    const orgIdsWritten = audit.calls.map((c) => c.organizationId).sort();
    expect(orgIdsWritten).toEqual(["org-owner", "org-requester"].sort());
    for (const call of audit.calls) {
      expect(call.action).toBe("create");
      expect(call.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "Requesting Organization", after: "Requester NGO" }),
          expect.objectContaining({ field: "Owning Organization", after: "Owner NGO" }),
          expect.objectContaining({ field: "Study", after: STUDY.title }),
        ]),
      );
    }
  });
});

describe("SharingService.decide (approve/reject)", () => {
  function seedPending(): FakeRow {
    return {
      id: "sr-1",
      ownerOrgId: "org-owner",
      requestingOrgId: "org-requester",
      studyId: STUDY.id,
      status: "pending",
      requestedBy: "user-1",
      requestedAt: new Date(),
      decidedBy: null,
      decidedAt: null,
      note: "why",
      decisionNote: null,
    };
  }

  it("only the owning org can decide", async () => {
    const svc = new SharingService(fakeTenant([STUDY], ORGS, [seedPending()]) as never, fakeAudit() as never);
    await expect(
      runAsOrg("org-requester", "user-2", () => svc.approve("sr-1")),
    ).rejects.toMatchObject({ response: { error: { code: "FORBIDDEN" } } });
  });

  it("rejecting without a reason is refused (reject reason is mandatory)", async () => {
    const svc = new SharingService(fakeTenant([STUDY], ORGS, [seedPending()]) as never, fakeAudit() as never);
    await expect(
      runAsOrg("org-owner", "user-2", () => svc.reject("sr-1", {})),
    ).rejects.toMatchObject({ response: { error: { code: "REJECT_REASON_REQUIRED" } } });
  });

  it("cannot decide an already-decided request", async () => {
    const row = { ...seedPending(), status: "approved" as const, decidedAt: new Date(), decidedBy: "user-2" };
    const svc = new SharingService(fakeTenant([STUDY], ORGS, [row]) as never, fakeAudit() as never);
    await expect(
      runAsOrg("org-owner", "user-2", () => svc.approve("sr-1")),
    ).rejects.toMatchObject({ response: { error: { code: "SHARING_REQUEST_ALREADY_DECIDED" } } });
  });

  it("approve writes a dual-org audit entry with action 'approve'", async () => {
    const audit = fakeAudit();
    const svc = new SharingService(fakeTenant([STUDY], ORGS, [seedPending()]) as never, audit as never);
    const result = await runAsOrg("org-owner", "user-2", () => svc.approve("sr-1"));

    expect(result.status).toBe("approved");
    expect(audit.calls).toHaveLength(2);
    expect(audit.calls.map((c) => c.organizationId).sort()).toEqual(["org-owner", "org-requester"].sort());
    for (const call of audit.calls) expect(call.action).toBe("approve");
  });

  it("reject with a reason writes a dual-org audit entry including the reason", async () => {
    const audit = fakeAudit();
    const svc = new SharingService(fakeTenant([STUDY], ORGS, [seedPending()]) as never, audit as never);
    const result = await runAsOrg("org-owner", "user-2", () =>
      svc.reject("sr-1", { note: "Not relevant to your current work" }),
    );

    expect(result.status).toBe("rejected");
    expect(result.decisionNote).toBe("Not relevant to your current work");
    expect(audit.calls).toHaveLength(2);
    for (const call of audit.calls) {
      expect(call.action).toBe("edit");
      expect(call.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "Decision Note", after: "Not relevant to your current work" }),
        ]),
      );
    }
  });
});

describe("SharingService.getSharedSnapshot", () => {
  function fakeTenantWithNeeds(initialRows: FakeRow[] = []) {
    const base = fakeTenant([STUDY], ORGS, initialRows);
    return {
      ...base,
      runAsSupervisor: async (fn: (tx: unknown) => unknown) =>
        fn({
          study: { findUnique: async () => STUDY },
          need: { findMany: async () => [{ id: "n1", statement: "Need water", village: ["V1"], status: "reviewer_approved" }] },
          evidence: { count: async () => 2 },
        }),
    };
  }

  it("refuses to reveal an unapproved request's snapshot (never shared without approval)", async () => {
    const row: FakeRow = {
      id: "sr-1", ownerOrgId: "org-owner", requestingOrgId: "org-requester", studyId: STUDY.id,
      status: "pending", requestedBy: "user-1", requestedAt: new Date(),
      decidedBy: null, decidedAt: null, note: null, decisionNote: null,
    };
    const svc = new SharingService(fakeTenantWithNeeds([row]) as never, fakeAudit() as never);
    await expect(
      runAsOrg("org-requester", "user-1", () => svc.getSharedSnapshot("sr-1")),
    ).rejects.toMatchObject({ response: { error: { code: "SHARING_NOT_APPROVED" } } });
  });

  it("only the requesting org can view the approved snapshot", async () => {
    const row: FakeRow = {
      id: "sr-1", ownerOrgId: "org-owner", requestingOrgId: "org-requester", studyId: STUDY.id,
      status: "approved", requestedBy: "user-1", requestedAt: new Date(),
      decidedBy: "user-2", decidedAt: new Date(), note: null, decisionNote: null,
    };
    const svc = new SharingService(fakeTenantWithNeeds([row]) as never, fakeAudit() as never);
    await expect(
      runAsOrg("org-owner", "user-2", () => svc.getSharedSnapshot("sr-1")),
    ).rejects.toMatchObject({ response: { error: { code: "FORBIDDEN" } } });
  });

  it("returns the study's needs and evidence count once approved, for the requesting org", async () => {
    const row: FakeRow = {
      id: "sr-1", ownerOrgId: "org-owner", requestingOrgId: "org-requester", studyId: STUDY.id,
      status: "approved", requestedBy: "user-1", requestedAt: new Date(),
      decidedBy: "user-2", decidedAt: new Date(), note: null, decisionNote: null,
    };
    const svc = new SharingService(fakeTenantWithNeeds([row]) as never, fakeAudit() as never);
    const snapshot = await runAsOrg("org-requester", "user-1", () => svc.getSharedSnapshot("sr-1"));
    expect(snapshot.title).toBe(STUDY.title);
    expect(snapshot.needs).toHaveLength(1);
    expect(snapshot.evidenceCount).toBe(2);
  });
});
