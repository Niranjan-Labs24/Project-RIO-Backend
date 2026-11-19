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
    // No admin user seeded in these fixtures — orgAdminEmail() resolves to
    // null, so the sharing-notification email is simply skipped (its own
    // null-check), same as a real org somehow missing an admin.
    user: {
      findFirst: async () => null,
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

function fakeMailer() {
  return {
    sendSharingRequestCreated: async () => true,
    sendSharingRequestDecided: async () => true,
  };
}

// UAT SHR-04 — the shared study's released reports.
function fakeReports(reports: Record<string, Record<string, unknown>> = {}) {
  return {
    findAcrossOrgsOrThrow: async (id: string) => {
      const report = reports[id];
      if (!report) throw Object.assign(new Error("not found"), { response: { error: { code: "REPORT_NOT_FOUND" } } });
      return report;
    },
  };
}

function fakeTranslation() {
  return { translate: async (text: string) => ({ translatedText: text, unchanged: false }) };
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
    const svc = new SharingService(fakeTenant([STUDY], ORGS) as never, fakeAudit() as never, fakeMailer() as never, fakeTranslation() as never, fakeReports() as never);
    await expect(
      runAsOrg("org-owner", "user-1", () =>
        svc.create({ ownerOrgId: "org-owner", studyId: STUDY.id, note: "why" }),
      ),
    ).rejects.toMatchObject({ response: { error: { code: "CANNOT_REQUEST_OWN_STUDY" } } });
  });

  it("rejects when the study doesn't belong to the claimed owner org", async () => {
    // STUDY actually belongs to org-owner — claiming it belongs to a
    // different org must 404, not silently resolve to the real owner.
    const svc = new SharingService(fakeTenant([STUDY], ORGS) as never, fakeAudit() as never, fakeMailer() as never, fakeTranslation() as never, fakeReports() as never);
    await expect(
      runAsOrg("org-requester", "user-1", () =>
        svc.create({ ownerOrgId: "org-third-party", studyId: STUDY.id, note: "why" }),
      ),
    ).rejects.toMatchObject({ response: { error: { code: "STUDY_NOT_FOUND" } } });
  });

  it("creates a pending request and writes one audit entry per org (FR-014: logs maintained)", async () => {
    const audit = fakeAudit();
    const svc = new SharingService(fakeTenant([STUDY], ORGS) as never, audit as never, fakeMailer() as never, fakeTranslation() as never, fakeReports() as never);
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
    const svc = new SharingService(fakeTenant([STUDY], ORGS, [seedPending()]) as never, fakeAudit() as never, fakeMailer() as never, fakeTranslation() as never, fakeReports() as never);
    await expect(
      runAsOrg("org-requester", "user-2", () => svc.approve("sr-1")),
    ).rejects.toMatchObject({ response: { error: { code: "FORBIDDEN" } } });
  });

  it("rejecting without a reason is refused (reject reason is mandatory)", async () => {
    const svc = new SharingService(fakeTenant([STUDY], ORGS, [seedPending()]) as never, fakeAudit() as never, fakeMailer() as never, fakeTranslation() as never, fakeReports() as never);
    await expect(
      runAsOrg("org-owner", "user-2", () => svc.reject("sr-1", {})),
    ).rejects.toMatchObject({ response: { error: { code: "REJECT_REASON_REQUIRED" } } });
  });

  it("cannot decide an already-decided request", async () => {
    const row = { ...seedPending(), status: "approved" as const, decidedAt: new Date(), decidedBy: "user-2" };
    const svc = new SharingService(fakeTenant([STUDY], ORGS, [row]) as never, fakeAudit() as never, fakeMailer() as never, fakeTranslation() as never, fakeReports() as never);
    await expect(
      runAsOrg("org-owner", "user-2", () => svc.approve("sr-1")),
    ).rejects.toMatchObject({ response: { error: { code: "SHARING_REQUEST_ALREADY_DECIDED" } } });
  });

  it("approve writes a dual-org audit entry with action 'approve'", async () => {
    const audit = fakeAudit();
    const svc = new SharingService(fakeTenant([STUDY], ORGS, [seedPending()]) as never, audit as never, fakeMailer() as never, fakeTranslation() as never, fakeReports() as never);
    const result = await runAsOrg("org-owner", "user-2", () => svc.approve("sr-1"));

    expect(result.status).toBe("approved");
    expect(audit.calls).toHaveLength(2);
    expect(audit.calls.map((c) => c.organizationId).sort()).toEqual(["org-owner", "org-requester"].sort());
    for (const call of audit.calls) expect(call.action).toBe("approve");
  });

  it("reject with a reason writes a dual-org audit entry including the reason", async () => {
    const audit = fakeAudit();
    const svc = new SharingService(fakeTenant([STUDY], ORGS, [seedPending()]) as never, audit as never, fakeMailer() as never, fakeTranslation() as never, fakeReports() as never);
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

describe("SharingService.approve — optional expiry (RIO-FR-014, Q30)", () => {
  function seedPending(): FakeRow {
    return {
      id: "sr-1", ownerOrgId: "org-owner", requestingOrgId: "org-requester", studyId: STUDY.id,
      status: "pending", requestedBy: "user-1", requestedAt: new Date(),
      decidedBy: null, decidedAt: null, note: "why", decisionNote: null,
    };
  }

  it("approving with no expiresAt leaves access open-ended", async () => {
    const svc = new SharingService(fakeTenant([STUDY], ORGS, [seedPending()]) as never, fakeAudit() as never, fakeMailer() as never, fakeTranslation() as never, fakeReports() as never);
    const result = await runAsOrg("org-owner", "user-2", () => svc.approve("sr-1"));
    expect(result.status).toBe("approved");
    expect(result.expiresAt).toBeNull();
  });

  it("approving with an expiresAt stores it", async () => {
    const svc = new SharingService(fakeTenant([STUDY], ORGS, [seedPending()]) as never, fakeAudit() as never, fakeMailer() as never, fakeTranslation() as never, fakeReports() as never);
    const result = await runAsOrg("org-owner", "user-2", () =>
      svc.approve("sr-1", { expiresAt: "2027-01-01T00:00:00.000Z" }),
    );
    expect(result.expiresAt).toBe("2027-01-01T00:00:00.000Z");
  });

  it("rejects an unparsable expiry date", async () => {
    const svc = new SharingService(fakeTenant([STUDY], ORGS, [seedPending()]) as never, fakeAudit() as never, fakeMailer() as never, fakeTranslation() as never, fakeReports() as never);
    await expect(
      runAsOrg("org-owner", "user-2", () => svc.approve("sr-1", { expiresAt: "not-a-date" })),
    ).rejects.toMatchObject({ response: { error: { code: "INVALID_EXPIRY_DATE" } } });
  });
});

describe("SharingService.withdraw (RIO-FR-014, Q30)", () => {
  function seedApproved(): FakeRow {
    return {
      id: "sr-1", ownerOrgId: "org-owner", requestingOrgId: "org-requester", studyId: STUDY.id,
      status: "approved", requestedBy: "user-1", requestedAt: new Date(),
      decidedBy: "user-2", decidedAt: new Date(), note: "why", decisionNote: null,
    };
  }

  it("only the owning org can withdraw", async () => {
    const svc = new SharingService(fakeTenant([STUDY], ORGS, [seedApproved()]) as never, fakeAudit() as never, fakeMailer() as never, fakeTranslation() as never, fakeReports() as never);
    await expect(
      runAsOrg("org-requester", "user-1", () => svc.withdraw("sr-1")),
    ).rejects.toMatchObject({ response: { error: { code: "FORBIDDEN" } } });
  });

  it("cannot withdraw a request that was never approved", async () => {
    const row = { ...seedApproved(), status: "pending" as const, decidedBy: null, decidedAt: null };
    const svc = new SharingService(fakeTenant([STUDY], ORGS, [row]) as never, fakeAudit() as never, fakeMailer() as never, fakeTranslation() as never, fakeReports() as never);
    await expect(
      runAsOrg("org-owner", "user-2", () => svc.withdraw("sr-1")),
    ).rejects.toMatchObject({ response: { error: { code: "SHARING_NOT_APPROVED" } } });
  });

  it("withdraws approved access, stamps who/when, and audits both orgs", async () => {
    const audit = fakeAudit();
    const svc = new SharingService(fakeTenant([STUDY], ORGS, [seedApproved()]) as never, audit as never, fakeMailer() as never, fakeTranslation() as never, fakeReports() as never);
    const result = await runAsOrg("org-owner", "user-3", () => svc.withdraw("sr-1"));

    expect(result.status).toBe("withdrawn");
    expect(result.withdrawnBy).toBe("user-3");
    expect(result.withdrawnAt).not.toBeNull();
    expect(audit.calls).toHaveLength(2);
    expect(audit.calls.map((c) => c.organizationId).sort()).toEqual(["org-owner", "org-requester"].sort());
  });

  it("a withdrawn request can no longer be viewed via getSharedSnapshot", async () => {
    const row = { ...seedApproved(), status: "withdrawn" as const, withdrawnBy: "user-3", withdrawnAt: new Date() };
    const svc = new SharingService(fakeTenant([STUDY], ORGS, [row]) as never, fakeAudit() as never, fakeMailer() as never, fakeTranslation() as never, fakeReports() as never);
    await expect(
      runAsOrg("org-requester", "user-1", () => svc.getSharedSnapshot("sr-1")),
    ).rejects.toMatchObject({ response: { error: { code: "SHARING_NOT_APPROVED" } } });
  });
});

describe("SharingService.getSharedSnapshot", () => {
  const needWhere: Record<string, unknown>[] = [];
  const reportWhere: Record<string, unknown>[] = [];
  function fakeTenantWithNeeds(initialRows: FakeRow[] = []) {
    const base = fakeTenant([STUDY], ORGS, initialRows);
    return {
      ...base,
      runAsSupervisor: async (fn: (tx: unknown) => unknown) =>
        fn({
          study: {
            findUnique: async () => ({
              ...STUDY,
              org: { name: "Owner NGO" },
              studyGovernorates: [{ governorate: { name: "Afif", nameAr: "عفيف" } }],
              studyType: "baseline",
              targetSector: null,
              population: 1200,
              requiredSampleSize: 292,
              createdAt: new Date("2026-09-16T00:00:00Z"),
            }),
          },
          need: {
            findMany: async (args: { where: Record<string, unknown> }) => {
              needWhere.push(args.where);
              return [
                {
                  id: "n1", statement: "Need water", village: ["V1"], status: "reviewer_approved",
                  internalRefSeq: 12, title: "Water", domain: "Water", subDomain: null, affectedPopulation: 40,
                },
              ];
            },
          },
          evidence: {
            findMany: async () => [
              { id: "e1", title: "Photo", fileName: "a.jpg", fileType: "image/jpeg", needId: "n1", uploadedAt: new Date("2026-09-17T00:00:00Z") },
              { id: "e2", title: null, fileName: "b.pdf", fileType: "application/pdf", needId: "n1", uploadedAt: new Date("2026-09-18T00:00:00Z") },
            ],
          },
          report: {
            findMany: async (args: { where: Record<string, unknown> }) => {
              reportWhere.push(args.where);
              return [{ id: "rep-1", title: "Core needs", reportType: "RPT18", generatedAt: new Date("2026-10-01T00:00:00Z") }];
            },
          },
          organisation: { findUnique: async () => ({ name: "Owner NGO" }) },
        }),
    };
  }

  it("refuses to reveal an unapproved request's snapshot (never shared without approval)", async () => {
    const row: FakeRow = {
      id: "sr-1", ownerOrgId: "org-owner", requestingOrgId: "org-requester", studyId: STUDY.id,
      status: "pending", requestedBy: "user-1", requestedAt: new Date(),
      decidedBy: null, decidedAt: null, note: null, decisionNote: null,
    };
    const svc = new SharingService(fakeTenantWithNeeds([row]) as never, fakeAudit() as never, fakeMailer() as never, fakeTranslation() as never, fakeReports() as never);
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
    const svc = new SharingService(fakeTenantWithNeeds([row]) as never, fakeAudit() as never, fakeMailer() as never, fakeTranslation() as never, fakeReports() as never);
    await expect(
      runAsOrg("org-owner", "user-2", () => svc.getSharedSnapshot("sr-1")),
    ).rejects.toMatchObject({ response: { error: { code: "FORBIDDEN" } } });
  });

  it("refuses to reveal a snapshot once the approval has expired (RIO-FR-014, Q30)", async () => {
    const row: FakeRow = {
      id: "sr-1", ownerOrgId: "org-owner", requestingOrgId: "org-requester", studyId: STUDY.id,
      status: "approved", requestedBy: "user-1", requestedAt: new Date(),
      decidedBy: "user-2", decidedAt: new Date(), note: null, decisionNote: null,
      expiresAt: new Date("2020-01-01T00:00:00.000Z"),
    };
    const svc = new SharingService(fakeTenantWithNeeds([row]) as never, fakeAudit() as never, fakeMailer() as never, fakeTranslation() as never, fakeReports() as never);
    await expect(
      runAsOrg("org-requester", "user-1", () => svc.getSharedSnapshot("sr-1")),
    ).rejects.toMatchObject({ response: { error: { code: "SHARING_EXPIRED" } } });
  });

  it("returns the study's needs and evidence count once approved, for the requesting org", async () => {
    const row: FakeRow = {
      id: "sr-1", ownerOrgId: "org-owner", requestingOrgId: "org-requester", studyId: STUDY.id,
      status: "approved", requestedBy: "user-1", requestedAt: new Date(),
      decidedBy: "user-2", decidedAt: new Date(), note: null, decisionNote: null,
    };
    const svc = new SharingService(fakeTenantWithNeeds([row]) as never, fakeAudit() as never, fakeMailer() as never, fakeTranslation() as never, fakeReports() as never);
    const snapshot = await runAsOrg("org-requester", "user-1", () => svc.getSharedSnapshot("sr-1"));
    expect(snapshot.title).toBe(STUDY.title);
    expect(snapshot.needs).toHaveLength(1);
    expect(snapshot.evidenceCount).toBe(2);
  });

  // UAT SHR-04 — "View full study": details, evidence list and released reports.
  it("returns the full read-only study: details, needs with their IDs, evidence and released reports", async () => {
    const row: FakeRow = {
      id: "sr-1", ownerOrgId: "org-owner", requestingOrgId: "org-requester", studyId: STUDY.id,
      status: "approved", requestedBy: "user-1", requestedAt: new Date(),
      decidedBy: "user-2", decidedAt: new Date(), note: null, decisionNote: null,
    };
    const svc = new SharingService(fakeTenantWithNeeds([row]) as never, fakeAudit() as never, fakeMailer() as never, fakeTranslation() as never, fakeReports() as never);
    const snapshot = await runAsOrg("org-requester", "user-1", () => svc.getSharedSnapshot("sr-1"));

    expect(snapshot).toMatchObject({
      ownerOrgName: "Owner NGO",
      studyType: "baseline",
      population: 1200,
      requiredSampleSize: 292,
      governorates: [{ name: "Afif", nameAr: "عفيف" }],
    });
    expect(snapshot.needs[0]).toMatchObject({ internalReferenceId: "NEED-000012", title: "Water", affectedPopulation: 40 });
    expect(snapshot.evidence.map((e) => e.fileName)).toEqual(["a.jpg", "b.pdf"]);
    expect(snapshot.reports).toEqual([
      { id: "rep-1", title: "Core needs", reportType: "RPT18", generatedAt: "2026-10-01T00:00:00.000Z" },
    ]);
    // Merged needs are not part of the study; only released reports are listed.
    expect(needWhere.at(-1)).toMatchObject({ mergedIntoNeedId: null });
    expect(reportWhere.at(-1)).toMatchObject({ status: { in: ["released", "archived"] } });
  });
});

describe("SharingService.getSharedStudyReport (UAT SHR-04)", () => {
  const approved: FakeRow = {
    id: "sr-1", ownerOrgId: "org-owner", requestingOrgId: "org-requester", studyId: STUDY.id,
    status: "approved", requestedBy: "user-1", requestedAt: new Date(),
    decidedBy: "user-2", decidedAt: new Date(), note: null, decisionNote: null,
  };
  const report = (over: Record<string, unknown> = {}) => ({
    id: "rep-1", studyId: STUDY.id, status: "released", reportType: "RPT01", filters: {},
    title: "Collective report", content: { blocks: [] }, generatedAt: "2026-10-01T00:00:00.000Z",
    generatedByName: "Sarah", officerConfirmedBy: null, officerConfirmedByName: null, officerConfirmedAt: null,
    reviewedBy: null, reviewedByName: null, reviewedByRole: null, reviewedAt: null,
    ...over,
  });
  const svcWith = (reports: Record<string, Record<string, unknown>>, rows: FakeRow[] = [approved]) =>
    new SharingService(fakeTenant([STUDY], ORGS, rows) as never, fakeAudit() as never, fakeMailer() as never, fakeTranslation() as never, fakeReports(reports) as never);

  it("shows a released report of the shared study, read-only, in the shared-report shape", async () => {
    const svc = svcWith({ "rep-1": report() });
    const snapshot = await runAsOrg("org-requester", "user-1", () => svc.getSharedStudyReport("sr-1", "rep-1"));
    expect(snapshot).toMatchObject({ reportId: "rep-1", title: "Collective report", ownerOrgName: "Owner NGO", generatedByName: "Sarah" });
  });

  it("refuses a report of another study, or one that is not released", async () => {
    for (const over of [{ studyId: "study-2" }, { status: "draft" }, { status: "submitted" }]) {
      const svc = svcWith({ "rep-1": report(over) });
      await expect(
        runAsOrg("org-requester", "user-1", () => svc.getSharedStudyReport("sr-1", "rep-1")),
      ).rejects.toMatchObject({ response: { error: { code: "REPORT_NOT_FOUND" } } });
    }
  });

  it("refuses a village-level (internal-only) report", async () => {
    const svc = svcWith({ "rep-1": report({ reportType: "RPT18", filters: { scopeLevel: "VILLAGE" } }) });
    await expect(
      runAsOrg("org-requester", "user-1", () => svc.getSharedStudyReport("sr-1", "rep-1")),
    ).rejects.toMatchObject({ response: { error: { code: "VILLAGE_REPORT_INTERNAL" } } });
  });

  it("follows the same rules as the study itself: approved, unexpired, requester only", async () => {
    const svc = svcWith({ "rep-1": report() }, [{ ...approved, status: "pending" }]);
    await expect(
      runAsOrg("org-requester", "user-1", () => svc.getSharedStudyReport("sr-1", "rep-1")),
    ).rejects.toMatchObject({ response: { error: { code: "SHARING_NOT_APPROVED" } } });
    const svc2 = svcWith({ "rep-1": report() });
    await expect(
      runAsOrg("org-owner", "user-2", () => svc2.getSharedStudyReport("sr-1", "rep-1")),
    ).rejects.toMatchObject({ response: { error: { code: "FORBIDDEN" } } });
  });
});
