import { BadRequestException } from '@nestjs/common';
import { orgContext } from '../../tenancy/org-context';
import { HistoricalStudiesService } from './historical-studies.service';

interface FakeRow {
  id: string;
  orgId: string;
  title: string;
  region: string[];
  governorateIds: string[];
  centerIds: string[];
  targetSector: string | null;
  studyDate: Date;
  author: string;
  methodologyVersionLabel: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  storageKey: string;
  fileHash: string | null;
  uploadedBy: string;
  uploadedAt: Date;
}

const ORGS = [
  { id: 'org-a', name: 'Org A' },
  { id: 'org-b', name: 'Org B' },
];
const USERS = [{ id: 'user-1', name: 'Aparna' }];
const GOVERNORATES = [{ id: 'gov-1', name: 'Ad-Dawadmi' }];
const CENTERS = [{ id: 'center-1', name: 'Ad-Dawadmi Center' }];

function fakeTenant(seed: { rows?: FakeRow[] } = {}) {
  const rows = [...(seed.rows ?? [])];
  let seq = 0;

  function makeTx(callerOrgId: string) {
    return {
      historicalStudy: {
        create: async ({ data }: { data: Omit<FakeRow, 'id' | 'uploadedAt'> }) => {
          const row: FakeRow = { id: `hist-${++seq}`, uploadedAt: new Date('2026-09-04T00:00:00Z'), ...data };
          rows.push(row);
          return row;
        },
        findMany: async () =>
          callerOrgId === '__supervisor__' ? rows : rows.filter((r) => r.orgId === callerOrgId),
        findUnique: async ({ where }: { where: { id: string } }) => {
          const row = rows.find((r) => r.id === where.id);
          if (!row) return null;
          return callerOrgId === '__supervisor__' || row.orgId === callerOrgId ? row : null;
        },
      },
      organisation: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          ORGS.filter((o) => where.id.in.includes(o.id)),
      },
      user: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          USERS.filter((u) => where.id.in.includes(u.id)),
      },
      governorate: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          GOVERNORATES.filter((g) => where.id.in.includes(g.id)),
      },
      center: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          CENTERS.filter((c) => where.id.in.includes(c.id)),
      },
    };
  }

  return {
    rows,
    runInOrgContext: async (fn: (tx: unknown) => unknown) => {
      const store = orgContext.getStore();
      return fn(makeTx(store?.orgId ?? ''));
    },
    runAsSupervisor: async (fn: (tx: unknown) => unknown) => fn(makeTx('__supervisor__')),
  };
}

function fakeStorage(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    assertAllowedExtension: () => '.pdf',
    assertAllowedSize: () => undefined,
    assertFileSignature: () => undefined,
    hashBuffer: () => 'fake-hash',
    save: async () => 'fake-storage-key.pdf',
    remove: async () => undefined,
    read: async () => Buffer.from('file content'),
    ...overrides,
  };
}

function fakeStudyConfig(activeNames: string[] = []) {
  return { listActiveTargetSectorNames: async () => activeNames };
}

function runAsOrg<T>(orgId: string, actorId: string, fn: () => Promise<T>): Promise<T> {
  return orgContext.run({ requestId: 'r', orgId, actorId }, fn);
}

function makeFile(overrides: Partial<{ originalName: string; mimeType: string; sizeBytes: number; buffer: Buffer }> = {}) {
  return {
    originalName: 'legacy-study.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    buffer: Buffer.from('%PDF-1.4'),
    ...overrides,
  };
}

const VALID_PAYLOAD = {
  title: 'Al Rawdah Baseline (2022)',
  region: ['Ad-Dawadmi'],
  governorateIds: ['gov-1'],
  centerIds: ['center-1'],
  studyDate: '2022-03-15',
  author: 'Dr. Fatima Al-Zahrani',
  methodologyVersionLabel: 'Internal manual scoring, v1',
  file: makeFile(),
};

