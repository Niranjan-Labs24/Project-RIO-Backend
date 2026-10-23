import { describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { NcnpReportReviewService } from './ncnp-report-review.service';
import { orgContext } from '../../tenancy/org-context';
import { fakeTx } from '../reports/core-needs/__fixtures__/core-needs-db';

// The NCNP Needs Report (Core Needs Report across organisations): areas,
// studies with their reliability, generation, the reader's view and export.

function makeService() {
  const rows: Array<Record<string, unknown>> = [];
  const tx = {
    ...(fakeTx() as unknown as Record<string, unknown>),
    ncnpReportReview: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `row-${rows.length + 1}`,
          status: 'draft',
          generatedAt: new Date('2026-10-23T09:00:00Z'),
          reviewedBy: null,
          reviewedAt: null,
          reviewerNotes: null,
          publishedBy: null,
          publishedAt: null,
          ...data,
        };
        rows.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
    },
    user: { findMany: async () => [{ id: 'admin-1', name: 'System Admin' }] },
  };
  const tenant = {
    runAsSupervisor: async (fn: (t: unknown) => unknown) => fn(tx),
    runAsSupervisorWrite: async (fn: (t: unknown) => unknown) => fn(tx),
  };
  const audited: string[] = [];
  const audit = { record: async (e: { entityLabel: string }) => void audited.push(e.entityLabel) };
  const translation = { translateMany: async (t: readonly string[]) => t.map((x) => ({ translatedText: x, unchanged: true })) };
  const service = new NcnpReportReviewService(tenant as never, audit as never, {} as never, translation as never);
  return { service, rows, audited };
}

const asAdmin = <T>(fn: () => Promise<T>) => orgContext.run({ requestId: 'r', actorId: 'admin-1', role: 'system_admin' }, fn);
const asNgo = <T>(fn: () => Promise<T>) => orgContext.run({ requestId: 'r', actorId: 'ngo-1', role: 'ngo_admin' }, fn);

describe('NCNP Needs Report', () => {
  it('lists the areas and the studies with scored data, each with its reliability', async () => {
    const { service } = makeService();
    const options = await asAdmin(() => service.needsScopeOptions());
    expect(options.governorates.map((g) => g.name)).toEqual(['Al-Ahsa', 'Qatif']);
    const studies = await asAdmin(() => service.needsStudies('KINGDOM', null));
    expect(studies).toHaveLength(1);
    expect(studies[0]).toMatchObject({ studyId: 's1', organization: 'Sample Charity', methodologyVersion: 'v5.0' });
  });

  it('is for NCNP users only', async () => {
    const { service } = makeService();
    await expect(asNgo(() => service.needsStudies('KINGDOM', null))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('generates a draft from the chosen studies, each with its share of the pooled responses', async () => {
    const { service, rows, audited } = makeService();
    // A study listed twice, and one that is no longer active, count once / not at all.
    const summary = await asAdmin(() => service.generateNeeds({ scopeLevel: 'KINGDOM', studyIds: ['s1', 's1', 'archived'] } as never));
    expect(summary).toMatchObject({ status: 'draft', generatedByName: 'System Admin' });
    const content = rows[0]!.content as { header: { isNcnp: boolean }; studies: Array<{ studyId: string; sharePct: number }> };
    expect(content.header.isNcnp).toBe(true);
    expect(content.studies).toEqual([expect.objectContaining({ studyId: 's1', sharePct: 100 })]);
    expect(audited).toContain('NCNP needs report generated for review');
  });

  it('asks for an area below the Kingdom, and for at least one scored study', async () => {
    const { service } = makeService();
    await expect(asAdmin(() => service.generateNeeds({ scopeLevel: 'REGION', unitId: ' ', studyIds: ['s1'] } as never))).rejects.toBeInstanceOf(BadRequestException);
    await expect(asAdmin(() => service.generateNeeds({ scopeLevel: 'KINGDOM', studyIds: ['archived'] } as never))).rejects.toBeInstanceOf(ConflictException);
  });

  it('opens the report as a view, and exports it only once released', async () => {
    const { service, rows } = makeService();
    const { id } = await asAdmin(() => service.generateNeeds({ scopeLevel: 'GOVERNORATE', unitId: 'g1', studyIds: ['s1'], output: 'SUMMARY' } as never));
    const detail = await asAdmin(() => service.getById(id));
    expect((detail.content as { coreView: { output: string } }).coreView.output).toBe('SUMMARY');

    await expect(asAdmin(() => service.exportReport(id, 'pdf'))).rejects.toBeInstanceOf(BadRequestException);
    Object.assign(rows[0]!, { status: 'released', reviewedBy: 'admin-1', reviewedAt: new Date('2026-10-23T10:00:00Z'), reviewerNotes: 'Reviewed.' });
    const pdf = await asAdmin(() => service.exportReport(id, 'pdf', 'ar'));
    expect(pdf.filename).toBe('ncnp-needs-report-2026-10-23.pdf');
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    const xlsx = await asAdmin(() => service.exportReport(id, 'excel', 'en'));
    expect(xlsx.filename.endsWith('.xlsx')).toBe(true);
  });
});
