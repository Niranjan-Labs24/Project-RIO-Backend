import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "../../generated/prisma";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { getOrgStore, requireActor, requireOrgId } from "../../tenancy/org-context";
import { can } from "../../rbac/role-matrix";
import { AuditService } from "../audit/audit.service";
import { buildPlaceholderReport, buildExportStub, type ExportAuditMeta } from "./reports.placeholder";
import { villageGenerator } from "./generators/village.generator";
import { sectorGenerator } from "./generators/sector.generator";
import { regionGenerator } from "./generators/region.generator";
import { executiveGenerator } from "./generators/executive.generator";
import { collectiveGenerator } from "./generators/collective.generator";
import { sharingStatusGenerator } from "./generators/sharing-status.generator";
import { ReportDataProvider } from "./providers/report-data.provider";
import {
  EXPORTABLE_STATUSES,
  REPORT_TYPE_META,
  type CreateReportPayload,
  type ExportFormat,
  type ListReportsParams,
  type Report,
  type ReportRow,
  type ReportStatus,
  type ReportTypeCode,
} from "./reports.types";

// The real assessment window = the study's survey-response collection span
// (first → last submittedAt). Formatted like "01 July 2026 - 15 July 2026";
// undefined when no responses exist yet (mock supplies its own fallback).
function formatAssessmentPeriod(min: Date | null, max: Date | null): string | undefined {
  if (!min || !max) return undefined;
  const fmt = (d: Date) => d.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
  const from = fmt(min);
  const to = fmt(max);
  return from === to ? from : `${from} - ${to}`;
}