describe('HistoricalStudiesService.create', () => {
  it('creates a historical study record and returns it enriched', async () => {
    const tenant = fakeTenant();
    const svc = new HistoricalStudiesService(tenant as never, fakeStorage() as never, fakeStudyConfig() as never);

    const result = await runAsOrg('org-a', 'user-1', () => svc.create(VALID_PAYLOAD));

    expect(result.title).toBe('Al Rawdah Baseline (2022)');
    expect(result.orgId).toBe('org-a');
    expect(result.orgName).toBe('Org A');
    expect(result.uploadedByName).toBe('Aparna');
    expect(result.studyDate).toBe('2022-03-15');
    expect(result.governorateNames).toEqual(['Ad-Dawadmi']);
    expect(result.centerNames).toEqual(['Ad-Dawadmi Center']);
    expect(tenant.rows).toHaveLength(1);
  });

  it('rejects a blank title', async () => {
    const tenant = fakeTenant();
    const svc = new HistoricalStudiesService(tenant as never, fakeStorage() as never, fakeStudyConfig() as never);
    await expect(
      runAsOrg('org-a', 'user-1', () => svc.create({ ...VALID_PAYLOAD, title: '   ' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an invalid study date', async () => {
    const tenant = fakeTenant();
    const svc = new HistoricalStudiesService(tenant as never, fakeStorage() as never, fakeStudyConfig() as never);
    await expect(
      runAsOrg('org-a', 'user-1', () => svc.create({ ...VALID_PAYLOAD, studyDate: 'not-a-date' })),
    ).rejects.toMatchObject({ response: { error: { code: 'INVALID_STUDY_DATE' } } });
  });

  it('rejects a target sector not in the configured list', async () => {
    const tenant = fakeTenant();
    const svc = new HistoricalStudiesService(
      tenant as never,
      fakeStorage() as never,
      fakeStudyConfig(['Health', 'Education']) as never,
    );
    await expect(
      runAsOrg('org-a', 'user-1', () => svc.create({ ...VALID_PAYLOAD, targetSector: 'Not A Real Sector' })),
    ).rejects.toMatchObject({ response: { error: { code: 'INVALID_TARGET_SECTOR' } } });
  });

  it('accepts a target sector that is in the configured list', async () => {
    const tenant = fakeTenant();
    const svc = new HistoricalStudiesService(
      tenant as never,
      fakeStorage() as never,
      fakeStudyConfig(['Health', 'Education']) as never,
    );
    const result = await runAsOrg('org-a', 'user-1', () =>
      svc.create({ ...VALID_PAYLOAD, targetSector: 'Health' }),
    );
    expect(result.targetSector).toBe('Health');
  });

  it('removes the just-saved file if the database insert fails', async () => {
    const tenant = fakeTenant();
    tenant.rows = tenant.rows; // no-op, keep structure
    const removeCalls: string[] = [];
    const storage = fakeStorage({
      save: async () => 'orphan-key.pdf',
      remove: async (key: string) => {
        removeCalls.push(key);
      },
    });
    // Force the create call to fail by making historicalStudy.create throw.
    const brokenTenant = {
      ...tenant,
      runInOrgContext: async (fn: (tx: unknown) => unknown) =>
        fn({
          historicalStudy: {
            create: async () => {
              throw new Error('db exploded');
            },
          },
        }),
    };
    const svc = new HistoricalStudiesService(brokenTenant as never, storage as never, fakeStudyConfig() as never);

    await expect(runAsOrg('org-a', 'user-1', () => svc.create(VALID_PAYLOAD))).rejects.toThrow('db exploded');
    expect(removeCalls).toEqual(['orphan-key.pdf']);
  });
});

describe('HistoricalStudiesService.list', () => {
  function seedRow(overrides: Partial<FakeRow> = {}): FakeRow {
    return {
      id: 'hist-1',
      orgId: 'org-a',
      title: 'Legacy Study',
      region: ['Riyadh'],
      governorateIds: [],
      centerIds: [],
      targetSector: null,
      studyDate: new Date('2021-01-01'),
      author: 'Someone',
      methodologyVersionLabel: 'v1',
      fileName: 'legacy.pdf',
      fileType: 'application/pdf',
      fileSize: 100,
      storageKey: 'key.pdf',
      fileHash: null,
      uploadedBy: 'user-1',
      uploadedAt: new Date('2021-01-02'),
      ...overrides,
    };
  }

  it('scopes results to the caller org for a non-cross-entity role', async () => {
    const tenant = fakeTenant({
      rows: [seedRow({ id: 'hist-1', orgId: 'org-a' }), seedRow({ id: 'hist-2', orgId: 'org-b' })],
    });
    const svc = new HistoricalStudiesService(tenant as never, fakeStorage() as never, fakeStudyConfig() as never);

    const result = await runAsOrg('org-a', 'user-1', () => svc.list());

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('hist-1');
  });
});

describe('HistoricalStudiesService.getFile', () => {
  it('throws when the record does not exist or is not visible to the caller', async () => {
    const tenant = fakeTenant({ rows: [] });
    const svc = new HistoricalStudiesService(tenant as never, fakeStorage() as never, fakeStudyConfig() as never);

    await expect(
      runAsOrg('org-a', 'user-1', () => svc.getFile('missing-id')),
    ).rejects.toMatchObject({ response: { error: { code: 'HISTORICAL_STUDY_NOT_FOUND' } } });
  });
});
