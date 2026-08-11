import { describe, expect, it, beforeEach } from "vitest";
import { orgContext } from "../../tenancy/org-context";
import { ReportsService } from "./reports.service";
import type { ReportRow, ReportStatus } from "./reports.types";

// In-memory Report store standing in for the tenant Prisma layer, so the
// lifecycle state machine can be exercised without a database.
function makeHarness() {
  const store = new Map<string, ReportRow>();
  const auditCalls: Array<{
    action: string;
    // Nullable: cross-org "viewed all organisations" events carry no entity
    // id at all (entity_id is a uuid column — see AuditService.record).
    entityId: string | null;
    entityLabel?: string;
    organizationId?: string;
    metadata?: unknown;
  }> = [];
  const userFindManyCalls: unknown[] = [];
  const tx = {
    report: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) => store.get(id) ?? null,
      findMany: async ({ where }: { where: { status?: ReportStatus | { in: ReportStatus[] } } }) => {
        const rows = [...store.values()];
        const s = where?.status;
        if (!s) return rows;
        if (typeof s === "string") return rows.filter((r) => r.status === s);
        return rows.filter((r) => s.in.includes(r.status));
      },
      update: async ({ where: { id }, data }: { where: { id: string }; data: Partial<ReportRow> }) => {
        const row = { ...store.get(id)!, ...data } as ReportRow;
        store.set(id, row);
        return row;
      },
    },
    user: {
      findMany: async (args: unknown) => {
        userFindManyCalls.push(args);
        return [] as { id: string; name: string; roleId: string }[];
      },
    },
    study: { findUnique: async () => null },
  };
  const tenant = {
    runInOrgContext: <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
    runAsSupervisor: <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
  };
  const audit = { record: async (input: (typeof auditCalls)[number]) => { auditCalls.push(input); } };
  const service = new ReportsService(
    tenant as never,
    audit as never,
    {} as never,
    {} as never,
  );
  return { service, store, auditCalls, userFindManyCalls };
}

function seed(store: Map<string, ReportRow>, over: Partial<ReportRow> = {}): ReportRow {
  const row: ReportRow = {
    id: "rpt-1",
    orgId: "org-1",
    reportType: "RPT14",
    status: "draft",
    title: "Village Report — Sample Village",
    studyId: "study-1",
    surveyId: null,
    filters: {},
    content: {},
    generatedBy: "officer-1",
    generatedAt: new Date(),
    officerConfirmedBy: null,
    officerConfirmedAt: null,
    reviewedBy: null,
    reviewedAt: null,
    reviewerNotes: null,
    archivedAt: null,
    ...over,
  };
  store.set(row.id, row);
  return row;
}

function asRole<T>(role: string, fn: () => Promise<T>): Promise<T> {
  return orgContext.run({ requestId: "t", orgId: "org-1", actorId: "actor-1", role }, fn);
}

