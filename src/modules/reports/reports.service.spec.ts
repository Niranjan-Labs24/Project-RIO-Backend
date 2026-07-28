import { describe, expect, it, beforeEach } from "vitest";
import { orgContext } from "../../tenancy/org-context";
import { ReportsService } from "./reports.service";
import type { ReportRow, ReportStatus } from "./reports.types";

// In-memory Report store standing in for the tenant Prisma layer, so the
// lifecycle state machine can be exercised without a database.
function makeHarness() {
  const store = new Map<string, ReportRow>();
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
    user: { findMany: async () => [] as { id: string; name: string }[] },
    study: { findUnique: async () => null },
  };
  const tenant = {
    runInOrgContext: <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
    runAsSupervisor: <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
  };
  const audit = { record: async () => {} };
  const service = new ReportsService(tenant as never, audit as never, {} as never);
  return { service, store };
}

function seed(store: Map<string, ReportRow>, over: Partial<ReportRow> = {}): ReportRow {
  const row: ReportRow = {
    id: "rpt-1",
    orgId: "org-1",
    reportType: "RPT14",
    status: "draft",
    title: "Village Report — Sample Village",
    studyId: "study-1",
    filters: {},
    content: {},
    generatedBy: "officer-1",
    generatedAt: new Date(),
    officerConfirmedBy: null,
    officerConfirmedAt: null,
    reviewedBy: null,
    reviewedAt: null,
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
    await expect(asRole("ngo_admin", () => h.service.approve("rpt-1"))).rejects.toMatchObject({
      response: { error: { code: "REPORT_NOT_CONFIRMED" } },
    });
  });

  it("approve AFTER confirm releases the report", async () => {
    seed(h.store, { officerConfirmedBy: "officer-1", officerConfirmedAt: new Date() });
    const r = await asRole("ngo_admin", () => h.service.approve("rpt-1"));
    expect(r.status).toBe("released");
    expect(r.reviewedBy).toBe("actor-1");
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
});
