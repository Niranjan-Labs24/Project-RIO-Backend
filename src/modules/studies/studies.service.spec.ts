import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma';
import { orgContext, type OrgStore } from '../../tenancy/org-context';
import { StudiesService } from './studies.service';

const run = <T>(store: Partial<OrgStore>, fn: () => Promise<T>) =>
  orgContext.run({ requestId: 'r', orgId: 'org-1', actorId: 'u1', ...store } as OrgStore, fn);
const asOrg = <T>(fn: () => Promise<T>) => run({ role: 'ngo_admin' }, fn);

const studyRaw = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  orgId: 'org-1',
  title: 'Study',
  villages: ['A'],
  methodologyVersionId: 'mv1',
  population: 1000,
  marginOfError: 5,
  requiredSampleSize: 278,
  minimumDetectableEffect: 0.1,
  cycleNumber: 1,
  isHistorical: false,
  historicalStudyDate: null,
  historicalStudyId: null,
  createdBy: 'u1',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
  studyType: 'baseline',
  targetSector: 'Health',
  status: 'active',
  studyGovernorates: [{ governorateId: 'g1' }],
  studyCenters: [{ centerId: 'c1' }],
  org: { name: 'Acme' },
  _count: { needs: 2 },
  needs: [],
  reports: [],
  ...over,
});

function setup(names: { types?: string[]; sectors?: string[] } = {}) {
  const tx = {
    study: {
      findMany: vi.fn().mockResolvedValue([studyRaw()]),
      findUnique: vi.fn().mockResolvedValue(studyRaw()),
      findFirst: vi.fn().mockResolvedValue({ cycleNumber: 3 }),
      count: vi.fn().mockResolvedValue(1),
      create: vi.fn().mockResolvedValue(studyRaw({ cycleNumber: 4 })),
      update: vi.fn().mockResolvedValue(studyRaw()),
      delete: vi.fn(),
    },
    organisation: {
      findUnique: vi
        .fn()
        .mockResolvedValue({
          regionId: 'r1',
          orgGovernorates: [{ governorateId: 'g1' }],
          orgCenters: [{ centerId: 'c1' }],
        }),
    },
    methodologyVersion: {
      findUnique: vi.fn().mockResolvedValue({ status: 'PUBLISHED', version: 'v5.0' }),
    },
    evidence: { count: vi.fn().mockResolvedValue(3) },
    need: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    studyGovernorate: { deleteMany: vi.fn(), createMany: vi.fn() },
    studyCenter: { deleteMany: vi.fn(), createMany: vi.fn() },
  };
  const tenant = {
    runInOrgContext: async (fn: (t: unknown) => unknown) => fn(tx),
    runAsSupervisor: async (fn: (t: unknown) => unknown) => fn(tx),
    runAsOrg: async (_o: string, fn: (t: unknown) => unknown) => fn(tx),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const geography = { validateHierarchy: vi.fn().mockResolvedValue(undefined) };
  const studyConfig = {
    listActiveStudyTypeNames: vi.fn().mockResolvedValue(names.types ?? ['baseline']),
    listActiveTargetSectorNames: vi.fn().mockResolvedValue(names.sectors ?? ['Health']),
  };
  return {
    tx,
    audit,
    geography,
    studyConfig,
    svc: new StudiesService(
      tenant as never,
      audit as never,
      geography as never,
      studyConfig as never,
    ),
  };
}

const payload = {
  title: 'New',
  population: 1000,
  governorateIds: ['g1'],
  centerIds: ['c1'],
  methodologyVersionId: 'mv1',
  studyType: 'baseline',
  targetSector: 'Health',
} as never;

describe('StudiesService.create', () => {
  it('creates a study with the next cycle number and a computed sample size, and audits it', async () => {
    const { svc, tx, audit } = setup();
    const study = await asOrg(() => svc.create(payload));
    expect(study.cycleNumber).toBe(4);
    const data = tx.study.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ cycleNumber: 4, orgId: 'org-1', createdBy: 'u1' });
    expect(data.requiredSampleSize).toBeGreaterThan(0);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'create',
        changes: expect.arrayContaining([
          { field: 'Methodology version', before: null, after: 'v5.0' },
        ]),
      }),
    );
  });

  it('starts at cycle 1 and works without a methodology version or optional fields', async () => {
    const { svc, tx } = setup();
    tx.study.findFirst.mockResolvedValue(null);
    await asOrg(() =>
      svc.create({ title: 'N', population: 500, governorateIds: [], centerIds: [] } as never),
    );
    expect(tx.study.create.mock.calls[0]![0].data).toMatchObject({ cycleNumber: 1, villages: [] });
    expect(tx.methodologyVersion.findUnique).not.toHaveBeenCalled();
  });

  it('retries once with a fresh cycle number when another study took it', async () => {
    const { svc, tx } = setup();
    tx.study.create
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
      )
      .mockResolvedValueOnce(studyRaw({ cycleNumber: 5 }));
    expect((await asOrg(() => svc.create(payload))).cycleNumber).toBe(5);
    tx.study.create.mockRejectedValueOnce(new Error('db down'));
    await expect(asOrg(() => svc.create(payload))).rejects.toThrow('db down');
  });

  it('rejects an unconfigured study type or target sector, but accepts anything when none are configured', async () => {
    const { svc } = setup({ types: ['survey'], sectors: ['Water'] });
    await expect(asOrg(() => svc.create(payload))).rejects.toMatchObject({
      response: { error: { code: 'INVALID_STUDY_TYPE' } },
    });
    await expect(
      asOrg(() => svc.create({ ...(payload as object), studyType: 'survey' } as never)),
    ).rejects.toMatchObject({ response: { error: { code: 'INVALID_TARGET_SECTOR' } } });
    const open = setup({ types: [], sectors: [] });
    await expect(asOrg(() => open.svc.create(payload))).resolves.toBeTruthy();
  });

  it("rejects geography outside the organization's own scope", async () => {
    const { svc } = setup();
    await expect(
      asOrg(() => svc.create({ ...(payload as object), governorateIds: ['g9'] } as never)),
    ).rejects.toMatchObject({ response: { error: { code: 'GOVERNORATE_NOT_IN_ORG_SCOPE' } } });
    await expect(
      asOrg(() => svc.create({ ...(payload as object), centerIds: ['c9'] } as never)),
    ).rejects.toMatchObject({ response: { error: { code: 'CENTER_NOT_IN_ORG_SCOPE' } } });
  });

  it('copes with an organization that has no geography recorded', async () => {
    const { svc, tx } = setup();
    tx.organisation.findUnique.mockResolvedValue(null);
    await expect(
      asOrg(() =>
        svc.create({ ...(payload as object), governorateIds: [], centerIds: [] } as never),
      ),
    ).resolves.toBeTruthy();
  });

  it('requires a real, published methodology version', async () => {
    const { svc, tx } = setup();
    tx.methodologyVersion.findUnique.mockResolvedValueOnce(null);
    await expect(asOrg(() => svc.create(payload))).rejects.toBeInstanceOf(NotFoundException);
    tx.methodologyVersion.findUnique.mockResolvedValueOnce({ status: 'DRAFT', version: 'v6' });
    await expect(asOrg(() => svc.create(payload))).rejects.toMatchObject({
      response: { error: { code: 'METHODOLOGY_VERSION_NOT_PUBLISHED' } },
    });
  });
});