describe("ReportsService lifecycle (two-step approval)", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness(); });

  it("confirm sets officer fields but keeps the report in draft", async () => {
    seed(h.store);
    const r = await asRole("ngo_research_officer", () => h.service.confirm("rpt-1"));
    expect(r.status).toBe("draft");
    expect(r.officerConfirmedBy).toBe("actor-1");
    expect(r.officerConfirmedAt).not.toBeNull();
  });

  it("approve WITHOUT a prior officer confirm is rejected", async () => {
    seed(h.store);
    await expect(asRole("ngo_admin", () => h.service.approve("rpt-1", "Looks good"))).rejects.toMatchObject({
      response: { error: { code: "REPORT_NOT_CONFIRMED" } },
    });
  });

  it("approve AFTER confirm releases the report", async () => {
    seed(h.store, { officerConfirmedBy: "officer-1", officerConfirmedAt: new Date() });
    const r = await asRole("ngo_admin", () => h.service.approve("rpt-1", "Looks good"));
    expect(r.status).toBe("released");
    expect(r.reviewedBy).toBe("actor-1");
    expect(r.reviewerNotes).toBe("Looks good");
  });

  it("approve rejects blank reviewer notes", async () => {
    seed(h.store, { officerConfirmedBy: "officer-1", officerConfirmedAt: new Date() });
    await expect(asRole("ngo_admin", () => h.service.approve("rpt-1", "   "))).rejects.toMatchObject({
      response: { error: { code: "REVIEWER_NOTES_REQUIRED" } },
    });
  });

  it("archive requires a released report, then makes it archived", async () => {
    seed(h.store, { status: "draft" });
    await expect(asRole("ngo_admin", () => h.service.archive("rpt-1"))).rejects.toMatchObject({
      response: { error: { code: "REPORT_NOT_RELEASED" } },
    });
    h.store.get("rpt-1")!.status = "released";
    const r = await asRole("ngo_admin", () => h.service.archive("rpt-1"));
    expect(r.status).toBe("archived");
    expect(r.archivedAt).not.toBeNull();
  });

  it("blocks export of a draft, allows it once released", async () => {
    seed(h.store, { status: "draft" });
    await expect(asRole("ngo_admin", () => h.service.export("rpt-1", "pdf"))).rejects.toMatchObject({
      response: { error: { code: "REPORT_NOT_RELEASED" } },
    });
    h.store.get("rpt-1")!.status = "released";
    const file = await asRole("ngo_admin", () => h.service.export("rpt-1", "pdf"));
    expect(file.contentType).toBe("application/pdf");
    expect(file.body.length).toBeGreaterThan(0);
  });

  it("hides in-review reports from read-only entity users (getById 404s)", async () => {
    seed(h.store, { status: "draft" });
    await expect(asRole("read_only_viewer", () => h.service.getById("rpt-1"))).rejects.toMatchObject({
      response: { error: { code: "REPORT_NOT_FOUND" } },
    });
    // …but a privileged role can see the draft.
    const r = await asRole("ngo_admin", () => h.service.getById("rpt-1"));
    expect(r.status).toBe("draft");
  });

  it("list restricts read-only users to released/archived only", async () => {
    seed(h.store, { id: "d", status: "draft" } as Partial<ReportRow> as ReportRow & { id: string });
    seed(h.store, { id: "r", status: "released" } as Partial<ReportRow> as ReportRow & { id: string });
    const viewer = await asRole("read_only_viewer", () => h.service.list({}));
    expect(viewer.map((x) => x.status).sort()).toEqual(["released"]);
    const admin = await asRole("ngo_admin", () => h.service.list({}));
    expect(admin.length).toBe(2);
  });

  it("a read-only user requesting a status they can't see gets an empty result, not an error", async () => {
    seed(h.store, { status: "draft" });
    const result = await asRole("read_only_viewer", () => h.service.list({ status: "draft" }));
    expect(result).toEqual([]);
  });

  it("reject transitions a draft to rejected; only a draft can be rejected", async () => {
    seed(h.store, { status: "released" });
    await expect(asRole("ngo_admin", () => h.service.reject("rpt-1", "Missing data"))).rejects.toMatchObject({
      response: { error: { code: "REPORT_NOT_DRAFT" } },
    });
    h.store.get("rpt-1")!.status = "draft";
    const r = await asRole("ngo_admin", () => h.service.reject("rpt-1", "Missing data"));
    expect(r.status).toBe("rejected");
    expect(r.reviewedBy).toBe("actor-1");
    expect(r.reviewerNotes).toBe("Missing data");
  });

  it("reject rejects blank reviewer notes", async () => {
    seed(h.store, { status: "draft" });
    await expect(asRole("ngo_admin", () => h.service.reject("rpt-1", ""))).rejects.toMatchObject({
      response: { error: { code: "REVIEWER_NOTES_REQUIRED" } },
    });
  });

  it("namesFor short-circuits without a user lookup when the result set is empty", async () => {
    // no reports seeded — list() returns [] and namesFor([]) must not call user.findMany
    const result = await asRole("ngo_admin", () => h.service.list({}));
    expect(result).toEqual([]);
    expect(h.userFindManyCalls).toHaveLength(0);
  });
});

describe("ReportsService.create — STUDY_ID_REQUIRED", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness(); });

  it("rejects a study-scoped report type (RPT01) with no studyId, before any content generation", async () => {
    await expect(
      asRole("ngo_admin", () => h.service.create({ reportType: "RPT01" })),
    ).rejects.toMatchObject({ response: { error: { code: "STUDY_ID_REQUIRED" } } });
  });
});

describe("ReportsService.export — format support", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness(); });

  it("EXPORT_FORMAT_NOT_SUPPORTED for an excel-only report type (RPT08) requested as pdf", async () => {
    seed(h.store, { reportType: "RPT08", status: "released" });
    await expect(
      asRole("ngo_admin", () => h.service.export("rpt-1", "pdf")),
    ).rejects.toMatchObject({ response: { error: { code: "EXPORT_FORMAT_NOT_SUPPORTED" } } });
    // excel is supported for RPT08, so that should succeed
    const file = await asRole("ngo_admin", () => h.service.export("rpt-1", "excel"));
    expect(file.contentType).toContain("sheet");
  });

  it("EXPORT_FORMAT_NOT_SUPPORTED for a report type with no export formats at all (RPT11)", async () => {
    seed(h.store, { reportType: "RPT11", status: "released" });
    await expect(
      asRole("ngo_admin", () => h.service.export("rpt-1", "pdf")),
    ).rejects.toMatchObject({ response: { error: { code: "EXPORT_FORMAT_NOT_SUPPORTED" } } });
    await expect(
      asRole("ngo_admin", () => h.service.export("rpt-1", "excel")),
    ).rejects.toMatchObject({ response: { error: { code: "EXPORT_FORMAT_NOT_SUPPORTED" } } });
  });

  it("succeeds when a report has no confirming/reviewing metadata at all (resolveExportAuditMeta nulls)", async () => {
    seed(h.store, {
      status: "released", studyId: null, officerConfirmedBy: null, officerConfirmedAt: null,
      reviewedBy: null, reviewedAt: null,
    });
    const file = await asRole("ngo_admin", () => h.service.export("rpt-1", "pdf"));
    expect(file.contentType).toBe("application/pdf");
    expect(file.body.length).toBeGreaterThan(0);
  });
});

