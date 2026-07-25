import { describe, expect, it } from 'vitest';
import { ArchiveService } from './archive.service';
import { orgContext } from '../../tenancy/org-context';

function fakeTenant(opts: { studies?: any[]; reports?: any[]; needs?: any[]; orgs?: any[]; auditLogs?: any[] }) {
  const tx = {
    organisation: {
      findMany: async () => opts.orgs ?? [{ id: 'o1', name: 'Org 1', region: ['Region A'], sector: 'Health' }],
    },
    study: {
      findMany: async () => opts.studies ?? [],
      findUnique: async ({ where }: any) => opts.studies?.find((s) => s.id === where.id) ?? null,
    },
    report: {
      findMany: async () => opts.reports ?? [],
    },
    need: {
      findMany: async () => opts.needs ?? [],
    },
    auditLog: {
      findMany: async () => opts.auditLogs ?? [],
    },
  };
  return {
    runInOrgContext: async (fn: (tx: any) => any) => fn(tx),
    runAsSupervisor: async (fn: (tx: any) => any) => fn(tx),
  };
}

const auditStub = { record: async () => {} };

describe('ArchiveService', () => {
  it('list filters completed studies by organization', async () => {
    const studies = [
      { id: 's1', orgId: 'o1', title: 'Study 1', updatedAt: new Date('2026-01-01T00:00:00Z') },
    ];
    const needs = [
      { id: 'n1', studyId: 's1', status: 'survey_published', village: ['Village A'] },
    ];
    const tenant = fakeTenant({ studies, needs });
    const svc = new ArchiveService(tenant as any, auditStub as any);

    const result = await orgContext.run(
      { requestId: 'r1', actorId: 'sys1', role: 'system_admin' },
      () => svc.list({ organizationId: 'o1' }),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe('Study 1');
  });

  it('getArchiveDetail retrieves detailed snapshot with audit history', async () => {
    const study = {
      id: 's1',
      orgId: 'o1',
      title: 'Archived Study Detail',
      status: 'archived',
      cycleNumber: 1,
      villages: ['V1'],
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
      archivedAt: new Date('2026-01-02'),
      archivedBy: 'sys1',
      archiveReason: 'Completed project',
      org: { name: 'Org 1', region: ['Region A'], sector: 'Health' },
      methodologyVersion: { id: 'm1', version: 'v1.0', name: 'Methodology 1' },
      needs: [{ id: 'n1' }],
      reports: [{ id: 'r1', title: 'Report 1', status: 'released', reportType: 'RPT01', generatedAt: new Date('2026-01-02') }],
      evidence: [{ id: 'e1' }],
    };
    const auditLogs = [
      { id: 'a1', action: 'STUDY_ARCHIVED', actorUserId: 'sys1', createdAt: new Date('2026-01-02'), metadata: null },
    ];

    const tenant = fakeTenant({ studies: [study], auditLogs });
    const svc = new ArchiveService(tenant as any, auditStub as any);

    const detail = await orgContext.run(
      { requestId: 'r1', actorId: 'sys1', role: 'system_admin' },
      () => svc.getArchiveDetail('s1'),
    );

    expect(detail).toBeDefined();
    expect(detail.title).toBe('Archived Study Detail');
    expect(detail.evidenceCount).toBe(1);
    expect(detail.needsCount).toBe(1);
    expect(detail.reports).toHaveLength(1);
    expect(detail.auditHistory).toHaveLength(1);
  });
});
