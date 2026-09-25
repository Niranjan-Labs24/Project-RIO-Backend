import { describe, expect, it, vi } from 'vitest';
import { orgContext, type OrgStore } from '../../tenancy/org-context';
import { ArchiveService } from './archive.service';

const run = <T>(store: Partial<OrgStore>, fn: () => Promise<T>) =>
  orgContext.run({ requestId: 'r', orgId: 'org-1', actorId: 'u1', ...store } as OrgStore, fn);
const asOrg = <T>(fn: () => Promise<T>) => run({ role: 'ngo_admin' }, fn);
const asAdmin = <T>(fn: () => Promise<T>) => run({ role: 'system_admin' }, fn);

const d = (s: string) => new Date(s);

function setup() {
  const tx = {
    organisation: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'org-1', name: 'Acme', region: ['North'] },
        { id: 'org-2', name: 'Beta', region: ['South'] },
      ]),
    },
    study: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 's1',
          orgId: 'org-1',
          title: 'Water Access Study',
          status: 'archived',
          updatedAt: d('2026-03-01'),
          targetSector: 'Health',
          historicalStudyId: null,
        },
        {
          id: 's2',
          orgId: 'org-2',
          title: 'Roads',
          status: 'archived',
          updatedAt: d('2026-02-01'),
          targetSector: null,
          historicalStudyId: null,
        },
        {
          id: 's3',
          orgId: 'org-1',
          title: 'Unfinished',
          status: 'archived',
          updatedAt: d('2026-01-01'),
          targetSector: null,
          historicalStudyId: null,
        },
        {
          id: 's4',
          orgId: 'org-1',
          title: 'Active',
          status: 'active',
          updatedAt: d('2026-01-01'),
          targetSector: null,
          historicalStudyId: 'h1',
        },
      ]),
      findUnique: vi.fn(),
    },
    report: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'r1',
          orgId: 'org-1',
          studyId: 's1',
          title: 'Report One',
          status: 'released',
          reviewedAt: d('2026-03-05'),
          generatedAt: d('2026-03-02'),
        },
        {
          id: 'r2',
          orgId: 'org-9',
          studyId: null,
          title: 'Orphan Report',
          status: 'released',
          reviewedAt: null,
          generatedAt: d('2026-02-15'),
        },
      ]),
    },
    need: {
      findMany: vi.fn().mockResolvedValue([
        {
          studyId: 's1',
          status: 'survey_published',
          village: ['Village A', 'Village B'],
          domain: 'Water',
          mergedIntoNeedId: null,
        },
        {
          studyId: 's1',
          status: 'survey_published',
          village: ['Village A'],
          domain: 'Custom',
          mergedIntoNeedId: null,
        },
        {
          studyId: 's1',
          status: 'survey_published',
          village: [],
          domain: 'Merged',
          mergedIntoNeedId: 'x',
        },
        {
          studyId: 's1',
          status: 'survey_published',
          village: [],
          domain: null,
          mergedIntoNeedId: null,
        },
        {
          studyId: 's2',
          status: 'survey_published',
          village: [],
          domain: 'Water',
          mergedIntoNeedId: null,
        },
        { studyId: 's3', status: 'draft', village: [], domain: null, mergedIntoNeedId: null },
      ]),
    },
    studyGovernorate: {
      findMany: vi.fn().mockResolvedValue([
        { studyId: 's1', governorateId: 'g1' },
        { studyId: 's1', governorateId: 'g1' },
        { studyId: 's1', governorateId: 'g2' },
        { studyId: 's1', governorateId: 'gX' },
      ]),
    },
    governorate: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'g1', name: 'Riyadh', region: { name: 'Central' } },
        { id: 'g2', name: 'Hail', region: null },
      ]),
    },
    domain: { findMany: vi.fn().mockResolvedValue([{ name: 'Water', nameAr: 'المياه' }]) },
    auditLog: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          {
            id: 'a1',
            action: 'edit',
            actorUserId: 'u',
            createdAt: d('2026-03-01'),
            metadata: { x: 1 },
          },
        ]),
    },
  };
  const tenant = {
    runInOrgContext: async (fn: (t: unknown) => unknown) => fn(tx),
    runAsSupervisor: async (fn: (t: unknown) => unknown) => fn(tx),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const historical = {
    list: vi.fn().mockResolvedValue([
      {
        id: 'h1',
        orgId: 'org-1',
        orgName: 'Acme',
        title: 'Old Health Study',
        region: ['North'],
        targetSector: 'Health',
        studyDate: '2020-05-01',
        governorateNames: ['Riyadh'],
        centerNames: ['C1'],
        author: 'Ana',
        methodologyVersionLabel: 'v1',
        uploadedByName: 'Bob',
        uploadedAt: '2021-01-01',
        fileName: 'a.pdf',
      },
      {
        id: 'h2',
        orgId: 'org-2',
        orgName: 'Beta',
        title: 'Other',
        region: ['South'],
        targetSector: null,
        studyDate: '2019-01-01',
        governorateNames: [],
        centerNames: [],
        author: 'x',
        methodologyVersionLabel: 'v1',
        uploadedByName: null,
        uploadedAt: '2021-01-01',
        fileName: null,
      },
    ]),
  };
  return {
    tx,
    audit,
    svc: new ArchiveService(tenant as never, audit as never, historical as never),
  };
}

const ids = (entries: Array<{ id: string }>) => entries.map((e) => e.id);

