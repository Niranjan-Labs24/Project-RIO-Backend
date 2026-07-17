import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "../../generated/prisma";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { requireActor, requireOrgId } from "../../tenancy/org-context";
import { AuditService } from "../audit/audit.service";
import { buildPlaceholderReport, buildExportStub } from "./reports.placeholder";
import {
  REPORT_TYPE_META,
  type CreateReportPayload,
  type ExportFormat,
  type ListReportsParams,
  type Report,
  type ReportRow,
  type ReportTypeCode,
} from "./reports.types";

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
    return buildExportStub(format, {
      id: row.id,
      title: row.title,
      reportType: row.reportType,
      content: row.content as Record<string, unknown>,
    });
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
          const needSections = await Promise.all(
            needs.map(async (need) => {
              const [evidenceCount, priority, summary] = await Promise.all([
                tx.evidence.count({ where: { needId: need.id } }),
                tx.priorityScore.findFirst({ where: { needId: need.id, approvedAt: { not: null } }, orderBy: { scoredAt: "desc" } }),
                tx.aiSummary.findFirst({ where: { needId: need.id }, orderBy: { generatedAt: "desc" } }),
              ]);
              return {
                needId: need.id,
                statement: need.statement,
                villages: need.village,
                status: need.status,
                evidenceCount,
                priorityScore: priority ? { level: priority.level, overallScore: priority.overallScore } : null,
                aiSummary: summary?.summaryText ?? null,
              };
            }),
          );
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
