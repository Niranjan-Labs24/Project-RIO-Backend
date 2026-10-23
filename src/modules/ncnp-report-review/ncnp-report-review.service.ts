import { toJson } from '../../common/prisma/json';
import { ROLE_KEYS } from '../../rbac/role-keys';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { getOrgStore, requireActor } from '../../tenancy/org-context';
import { roleByKey } from '../../rbac/role-matrix';
import { AuditService } from '../audit/audit.service';
import { NcnpReportService } from '../ncnp-report/ncnp-report.service';
import { fmtDate, renderNcnpReportPdf } from '../ncnp-report/ncnp-report-pdf';
import type { NcnpReport } from '../ncnp-report/ncnp-report.types';
import type { SupportedLocale } from '../translation/translation.types';
import { requireNonBlank } from '../../common/validation/require-non-blank';
import type { NcnpReportReviewDetail, NcnpReportReviewRow, NcnpReportReviewSummary } from './ncnp-report-review.types';
import { TranslationService } from '../translation/translation.service';
import { loadMasterDataAliases } from '../reports/i18n/master-data-names';
import { isCoreNeedsContent, type CoreNeedsContent, type ScopeLevel } from '../reports/core-needs/core-needs.types';
import { loadCoreNeedsInputs, resolveStudySurveyId, type CoreInputs } from '../reports/core-needs/load-core-needs';
import { buildCoreNeedsContent } from '../reports/core-needs/build-core-needs';
import { mergeCoreInputs, type NcnpStudyReliability } from '../reports/core-needs/ncnp-needs';
import { loadCoreScopeOptions, type CoreScopeOptions } from '../reports/core-needs/load-core-scope-options';
import { resolveCoreView } from '../reports/core-needs/resolve-core-view';
import { renderCoreNeedsPdf } from '../reports/core-needs/core-needs-pdf';
import { renderCoreNeedsExcel } from '../reports/core-needs/core-needs-excel';
import { requestLocale } from '../../common/locale/request-locale';
import type { GenerateNcnpNeedsDto } from './ncnp-report-review.contract';