describe("ReportsService — system_admin branches", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness(); });

  it("getById as system_admin bypasses org RLS and records SYSTEM_ADMIN_VIEWED_REPORT", async () => {
    seed(h.store, { status: "draft" });
    const r = await asRole("system_admin", () => h.service.getById("rpt-1"));
    expect(r.status).toBe("draft");
    expect(h.auditCalls.some((c) => c.action === "SYSTEM_ADMIN_VIEWED_REPORT" && c.entityId === "rpt-1")).toBe(true);
  });

  it("getById as system_admin 404s for an unknown id", async () => {
    await expect(
      asRole("system_admin", () => h.service.getById("missing")),
    ).rejects.toMatchObject({ response: { error: { code: "REPORT_NOT_FOUND" } } });
  });

  it("list as system_admin records SYSTEM_ADMIN_VIEWED_REPORT and sees drafts too", async () => {
    seed(h.store, { status: "draft" });
    const result = await asRole("system_admin", () => h.service.list({}));
    expect(result).toHaveLength(1);
    expect(h.auditCalls.some((c) => c.action === "SYSTEM_ADMIN_VIEWED_REPORT")).toBe(true);
  });

  it("records the all-orgs view with a null entityId, never the string 'all'", async () => {
    // Regression: entityId was `params.organizationId ?? "all"`, but
    // audit_logs.entity_id is a uuid column — Postgres rejected the INSERT
    // and AuditService.record() swallowed the error, so every cross-org
    // report view went unaudited while the request still returned 200.
    // The "all organisations" scope belongs in entityLabel/metadata.
    seed(h.store, { status: "draft" });
    await asRole("system_admin", () => h.service.list({}));

    const event = h.auditCalls.find((c) => c.action === "SYSTEM_ADMIN_VIEWED_REPORT");
    expect(event?.entityId ?? null).toBeNull();
    expect(event?.entityLabel).toBe("All Platform Reports");
    expect(event?.metadata).toMatchObject({ scope: "all" });
  });

  it("export as system_admin records SYSTEM_ADMIN_DOWNLOADED_REPORT instead of 'share'", async () => {
    seed(h.store, { status: "released" });
    const file = await asRole("system_admin", () => h.service.export("rpt-1", "pdf"));
    expect(file.body.length).toBeGreaterThan(0);
    expect(h.auditCalls.some((c) => c.action === "SYSTEM_ADMIN_DOWNLOADED_REPORT")).toBe(true);
    expect(h.auditCalls.some((c) => c.action === "share")).toBe(false);
  });

  it("export as system_admin 404s for an unknown id", async () => {
    await expect(
      asRole("system_admin", () => h.service.export("missing", "pdf")),
    ).rejects.toMatchObject({ response: { error: { code: "REPORT_NOT_FOUND" } } });
  });
});

describe("ReportsService.exportForApprovedSharingGrant", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness(); });

  it("404s when the report doesn't exist", async () => {
    await expect(h.service.exportForApprovedSharingGrant("missing", "pdf")).rejects.toMatchObject({
      response: { error: { code: "REPORT_NOT_FOUND" } },
    });
  });

  it("refuses a report that isn't released or archived yet", async () => {
    seed(h.store, { status: "draft" });
    await expect(h.service.exportForApprovedSharingGrant("rpt-1", "pdf")).rejects.toMatchObject({
      response: { error: { code: "REPORT_NOT_RELEASED" } },
    });
  });

  it("refuses an unsupported format for the report's type", async () => {
    seed(h.store, { reportType: "RPT08", status: "released" });
    await expect(h.service.exportForApprovedSharingGrant("rpt-1", "pdf")).rejects.toMatchObject({
      response: { error: { code: "EXPORT_FORMAT_NOT_SUPPORTED" } },
    });
  });

  it("succeeds and records a 'share' audit entry with crossOrg: true metadata", async () => {
    seed(h.store, { status: "released" });
    const file = await h.service.exportForApprovedSharingGrant("rpt-1", "pdf");
    expect(file.contentType).toBe("application/pdf");
    expect(file.body.length).toBeGreaterThan(0);
    expect(h.auditCalls).toContainEqual(
      expect.objectContaining({ action: "share", entityId: "rpt-1", metadata: expect.objectContaining({ crossOrg: true }) }),
    );
  });
});