describe('ArchiveService.list', () => {
  it('shows an organization only its own completed studies, reports and uploads, newest first', async () => {
    const { svc } = setup();
    const entries = await asOrg(() => svc.list({}));
    expect(ids(entries)).toEqual(['r1', 's1', 'h1']);
    const study = entries.find((e) => e.id === 's1')!;
    expect(study).toMatchObject({
      kind: 'study',
      status: 'completed',
      organizationName: 'Acme',
      sector: 'Health',
      villages: ['Village A', 'Village B'],
      governorateNames: ['Riyadh', 'Hail'],
      region: ['North', 'Central'],
    });
    expect(study.domains).toEqual([
      { name: 'Custom', nameAr: null },
      { name: 'Water', nameAr: 'المياه' },
    ]);
    expect(entries.find((e) => e.id === 'r1')).toMatchObject({
      kind: 'report',
      date: '2026-03-05T00:00:00.000Z',
      sector: 'Health',
    });
    expect(entries.find((e) => e.id === 'h1')).toMatchObject({
      kind: 'historical',
      status: 'imported',
      studyId: 's4',
      centerNames: ['C1'],
    });
  });

  it('shows every organization to a cross-entity role, including reports with no study or known organization', async () => {
    const { svc } = setup();
    const entries = await asAdmin(() => svc.list({}));
    expect(ids(entries)).toEqual(['r1', 's1', 'r2', 's2', 'h1', 'h2']);
    expect(entries.find((e) => e.id === 'r2')).toMatchObject({
      organizationName: '',
      studyId: null,
      villages: [],
      governorateNames: [],
      sector: null,
      domains: [],
    });
    expect(entries.find((e) => e.id === 'h2')).toMatchObject({
      status: 'completed',
      studyId: null,
    });
  });

  it('limits results by kind', async () => {
    const { svc } = setup();
    expect(ids(await asAdmin(() => svc.list({ kind: 'study' })))).toEqual(['s1', 's2']);
    expect(ids(await asAdmin(() => svc.list({ kind: 'report' })))).toEqual(['r1', 'r2']);
    expect(ids(await asAdmin(() => svc.list({ kind: 'historical' })))).toEqual(['h1', 'h2']);
  });

  it('filters by organization, title search, region, sector, village, governorate and domain', async () => {
    const { svc } = setup();
    const list = (params: Record<string, string>) =>
      asAdmin(() => svc.list(params as never)).then(ids);
    expect(await list({ organizationId: 'org-2' })).toEqual(['s2', 'h2']);
    expect(await list({ search: 'WATER' })).toEqual(['s1']);
    expect(await list({ region: 'Central' })).toEqual(['r1', 's1']);
    expect(await list({ sector: 'Health' })).toEqual(['r1', 's1', 'h1']);
    expect(await list({ village: 'Village B' })).toEqual(['r1', 's1']);
    expect(await list({ governorate: 'Riyadh' })).toEqual(['r1', 's1', 'h1']);
    expect(await list({ domain: 'Water' })).toEqual(['r1', 's1', 's2']);
  });

  it('filters by date range', async () => {
    const { svc } = setup();
    const list = (params: Record<string, string>) =>
      asAdmin(() => svc.list(params as never)).then(ids);
    expect(await list({ dateFrom: '2026-02-10T00:00:00.000Z' })).toEqual(['r1', 's1', 'r2']);
    expect(await list({ dateTo: '2026-02-10T00:00:00.000Z' })).toEqual(['s2', 'h1', 'h2']);
  });
});

describe('ArchiveService.getArchiveDetail', () => {
  const study = (over: Record<string, unknown> = {}) => ({
    id: 's1',
    orgId: 'org-1',
    title: 'Study',
    status: 'archived',
    cycleNumber: 2,
    org: { name: 'Acme', region: ['North'] },
    targetSector: 'Health',
    villages: ['A'],
    createdAt: d('2026-01-01'),
    updatedAt: d('2026-03-01'),
    archivedAt: d('2026-03-02'),
    archivedBy: 'u1',
    archiveReason: 'Done',
    methodologyVersion: { id: 'mv1', version: 'v5', name: 'Baseline' },
    evidence: [{ id: 'e' }],
    needs: [{ id: 'n' }, { id: 'n2' }],
    reports: [
      {
        id: 'r1',
        title: 'R',
        status: 'released',
        reportType: 'RPT01',
        generatedAt: d('2026-03-01'),
      },
    ],
    ...over,
  });

  it('returns the study with counts, reports and audit history', async () => {
    const { svc, tx, audit } = setup();
    tx.study.findUnique.mockResolvedValue(study());
    const detail = await asOrg(() => svc.getArchiveDetail('s1'));
    expect(detail).toMatchObject({
      evidenceCount: 1,
      needsCount: 2,
      archivedAt: '2026-03-02T00:00:00.000Z',
      methodologyVersion: { version: 'v5' },
      organizationName: 'Acme',
    });
    expect(detail.auditHistory).toHaveLength(1);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('audits a cross-entity read, and copes with a study with little recorded', async () => {
    const { svc, tx, audit } = setup();
    tx.study.findUnique.mockResolvedValue(
      study({
        org: null,
        targetSector: null,
        archivedAt: null,
        methodologyVersion: null,
        evidence: undefined,
        needs: undefined,
        reports: undefined,
      }),
    );
    const detail = await asAdmin(() => svc.getArchiveDetail('s1'));
    expect(detail).toMatchObject({
      organizationName: '',
      region: [],
      sector: null,
      archivedAt: null,
      methodologyVersion: null,
      evidenceCount: 0,
      needsCount: 0,
      reports: [],
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SYSTEM_ADMIN_VIEWED_ARCHIVED_REPORT' }),
    );
  });

  it('404s an unknown study', async () => {
    const { svc, tx } = setup();
    tx.study.findUnique.mockResolvedValue(null);
    await expect(asOrg(() => svc.getArchiveDetail('x'))).rejects.toMatchObject({
      response: { error: { code: 'STUDY_NOT_FOUND' } },
    });
  });
});
