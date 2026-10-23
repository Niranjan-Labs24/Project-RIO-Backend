import { describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { NcnpReportReviewService } from './ncnp-report-review.service';
import { orgContext } from '../../tenancy/org-context';

interface FakeRow {
  id: string;
  status: string;
  content: unknown;
  filters: unknown;
  generatedBy: string;
  generatedAt: Date;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewerNotes: string | null;
  publishedBy: string | null;
  publishedAt: Date | null;
}

function fakeTenant(initial: FakeRow[] = []) {
  const rows = [...initial];
  const tx = {
    ncnpReportReview: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: FakeRow = {
          id: `row-${rows.length + 1}`,
          status: 'draft',
          content: {},
          filters: {},
          generatedBy: 'admin-1',
          generatedAt: new Date(),
          reviewedBy: null,
          reviewedAt: null,
          reviewerNotes: null,
          publishedBy: null,
          publishedAt: null,
          ...data,
        } as FakeRow;
        rows.push(row);
        return row;
      },
      findMany: async ({ where }: { where?: { status?: string } } = {}) =>
        where?.status ? rows.filter((r) => r.status === where.status) : rows,
      findUnique: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const idx = rows.findIndex((r) => r.id === where.id);
        rows[idx] = { ...rows[idx], ...data } as FakeRow;
        return rows[idx];
      },
    },
    user: {
      findMany: async () => [],
    },
  };
  return {
    rows,
    tenant: {
      runAsSupervisor: async (fn: (tx: unknown) => unknown) => fn(tx),
      runAsSupervisorWrite: async (fn: (tx: unknown) => unknown) => fn(tx),
    },
  };
}

function makeService(initial: FakeRow[] = []) {
  const { rows, tenant } = fakeTenant(initial);
  const audit = { record: async () => undefined };
  const ncnpReport = { getReport: async () => ({ generatedAt: new Date().toISOString() }) };
  const service = new NcnpReportReviewService(tenant as never, audit as never, ncnpReport as never);
  return { service, rows };
}

function runAsReviewer<T>(fn: () => Promise<T>): Promise<T> {
  return orgContext.run({ requestId: 'r1', actorId: 'reviewer-1', role: 'system_reviewer' }, fn);
}
function runAsAdmin<T>(fn: () => Promise<T>): Promise<T> {
  return orgContext.run({ requestId: 'r1', actorId: 'admin-1', role: 'system_admin' }, fn);
}
function runAsNonCrossEntity<T>(fn: () => Promise<T>): Promise<T> {
  return orgContext.run({ requestId: 'r1', actorId: 'ngo-1', role: 'ngo_admin' }, fn);
}

describe('NcnpReportReviewService.generate', () => {
  it('System Admin generates a new draft snapshot', async () => {
    const { service } = makeService();
    const result = await runAsAdmin(() => service.generate(30, 90));
    expect(result.status).toBe('draft');
    expect(result.generatedBy).toBe('admin-1');
  });

  it('rejects a non-cross-entity actor', async () => {
    const { service } = makeService();
    await expect(runAsNonCrossEntity(() => service.generate())).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('NcnpReportReviewService.approve/reject', () => {
  const draft: FakeRow = {
    id: 'rev-1', status: 'draft', content: {}, filters: {}, generatedBy: 'admin-1', generatedAt: new Date(),
    reviewedBy: null, reviewedAt: null, reviewerNotes: null, publishedBy: null, publishedAt: null,
  };

  it('requires reviewer notes to approve — rejects with empty notes', async () => {
    const { service } = makeService([{ ...draft }]);
    await expect(runAsReviewer(() => service.approve('rev-1', ''))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('whitespace-only notes still fail', async () => {
    const { service } = makeService([{ ...draft }]);
    await expect(runAsReviewer(() => service.reject('rev-1', '   '))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('approves with real notes — status becomes approved, notes persisted', async () => {
    const { service } = makeService([{ ...draft }]);
    const result = await runAsReviewer(() => service.approve('rev-1', 'Looks accurate, ready to publish.'));
    expect(result.status).toBe('approved');
    expect(result.reviewerNotes).toBe('Looks accurate, ready to publish.');
    expect(result.reviewedBy).toBe('reviewer-1');
  });

  it('rejects with real notes — status becomes rejected, terminal', async () => {
    const { service } = makeService([{ ...draft }]);
    const result = await runAsReviewer(() => service.reject('rev-1', 'Numbers look stale, regenerate.'));
    expect(result.status).toBe('rejected');
    expect(result.reviewerNotes).toBe('Numbers look stale, regenerate.');
  });

  it('cannot approve a report that is not in draft status', async () => {
    const { service } = makeService([{ ...draft, status: 'approved' }]);
    await expect(runAsReviewer(() => service.approve('rev-1', 'Notes'))).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('NcnpReportReviewService.publish', () => {
  const approved: FakeRow = {
    id: 'rev-1', status: 'approved', content: {}, filters: {}, generatedBy: 'admin-1', generatedAt: new Date(),
    reviewedBy: 'reviewer-1', reviewedAt: new Date(), reviewerNotes: 'Looks good', publishedBy: null, publishedAt: null,
  };

  it('System Admin publishes an approved report — no notes required', async () => {
    const { service } = makeService([{ ...approved }]);
    const result = await runAsAdmin(() => service.publish('rev-1'));
    expect(result.status).toBe('released');
    expect(result.publishedBy).toBe('admin-1');
  });

  it('cannot publish a report that has not been approved yet', async () => {
    const { service } = makeService([{ ...approved, status: 'draft', reviewedBy: null }]);
    await expect(runAsAdmin(() => service.publish('rev-1'))).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('NcnpReportReviewService.listAlerts', () => {
  const draft: FakeRow = {
    id: 'rev-1', status: 'draft', content: {}, filters: {}, generatedBy: 'admin-1', generatedAt: new Date(),
    reviewedBy: null, reviewedAt: null, reviewerNotes: null, publishedBy: null, publishedAt: null,
  };
  const approved: FakeRow = { ...draft, id: 'rev-2', status: 'approved' };

  it('System Reviewer sees drafts awaiting their decision', async () => {
    const { service } = makeService([draft, approved]);
    const alerts = await runAsReviewer(() => service.listAlerts());
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.id).toBe('rev-1');
    expect(alerts[0]?.type).toBe('ncnp_report_pending_review');
  });

  it('System Admin sees approved reports ready to publish', async () => {
    const { service } = makeService([draft, approved]);
    const alerts = await runAsAdmin(() => service.listAlerts());
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.id).toBe('rev-2');
    expect(alerts[0]?.type).toBe('ncnp_report_ready_to_publish');
  });
});