// The NCNP Compiled Report's own review workflow — System Admin generates a
// frozen snapshot, System Reviewer approves/rejects it with mandatory
// notes, System Admin does the final publish. Method shapes mirror
// ReportsService.confirm/approve/reject/archive closely (same
// findOrThrow -> status guard -> update -> audit.record structure), but
// this table has no org_id/RLS at all (see NcnpReportReview's schema
// comment) — every query runs via runAsSupervisor, gated by
// assertCrossEntity(), same as NcnpReportService itself.
@Injectable()
export class NcnpReportReviewService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly ncnpReport: NcnpReportService,
    private readonly translation: TranslationService,
  ) {}

  // ── NCNP needs report (Core Needs Report across organisations) ──

  /** Areas and domains across every study on the platform. */
  async needsScopeOptions(): Promise<CoreScopeOptions> {
    this.assertCrossEntity();
    return this.tenant.runAsSupervisor(async (tx) => {
      // Archived studies are left out, as in the organisation's own report.
      const studies = await tx.study.findMany({ where: { isHistorical: false, archivedAt: null }, select: { id: true } });
      return loadCoreScopeOptions(tx, studies.map((s) => s.id));
    });
  }

  /** Every study with scored answers in the scope, with its reliability, so
   *  NCNP can see the data quality behind what it combines (point 2). */
  async needsStudies(scopeLevel: ScopeLevel, unitId: string | null): Promise<NcnpStudyReliability[]> {
    this.assertCrossEntity();
    return this.tenant.runAsSupervisor(async (tx) => {
      const studies = await tx.study.findMany({
        where: { isHistorical: false, archivedAt: null, scoreRollups: { some: {} } },
        select: { id: true },
        orderBy: { createdAt: 'desc' },
      });
      const out: NcnpStudyReliability[] = [];
      for (const s of studies) {
        const inputs = await this.studyInputs(tx, s.id, scopeLevel, unitId);
        if (inputs) out.push(this.reliabilityOf(inputs));
      }
      return out;
    });
  }

  async generateNeeds(body: GenerateNcnpNeedsDto): Promise<NcnpReportReviewSummary> {
    this.assertCrossEntity();
    const generatedBy = requireActor();
    const unitId = body.scopeLevel === 'KINGDOM' ? null : (body.unitId?.trim() || null);
    if (body.scopeLevel !== 'KINGDOM' && !unitId) {
      throw new BadRequestException({ error: { code: 'SCOPE_UNIT_REQUIRED', message: 'Choose the area for this scope level.' } });
    }
    const content = await this.tenant.runAsSupervisor(async (tx) => {
      const list: CoreInputs[] = [];
      // Only active studies, even if a list opened before a study was
      // archived still sends it.
      const active = new Set(
        (
          await tx.study.findMany({
            where: { id: { in: body.studyIds }, isHistorical: false, archivedAt: null },
            select: { id: true },
          })
        ).map((st) => st.id),
      );
      // In the order chosen: the first study is the base the others are compared with.
      for (const id of [...new Set(body.studyIds)].filter((x) => active.has(x))) {
        const inputs = await this.studyInputs(tx, id, body.scopeLevel, unitId);
        if (inputs) list.push(inputs);
      }
      if (!list.length) {
        throw new ConflictException({ error: { code: 'STUDY_NOT_SCORED', message: 'None of the selected studies has scored data in this area.' } });
      }
      const merged = mergeCoreInputs(list);
      const filters = { kind: 'NEEDS', scopeLevel: body.scopeLevel, unitId, domainKeys: body.domainKeys ?? [], studyIds: body.studyIds, output: body.output ?? 'FULL' };
      const built: CoreNeedsContent = buildCoreNeedsContent({
        inputs: merged,
        output: body.output === 'SUMMARY' ? 'SUMMARY' : 'FULL',
        domainKeys: body.domainKeys?.length ? body.domainKeys : null,
        filters,
        generatedAt: new Date().toISOString(),
      });
      // Each study's own result, and its share of the pooled valid responses.
      const studies = list.map((i) => this.reliabilityOf(i));
      const pooled = studies.reduce((t, st) => t + st.valid, 0);
      for (const st of studies) st.sharePct = pooled ? Math.round((st.valid / pooled) * 1000) / 10 : 0;
      return { ...built, header: { ...built.header, isNcnp: true }, studies };
    });

    const row = await this.tenant.runAsSupervisorWrite((tx) =>
      tx.ncnpReportReview.create({
        data: { content: toJson(content), filters: toJson(content.filters), generatedBy },
      }),
    );
    await this.audit.record({
      action: 'create',
      entityType: 'ncnp_report',
      entityId: row.id,
      entityLabel: 'NCNP needs report generated for review',
      changes: [
        { field: 'Status', before: null, after: row.status },
        { field: 'Studies', before: null, after: String(content.studies?.length ?? 0) },
      ],
    });
    return this.toSummary(row, await this.namesFor([row]));
  }

  private async studyInputs(
    tx: Parameters<Parameters<TenantPrismaService['runAsSupervisor']>[0]>[0],
    studyId: string,
    scopeLevel: ScopeLevel,
    unitId: string | null,
  ): Promise<CoreInputs | null> {
    const surveyId = await resolveStudySurveyId(tx, studyId);
    if (!surveyId) return null;
    try {
      const inputs = await loadCoreNeedsInputs(tx, { studyId, surveyId, scopeLevel, unitId });
      return inputs.answers.some((a) => a.status === 'SCORED') ? inputs : null;
    } catch (err) {
      if ((err as Error).message === 'no-data') return null;
      throw err;
    }
  }

  private reliabilityOf(inputs: CoreInputs): NcnpStudyReliability {
    const c = buildCoreNeedsContent({ inputs, output: 'SUMMARY', domainKeys: null, filters: {}, generatedAt: new Date().toISOString() });
    return {
      studyId: inputs.study.id,
      title: inputs.study.title,
      organization: inputs.study.organizationName,
      valid: c.confidence.sample.valid,
      required: c.confidence.sample.required,
      villagesWithData: c.profile.villages.withData,
      unitsWithData: c.confidence.coverage.withData,
      unitsTotal: c.confidence.coverage.total,
      sharePct: null,
      sampleResult: c.confidence.sample.result,
      completenessResult: c.confidence.completeness.result,
      overall: c.confidence.overall,
      methodologyVersion: inputs.study.methodologyVersionLabel,
    };
  }

  /** The needs report's view in the reader's language. */
  private async needsViewFor(row: NcnpReportReviewRow, content: CoreNeedsContent, locale = requestLocale()) {
    const names = await this.namesFor([row]);
    const aliases = await this.tenant.runAsSupervisor((tx) => loadMasterDataAliases(tx as never, locale));
    return resolveCoreView({
      content,
      locale,
      aliases,
      translateMany: (texts, l) => this.translation.translateMany(texts, l),
      audit: {
        generatedBy: names.get(row.generatedBy) ?? null,
        generatedAt: row.generatedAt.toISOString(),
        confirmedBy: null,
        confirmedAt: null,
        reviewedBy: row.reviewedBy ? (names.get(row.reviewedBy) ?? null) : null,
        reviewedRole: row.reviewedBy ? 'System Reviewer' : null,
        reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
        reviewerNotes: row.reviewerNotes,
        version: 1,
      },
    });
  }

  // System Admin: snapshot NcnpReportService.getReport()'s current output
  // into a new draft row — the one genuinely new piece of "generation"
  // logic; NcnpReportService itself is untouched.
  async generate(periodDays?: number, dormantDays?: number): Promise<NcnpReportReviewSummary> {
    this.assertCrossEntity();
    const generatedBy = requireActor();
    const content = await this.ncnpReport.getReport(periodDays, dormantDays);
    const filters = { periodDays: periodDays ?? null, dormantDays: dormantDays ?? null };

    const row = await this.tenant.runAsSupervisorWrite((tx) =>
      tx.ncnpReportReview.create({
        data: {
          content: toJson(content),
          filters: filters,
          generatedBy,
        },
      }),
    );
    await this.audit.record({
      action: 'create',
      entityType: 'ncnp_report',
      entityId: row.id,
      entityLabel: 'NCNP Compiled Report generated for review',
      changes: [
        { field: 'Status', before: null, after: row.status },
      ],
    });
    return this.toSummary(row, await this.namesFor([row]));
  }

  async list(status?: string): Promise<NcnpReportReviewSummary[]> {
    this.assertCrossEntity();
    const rows = await this.tenant.runAsSupervisor((tx) =>
      tx.ncnpReportReview.findMany({
        where: status ? { status: status as never } : undefined,
        orderBy: { generatedAt: 'desc' },
      }),
    );
    const typedRows = rows as unknown as NcnpReportReviewRow[];
    const nameById = await this.namesFor(typedRows);
    return typedRows.map((r) => this.toSummary(r, nameById));
  }

  async getById(id: string): Promise<NcnpReportReviewDetail> {
    this.assertCrossEntity();
    const row = await this.findOrThrow(id);
    const nameById = await this.namesFor([row]);
    const content = row.content as Record<string, unknown>;
    if (isCoreNeedsContent(content)) {
      return { ...this.toSummary(row, nameById), content: { ...content, coreView: await this.needsViewFor(row, content) } };
    }
    return { ...this.toSummary(row, nameById), content };
  }

  // Export the frozen snapshot this specific review holds — not the
  // always-live current data (that's NcnpReportService.exportReport's own,
  // separate job) — so what gets downloaded matches exactly what the
  // Reviewer approved and the Admin published. Only once Released, same
  // rule the UI enforces; includes a full Audit Trail section (generated/
  // reviewed/published by+when, reviewer notes) the live export can't,
  // since that one has no review row to draw them from.
  async exportReport(
    id: string,
    format: 'pdf' | 'excel',
    locale: SupportedLocale = 'en',
  ): Promise<{ filename: string; contentType: string; body: Buffer }> {
    this.assertCrossEntity();
    const row = await this.findOrThrow(id);
    if (row.status !== 'released') {
      throw new BadRequestException({
        error: { code: 'NCNP_REPORT_REVIEW_NOT_RELEASED', message: 'Only a Released report can be exported.' },
      });
    }
    if (isCoreNeedsContent(row.content)) {
      const view = await this.needsViewFor(row, row.content, locale);
      const stamp = row.generatedAt.toISOString().slice(0, 10);
      await this.audit.record({
        action: 'export', entityType: 'ncnp_report', entityId: row.id,
        entityLabel: `NCNP needs report exported (${format})`, metadata: { format },
      });
      return format === 'pdf'
        ? { filename: `ncnp-needs-report-${stamp}.pdf`, contentType: 'application/pdf', body: renderCoreNeedsPdf(view) }
        : {
            filename: `ncnp-needs-report-${stamp}.xlsx`,
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            body: await renderCoreNeedsExcel(view),
          };
    }
    const nameById = await this.namesFor([row]);
    const generatedByName = nameById.get(row.generatedBy) ?? '—';
    const reviewedByName = row.reviewedBy ? (nameById.get(row.reviewedBy) ?? '—') : null;
    const publishedByName = row.publishedBy ? (nameById.get(row.publishedBy) ?? '—') : null;
    // Same client-approved catalogue as ncnp-report-doc.ts's LABELS_AR (this
    // audit trail's fields aren't in that map since they're specific to the
    // review workflow, not the live report) — verbatim from
    // messages/ar.json's app.reports.content.audit / systemAdmin.ncnpReport.
    const auditLabels: Record<string, string> =
      locale === 'ar'
        ? {
            'Generated By': 'أُنشئ بواسطة',
            'Generated On': 'تاريخ الإنشاء',
            'Reviewed By': 'تمت المراجعة بواسطة',
            'Reviewed On': 'تاريخ المراجعة',
            'Reviewer Notes': 'ملاحظات المراجع',
            'Published By': 'تم النشر بواسطة',
            'Published On': 'تاريخ النشر',
          }
        : {};
    const l = (key: string) => auditLabels[key] ?? key;
    const auditRows = [
      { label: l('Generated By'), value: generatedByName },
      { label: l('Generated On'), value: fmtDate(row.generatedAt.toISOString(), locale) },
      { label: l('Reviewed By'), value: reviewedByName ?? '—' },
      { label: l('Reviewed On'), value: row.reviewedAt ? fmtDate(row.reviewedAt.toISOString(), locale) : '—' },
      { label: l('Reviewer Notes'), value: row.reviewerNotes ?? '—' },
      { label: l('Published By'), value: publishedByName ?? '—' },
      { label: l('Published On'), value: row.publishedAt ? fmtDate(row.publishedAt.toISOString(), locale) : '—' },
    ];
    const stored = row.content as NcnpReport;
    const content = await this.ncnpReport.localizeForExport(stored, locale);
    const dateStamp = row.generatedAt.toISOString().slice(0, 10);
    await this.audit.record({
      action: 'export',
      entityType: 'ncnp_report',
      entityId: row.id,
      entityLabel: `NCNP Compiled Report exported (${format})`,
      metadata: { format },
    });
    if (format === 'pdf') {
      return {
        filename: `ncnp-compiled-report-${dateStamp}.pdf`,
        contentType: 'application/pdf',
        body: renderNcnpReportPdf(content, generatedByName, auditRows, locale),
      };
    }
    return {
      filename: `ncnp-compiled-report-${dateStamp}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: await this.ncnpReport.renderExcel(content, generatedByName, locale, auditRows),
    };
  }

  // System Reviewer: approve -> awaiting System Admin publish. Mandatory
  // notes (client requirement) — same shared blank-check as Survey
  // approve/reject.
  async approve(id: string, notes: string): Promise<NcnpReportReviewSummary> {
    this.assertCrossEntity();
    requireNonBlank(notes, 'REVIEWER_NOTES_REQUIRED', 'Reviewer notes are required.');
    const reviewer = requireActor();
    const existing = await this.findOrThrow(id);
    if (existing.status !== 'draft') {
      throw new ConflictException({
        error: { code: 'NCNP_REPORT_REVIEW_NOT_DRAFT', message: 'Only a draft report review can be approved.' },
      });
    }
    const row = await this.tenant.runAsSupervisorWrite((tx) =>
      tx.ncnpReportReview.update({
        where: { id },
        data: { status: 'approved', reviewedBy: reviewer, reviewedAt: new Date(), reviewerNotes: notes },
      }),
    );
    await this.audit.record({
      action: 'approve',
      entityType: 'ncnp_report',
      entityId: row.id,
      entityLabel: 'NCNP Compiled Report approved',
      changes: [{ field: 'Reviewer Notes', before: null, after: notes }],
      metadata: { status: 'approved' },
    });
    return this.toSummary(row, await this.namesFor([row]));
  }

  // System Reviewer: reject — terminal, sent back to System Admin, who must
  // generate a fresh snapshot to try again (no resubmit path, since there's
  // no Researcher-equivalent role here to fix and resubmit the same row).
  async reject(id: string, notes: string): Promise<NcnpReportReviewSummary> {
    this.assertCrossEntity();
    requireNonBlank(notes, 'REVIEWER_NOTES_REQUIRED', 'Reviewer notes are required.');
    const reviewer = requireActor();
    const existing = await this.findOrThrow(id);
    if (existing.status !== 'draft') {
      throw new ConflictException({
        error: { code: 'NCNP_REPORT_REVIEW_NOT_DRAFT', message: 'Only a draft report review can be rejected.' },
      });
    }
    const row = await this.tenant.runAsSupervisorWrite((tx) =>
      tx.ncnpReportReview.update({
        where: { id },
        data: { status: 'rejected', reviewedBy: reviewer, reviewedAt: new Date(), reviewerNotes: notes },
      }),
    );
    await this.audit.record({
      action: 'approve',
      entityType: 'ncnp_report',
      entityId: row.id,
      entityLabel: 'NCNP Compiled Report rejected',
      changes: [{ field: 'Reviewer Notes', before: null, after: notes }],
      metadata: { status: 'rejected' },
    });
    return this.toSummary(row, await this.namesFor([row]));
  }

  // System Admin: final publish, only once a System Reviewer has approved.
  // No notes required — client spec only mandates notes for Approve/Reject.
  async publish(id: string): Promise<NcnpReportReviewSummary> {
    this.assertCrossEntity();
    const publisher = requireActor();
    const existing = await this.findOrThrow(id);
    if (existing.status !== 'approved') {
      throw new ConflictException({
        error: { code: 'NCNP_REPORT_REVIEW_NOT_APPROVED', message: 'Only a Reviewer-approved report can be published.' },
      });
    }
    const row = await this.tenant.runAsSupervisorWrite((tx) =>
      tx.ncnpReportReview.update({
        where: { id },
        data: { status: 'released', publishedBy: publisher, publishedAt: new Date() },
      }),
    );
    await this.audit.record({
      action: 'approve',
      entityType: 'ncnp_report',
      entityId: row.id,
      entityLabel: 'NCNP Compiled Report published',
      metadata: { step: 'publish' },
      changes: [
        { field: 'Status', before: 'approved', after: row.status },
      ],
    });
    return this.toSummary(row, await this.namesFor([row]));
  }

  // Derived/computed alerts for the notifications bell — same pattern as
  // ReviewerSlaService (no persisted Notification row; queried fresh each
  // call), role-branched here since this endpoint serves both System
  // Reviewer (pending decision) and System Admin (ready to publish).
  async listAlerts(): Promise<Array<{ id: string; type: string; generatedAt: string }>> {
    this.assertCrossEntity();
    const role = getOrgStore()?.role;
    const status = role === ROLE_KEYS.systemReviewer ? 'draft' : 'approved';
    const rows = await this.tenant.runAsSupervisor((tx) =>
      tx.ncnpReportReview.findMany({ where: { status }, orderBy: { generatedAt: 'desc' } }),
    );
    const type = role === ROLE_KEYS.systemReviewer ? 'ncnp_report_pending_review' : 'ncnp_report_ready_to_publish';
    return (rows as unknown as NcnpReportReviewRow[]).map((r) => ({ id: r.id, type, generatedAt: r.generatedAt.toISOString() }));
  }

  private async findOrThrow(id: string): Promise<NcnpReportReviewRow> {
    const row = await this.tenant.runAsSupervisor((tx) => tx.ncnpReportReview.findUnique({ where: { id } }));
    if (!row) {
      throw new NotFoundException({ error: { code: 'NCNP_REPORT_REVIEW_NOT_FOUND', message: 'NCNP report review not found' } });
    }
    return row;
  }

  private toSummary(
    row: NcnpReportReviewRow,
    nameById: Map<string, string> = new Map(),
  ): NcnpReportReviewSummary {
    return {
      id: row.id,
      status: row.status,
      filters: row.filters as Record<string, unknown>,
      generatedBy: row.generatedBy,
      generatedByName: nameById.get(row.generatedBy) ?? null,
      generatedAt: row.generatedAt.toISOString(),
      reviewedBy: row.reviewedBy,
      reviewedByName: row.reviewedBy ? (nameById.get(row.reviewedBy) ?? null) : null,
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
      reviewerNotes: row.reviewerNotes,
      publishedBy: row.publishedBy,
      publishedByName: row.publishedBy ? (nameById.get(row.publishedBy) ?? null) : null,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    };
  }

  private async namesFor(rows: NcnpReportReviewRow[]): Promise<Map<string, string>> {
    const userIds = [
      ...new Set(rows.flatMap((r) => [r.generatedBy, r.reviewedBy, r.publishedBy]).filter((id): id is string => id !== null)),
    ];
    if (userIds.length === 0) return new Map();
    const users = await this.tenant.runAsSupervisor((tx) => tx.user.findMany({ where: { id: { in: userIds } } }));
    return new Map(users.map((u) => [u.id, u.name]));
  }

  // Same check as NcnpReportService.assertCrossEntity — duplicated rather
  // than shared, matching this codebase's existing convention (each
  // cross-entity-gated service already has its own copy: organizations,
  // supervisor-overview, users, ncnp-report).
  private assertCrossEntity(): void {
    const role = getOrgStore()?.role;
    if (!role || roleByKey(role)?.crossEntity !== true) {
      throw new ForbiddenException({
        error: { code: 'FORBIDDEN', message: 'Only NCNP users can access the NCNP Compiled Report review workflow.' },
      });
    }
  }
}
