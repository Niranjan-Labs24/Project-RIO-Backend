import { describe, expect, it } from 'vitest';
import { ArchiveService } from './archive.service';
import { orgContext } from '../../tenancy/org-context';

// Minimal local shapes for this file's own mock fixtures — only the fields
// the two tests below actually set/read, not the full Prisma model types.
interface FakeStudy {
  id: string;
  orgId?: string;
  title: string;
  status: string;
  updatedAt?: Date;
  cycleNumber?: number;
  villages?: string[];
  createdAt?: Date;
  archivedAt?: Date;
  archivedBy?: string;
  archiveReason?: string;
  org?: { name: string; region: string[]; sector: string };
  methodologyVersion?: { id: string; version: string; name: string } | null;
  needs?: { id: string }[];
  reports?: { id: string; title: string; status: string; reportType: string; generatedAt: Date }[];
  evidence?: { id: string }[];
}
interface FakeReport { id: string; title: string; status: string; reportType: string; generatedAt: Date }
interface FakeNeed { id: string; studyId: string; status: string; village: string[] }
interface FakeOrg { id: string; name: string; region: string[]; sector: string }
interface FakeAuditLog { id: string; action: string; actorUserId: string; createdAt: Date; metadata: unknown }
interface FakeHistoricalStudy { id: string; orgId: string; title: string; region: string[]; targetSector: string | null; studyDate: Date }
interface FakeTx {
  organisation: { findMany: () => Promise<FakeOrg[]> };
  study: { findMany: () => Promise<FakeStudy[]>; findUnique: (args: { where: { id: string } }) => Promise<FakeStudy | null> };
  report: { findMany: () => Promise<FakeReport[]> };
  need: { findMany: () => Promise<FakeNeed[]> };
  auditLog: { findMany: () => Promise<FakeAuditLog[]> };
  historicalStudy: { findMany: () => Promise<FakeHistoricalStudy[]> };
}

function fakeTenant(opts: { studies?: FakeStudy[]; reports?: FakeReport[]; needs?: FakeNeed[]; orgs?: FakeOrg[]; auditLogs?: FakeAuditLog[]; historicalStudies?: FakeHistoricalStudy[] }) {
  const tx: FakeTx = {
    organisation: {
      findMany: async () => opts.orgs ?? [{ id: 'o1', name: 'Org 1', region: ['Region A'], sector: 'Health' }],
    },
    study: {
      findMany: async () => opts.studies ?? [],
      findUnique: async ({ where }) => opts.studies?.find((s) => s.id === where.id) ?? null,
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
    historicalStudy: {
      findMany: async () => opts.historicalStudies ?? [],
    },
  };
  return {
    runInOrgContext: async (fn: (tx: FakeTx) => unknown) => fn(tx),
    runAsSupervisor: async (fn: (tx: FakeTx) => unknown) => fn(tx),
  };
}

const auditStub = { record: async () => {} };

describe('ArchiveService', () => {
  it('list filters completed studies by organization', async () => {
    const studies = [
      { id: 's1', orgId: 'o1', title: 'Study 1', status: 'archived', updatedAt: new Date('2026-01-01T00:00:00Z') },
    ];
    const needs = [
      { id: 'n1', studyId: 's1', status: 'survey_published', village: ['Village A'] },
    ];
    const tenant = fakeTenant({ studies, needs });
    const svc = new ArchiveService(tenant as never, auditStub as never);

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
    const svc = new ArchiveService(tenant as never, auditStub as never);

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

  // RIO-FR-013 (client Q25) — historical/pre-platform study uploads surface
  // in the same Archive listing as real studies and reports.
  it('includes historical study uploads in the archive listing, with their own recorded region and sector', async () => {
    const historicalStudies = [
      {
        id: 'h1',
        orgId: 'o1',
        title: 'Pre-2024 Water Access Survey',
        region: ['Ad-Dawadmi'],
        targetSector: 'Water & Sanitation',
        studyDate: new Date('2022-06-01'),
      },
    ];
    const tenant = fakeTenant({ historicalStudies });
    const svc = new ArchiveService(tenant as never, auditStub as never);

    const entries = await orgContext.run(
      { requestId: 'r1', actorId: 'u1', orgId: 'o1', role: 'ngo_admin' },
      () => svc.list({}),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'historical',
      title: 'Pre-2024 Water Access Survey',
      region: ['Ad-Dawadmi'],
      sector: 'Water & Sanitation',
      studyId: null,
    });
  });

  it('filters to only historical entries when kind=historical is requested', async () => {
    const study = { id: 's1', orgId: 'o1', title: 'Real Study', status: 'archived', updatedAt: new Date('2026-01-01') };
    const historicalStudies = [
      { id: 'h1', orgId: 'o1', title: 'Old Study', region: [], targetSector: null, studyDate: new Date('2020-01-01') },
    ];
    const tenant = fakeTenant({ studies: [study], historicalStudies });
    const svc = new ArchiveService(tenant as never, auditStub as never);

    const entries = await orgContext.run(
      { requestId: 'r1', actorId: 'u1', orgId: 'o1', role: 'ngo_admin' },
      () => svc.list({ kind: 'historical' }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe('historical');
  });
});
