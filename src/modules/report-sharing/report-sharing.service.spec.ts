import { orgContext } from "../../tenancy/org-context";
import { ReportSharingService } from "./report-sharing.service";

interface FakeReport {
  id: string;
  orgId: string;
  title: string;
  status: "draft" | "approved" | "rejected";
  reportType: string;
  content: Record<string, unknown>;
  generatedBy: string;
  generatedAt: Date;
}
interface FakeOrg {
  id: string;
  name: string;
}

function fakeTenant(reports: FakeReport[], orgs: FakeOrg[], users: Array<{ id: string; name: string }> = []) {
  const tx = {
    report: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        reports.find((r) => r.id === where.id) ?? null,
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        reports.filter((r) => where.id.in.includes(r.id)),
    },
    organisation: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        orgs.find((o) => o.id === where.id) ?? null,
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        orgs.filter((o) => where.id.in.includes(o.id)),
    },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        users.find((u) => u.id === where.id) ?? null,
    },
  };
  return {
    runAsSupervisor: async (fn: (tx: unknown) => unknown) => fn(tx),
    runAsOrg: async (_orgId: string, fn: (tx: unknown) => unknown) => fn(tx),
    runInOrgContext: async (fn: (tx: unknown) => unknown) => fn(tx),
  };
}

interface FakeRow {
  id: string;
  ownerOrgId: string;
  requestingOrgId: string;
  reportId: string;
  status: "pending" | "approved" | "rejected" | "expired";
  requestedBy: string;
  requestedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  note: string | null;
  decisionNote: string | null;
}

function fakePrisma(initial: FakeRow[] = []) {
  const rows = [...initial];
  let seq = 0;
  return {
    rows,
    reportSharingRequest: {
      create: async ({ data }: { data: Partial<FakeRow> }) => {
        const row: FakeRow = {
          id: `rsr-${++seq}`,
          ownerOrgId: data.ownerOrgId!,
          requestingOrgId: data.requestingOrgId!,
          reportId: data.reportId!,
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
}

function fakeAudit() {
  const calls: Array<{ organizationId?: string; action: string; entityLabel: string; changes?: unknown }> = [];
  return { calls, record: async (input: (typeof calls)[number]) => { calls.push(input); } };
}

function fakeReportsService(reports: FakeReport[]) {
  return {
    findAcrossOrgsOrThrow: async (id: string) => {
      const report = reports.find((r) => r.id === id);
      if (!report) throw new Error("not found");
      return report;
    },
  };
}

const APPROVED_REPORT: FakeReport = {
  id: "report-1", orgId: "org-owner", title: "Village Needs Assessment", status: "approved",
  reportType: "RPT13", content: { summary: "..." }, generatedBy: "user-owner-1", generatedAt: new Date(),
};
const DRAFT_REPORT: FakeReport = { ...APPROVED_REPORT, id: "report-2", status: "draft" };
const ORGS = [
  { id: "org-owner", name: "Owner NGO" },
  { id: "org-requester", name: "Requester NGO" },
];

function runAsOrg<T>(orgId: string, actorId: string, fn: () => Promise<T>): Promise<T> {
  return orgContext.run({ requestId: "r", orgId, actorId }, fn);
}

describe("ReportSharingService.create", () => {
  it("rejects requesting your own org's report", async () => {
    const svc = new ReportSharingService(
      fakePrisma() as never, fakeTenant([APPROVED_REPORT], ORGS) as never, fakeAudit() as never,
      fakeReportsService([APPROVED_REPORT]) as never,
    );
    await expect(
      runAsOrg("org-owner", "user-1", () =>
        svc.create({ ownerOrgId: "org-owner", reportId: APPROVED_REPORT.id, note: "why" }),
      ),
    ).rejects.toMatchObject({ response: { error: { code: "CANNOT_REQUEST_OWN_REPORT" } } });
  });

  it("rejects a report that isn't approved yet (sharing only starts from an approved report)", async () => {
    const svc = new ReportSharingService(
      fakePrisma() as never, fakeTenant([DRAFT_REPORT], ORGS) as never, fakeAudit() as never,
      fakeReportsService([DRAFT_REPORT]) as never,
    );
    await expect(
      runAsOrg("org-requester", "user-1", () =>
        svc.create({ ownerOrgId: "org-owner", reportId: DRAFT_REPORT.id, note: "why" }),
      ),
    ).rejects.toMatchObject({ response: { error: { code: "REPORT_NOT_APPROVED" } } });
  });

  it("creates a pending request and writes one audit entry per org (FR-014: logs maintained)", async () => {
    const audit = fakeAudit();
    const svc = new ReportSharingService(
      fakePrisma() as never, fakeTenant([APPROVED_REPORT], ORGS) as never, audit as never,
      fakeReportsService([APPROVED_REPORT]) as never,
    );
    const result = await runAsOrg("org-requester", "user-1", () =>
      svc.create({ ownerOrgId: "org-owner", reportId: APPROVED_REPORT.id, note: "For reference" }),
    );

    expect(result.status).toBe("pending");
    expect(audit.calls).toHaveLength(2);
    expect(audit.calls.map((c) => c.organizationId).sort()).toEqual(["org-owner", "org-requester"].sort());
    for (const call of audit.calls) {
      expect(call.action).toBe("create");
      expect(call.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "Report", after: APPROVED_REPORT.title }),
        ]),
      );
    }
  });
});