describe('StudiesService.list', () => {
  it("lists the organization's own studies with filters and clamped paging", async () => {
    const { svc, tx } = setup();
    const result = await asOrg(() =>
      svc.list({ limit: 9999, offset: -3, organizationId: 'o', village: 'A', search: 'stud' }),
    );
    expect(result).toMatchObject({ total: 1, limit: 200, offset: 0 });
    expect(result.items[0]).toMatchObject({ orgName: 'Acme', surveysCount: 2 });
    expect(tx.study.findMany.mock.calls[0]![0].where).toMatchObject({
      orgId: 'o',
      villages: { has: 'A' },
    });
    await asOrg(() => svc.list());
    expect(tx.study.findMany.mock.calls[1]![0].take).toBe(100);
  });

  it('lets cross-organization roles read every organization, and audits it only for the system admin', async () => {
    const { svc, audit } = setup();
    await run({ role: 'system_admin' }, () => svc.list({ organizationId: 'org-9' }));
    await run({ role: 'system_admin' }, () => svc.list());
    expect(audit.record.mock.calls[0]![0]).toMatchObject({
      action: 'SYSTEM_ADMIN_VIEWED_STUDIES',
      metadata: { scope: 'organization' },
    });
    expect(audit.record.mock.calls[1]![0]).toMatchObject({
      entityLabel: 'All Platform Studies',
      metadata: { scope: 'all' },
    });
    audit.record.mockClear();
    await run({ role: 'center_supervisor' }, () => svc.list());
    await run({ role: 'system_reviewer' }, () => svc.list());
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('returns defaults for a study with no organization or need count', async () => {
    const { svc, tx } = setup();
    tx.study.findMany.mockResolvedValue([
      studyRaw({
        org: null,
        _count: undefined,
        historicalStudyDate: new Date('2020-05-06T00:00:00Z'),
      }),
    ]);
    const [item] = (await asOrg(() => svc.list())).items;
    expect(item).toMatchObject({
      orgName: undefined,
      surveysCount: 0,
      historicalStudyDate: '2020-05-06',
    });
  });
});

describe('StudiesService.getById', () => {
  const need = (over: Record<string, unknown> = {}) => ({
    id: 'n1',
    title: 'Need',
    status: 'draft',
    village: ['A', 'B'],
    domain: null,
    aiSuggestedDomain: 'Water',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    surveys: [{ _count: { surveyQuestions: 5 } }],
    surveyResponses: [{ id: 'r' }],
    _count: { evidence: 2 },
    priorityScores: [{ overallScore: 70 }],
    ...over,
  });

  it('returns the study with its needs summarised', async () => {
    const { svc, tx } = setup();
    tx.need.findMany.mockResolvedValue([
      need(),
      need({
        id: 'n2',
        village: null,
        aiSuggestedDomain: null,
        surveys: [],
        surveyResponses: undefined,
        _count: undefined,
        priorityScores: [],
        createdAt: null,
        village2: 1,
      }),
    ]);
    tx.need.count.mockResolvedValue(2);
    const study = await asOrg(() => svc.getById('s1'));
    expect(study).toMatchObject({ evidenceCount: 3, needCount: 2, orgName: 'Acme' });
    expect(study.needs?.[0]).toMatchObject({
      village: 'A, B',
      domainCategory: 'Water',
      responseCount: 1,
      questionCount: 5,
      score: 70,
      evidenceCount: 2,
    });
    expect(study.needs?.[1]).toMatchObject({
      village: '—',
      domainCategory: '—',
      responseCount: 0,
      questionCount: 0,
      score: null,
      evidenceCount: 0,
    });
  });

  it("404s an unknown study, and audits a system admin's view of one", async () => {
    const { svc, tx, audit } = setup();
    tx.study.findUnique.mockResolvedValueOnce(null);
    await expect(asOrg(() => svc.getById('x'))).rejects.toBeInstanceOf(NotFoundException);
    await run({ role: 'system_admin' }, () => svc.getById('s1'));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ entityId: 's1' }));
    audit.record.mockClear();
    await run({ role: 'center_supervisor' }, () => svc.getById('s1'));
    tx.study.findUnique.mockResolvedValueOnce(null);
    await expect(run({ role: 'center_supervisor' }, () => svc.getById('x'))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('StudiesService.update', () => {
  it('applies changes, replaces geography and audits what changed', async () => {
    const { svc, tx, audit } = setup();
    await asOrg(() =>
      svc.update('s1', {
        title: 'Renamed',
        villages: ['Z'],
        governorateIds: ['g1'],
        centerIds: [],
        studyType: 'baseline',
        targetSector: 'Health',
        methodologyVersionId: 'mv1',
      } as never),
    );
    expect(tx.study.update.mock.calls[0]![0].data).toMatchObject({
      title: 'Renamed',
      villages: ['Z'],
    });
    expect(tx.studyGovernorate.deleteMany).toHaveBeenCalled();
    expect(tx.studyGovernorate.createMany).toHaveBeenCalled();
    expect(tx.studyCenter.deleteMany).toHaveBeenCalled();
    expect(tx.studyCenter.createMany).not.toHaveBeenCalled(); // an empty list only clears
    const fields = audit.record.mock.calls[0]![0].changes.map((c: { field: string }) => c.field);
    expect(fields.length).toBeGreaterThan(1);
  });

  it('replaces centers and skips the audit when nothing changed', async () => {
    const { svc, tx, audit } = setup();
    await asOrg(() => svc.update('s1', { centerIds: ['c1'] } as never));
    expect(tx.studyCenter.createMany).toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    await asOrg(() => svc.update('s1', {} as never));
  });

  it('404s an unknown study and rejects an unpublished methodology or out-of-scope geography', async () => {
    const { svc, tx } = setup();
    tx.study.findUnique.mockResolvedValueOnce(null);
    await expect(asOrg(() => svc.update('x', {} as never))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    tx.methodologyVersion.findUnique.mockResolvedValueOnce({ status: 'RETIRED', version: 'v1' });
    await expect(
      asOrg(() => svc.update('s1', { methodologyVersionId: 'mv9' } as never)),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      asOrg(() => svc.update('s1', { governorateIds: ['nope'] } as never)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('StudiesService.remove', () => {
  it('deletes a study whose needs are all still drafts and audits it', async () => {
    const { svc, tx, audit } = setup();
    await asOrg(() => svc.remove('s1'));
    expect(tx.study.delete).toHaveBeenCalledWith({ where: { id: 's1' } });
    expect(audit.record.mock.calls[0]![0].changes[2]).toMatchObject({ before: 'v5.0' });
  });

  it('handles a study with no methodology version, and refuses missing or advanced ones', async () => {
    const { svc, tx } = setup();
    tx.study.findUnique.mockResolvedValueOnce(studyRaw({ methodologyVersionId: null }));
    await asOrg(() => svc.remove('s1'));
    tx.study.findUnique.mockResolvedValueOnce(studyRaw());
    tx.methodologyVersion.findUnique.mockResolvedValueOnce(null);
    await asOrg(() => svc.remove('s1'));
    tx.study.findUnique.mockResolvedValueOnce(null);
    await expect(asOrg(() => svc.remove('x'))).rejects.toBeInstanceOf(NotFoundException);
    tx.need.count.mockResolvedValueOnce(1);
    await expect(asOrg(() => svc.remove('s1'))).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('StudiesService archive and restore', () => {
  const ready = { needs: [{ status: 'survey_published' }], reports: [{ status: 'released' }] };

  it('archives a completed study with a released report', async () => {
    const { svc, tx, audit } = setup();
    tx.study.findUnique.mockResolvedValue(studyRaw(ready));
    await asOrg(() => svc.archive('s1', 'Done'));
    expect(tx.study.update.mock.calls[0]![0].data).toMatchObject({
      status: 'archived',
      archiveReason: 'Done',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STUDY_ARCHIVED' }),
    );
    await asOrg(() => svc.archive('s1'));
    expect(tx.study.update.mock.calls[1]![0].data.archiveReason).toBeNull();
  });

  it('lets a system admin or a granted supervisor archive across organizations', async () => {
    const { svc, tx } = setup();
    tx.study.findUnique.mockResolvedValue(
      studyRaw({ needs: [{ status: 'survey_published' }], reports: [{ status: 'archived' }] }),
    );
    await run({ role: 'system_admin' }, () => svc.archive('s1'));
    await run({ role: 'center_supervisor', grantCitation: { grantId: 'g' } as never }, () =>
      svc.archive('s1'),
    );
    expect(tx.study.update).toHaveBeenCalledTimes(2);
  });

  it('refuses to archive an unknown, already archived or incomplete study', async () => {
    const { svc, tx } = setup();
    tx.study.findUnique.mockResolvedValueOnce(null);
    await expect(asOrg(() => svc.archive('x'))).rejects.toBeInstanceOf(NotFoundException);
    tx.study.findUnique.mockResolvedValueOnce(studyRaw({ status: 'archived' }));
    await expect(asOrg(() => svc.archive('s1'))).rejects.toMatchObject({
      response: { error: { code: 'STUDY_ALREADY_ARCHIVED' } },
    });
    for (const incomplete of [
      { needs: [], reports: [{ status: 'released' }] },
      { needs: [{ status: 'draft' }], reports: [{ status: 'released' }] },
      { needs: [{ status: 'survey_published' }], reports: [{ status: 'draft' }] },
    ]) {
      tx.study.findUnique.mockResolvedValueOnce(studyRaw(incomplete));
      await expect(asOrg(() => svc.archive('s1'))).rejects.toMatchObject({
        response: { error: { code: 'STUDY_INCOMPLETE_FOR_ARCHIVE' } },
      });
    }
    tx.study.findUnique.mockResolvedValueOnce(studyRaw({ needs: undefined, reports: undefined }));
    await expect(asOrg(() => svc.archive('s1'))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('restores an archived study, in the organization or across organizations', async () => {
    const { svc, tx, audit } = setup();
    tx.study.findUnique.mockResolvedValue(studyRaw({ status: 'archived' }));
    await asOrg(() => svc.restore('s1'));
    await run({ role: 'system_admin' }, () => svc.restore('s1'));
    expect(tx.study.update.mock.calls[0]![0].data).toMatchObject({
      status: 'completed',
      archivedAt: null,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STUDY_RESTORED' }),
    );
  });

  it('refuses to restore an unknown or non-archived study', async () => {
    const { svc, tx } = setup();
    tx.study.findUnique.mockResolvedValueOnce(null);
    await expect(asOrg(() => svc.restore('x'))).rejects.toBeInstanceOf(NotFoundException);
    tx.study.findUnique.mockResolvedValueOnce(studyRaw());
    await expect(asOrg(() => svc.restore('s1'))).rejects.toMatchObject({
      response: { error: { code: 'STUDY_NOT_ARCHIVED' } },
    });
  });
});