// Minimal shape both runInOrgContext and runAsSupervisor transaction clients
// satisfy — just enough for resolveExportAuditMeta's own two lookups.
interface ExportMetaTx {
  user: { findMany: (args: { where: { id: { in: string[] } } }) => Promise<{ id: string; name: string }[]> };
  study: { findUnique: (args: { where: { id: string } }) => Promise<{ title: string } | null> };
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly reportData: ReportDataProvider,
  ) {}

  async create(payload: CreateReportPayload): Promise<Report> {
    const meta = REPORT_TYPE_META[payload.reportType];
    if (meta.requiresStudyId && !payload.studyId) {
      throw new BadRequestException({
        error: { code: "STUDY_ID_REQUIRED", message: `${payload.reportType} requires a studyId.` },
      });
    }
    const orgId = requireOrgId();
    const generatedBy = requireActor();
    const filters = payload.filters ?? {};

    const { title, content } = await this.generateContent(payload.reportType, payload.studyId, filters);

    const row = await this.tenant.runInOrgContext((tx) =>
      tx.report.create({
        data: {
          orgId,
          reportType: payload.reportType,
          title,
          studyId: payload.studyId ?? null,
          filters: filters as unknown as Prisma.InputJsonValue,
          content: content as unknown as Prisma.InputJsonValue,
          generatedBy,
        },
      }),
    );
    await this.audit.record({ action: "create", entityType: "report", entityId: row.id, entityLabel: title });
    return this.toReport(row as unknown as ReportRow);
  }

  async list(params: ListReportsParams): Promise<Report[]> {
    const rows = await this.tenant.runInOrgContext((tx) =>
      tx.report.findMany({
        where: { reportType: params.reportType, status: this.visibleStatusWhere(params.status), studyId: params.studyId },
        orderBy: { generatedAt: "desc" },
      }),
    );
    return (rows as unknown as ReportRow[]).map((r) => this.toReport(r));
  }

  async getById(id: string): Promise<Report> {
    const row = await this.findOrThrow(id);
    // Don't leak in-review (draft/rejected) reports to read-only entity users.
    if (!this.canSeeAllStatuses() && !EXPORTABLE_STATUSES.includes(row.status)) {
      throw new NotFoundException({ error: { code: "REPORT_NOT_FOUND", message: "Report not found" } });
    }
    return this.toReport(row);
  }

  // Officers/reviewers/analysts (anyone who can create/write/approve reports)
  // see every status incl. draft & rejected; read-only "entity users" only
  // ever see released/archived reports.
  private canSeeAllStatuses(): boolean {
    const role = getOrgStore()?.role;
    return (
      can(role, "reportsDashboards", "write") ||
      can(role, "reportsDashboards", "approve") ||
      can(role, "reportsDashboards", "create")
    );
  }

  private visibleStatusWhere(requested?: ReportStatus): ReportStatus | { in: ReportStatus[] } | undefined {
    if (this.canSeeAllStatuses()) return requested;
    if (!requested) return { in: EXPORTABLE_STATUSES };
    // A read-only user asking for a status they can't see gets an empty result.
    return EXPORTABLE_STATUSES.includes(requested) ? requested : { in: [] };
  }

  // Officer confirms a draft — the first of the two approval steps. Sets the
  // officer fields but keeps the report in draft; a Reviewer still has to
  // approve() to release it.
  async confirm(id: string): Promise<Report> {
    const officer = requireActor();
    const existing = await this.findOrThrow(id);
    if (existing.status !== "draft") {
      throw new ForbiddenException({
        error: { code: "REPORT_NOT_DRAFT", message: "Only a draft report can be confirmed." },
      });
    }
    const row = await this.tenant.runInOrgContext((tx) =>
      tx.report.update({ where: { id }, data: { officerConfirmedBy: officer, officerConfirmedAt: new Date() } }),
    );
    await this.audit.record({ action: "approve", entityType: "report", entityId: row.id, entityLabel: row.title, metadata: { step: "confirm" } });
    return this.toReport(row as unknown as ReportRow);
  }

  // Reviewer approves → released. Requires a prior officer confirm (two-step).
  async approve(id: string): Promise<Report> {
    const reviewer = requireActor();
    const existing = await this.findOrThrow(id);
    if (existing.status !== "draft") {
      throw new ForbiddenException({
        error: { code: "REPORT_NOT_DRAFT", message: "Only a draft report can be approved." },
      });
    }
    if (!existing.officerConfirmedAt) {
      throw new ForbiddenException({
        error: { code: "REPORT_NOT_CONFIRMED", message: "A Research Officer must confirm the report before it can be approved." },
      });
    }
    const row = await this.tenant.runInOrgContext((tx) =>
      tx.report.update({ where: { id }, data: { status: "released", reviewedBy: reviewer, reviewedAt: new Date() } }),
    );
    await this.audit.record({ action: "approve", entityType: "report", entityId: row.id, entityLabel: row.title, metadata: { status: "released" } });
    return this.toReport(row as unknown as ReportRow);
  }

  async reject(id: string): Promise<Report> {
    const reviewer = requireActor();
    const existing = await this.findOrThrow(id);
    if (existing.status !== "draft") {
      throw new ForbiddenException({
        error: { code: "REPORT_NOT_DRAFT", message: "Only a draft report can be rejected." },
      });
    }
    const row = await this.tenant.runInOrgContext((tx) =>
      tx.report.update({ where: { id }, data: { status: "rejected", reviewedBy: reviewer, reviewedAt: new Date() } }),
    );
    await this.audit.record({ action: "approve", entityType: "report", entityId: row.id, entityLabel: row.title, metadata: { status: "rejected" } });
    return this.toReport(row as unknown as ReportRow);
  }

  // Post-study archival — released → archived. Archived reports stay searchable
  // and exportable but read-only (no re-review, no further transitions).
  async archive(id: string): Promise<Report> {
    requireActor();
    const existing = await this.findOrThrow(id);
    if (existing.status !== "released") {
      throw new ForbiddenException({
        error: { code: "REPORT_NOT_RELEASED", message: "Only a released report can be archived." },
      });
    }
    const row = await this.tenant.runInOrgContext((tx) =>
      tx.report.update({ where: { id }, data: { status: "archived", archivedAt: new Date() } }),
    );
    await this.audit.record({ action: "edit", entityType: "report", entityId: row.id, entityLabel: row.title, metadata: { status: "archived" } });
    return this.toReport(row as unknown as ReportRow);
  }

  async export(id: string, format: ExportFormat): Promise<{ filename: string; contentType: string; body: Buffer }> {
    const row = await this.findOrThrow(id);
    const meta = REPORT_TYPE_META[row.reportType];
    if (!EXPORTABLE_STATUSES.includes(row.status)) {
      throw new ForbiddenException({
        error: { code: "REPORT_NOT_RELEASED", message: "Only a released or archived report may be exported." },
      });
    }
    if (!meta.exportFormats.includes(format)) {
      throw new BadRequestException({
        error: { code: "EXPORT_FORMAT_NOT_SUPPORTED", message: `${row.reportType} doesn't support ${format} export.` },
      });
    }
    await this.audit.record({ action: "share", entityType: "report", entityId: row.id, entityLabel: row.title, metadata: { format } });
    const auditMeta = await this.tenant.runInOrgContext((tx) => this.resolveExportAuditMeta(row, tx));
    return buildExportStub(
      format,
      { id: row.id, title: row.title, reportType: row.reportType, content: row.content as Record<string, unknown> },
      auditMeta,
    );
  }

  // Every field renders conditionally in the export itself (see
  // buildExportStub/auditMetaLines) — this just resolves what's actually
  // available, nulls stay nulls rather than "Unknown"/"N/A" filler text.
  private async resolveExportAuditMeta(row: ReportRow, tx: ExportMetaTx): Promise<ExportAuditMeta> {
    const userIds = [row.generatedBy, row.officerConfirmedBy, row.reviewedBy].filter(
      (id): id is string => id !== null,
    );
    const [users, study] = await Promise.all([
      userIds.length === 0 ? Promise.resolve([]) : tx.user.findMany({ where: { id: { in: userIds } } }),
      row.studyId ? tx.study.findUnique({ where: { id: row.studyId } }) : Promise.resolve(null),
    ]);
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    return {
      generatedAt: row.generatedAt.toISOString(),
      status: row.status,
      studyTitle: study?.title ?? null,
      generatedByName: nameById.get(row.generatedBy) ?? null,
      officerConfirmedByName: row.officerConfirmedBy ? (nameById.get(row.officerConfirmedBy) ?? null) : null,
      officerConfirmedAt: row.officerConfirmedAt ? row.officerConfirmedAt.toISOString() : null,
      reviewedByName: row.reviewedBy ? (nameById.get(row.reviewedBy) ?? null) : null,
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
      archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    };
  }

  private async findOrThrow(id: string): Promise<ReportRow> {
    const row = await this.tenant.runInOrgContext((tx) => tx.report.findUnique({ where: { id } }));
    if (!row) throw new NotFoundException({ error: { code: "REPORT_NOT_FOUND", message: "Report not found" } });
    return row as unknown as ReportRow;
  }

  // `reports` has RLS scoped to the caller's own org (see findOrThrow above)
  // — a cross-org report id 404s under the normal `export()` path by design.
  // This is the one exception: ReportSharingService calls this only after
  // confirming an *approved* ReportSharingRequest actually grants the
  // caller's org access to this specific report, so a supervisor-scoped
  // (RLS-bypassing) read is safe here specifically, not a general escape
  // hatch. Same status/format checks and export pipeline as `export()`.
  async exportForApprovedSharingGrant(
    id: string,
    format: ExportFormat,
  ): Promise<{ filename: string; contentType: string; body: Buffer }> {
    const row = (await this.tenant.runAsSupervisor((tx) =>
      tx.report.findUnique({ where: { id } }),
    )) as unknown as ReportRow | null;
    if (!row) throw new NotFoundException({ error: { code: "REPORT_NOT_FOUND", message: "Report not found" } });
    const meta = REPORT_TYPE_META[row.reportType];
    if (!EXPORTABLE_STATUSES.includes(row.status)) {
      throw new ForbiddenException({
        error: { code: "REPORT_NOT_RELEASED", message: "Only a released or archived report may be exported." },
      });
    }
    if (!meta.exportFormats.includes(format)) {
      throw new BadRequestException({
        error: { code: "EXPORT_FORMAT_NOT_SUPPORTED", message: `${row.reportType} doesn't support ${format} export.` },
      });
    }
    await this.audit.record({ action: "share", entityType: "report", entityId: row.id, entityLabel: row.title, metadata: { format, crossOrg: true } });
    const auditMeta = await this.tenant.runAsSupervisor((tx) => this.resolveExportAuditMeta(row, tx));
    return buildExportStub(
      format,
      { id: row.id, title: row.title, reportType: row.reportType, content: row.content as Record<string, unknown> },
      auditMeta,
    );
  }

  // Cross-org read for ReportSharingService's own lookup/snapshot needs
  // (confirming a report exists/belongs to the expected owner org, and
  // returning its flattened content for the read-only shared view). A
  // shared report is view-only -- there is deliberately no cross-org export
  // counterpart to this read; the owning org's own export stays on the
  // normal RLS-scoped `export()` below.
  async findAcrossOrgsOrThrow(id: string): Promise<Report> {
    const row = (await this.tenant.runAsSupervisor((tx) =>
      tx.report.findUnique({ where: { id } }),
    )) as unknown as ReportRow | null;
    if (!row) throw new NotFoundException({ error: { code: "REPORT_NOT_FOUND", message: "Report not found" } });
    return this.toReport(row);
  }

  // RPT-01 and RPT-14 have real generators. RPT-14 (Village Report) reads
  // through the ReportDataProvider seam — mock now, real analytics later, no
  // change here. RPT-02..13 use the shared placeholder content contract from
  // reports.placeholder.ts until the real AI report generation engine lands.
  private async generateContent(
    reportType: ReportTypeCode,
    studyId: string | undefined,
    filters: Record<string, unknown>,
  ): Promise<{ title: string; content: Record<string, unknown> }> {
    const meta = REPORT_TYPE_META[reportType];

    // Real generators reading through the ReportDataProvider seam. Resolve real
    // study metadata up front — title, cycle number, and the actual data-
    // collection window (min/max survey-response date) — so reports carry real
    // identity even while the analytical numbers still come from the provider.
    let studyTitle: string | undefined;
    let assessmentCycle: number | undefined;
    let assessmentPeriod: string | undefined;
    if (studyId) {
      const resolved = await this.tenant.runInOrgContext(async (tx) => {
        const study = await tx.study.findUnique({ where: { id: studyId } });
        const window = await tx.surveyResponse.aggregate({
          where: { studyId },
          _min: { submittedAt: true },
          _max: { submittedAt: true },
        });
        return { study, window };
      });
      studyTitle = resolved.study?.title ?? undefined;
      assessmentCycle = resolved.study?.cycleNumber ?? undefined;
      assessmentPeriod = formatAssessmentPeriod(resolved.window._min.submittedAt, resolved.window._max.submittedAt);
    }
    const providerCtx = {
      provider: this.reportData,
      orgId: requireOrgId(),
      studyId,
      studyTitle,
      assessmentCycle,
      assessmentPeriod,
      filters,
    };
    if (reportType === "RPT14") return villageGenerator(providerCtx);
    if (reportType === "RPT04") return sectorGenerator(providerCtx);
    if (reportType === "RPT06") return regionGenerator(providerCtx);
    if (reportType === "RPT13") return executiveGenerator(providerCtx);
    if (reportType === "RPT02") return collectiveGenerator(providerCtx);
    if (reportType === "RPT12") return sharingStatusGenerator(providerCtx);

    if (reportType === "RPT01") {
      return this.tenant
        .runInOrgContext(async (tx) => {
          const study = await tx.study.findUnique({ where: { id: studyId } });
          if (!study) throw new NotFoundException({ error: { code: "STUDY_NOT_FOUND", message: "Study not found" } });
          // A Study can hold many Needs now — the report covers all of them,
          // each with its own evidence count/priority score/AI summary.
          const needs = await tx.need.findMany({ where: { studyId }, orderBy: { createdAt: "asc" } });
          const needIds = needs.map((n) => n.id);
          // Batched (RIO-NFR-005) instead of 3 queries per Need — a Study
          // with dozens of Needs would otherwise fire 3xN concurrent
          // queries just to build this one report.
          const [evidenceCounts, priorities, summaries] = await Promise.all([
            needIds.length === 0
              ? Promise.resolve([])
              : tx.evidence.groupBy({ by: ["needId"], where: { needId: { in: needIds } }, _count: { _all: true } }),
            needIds.length === 0
              ? Promise.resolve([])
              : tx.priorityScore.findMany({
                  where: { needId: { in: needIds }, approvedAt: { not: null } },
                  orderBy: { scoredAt: "desc" },
                }),
            needIds.length === 0
              ? Promise.resolve([])
              : tx.aiSummary.findMany({ where: { needId: { in: needIds } }, orderBy: { generatedAt: "desc" } }),
          ]);
          const evidenceCountByNeedId = new Map(evidenceCounts.map((e) => [e.needId, e._count._all]));
          // findMany results are ordered desc, so the first entry seen per
          // needId is the latest — same "first wins" semantics as the
          // previous per-need findFirst calls.
          const priorityByNeedId = new Map<string, (typeof priorities)[number]>();
          for (const p of priorities) if (!priorityByNeedId.has(p.needId)) priorityByNeedId.set(p.needId, p);
          const summaryByNeedId = new Map<string, (typeof summaries)[number]>();
          for (const s of summaries) if (!summaryByNeedId.has(s.needId)) summaryByNeedId.set(s.needId, s);

          const needSections = needs.map((need) => {
            const priority = priorityByNeedId.get(need.id);
            const summary = summaryByNeedId.get(need.id);
            return {
              needId: need.id,
              statement: need.statement,
              villages: need.village,
              status: need.status,
              evidenceCount: evidenceCountByNeedId.get(need.id) ?? 0,
              priorityScore: priority ? { level: priority.level, overallScore: priority.overallScore } : null,
              aiSummary: summary?.summaryText ?? null,
            };
          });
          return {
            title: `Individual Study Report — ${study.title}`,
            content: {
              study: { id: study.id, title: study.title },
              needs: needSections,
            },
          };
        })
        .then((result) => ({ ...result, content: { ...result.content, filters, reportKind: meta.kind } }));
    }

    return buildPlaceholderReport(reportType);
  }

  private toReport(row: ReportRow): Report {
    const meta = REPORT_TYPE_META[row.reportType];
    return {
      id: row.id,
      reportType: row.reportType,
      status: row.status,
      title: row.title,
      studyId: row.studyId,
      filters: row.filters as Record<string, unknown>,
      content: row.content as Record<string, unknown>,
      generatedBy: row.generatedBy,
      generatedAt: row.generatedAt.toISOString(),
      officerConfirmedBy: row.officerConfirmedBy,
      officerConfirmedAt: row.officerConfirmedAt ? row.officerConfirmedAt.toISOString() : null,
      reviewedBy: row.reviewedBy,
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
      archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
      exportFormats: meta.exportFormats,
    };
  }
}
