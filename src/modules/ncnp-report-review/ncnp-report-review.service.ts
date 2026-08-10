import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { getOrgStore, requireActor } from '../../tenancy/org-context';
import { roleByKey } from '../../rbac/role-matrix';
import { AuditService } from '../audit/audit.service';
import { NcnpReportService } from '../ncnp-report/ncnp-report.service';
import { buildNcnpReportDoc } from '../ncnp-report/ncnp-report-doc';
import { fmtDate, renderNcnpReportPdf } from '../ncnp-report/ncnp-report-pdf';
import type { NcnpReport } from '../ncnp-report/ncnp-report.types';
import { renderReportExcel } from '../reports/excel-builder';
import { requireNonBlank } from '../../common/validation/require-non-blank';
import type { NcnpReportReviewDetail, NcnpReportReviewRow, NcnpReportReviewSummary } from './ncnp-report-review.types';

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
  ) {}

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
          content: content as unknown as Prisma.InputJsonValue,
          filters: filters as unknown as Prisma.InputJsonValue,
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
    return this.toSummary(row as unknown as NcnpReportReviewRow, await this.namesFor([row as unknown as NcnpReportReviewRow]));
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
    return { ...this.toSummary(row, nameById), content: row.content as Record<string, unknown> };
  }

  // Export the frozen snapshot this specific review holds — not the
  // always-live current data (that's NcnpReportService.exportReport's own,
  // separate job) — so what gets downloaded matches exactly what the
  // Reviewer approved and the Admin published. Only once Released, same
  // rule the UI enforces; includes a full Audit Trail section (generated/
  // reviewed/published by+when, reviewer notes) the live export can't,
  // since that one has no review row to draw them from.
  async exportReport(id: string, format: 'pdf' | 'excel'): Promise<{ filename: string; contentType: string; body: Buffer }> {
    this.assertCrossEntity();
    const row = await this.findOrThrow(id);
    if (row.status !== 'released') {
      throw new BadRequestException({
        error: { code: 'NCNP_REPORT_REVIEW_NOT_RELEASED', message: 'Only a Released report can be exported.' },
      });
    }
    const nameById = await this.namesFor([row]);
    const generatedByName = nameById.get(row.generatedBy) ?? '—';
    const reviewedByName = row.reviewedBy ? (nameById.get(row.reviewedBy) ?? '—') : null;
    const publishedByName = row.publishedBy ? (nameById.get(row.publishedBy) ?? '—') : null;
    const auditRows = [
      { label: 'Generated By', value: generatedByName },
      { label: 'Generated On', value: fmtDate(row.generatedAt.toISOString()) },
      { label: 'Reviewed By', value: reviewedByName ?? '—' },
      { label: 'Reviewed On', value: row.reviewedAt ? fmtDate(row.reviewedAt.toISOString()) : '—' },
      { label: 'Reviewer Notes', value: row.reviewerNotes ?? '—' },
      { label: 'Published By', value: publishedByName ?? '—' },
      { label: 'Published On', value: row.publishedAt ? fmtDate(row.publishedAt.toISOString()) : '—' },
    ];
    const content = row.content as unknown as NcnpReport;
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
        body: renderNcnpReportPdf(content, generatedByName, auditRows),
      };
    }
    return {
      filename: `ncnp-compiled-report-${dateStamp}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: await renderReportExcel(buildNcnpReportDoc(content, generatedByName, auditRows)),
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
    return this.toSummary(row as unknown as NcnpReportReviewRow, await this.namesFor([row as unknown as NcnpReportReviewRow]));
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
    return this.toSummary(row as unknown as NcnpReportReviewRow, await this.namesFor([row as unknown as NcnpReportReviewRow]));
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
    return this.toSummary(row as unknown as NcnpReportReviewRow, await this.namesFor([row as unknown as NcnpReportReviewRow]));
  }

  // Derived/computed alerts for the notifications bell — same pattern as
  // ReviewerSlaService (no persisted Notification row; queried fresh each
  // call), role-branched here since this endpoint serves both System
  // Reviewer (pending decision) and System Admin (ready to publish).
  async listAlerts(): Promise<Array<{ id: string; type: string; generatedAt: string }>> {
    this.assertCrossEntity();
    const role = getOrgStore()?.role;
    const status = role === 'system_reviewer' ? 'draft' : 'approved';
    const rows = await this.tenant.runAsSupervisor((tx) =>
      tx.ncnpReportReview.findMany({ where: { status }, orderBy: { generatedAt: 'desc' } }),
    );
    const type = role === 'system_reviewer' ? 'ncnp_report_pending_review' : 'ncnp_report_ready_to_publish';
    return (rows as unknown as NcnpReportReviewRow[]).map((r) => ({ id: r.id, type, generatedAt: r.generatedAt.toISOString() }));
  }

  private async findOrThrow(id: string): Promise<NcnpReportReviewRow> {
    const row = await this.tenant.runAsSupervisor((tx) => tx.ncnpReportReview.findUnique({ where: { id } }));
    if (!row) {
      throw new NotFoundException({ error: { code: 'NCNP_REPORT_REVIEW_NOT_FOUND', message: 'NCNP report review not found' } });
    }
    return row as unknown as NcnpReportReviewRow;
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
