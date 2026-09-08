import { orgContext } from "../../tenancy/org-context";
import { ReportSharingService } from "./report-sharing.service";

interface FakeReport {
  id: string;
  orgId: string;
  title: string;
  status: "draft" | "released" | "rejected" | "archived";
  reportType: string;
  content: Record<string, unknown>;
  generatedBy: string;
  generatedAt: Date;
}
interface FakeOrg {
  id: string;
  name: string;
}

interface ReportFindManyArgs {
  where?: { id?: { in: string[] }; orgId?: string; status?: { in: string[] } };
  orderBy?: unknown;
}
interface OrgFindManyArgs {
  where?: { id?: { in?: string[]; not?: string }; isActive?: boolean; name?: { contains: string; mode?: string } };
  orderBy?: unknown;
  take?: number;
}

function fakeTenant(reports: FakeReport[], orgs: (FakeOrg & { isActive?: boolean })[], users: Array<{ id: string; name: string }> = []) {
  const tx = {
    report: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        reports.find((r) => r.id === where.id) ?? null,
      findMany: async ({ where }: ReportFindManyArgs) => {
        let result = reports;
        if (where?.id?.in) result = result.filter((r) => where.id!.in.includes(r.id));
        if (where?.orgId) result = result.filter((r) => r.orgId === where.orgId);
        if (where?.status?.in) result = result.filter((r) => where.status!.in.includes(r.status));
        return result;
      },
    },
    organisation: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        orgs.find((o) => o.id === where.id) ?? null,
      findMany: async ({ where, take }: OrgFindManyArgs) => {
        let result = orgs;
        if (where?.id?.in) result = result.filter((o) => where.id!.in!.includes(o.id));
        if (where?.id?.not) result = result.filter((o) => o.id !== where.id!.not);
        if (where?.isActive !== undefined) result = result.filter((o) => (o.isActive ?? true) === where.isActive);
        if (where?.name?.contains) {
          const needle = where.name.contains.toLowerCase();
          result = result.filter((o) => o.name.toLowerCase().includes(needle));
        }
        result = [...result].sort((a, b) => a.name.localeCompare(b.name));
        return take ? result.slice(0, take) : result;
      },
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
  status: "pending" | "approved" | "rejected" | "expired" | "withdrawn";
  requestedBy: string;
  requestedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  note: string | null;
  decisionNote: string | null;
  expiresAt?: Date | null;
  withdrawnBy?: string | null;
  withdrawnAt?: Date | null;
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
      findMany: async (
        args?: { where?: { OR?: Array<{ ownerOrgId?: string; requestingOrgId?: string }> } },
      ) => {
        const where = args?.where;
        const filtered = where?.OR
          ? rows.filter((r) =>
              where.OR!.some(
                (cond) =>
                  (cond.ownerOrgId !== undefined && cond.ownerOrgId === r.ownerOrgId) ||
                  (cond.requestingOrgId !== undefined && cond.requestingOrgId === r.requestingOrgId),
              ),
            )
          : rows;
        return [...filtered].sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
      },
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
  id: "report-1", orgId: "org-owner", title: "Village Needs Assessment", status: "released",
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

// center_supervisor is a cross-entity role (role-matrix.ts) — used to exercise
// the ReportSharingService branches that bypass per-org scoping.
function runAsCrossEntity<T>(orgId: string, actorId: string, fn: () => Promise<T>): Promise<T> {
  return orgContext.run({ requestId: "r", orgId, actorId, role: "center_supervisor" }, fn);
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

  it("rejects a report that isn't released yet (sharing only starts from a released report)", async () => {
    const svc = new ReportSharingService(
      fakePrisma() as never, fakeTenant([DRAFT_REPORT], ORGS) as never, fakeAudit() as never,
      fakeReportsService([DRAFT_REPORT]) as never,
    );
    await expect(
      runAsOrg("org-requester", "user-1", () =>
        svc.create({ ownerOrgId: "org-owner", reportId: DRAFT_REPORT.id, note: "why" }),
      ),
    ).rejects.toMatchObject({ response: { error: { code: "REPORT_NOT_RELEASED" } } });
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

describe("ReportSharingService.approve — optional expiry (RIO-FR-014, Q30)", () => {
  function seedPending(): FakeRow {
    return {
      id: "rsr-1", ownerOrgId: "org-owner", requestingOrgId: "org-requester", reportId: APPROVED_REPORT.id,
      status: "pending", requestedBy: "user-1", requestedAt: new Date(),
      decidedBy: null, decidedAt: null, note: "why", decisionNote: null,
    };
  }

  it("approving with no expiresAt leaves access open-ended", async () => {
    const svc = new ReportSharingService(
      fakePrisma([seedPending()]) as never, fakeTenant([APPROVED_REPORT], ORGS) as never, fakeAudit() as never,
      fakeReportsService([APPROVED_REPORT]) as never,
    );
    const result = await runAsOrg("org-owner", "user-2", () => svc.approve("rsr-1"));
    expect(result.expiresAt).toBeNull();
  });

  it("approving with an expiresAt stores it", async () => {
    const svc = new ReportSharingService(
      fakePrisma([seedPending()]) as never, fakeTenant([APPROVED_REPORT], ORGS) as never, fakeAudit() as never,
      fakeReportsService([APPROVED_REPORT]) as never,
    );
    const result = await runAsOrg("org-owner", "user-2", () =>
      svc.approve("rsr-1", { expiresAt: "2027-01-01T00:00:00.000Z" }),
    );
    expect(result.expiresAt).toBe("2027-01-01T00:00:00.000Z");
  });

  it("rejects an unparsable expiry date", async () => {
    const svc = new ReportSharingService(
      fakePrisma([seedPending()]) as never, fakeTenant([APPROVED_REPORT], ORGS) as never, fakeAudit() as never,
      fakeReportsService([APPROVED_REPORT]) as never,
    );
    await expect(
      runAsOrg("org-owner", "user-2", () => svc.approve("rsr-1", { expiresAt: "not-a-date" })),
    ).rejects.toMatchObject({ response: { error: { code: "INVALID_EXPIRY_DATE" } } });
  });
});

describe("ReportSharingService.withdraw (RIO-FR-014, Q30)", () => {
  function seedApproved(): FakeRow {
    return {
      id: "rsr-1", ownerOrgId: "org-owner", requestingOrgId: "org-requester", reportId: APPROVED_REPORT.id,
      status: "approved", requestedBy: "user-1", requestedAt: new Date(),
      decidedBy: "user-2", decidedAt: new Date(), note: "why", decisionNote: null,
    };
  }

  it("only the owning org can withdraw", async () => {
    const svc = new ReportSharingService(
      fakePrisma([seedApproved()]) as never, fakeTenant([APPROVED_REPORT], ORGS) as never, fakeAudit() as never,
      fakeReportsService([APPROVED_REPORT]) as never,
    );
    await expect(
      runAsOrg("org-requester", "user-1", () => svc.withdraw("rsr-1")),
    ).rejects.toMatchObject({ response: { error: { code: "FORBIDDEN" } } });
  });

  it("cannot withdraw a request that was never approved", async () => {
    const row = { ...seedApproved(), status: "pending" as const, decidedBy: null, decidedAt: null };
    const svc = new ReportSharingService(
      fakePrisma([row]) as never, fakeTenant([APPROVED_REPORT], ORGS) as never, fakeAudit() as never,
      fakeReportsService([APPROVED_REPORT]) as never,
    );
    await expect(
      runAsOrg("org-owner", "user-2", () => svc.withdraw("rsr-1")),
    ).rejects.toMatchObject({ response: { error: { code: "REPORT_SHARING_NOT_APPROVED" } } });
  });

  it("withdraws approved access, stamps who/when, and audits both orgs", async () => {
    const audit = fakeAudit();
    const svc = new ReportSharingService(
      fakePrisma([seedApproved()]) as never, fakeTenant([APPROVED_REPORT], ORGS) as never, audit as never,
      fakeReportsService([APPROVED_REPORT]) as never,
    );
    const result = await runAsOrg("org-owner", "user-3", () => svc.withdraw("rsr-1"));

    expect(result.status).toBe("withdrawn");
    expect(result.withdrawnBy).toBe("user-3");
    expect(result.withdrawnAt).not.toBeNull();
    expect(audit.calls).toHaveLength(2);
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

  it("refuses to reveal a snapshot once the approval has expired (RIO-FR-014, Q30)", async () => {
    const row = {
      id: "rsr-1", ownerOrgId: "org-owner", requestingOrgId: "org-requester", reportId: APPROVED_REPORT.id,
      status: "approved" as const, requestedBy: "user-1", requestedAt: new Date(),
      decidedBy: "user-2", decidedAt: new Date(), note: null, decisionNote: null,
      expiresAt: new Date("2020-01-01T00:00:00.000Z"),
    };
    const svc = new ReportSharingService(
      fakePrisma([row]) as never, fakeTenant([APPROVED_REPORT], ORGS) as never, fakeAudit() as never,
      fakeReportsService([APPROVED_REPORT]) as never,
    );
    await expect(
      runAsOrg("org-requester", "user-1", () => svc.getSharedSnapshot("rsr-1")),
    ).rejects.toMatchObject({ response: { error: { code: "SHARING_EXPIRED" } } });
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

const THIRD_ORG = { id: "org-third", name: "Unrelated NGO" };
const ORGS_WITH_THIRD = [...ORGS, THIRD_ORG];

function seedRow(overrides: Partial<FakeRow> & Pick<FakeRow, "id" | "ownerOrgId" | "requestingOrgId">): FakeRow {
  return {
    reportId: APPROVED_REPORT.id, status: "pending", requestedBy: "user-1", requestedAt: new Date(),
    decidedBy: null, decidedAt: null, note: null, decisionNote: null,
    ...overrides,
  };
}

describe("ReportSharingService.list", () => {
  it("a plain-org actor only sees requests where their org is owner or requester", async () => {
    const rows = [
      seedRow({ id: "rsr-1", ownerOrgId: "org-owner", requestingOrgId: "org-requester" }),
      seedRow({ id: "rsr-2", ownerOrgId: "org-owner", requestingOrgId: "org-third" }),
      seedRow({ id: "rsr-3", ownerOrgId: "org-third", requestingOrgId: "org-requester" }),
    ];
    const svc = new ReportSharingService(
      fakePrisma(rows) as never, fakeTenant([APPROVED_REPORT], ORGS_WITH_THIRD) as never, fakeAudit() as never,
      fakeReportsService([APPROVED_REPORT]) as never,
    );
    const result = await runAsOrg("org-owner", "user-1", () => svc.list());
    expect(result.map((r) => r.id).sort()).toEqual(["rsr-1", "rsr-2"]);
  });

  it("a cross-entity actor (e.g. Center Supervisor) sees requests across all orgs", async () => {
    const rows = [
      seedRow({ id: "rsr-1", ownerOrgId: "org-owner", requestingOrgId: "org-requester" }),
      seedRow({ id: "rsr-2", ownerOrgId: "org-third", requestingOrgId: "org-requester" }),
    ];
    const svc = new ReportSharingService(
      fakePrisma(rows) as never, fakeTenant([APPROVED_REPORT], ORGS_WITH_THIRD) as never, fakeAudit() as never,
      fakeReportsService([APPROVED_REPORT]) as never,
    );
    const result = await runAsCrossEntity("org-supervisor", "user-sup", () => svc.list());
    expect(result.map((r) => r.id).sort()).toEqual(["rsr-1", "rsr-2"]);
  });
});

describe("ReportSharingService.getById", () => {
  it("returns a request visible to the caller's org", async () => {
    const row = seedRow({ id: "rsr-1", ownerOrgId: "org-owner", requestingOrgId: "org-requester" });
    const svc = new ReportSharingService(
      fakePrisma([row]) as never, fakeTenant([APPROVED_REPORT], ORGS) as never, fakeAudit() as never,
      fakeReportsService([APPROVED_REPORT]) as never,
    );
    const result = await runAsOrg("org-owner", "user-1", () => svc.getById("rsr-1"));
    expect(result.id).toBe("rsr-1");
  });

  it("404s (not 403) for a request outside the caller's org, to avoid leaking existence", async () => {
    const row = seedRow({ id: "rsr-1", ownerOrgId: "org-owner", requestingOrgId: "org-requester" });
    const svc = new ReportSharingService(
      fakePrisma([row]) as never, fakeTenant([APPROVED_REPORT], ORGS_WITH_THIRD) as never, fakeAudit() as never,
      fakeReportsService([APPROVED_REPORT]) as never,
    );
    await expect(
      runAsOrg("org-third", "user-1", () => svc.getById("rsr-1")),
    ).rejects.toMatchObject({ response: { error: { code: "REPORT_SHARING_REQUEST_NOT_FOUND" } } });
  });

  it("a cross-entity actor can view a request belonging to neither of their orgs", async () => {
    const row = seedRow({ id: "rsr-1", ownerOrgId: "org-owner", requestingOrgId: "org-requester" });
    const svc = new ReportSharingService(
      fakePrisma([row]) as never, fakeTenant([APPROVED_REPORT], ORGS) as never, fakeAudit() as never,
      fakeReportsService([APPROVED_REPORT]) as never,
    );
    const result = await runAsCrossEntity("org-supervisor", "user-sup", () => svc.getById("rsr-1"));
    expect(result.id).toBe("rsr-1");
  });

  it("unknown id 404s", async () => {
    const svc = new ReportSharingService(
      fakePrisma([]) as never, fakeTenant([APPROVED_REPORT], ORGS) as never, fakeAudit() as never,
      fakeReportsService([APPROVED_REPORT]) as never,
    );
    await expect(
      runAsOrg("org-owner", "user-1", () => svc.getById("missing")),
    ).rejects.toMatchObject({ response: { error: { code: "REPORT_SHARING_REQUEST_NOT_FOUND" } } });
  });
});

describe("ReportSharingService.create — not-found branches", () => {
  it("REPORT_NOT_FOUND when the reportId doesn't exist", async () => {
    const svc = new ReportSharingService(
      fakePrisma() as never, fakeTenant([], ORGS) as never, fakeAudit() as never,
      fakeReportsService([]) as never,
    );
    await expect(
      runAsOrg("org-requester", "user-1", () =>
        svc.create({ ownerOrgId: "org-owner", reportId: "no-such-report", note: "why" }),
      ),
    ).rejects.toMatchObject({ response: { error: { code: "REPORT_NOT_FOUND" } } });
  });

  it("REPORT_NOT_FOUND when the report belongs to a different org than payload.ownerOrgId", async () => {
    const svc = new ReportSharingService(
      fakePrisma() as never, fakeTenant([APPROVED_REPORT], ORGS_WITH_THIRD) as never, fakeAudit() as never,
      fakeReportsService([APPROVED_REPORT]) as never,
    );
    await expect(
      runAsOrg("org-requester", "user-1", () =>
        // APPROVED_REPORT.orgId is "org-owner", not "org-third" — a spoofed ownerOrgId must not resolve.
        svc.create({ ownerOrgId: "org-third", reportId: APPROVED_REPORT.id, note: "why" }),
      ),
    ).rejects.toMatchObject({ response: { error: { code: "REPORT_NOT_FOUND" } } });
  });
});

describe("ReportSharingService.decide — already-decided / not-found", () => {
  it("REPORT_SHARING_REQUEST_ALREADY_DECIDED when re-deciding an approved request", async () => {
    const row = seedRow({ id: "rsr-1", ownerOrgId: "org-owner", requestingOrgId: "org-requester", status: "approved", decidedBy: "user-2", decidedAt: new Date() });
    const svc = new ReportSharingService(
      fakePrisma([row]) as never, fakeTenant([APPROVED_REPORT], ORGS) as never, fakeAudit() as never,
      fakeReportsService([APPROVED_REPORT]) as never,
    );
    await expect(
      runAsOrg("org-owner", "user-2", () => svc.approve("rsr-1")),
    ).rejects.toMatchObject({ response: { error: { code: "REPORT_SHARING_REQUEST_ALREADY_DECIDED" } } });
  });

  it("REPORT_SHARING_REQUEST_ALREADY_DECIDED when re-deciding a rejected request", async () => {
    const row = seedRow({ id: "rsr-1", ownerOrgId: "org-owner", requestingOrgId: "org-requester", status: "rejected", decidedBy: "user-2", decidedAt: new Date(), decisionNote: "no" });
    const svc = new ReportSharingService(
      fakePrisma([row]) as never, fakeTenant([APPROVED_REPORT], ORGS) as never, fakeAudit() as never,
      fakeReportsService([APPROVED_REPORT]) as never,
    );
    await expect(
      runAsOrg("org-owner", "user-2", () => svc.reject("rsr-1", { note: "still no" })),
    ).rejects.toMatchObject({ response: { error: { code: "REPORT_SHARING_REQUEST_ALREADY_DECIDED" } } });
  });

  it("unknown id 404s on decide", async () => {
    const svc = new ReportSharingService(
      fakePrisma([]) as never, fakeTenant([APPROVED_REPORT], ORGS) as never, fakeAudit() as never,
      fakeReportsService([APPROVED_REPORT]) as never,
    );
    await expect(
      runAsOrg("org-owner", "user-2", () => svc.approve("missing")),
    ).rejects.toMatchObject({ response: { error: { code: "REPORT_SHARING_REQUEST_NOT_FOUND" } } });
  });
});

describe("ReportSharingService.lookupOrganizations", () => {
  it("excludes the caller's own org and inactive orgs, and filters by name substring (case-insensitive)", async () => {
    const orgs = [
      { id: "org-owner", name: "Owner NGO", isActive: true },
      { id: "org-requester", name: "Requester NGO", isActive: true },
      { id: "org-inactive", name: "Inactive NGO", isActive: false },
    ];
    const svc = new ReportSharingService(
      fakePrisma() as never, fakeTenant([], orgs) as never, fakeAudit() as never,
      fakeReportsService([]) as never,
    );
    // "ngo" (lowercase) matches all three by name, but org-owner is excluded as the
    // caller's own org and org-inactive is excluded as inactive — only org-requester survives.
    const result = await runAsOrg("org-owner", "user-1", () => svc.lookupOrganizations("ngo"));
    expect(result).toEqual([{ id: "org-requester", name: "Requester NGO" }]);
  });

  it("caps results at 20 and matches active orgs other than the caller's own", async () => {
    const orgs = [
      { id: "org-owner", name: "Owner NGO", isActive: true },
      ...Array.from({ length: 25 }, (_, i) => ({ id: `org-${i}`, name: `Partner NGO ${i}`, isActive: true })),
    ];
    const svc = new ReportSharingService(
      fakePrisma() as never, fakeTenant([], orgs) as never, fakeAudit() as never,
      fakeReportsService([]) as never,
    );
    const result = await runAsOrg("org-owner", "user-1", () => svc.lookupOrganizations(undefined));
    expect(result.length).toBe(20);
    expect(result.every((o) => o.id !== "org-owner")).toBe(true);
  });
});

describe("ReportSharingService.lookupReportsForOrg", () => {
  it("only returns released/archived reports, excluding draft", async () => {
    const reports: FakeReport[] = [
      { ...APPROVED_REPORT, id: "r-released", status: "released" },
      { ...APPROVED_REPORT, id: "r-archived", status: "archived" },
      { ...APPROVED_REPORT, id: "r-draft", status: "draft" },
    ];
    const svc = new ReportSharingService(
      fakePrisma() as never, fakeTenant(reports, ORGS) as never, fakeAudit() as never,
      fakeReportsService(reports) as never,
    );
    const result = await runAsOrg("org-owner", "user-1", () => svc.lookupReportsForOrg("org-owner"));
    expect(result.map((r) => r.id).sort()).toEqual(["r-archived", "r-released"]);
  });
});

describe("ReportSharingService.enrichMany", () => {
  it("falls back to the raw id when the org or report was since deleted", async () => {
    const row = seedRow({ id: "rsr-1", ownerOrgId: "org-owner", requestingOrgId: "org-gone", reportId: "report-gone" });
    const svc = new ReportSharingService(
      fakePrisma([row]) as never, fakeTenant([], [{ id: "org-owner", name: "Owner NGO" }]) as never, fakeAudit() as never,
      fakeReportsService([]) as never,
    );
    const result = await runAsOrg("org-owner", "user-1", () => svc.getById("rsr-1"));
    expect(result.requestingOrgName).toBe("org-gone");
    expect(result.reportTitle).toBe("report-gone");
  });

  it("dedupes repeated org/report ids across a batch before looking them up", async () => {
    const rows = [
      seedRow({ id: "rsr-1", ownerOrgId: "org-owner", requestingOrgId: "org-requester" }),
      seedRow({ id: "rsr-2", ownerOrgId: "org-owner", requestingOrgId: "org-requester" }),
    ];
    const reportFindManyArgs: ReportFindManyArgs[] = [];
    const orgFindManyArgs: OrgFindManyArgs[] = [];
    const base = fakeTenant([APPROVED_REPORT], ORGS);
    const tenant = {
      ...base,
      runAsSupervisor: async (fn: (tx: unknown) => unknown) =>
        base.runAsSupervisor((tx) => {
          const wrapped = tx as {
            report: { findMany: (args: ReportFindManyArgs) => unknown };
            organisation: { findMany: (args: OrgFindManyArgs) => unknown };
          };
          return fn({
            ...wrapped,
            report: {
              ...wrapped.report,
              findMany: (args: ReportFindManyArgs) => { reportFindManyArgs.push(args); return wrapped.report.findMany(args); },
            },
            organisation: {
              ...wrapped.organisation,
              findMany: (args: OrgFindManyArgs) => { orgFindManyArgs.push(args); return wrapped.organisation.findMany(args); },
            },
          });
        }),
    };
    const svc = new ReportSharingService(
      fakePrisma(rows) as never, tenant as never, fakeAudit() as never,
      fakeReportsService([APPROVED_REPORT]) as never,
    );
    const result = await runAsOrg("org-owner", "user-1", () => svc.list());
    expect(result).toHaveLength(2);
    // one batched report.findMany + one batched organisation.findMany for the whole list, not per-row,
    // and each is called with only the distinct ids (one report id, two org ids: owner + requester).
    expect(reportFindManyArgs).toHaveLength(1);
    expect(reportFindManyArgs[0]?.where?.id?.in).toEqual([APPROVED_REPORT.id]);
    expect(orgFindManyArgs).toHaveLength(1);
    expect(orgFindManyArgs[0]?.where?.id?.in).toEqual(["org-owner", "org-requester"]);
  });
});
