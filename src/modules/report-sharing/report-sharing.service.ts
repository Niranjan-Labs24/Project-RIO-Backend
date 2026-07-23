import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { getOrgStore, requireActor, requireOrgId } from "../../tenancy/org-context";
import { roleByKey } from "../../rbac/role-matrix";
import { AuditService } from "../audit/audit.service";
import { ReportsService } from "../reports/reports.service";
import type { ExportFormat } from "../reports/reports.types";
import type {
  CreateReportSharingRequestPayload, DecideReportSharingRequestPayload, OrgLookupResult,
  ReportLookupResult, ReportSharingRequest, ReportSharingRequestRow, SharedReportSnapshot,
} from "./report-sharing.types";

// report_sharing_requests has no RLS (mirrors sharing_requests — see that
// model's comment in schema.prisma) — a request is inherently visible to
// both the owning and requesting orgs, plus the cross-entity Center
// Supervisor. Authorization is enforced here instead of at the DB layer.
//
// Deliberately NOT generalized into one polymorphic table/service shared
// with SharingService (Study-sharing) — see ReportSharingRequest's own
// schema.prisma comment for the reasoning (this codebase always uses one
// join table per relationship, even for more structurally similar pairs
// like OrganisationGovernorate/OrganisationCenter). The near-duplication
// here is schema-level only; the actual UI (see the frontend's shared
// <SharingRequestsPage>) and the reject-reason field shape are shared.
@Injectable()
export class ReportSharingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly reports: ReportsService,
  ) {}

  private isCrossEntity(): boolean {
    const role = getOrgStore()?.role;
    return role !== undefined && roleByKey(role)?.crossEntity === true;
  }

  async create(payload: CreateReportSharingRequestPayload): Promise<ReportSharingRequest> {
    const requestingOrgId = requireOrgId();
    const requestedBy = requireActor();
    if (payload.ownerOrgId === requestingOrgId) {
      throw new BadRequestException({
        error: { code: "CANNOT_REQUEST_OWN_REPORT", message: "You already own this report." },
      });
    }

    // Cross-org existence + ownership + approval check — sharing only ever
    // starts from an already-approved report (RIO-FR-014).
    const report = await this.tenant.runAsSupervisor((tx) =>
      tx.report.findUnique({ where: { id: payload.reportId } }),
    );
    if (!report || report.orgId !== payload.ownerOrgId) {
      throw new NotFoundException({ error: { code: "REPORT_NOT_FOUND", message: "Report not found" } });
    }
    if (report.status !== "approved") {
      throw new BadRequestException({
        error: { code: "REPORT_NOT_APPROVED", message: "Only an approved report can be requested for sharing." },
      });
    }

    const row = await this.prisma.reportSharingRequest.create({
      data: {
        ownerOrgId: payload.ownerOrgId,
        requestingOrgId,
        reportId: payload.reportId,
        requestedBy,
        note: payload.note ?? null,
      },
    });
    await this.audit.record({
      action: "create",
      entityType: "report_sharing_request",
      entityId: row.id,
      entityLabel: `Report sharing request for "${report.title}"`,
      organizationId: requestingOrgId,
    });
    return this.enrichOne(row as unknown as ReportSharingRequestRow);
  }

  async list(): Promise<ReportSharingRequest[]> {
    const orgId = requireOrgId();
    const rows = this.isCrossEntity()
      ? await this.prisma.reportSharingRequest.findMany({ orderBy: { requestedAt: "desc" } })
      : await this.prisma.reportSharingRequest.findMany({
          where: { OR: [{ ownerOrgId: orgId }, { requestingOrgId: orgId }] },
          orderBy: { requestedAt: "desc" },
        });
    return this.enrichMany(rows as unknown as ReportSharingRequestRow[]);
  }

  async getById(id: string): Promise<ReportSharingRequest> {
    const row = await this.findVisibleOrThrow(id);
    return this.enrichOne(row);
  }

  async approve(id: string, payload: DecideReportSharingRequestPayload = {}): Promise<ReportSharingRequest> {
    return this.decide(id, "approved", payload.note);
  }

  async reject(id: string, payload: DecideReportSharingRequestPayload = {}): Promise<ReportSharingRequest> {
    return this.decide(id, "rejected", payload.note);
  }

  async getSharedSnapshot(id: string): Promise<SharedReportSnapshot> {
    const row = await this.findVisibleOrThrow(id);
    const orgId = requireOrgId();
    if (row.status !== "approved") {
      throw new ForbiddenException({
        error: { code: "SHARING_NOT_APPROVED", message: "This sharing request has not been approved." },
      });
    }
    if (!this.isCrossEntity() && row.requestingOrgId !== orgId) {
      throw new ForbiddenException({
        error: { code: "FORBIDDEN", message: "Only the requesting organisation can view the shared report." },
      });
    }
    const report = await this.reports.findAcrossOrgsOrThrow(row.reportId);
    return {
      reportId: report.id,
      title: report.title,
      reportType: report.reportType,
      content: report.content,
      generatedAt: report.generatedAt,
    };
  }

  // Post-approval access is exactly: (1) read-only in-app snapshot above,
  // (2) PDF/Excel export below. No edit/delete/re-share/archive route exists
  // for a requesting org on a report it doesn't own — those endpoints only
  // ever check the OWNING org's own normal permissions, so a requesting org
  // simply has no path to them, not something explicitly disabled here.
  async exportSharedReport(id: string, format: ExportFormat): Promise<{ filename: string; contentType: string; body: Buffer }> {
    const row = await this.findVisibleOrThrow(id);
    const orgId = requireOrgId();
    if (row.status !== "approved") {
      throw new ForbiddenException({
        error: { code: "SHARING_NOT_APPROVED", message: "This sharing request has not been approved." },
      });
    }
    if (!this.isCrossEntity() && row.requestingOrgId !== orgId) {
      throw new ForbiddenException({
        error: { code: "FORBIDDEN", message: "Only the requesting organisation can export the shared report." },
      });
    }
    return this.reports.exportForApprovedSharingGrant(row.reportId, format);
  }

  // Organizations searchable for a new sharing request — name-only, active
  // orgs, excluding the caller's own (you can't request your own report).
  async lookupOrganizations(query: string | undefined): Promise<OrgLookupResult[]> {
    const orgId = requireOrgId();
    const rows = await this.tenant.runAsSupervisor((tx) =>
      tx.organisation.findMany({
        where: {
          id: { not: orgId },
          isActive: true,
          ...(query ? { name: { contains: query, mode: "insensitive" } } : {}),
        },
        orderBy: { name: "asc" },
        take: 20,
      }),
    );
    return rows.map((r) => ({ id: r.id, name: r.name }));
  }

  // Only an org's own APPROVED reports are eligible to be requested for
  // sharing (RIO-FR-014's "sharing only after approval").
  async lookupReportsForOrg(ownerOrgId: string): Promise<ReportLookupResult[]> {
    const rows = await this.tenant.runAsSupervisor((tx) =>
      tx.report.findMany({
        where: { orgId: ownerOrgId, status: "approved" },
        orderBy: { generatedAt: "desc" },
      }),
    );
    return rows.map((r) => ({ id: r.id, title: r.title }));
  }

  private async decide(
    id: string,
    status: "approved" | "rejected",
    decisionNote: string | undefined,
  ): Promise<ReportSharingRequest> {
    const orgId = requireOrgId();
    const decidedBy = requireActor();
    const existing = await this.prisma.reportSharingRequest.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException({ error: { code: "REPORT_SHARING_REQUEST_NOT_FOUND", message: "Report sharing request not found" } });
    }
    if (existing.ownerOrgId !== orgId) {
      throw new ForbiddenException({
        error: { code: "FORBIDDEN", message: "Only the owning organisation can decide this request." },
      });
    }
    if (existing.status !== "pending") {
      throw new BadRequestException({
        error: { code: "REPORT_SHARING_REQUEST_ALREADY_DECIDED", message: "This request has already been decided." },
      });
    }

    const row = await this.prisma.reportSharingRequest.update({
      where: { id },
      data: { status, decidedBy, decidedAt: new Date(), decisionNote: decisionNote ?? null },
    });
    const report = await this.tenant.runAsSupervisor((tx) =>
      tx.report.findUnique({ where: { id: row.reportId } }),
    );
    await this.audit.record({
      action: status === "approved" ? "approve" : "edit",
      entityType: "report_sharing_request",
      entityId: row.id,
      entityLabel: `Report sharing request for "${report?.title ?? row.reportId}"`,
      organizationId: orgId,
      ...(decisionNote ? { changes: [{ field: "Decision Note", before: null, after: decisionNote }] } : {}),
    });
    return this.enrichOne(row as unknown as ReportSharingRequestRow);
  }

  private async findVisibleOrThrow(id: string): Promise<ReportSharingRequestRow> {
    const orgId = requireOrgId();
    const row = await this.prisma.reportSharingRequest.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException({ error: { code: "REPORT_SHARING_REQUEST_NOT_FOUND", message: "Report sharing request not found" } });
    }
    const visible = this.isCrossEntity() || row.ownerOrgId === orgId || row.requestingOrgId === orgId;
    if (!visible) {
      throw new NotFoundException({ error: { code: "REPORT_SHARING_REQUEST_NOT_FOUND", message: "Report sharing request not found" } });
    }
    return row as unknown as ReportSharingRequestRow;
  }

  private async enrichOne(row: ReportSharingRequestRow): Promise<ReportSharingRequest> {
    const [enriched] = await this.enrichMany([row]);
    return enriched as ReportSharingRequest;
  }

  // Batched to avoid N+1 org/report lookups when rendering the list — one
  // supervisor read for all reports involved, one for all orgs involved.
  private async enrichMany(rows: ReportSharingRequestRow[]): Promise<ReportSharingRequest[]> {
    const reportIds = Array.from(new Set(rows.map((r) => r.reportId)));
    const orgIds = Array.from(new Set(rows.flatMap((r) => [r.ownerOrgId, r.requestingOrgId])));

    const [reports, orgs] = await Promise.all([
      reportIds.length === 0
        ? Promise.resolve([])
        : this.tenant.runAsSupervisor((tx) => tx.report.findMany({ where: { id: { in: reportIds } } })),
      orgIds.length === 0
        ? Promise.resolve([])
        : this.tenant.runAsSupervisor((tx) => tx.organisation.findMany({ where: { id: { in: orgIds } } })),
    ]);
    const reportById = new Map(reports.map((r) => [r.id, r]));
    const orgById = new Map(orgs.map((o) => [o.id, o]));

    return rows.map((row) => ({
      id: row.id,
      ownerOrgId: row.ownerOrgId,
      ownerOrgName: orgById.get(row.ownerOrgId)?.name ?? row.ownerOrgId,
      requestingOrgId: row.requestingOrgId,
      requestingOrgName: orgById.get(row.requestingOrgId)?.name ?? row.requestingOrgId,
      reportId: row.reportId,
      reportTitle: reportById.get(row.reportId)?.title ?? row.reportId,
      status: row.status,
      requestedBy: row.requestedBy,
      requestedAt: row.requestedAt.toISOString(),
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      note: row.note,
      decisionNote: row.decisionNote,
    }));
  }
}
