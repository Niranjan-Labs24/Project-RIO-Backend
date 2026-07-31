import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "../../generated/prisma";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { getOrgStore, requireActor, requireOrgId } from "../../tenancy/org-context";
import { can, ROLE_MATRIX } from "../../rbac/role-matrix";
import { AuditService } from "../audit/audit.service";
import {
  buildPlaceholderReport,
  buildExportStub,
  isPlaceholderReportType,
  type ExportAuditMeta,
} from "./reports.placeholder";
import { individualSurveyGenerator } from "./generators/individual-survey.generator";
import { combinedGenerator } from "./generators/combined.generator";
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

// Role id → human-readable role name, from the RBAC source of truth. Used to
// annotate the audit trail with the reviewer's role (e.g. "Reviewer/Approver"
// vs "Center Supervisor").
const roleNameById = new Map(ROLE_MATRIX.map((r) => [r.id, r.name]));

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
  user: { findMany: (args: { where: { id: { in: string[] } } }) => Promise<{ id: string; name: string; roleId: string }[]> };
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
    if (meta.requiresSurveyId && !payload.surveyId) {
      throw new BadRequestException({
        error: { code: "SURVEY_ID_REQUIRED", message: `${payload.reportType} requires a surveyId.` },
      });
    }
    // A surveyId that belongs to a different study would silently produce a
    // report whose header says one study and whose numbers come from another.
    if (payload.surveyId) await this.assertSurveyInStudy(payload.surveyId, payload.studyId);

    const orgId = requireOrgId();
    const generatedBy = requireActor();
    const filters = payload.filters ?? {};

    const { title, content } = await this.generateContent(
      payload.reportType,
      payload.studyId,
      filters,
      payload.surveyId,
    );

    const row = await this.tenant.runInOrgContext((tx) =>
      tx.report.create({
        data: {
          orgId,
          reportType: payload.reportType,
          title,
          studyId: payload.studyId ?? null,
          // Only persisted for survey-scoped types — a stray surveyId on a
          // study-scoped type would make the list column lie.
          surveyId: meta.requiresSurveyId ? (payload.surveyId ?? null) : null,
          filters: filters as unknown as Prisma.InputJsonValue,
          content: content as unknown as Prisma.InputJsonValue,
          generatedBy,
        },
      }),
    );
    await this.audit.record({ action: "create", entityType: "report", entityId: row.id, entityLabel: title });
    return this.hydrateOne(row as unknown as ReportRow);
  }

  async list(params: ListReportsParams): Promise<Report[]> {
    const store = getOrgStore();
    const isSysAdmin = store?.role === "system_admin";

    const take = Math.min(Math.max(params.limit ?? 100, 1), 200);
    const skip = Math.max(params.offset ?? 0, 0);

    if (isSysAdmin) {
      const where = {
        ...(params.organizationId ? { orgId: params.organizationId } : {}),
        ...(params.reportType ? { reportType: params.reportType } : {}),
        ...(params.status ? { status: params.status } : {}),
        ...(params.studyId ? { studyId: params.studyId } : {}),
        ...(params.surveyId ? { surveyId: params.surveyId } : {}),
      };
      const rows = await this.tenant.runAsSupervisor((tx) =>
        tx.report.findMany({
          where,
          orderBy: { generatedAt: "desc" },
          take,
          skip,
        }),
      );
      await this.audit.record({
        action: "SYSTEM_ADMIN_VIEWED_REPORT",
        entityType: "report",
        entityId: params.organizationId ?? "all",
        entityLabel: params.organizationId ? "Organization Reports" : "All Platform Reports",
        organizationId: params.organizationId,
      });
      return this.hydrate(rows as unknown as ReportRow[], true);
    }

    const rows = await this.tenant.runInOrgContext((tx) =>
      tx.report.findMany({
        where: {
          reportType: params.reportType,
          status: this.visibleStatusWhere(params.status),
          studyId: params.studyId,
          surveyId: params.surveyId,
        },
        orderBy: { generatedAt: "desc" },
        take,
        skip,
      }),
    );
    return this.hydrate(rows as unknown as ReportRow[]);
  }

  async getById(id: string): Promise<Report> {
    const store = getOrgStore();
    const isSysAdmin = store?.role === "system_admin";

    if (isSysAdmin) {
      const row = (await this.tenant.runAsSupervisor((tx) =>
        tx.report.findUnique({ where: { id } }),
      )) as ReportRow | null;
      if (!row) throw new NotFoundException({ error: { code: "REPORT_NOT_FOUND", message: "Report not found" } });
      await this.audit.record({
        action: "SYSTEM_ADMIN_VIEWED_REPORT",
        entityType: "report",
        entityId: id,
        entityLabel: row.title,
        organizationId: row.orgId,
      });
      return this.hydrateOne(row, true);
    }

    const row = await this.findOrThrow(id);
    // Don't leak in-review (draft/rejected) reports to read-only entity users.
    if (!this.canSeeAllStatuses() && !EXPORTABLE_STATUSES.includes(row.status)) {
      throw new NotFoundException({ error: { code: "REPORT_NOT_FOUND", message: "Report not found" } });
    }
    return this.hydrateOne(row);
  }

  // Officers/reviewers/analysts (anyone who can create/write/approve reports)
  // see every status incl. draft & rejected; read-only "entity users" only
  // ever see released/archived reports.
  private canSeeAllStatuses(): boolean {
    const role = getOrgStore()?.role;
    return (
      role === "system_admin" ||
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
    return this.hydrateOne(row as unknown as ReportRow);
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
    return this.hydrateOne(row as unknown as ReportRow);
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
    return this.hydrateOne(row as unknown as ReportRow);
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
    return this.hydrateOne(row as unknown as ReportRow);
  }

  async export(id: string, format: ExportFormat): Promise<{ filename: string; contentType: string; body: Buffer }> {
    const store = getOrgStore();
    const isSysAdmin = store?.role === "system_admin";

    let row: ReportRow | null = null;
    if (isSysAdmin) {
      row = (await this.tenant.runAsSupervisor((tx) =>
        tx.report.findUnique({ where: { id } }),
      )) as ReportRow | null;
      if (!row) throw new NotFoundException({ error: { code: "REPORT_NOT_FOUND", message: "Report not found" } });
    } else {
      row = await this.findOrThrow(id);
    }

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

    if (isSysAdmin) {
      await this.audit.record({
        action: "SYSTEM_ADMIN_DOWNLOADED_REPORT",
        entityType: "report",
        entityId: row.id,
        entityLabel: row.title,
        organizationId: row.orgId,
        metadata: { format },
      });
      const auditMeta = await this.tenant.runAsSupervisor((tx) => this.resolveExportAuditMeta(row!, tx));
      return buildExportStub(
        format,
        { id: row.id, title: row.title, reportType: row.reportType, content: row.content as Record<string, unknown> },
        auditMeta,
      );
    }

    await this.audit.record({ action: "share", entityType: "report", entityId: row.id, entityLabel: row.title, metadata: { format } });
    const auditMeta = await this.tenant.runInOrgContext((tx) => this.resolveExportAuditMeta(row!, tx));
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
    const roleById = new Map(users.map((u) => [u.id, roleNameById.get(u.roleId) ?? null]));
    return {
      generatedAt: row.generatedAt.toISOString(),
      status: row.status,
      studyTitle: study?.title ?? null,
      generatedByName: nameById.get(row.generatedBy) ?? null,
      officerConfirmedByName: row.officerConfirmedBy ? (nameById.get(row.officerConfirmedBy) ?? null) : null,
      officerConfirmedAt: row.officerConfirmedAt ? row.officerConfirmedAt.toISOString() : null,
      reviewedByName: row.reviewedBy ? (nameById.get(row.reviewedBy) ?? null) : null,
      reviewedByRole: row.reviewedBy ? (roleById.get(row.reviewedBy) ?? null) : null,
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
    return this.hydrateOne(row, true);
  }

  // RPT-01 and RPT-14 have real generators. RPT-14 (Village Report) reads
  // through the ReportDataProvider seam — mock now, real analytics later, no
  // change here. RPT-02..13 use the shared placeholder content contract from
  // reports.placeholder.ts until the real AI report generation engine lands.
  private async generateContent(
    reportType: ReportTypeCode,
    studyId: string | undefined,
    filters: Record<string, unknown>,
    surveyId?: string,
  ): Promise<{ title: string; content: Record<string, unknown> }> {
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
      surveyId,
      studyTitle,
      assessmentCycle,
      assessmentPeriod,
      filters,
    };
    if (reportType === "RPT01") return individualSurveyGenerator(providerCtx);
    if (reportType === "RPT15") return combinedGenerator(providerCtx);
    if (reportType === "RPT14") return villageGenerator(providerCtx);
    if (reportType === "RPT04") return sectorGenerator(providerCtx);
    if (reportType === "RPT06") return regionGenerator(providerCtx);
    if (reportType === "RPT13") return executiveGenerator(providerCtx);
    if (reportType === "RPT02") return collectiveGenerator(providerCtx);
    if (reportType === "RPT12") return sharingStatusGenerator(providerCtx);

    // Exhaustiveness guard: PlaceholderReportType deliberately excludes every
    // type that has a real generator, so if a real type ever reaches here it
    // means its route above is missing. Fail loudly instead of silently
    // emitting placeholder copy under a real report's name.
    if (!isPlaceholderReportType(reportType)) {
      throw new BadRequestException({
        error: {
          code: "REPORT_GENERATOR_MISSING",
          message: `${reportType} has no generator wired.`,
        },
      });
    }
    return buildPlaceholderReport(reportType);
  }

  // Resolve every display field a Report row needs (user names/roles + the
  // survey title) in one batched pass, for one row or many. Call sites used to
  // do `toReport(row, await this.namesFor([row]))` by hand, which meant each new
  // lookup had to be threaded through nine places.
  private async hydrate(rows: ReportRow[], crossOrg = false): Promise<Report[]> {
    const [nameById, surveyTitleById] = await Promise.all([
      this.namesFor(rows, crossOrg),
      this.surveyTitlesFor(rows, crossOrg),
    ]);
    return rows.map((r) => this.toReport(r, nameById, surveyTitleById));
  }

  private async hydrateOne(row: ReportRow, crossOrg = false): Promise<Report> {
    const reports = await this.hydrate([row], crossOrg);
    return reports[0]!;
  }

  private toReport(
    row: ReportRow,
    nameById: Map<string, { name: string; role: string | null }> = new Map(),
    surveyTitleById: Map<string, string> = new Map(),
  ): Report {
    const meta = REPORT_TYPE_META[row.reportType];
    return {
      id: row.id,
      reportType: row.reportType,
      status: row.status,
      title: row.title,
      studyId: row.studyId,
      surveyId: row.surveyId,
      surveyTitle: row.surveyId ? (surveyTitleById.get(row.surveyId) ?? null) : null,
      filters: row.filters as Record<string, unknown>,
      content: row.content as Record<string, unknown>,
      generatedBy: row.generatedBy,
      generatedByName: nameById.get(row.generatedBy)?.name ?? null,
      generatedAt: row.generatedAt.toISOString(),
      officerConfirmedBy: row.officerConfirmedBy,
      officerConfirmedByName: row.officerConfirmedBy ? (nameById.get(row.officerConfirmedBy)?.name ?? null) : null,
      officerConfirmedAt: row.officerConfirmedAt ? row.officerConfirmedAt.toISOString() : null,
      reviewedBy: row.reviewedBy,
      reviewedByName: row.reviewedBy ? (nameById.get(row.reviewedBy)?.name ?? null) : null,
      reviewedByRole: row.reviewedBy ? (nameById.get(row.reviewedBy)?.role ?? null) : null,
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
      archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
      exportFormats: meta.exportFormats,
    };
  }

  // The on-screen viewer showed raw user ids for "Officer Confirmed By" /
  // "Reviewed By" (the PDF/Excel export already resolves these — see
  // resolveExportAuditMeta) — this batches the same lookup for one or many
  // rows so toReport can attach the *Name fields consistently everywhere.
  private async namesFor(rows: ReportRow[], crossOrg = false): Promise<Map<string, { name: string; role: string | null }>> {
    const userIds = [
      ...new Set(rows.flatMap((r) => [r.generatedBy, r.officerConfirmedBy, r.reviewedBy]).filter((id): id is string => id !== null)),
    ];
    if (userIds.length === 0) return new Map();
    // findAcrossOrgsOrThrow's report may belong to a different org than the
    // caller's own — the normal org-scoped RLS context wouldn't see its users.
    const users = crossOrg
      ? await this.tenant.runAsSupervisor((tx) => tx.user.findMany({ where: { id: { in: userIds } } }))
      : await this.tenant.runInOrgContext((tx) => tx.user.findMany({ where: { id: { in: userIds } } }));
    // Role name resolved in-memory from ROLE_MATRIX (the RBAC source of truth,
    // seeded into `roles`) — no extra join needed.
    return new Map(users.map((u) => [u.id, { name: u.name, role: roleNameById.get(u.roleId) ?? null }]));
  }

  // Survey titles for survey-scoped rows (RPT01/RPT15), so the reports list can
  // show WHICH survey a report came from. Same batching + cross-org convention
  // as namesFor above; rows with no surveyId cost nothing.
  private async surveyTitlesFor(rows: ReportRow[], crossOrg = false): Promise<Map<string, string>> {
    const surveyIds = [...new Set(rows.map((r) => r.surveyId).filter((id): id is string => id !== null))];
    if (surveyIds.length === 0) return new Map();
    const surveys = crossOrg
      ? await this.tenant.runAsSupervisor((tx) =>
          tx.survey.findMany({ where: { id: { in: surveyIds } }, select: { id: true, title: true } }),
        )
      : await this.tenant.runInOrgContext((tx) =>
          tx.survey.findMany({ where: { id: { in: surveyIds } }, select: { id: true, title: true } }),
        );
    return new Map(surveys.map((s) => [s.id, s.title]));
  }

  // A survey-scoped report must be generated from a survey that actually sits
  // under the named study — otherwise the header claims one study while the
  // scores come from another. RLS already confines the lookup to the caller's
  // own org, so a cross-org surveyId 404s here rather than leaking.
  private async assertSurveyInStudy(surveyId: string, studyId: string | undefined): Promise<void> {
    const survey = await this.tenant.runInOrgContext((tx) =>
      tx.survey.findUnique({ where: { id: surveyId }, select: { id: true, studyId: true } }),
    );
    if (!survey) {
      throw new NotFoundException({ error: { code: "SURVEY_NOT_FOUND", message: "Survey not found" } });
    }
    if (studyId && survey.studyId !== studyId) {
      throw new BadRequestException({
        error: { code: "SURVEY_NOT_IN_STUDY", message: "That survey does not belong to the selected study." },
      });
    }
  }
}