describe("ReportSharingService.decide (approve/reject)", () => {
  function seedPending(): FakeRow {
    return {
      id: "rsr-1", ownerOrgId: "org-owner", requestingOrgId: "org-requester", reportId: APPROVED_REPORT.id,
      status: "pending", requestedBy: "user-1", requestedAt: new Date(),
      decidedBy: null, decidedAt: null, note: "why", decisionNote: null,
    };
  }

  it("only the owning org can decide", async () => {
    const svc = new ReportSharingService(
      fakePrisma([seedPending()]) as never, fakeTenant([APPROVED_REPORT], ORGS) as never, fakeAudit() as never,
      fakeReportsService([APPROVED_REPORT]) as never,
    );
    await expect(
      runAsOrg("org-requester", "user-2", () => svc.approve("rsr-1")),
    ).rejects.toMatchObject({ response: { error: { code: "FORBIDDEN" } } });
  });

  it("rejecting without a reason is refused", async () => {
    const svc = new ReportSharingService(
      fakePrisma([seedPending()]) as never, fakeTenant([APPROVED_REPORT], ORGS) as never, fakeAudit() as never,
      fakeReportsService([APPROVED_REPORT]) as never,
    );
    await expect(
      runAsOrg("org-owner", "user-2", () => svc.reject("rsr-1", {})),
    ).rejects.toMatchObject({ response: { error: { code: "REJECT_REASON_REQUIRED" } } });
  });

  it("approve writes a dual-org audit entry with action 'approve'", async () => {
    const audit = fakeAudit();
    const svc = new ReportSharingService(
      fakePrisma([seedPending()]) as never, fakeTenant([APPROVED_REPORT], ORGS) as never, audit as never,
      fakeReportsService([APPROVED_REPORT]) as never,
    );
    const result = await runAsOrg("org-owner", "user-2", () => svc.approve("rsr-1"));

    expect(result.status).toBe("approved");
    expect(audit.calls).toHaveLength(2);
    for (const call of audit.calls) expect(call.action).toBe("approve");
  });

  it("reject with a reason writes a dual-org audit entry including the reason", async () => {
    const audit = fakeAudit();
    const svc = new ReportSharingService(
      fakePrisma([seedPending()]) as never, fakeTenant([APPROVED_REPORT], ORGS) as never, audit as never,
      fakeReportsService([APPROVED_REPORT]) as never,
    );
    const result = await runAsOrg("org-owner", "user-2", () =>
      svc.reject("rsr-1", { note: "Doesn't match our scope" }),
    );

    expect(result.status).toBe("rejected");
    expect(result.decisionNote).toBe("Doesn't match our scope");
    for (const call of audit.calls) {
      expect(call.action).toBe("edit");
      expect(call.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "Decision Note", after: "Doesn't match our scope" }),
        ]),
      );
    }
  });
});

describe("ReportSharingService.getSharedSnapshot", () => {
  it("refuses to reveal an unapproved request's snapshot (never shared without approval)", async () => {
    const row = {
      id: "rsr-1", ownerOrgId: "org-owner", requestingOrgId: "org-requester", reportId: APPROVED_REPORT.id,
      status: "pending" as const, requestedBy: "user-1", requestedAt: new Date(),
      decidedBy: null, decidedAt: null, note: null, decisionNote: null,
    };
    const svc = new ReportSharingService(
      fakePrisma([row]) as never, fakeTenant([APPROVED_REPORT], ORGS) as never, fakeAudit() as never,
      fakeReportsService([APPROVED_REPORT]) as never,
    );
    await expect(
      runAsOrg("org-requester", "user-1", () => svc.getSharedSnapshot("rsr-1")),
    ).rejects.toMatchObject({ response: { error: { code: "SHARING_NOT_APPROVED" } } });
  });

  it("only the requesting org can view the approved snapshot", async () => {
    const row = {
      id: "rsr-1", ownerOrgId: "org-owner", requestingOrgId: "org-requester", reportId: APPROVED_REPORT.id,
      status: "approved" as const, requestedBy: "user-1", requestedAt: new Date(),
      decidedBy: "user-2", decidedAt: new Date(), note: null, decisionNote: null,
    };
    const svc = new ReportSharingService(
      fakePrisma([row]) as never, fakeTenant([APPROVED_REPORT], ORGS) as never, fakeAudit() as never,
      fakeReportsService([APPROVED_REPORT]) as never,
    );
    await expect(
      runAsOrg("org-owner", "user-2", () => svc.getSharedSnapshot("rsr-1")),
    ).rejects.toMatchObject({ response: { error: { code: "FORBIDDEN" } } });
  });

  it("returns the report content plus owner org / generated-by names once approved", async () => {
    const row = {
      id: "rsr-1", ownerOrgId: "org-owner", requestingOrgId: "org-requester", reportId: APPROVED_REPORT.id,
      status: "approved" as const, requestedBy: "user-1", requestedAt: new Date(),
      decidedBy: "user-2", decidedAt: new Date(), note: null, decisionNote: null,
    };
    const svc = new ReportSharingService(
      fakePrisma([row]) as never,
      fakeTenant([APPROVED_REPORT], ORGS, [{ id: "user-owner-1", name: "Owner Staffer" }]) as never,
      fakeAudit() as never,
      fakeReportsService([APPROVED_REPORT]) as never,
    );
    const snapshot = await runAsOrg("org-requester", "user-1", () => svc.getSharedSnapshot("rsr-1"));
    expect(snapshot.title).toBe(APPROVED_REPORT.title);
    expect(snapshot.ownerOrgName).toBe("Owner NGO");
    expect(snapshot.generatedByName).toBe("Owner Staffer");
  });
});
