import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "../../generated/prisma";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { requireActor, requireOrgId } from "../../tenancy/org-context";
import { AuditService } from "../audit/audit.service";
import { buildPlaceholderReport, buildExportStub, type ExportAuditMeta } from "./reports.placeholder";
import {
  REPORT_TYPE_META,
  type CreateReportPayload,
  type ExportFormat,
  type ListReportsParams,
  type Report,
  type ReportRow,
  type ReportTypeCode,
} from "./reports.types";

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
        where: { reportType: params.reportType, status: params.status, studyId: params.studyId },
        orderBy: { generatedAt: "desc" },
      }),
    );
    return (rows as unknown as ReportRow[]).map((r) => this.toReport(r));
  }

  async getById(id: string): Promise<Report> {
    const row = await this.findOrThrow(id);
    return this.toReport(row);
  }

  async approve(id: string): Promise<Report> {
    return this.review(id, "approved");
  }

  async reject(id: string): Promise<Report> {
    return this.review(id, "rejected");
  }

  async export(id: string, format: ExportFormat): Promise<{ filename: string; contentType: string; body: Buffer }> {
    const row = await this.findOrThrow(id);
    const meta = REPORT_TYPE_META[row.reportType];
    if (row.status !== "approved") {
      throw new ForbiddenException({
        error: { code: "REPORT_NOT_APPROVED", message: "Only an approved report may be exported." },
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
    const userIds = [row.generatedBy, row.reviewedBy].filter((id): id is string => id !== null);
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
      reviewedByName: row.reviewedBy ? (nameById.get(row.reviewedBy) ?? null) : null,
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    };
  }

  private async review(id: string, status: "approved" | "rejected"): Promise<Report> {
    const reviewedBy = requireActor();
    await this.findOrThrow(id);
    const row = await this.tenant.runInOrgContext((tx) =>
      tx.report.update({ where: { id }, data: { status, reviewedBy, reviewedAt: new Date() } }),
    );
    await this.audit.record({ action: "approve", entityType: "report", entityId: row.id, entityLabel: row.title, metadata: { status } });
    return this.toReport(row as unknown as ReportRow);
  }

  private async findOrThrow(id: string): Promise<ReportRow> {
    const row = await this.tenant.runInOrgContext((tx) => tx.report.findUnique({ where: { id } }));
    if (!row) throw new NotFoundException({ error: { code: "REPORT_NOT_FOUND", message: "Report not found" } });
    return row as unknown as ReportRow;
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

  // RPT-01 keeps its real-data path (out of scope here — it gets its own
  // table in a future task). RPT-02..13 use the shared placeholder content
  // contract from reports.placeholder.ts until the real AI report generation
  // engine lands — see buildPlaceholderReport's doc comment.
  private async generateContent(
    reportType: ReportTypeCode,
    studyId: string | undefined,
    filters: Record<string, unknown>,
  ): Promise<{ title: string; content: Record<string, unknown> }> {
    const meta = REPORT_TYPE_META[reportType];

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
      reviewedBy: row.reviewedBy,
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
      exportFormats: meta.exportFormats,
    };
  }
}
