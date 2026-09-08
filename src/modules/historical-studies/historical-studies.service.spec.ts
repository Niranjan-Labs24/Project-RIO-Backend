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

function fakeTenant(seed: { rows?: FakeRow[]; studies?: Array<Record<string, unknown>> } = {}) {
  const rows = [...(seed.rows ?? [])];
  const studies: Array<Record<string, unknown>> = [...(seed.studies ?? [])];
  const studyGovernorates: unknown[] = [];
  const studyCenters: unknown[] = [];
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
      // RIO-DATA-002 — importToDashboard creates a real Study (plus its
      // geography joins) and checks for an earlier import of the same
      // archive entry.
      study: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const study = { id: `study-${++seq}`, ...data };
          studies.push(study);
          return study;
        },
        findFirst: async ({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: { cycleNumber?: string } }) => {
          let found = studies;
          if (where?.historicalStudyId !== undefined) {
            found = found.filter((st) => st.historicalStudyId === where.historicalStudyId);
          }
          if (where?.orgId !== undefined) found = found.filter((st) => st.orgId === where.orgId);
          if (orderBy?.cycleNumber === 'asc') {
            found = [...found].sort((a, b) => Number(a.cycleNumber) - Number(b.cycleNumber));
          }
          return found[0] ?? null;
        },
        delete: async ({ where }: { where: { id: string } }) => {
          const idx = studies.findIndex((st) => st.id === where.id);
          if (idx >= 0) studies.splice(idx, 1);
          return { id: where.id };
        },
      },
      studyGovernorate: {
        createMany: async ({ data }: { data: unknown[] }) => {
          studyGovernorates.push(...data);
          return { count: data.length };
        },
      },
      studyCenter: {
        createMany: async ({ data }: { data: unknown[] }) => {
          studyCenters.push(...data);
          return { count: data.length };
        },
      },
    };
  }

  return {
    rows,
    studies,
    studyGovernorates,
    studyCenters,
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

// RIO-DATA-002 — stands in for NeedsImportService. `importFromFile` is the
// only member importToDashboard touches; the default result is a clean
// 3-of-3 import so tests override just the shape they care about.
function fakeNeedsImport(
  result: Partial<{ totalRows: number; imported: number; failed: number; errors: unknown[] }> = {},
) {
  const calls: Array<{ studyId: string; originalname: string }> = [];
  return {
    calls,
    importFromFile: async (studyId: string, file: { originalname: string }) => {
      calls.push({ studyId, originalname: file.originalname });
      return { totalRows: 3, imported: 3, failed: 0, errors: [], ...result };
    },
  };
}

// RIO-DATA-002 — a crossEntity role reads every org's archive entries,
// which is what makes the import's own-org guard load-bearing rather than
// unreachable code.
function runAsCrossEntityOrg<T>(orgId: string, actorId: string, fn: () => Promise<T>): Promise<T> {
  return orgContext.run({ requestId: 'r', orgId, actorId, role: 'system_admin' }, fn);
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
    const svc = new HistoricalStudiesService(
      tenant as never,
      fakeStorage() as never,
      fakeStudyConfig() as never,
      fakeNeedsImport() as never,
    );

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
    const svc = new HistoricalStudiesService(
      tenant as never,
      fakeStorage() as never,
      fakeStudyConfig() as never,
      fakeNeedsImport() as never,
    );
    await expect(
      runAsOrg('org-a', 'user-1', () => svc.create({ ...VALID_PAYLOAD, title: '   ' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an invalid study date', async () => {
    const tenant = fakeTenant();
    const svc = new HistoricalStudiesService(
      tenant as never,
      fakeStorage() as never,
      fakeStudyConfig() as never,
      fakeNeedsImport() as never,
    );
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
      fakeNeedsImport() as never,
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
      fakeNeedsImport() as never,
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
    const svc = new HistoricalStudiesService(
      brokenTenant as never,
      storage as never,
      fakeStudyConfig() as never,
      fakeNeedsImport() as never,
    );

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
    const svc = new HistoricalStudiesService(
      tenant as never,
      fakeStorage() as never,
      fakeStudyConfig() as never,
      fakeNeedsImport() as never,
    );

    const result = await runAsOrg('org-a', 'user-1', () => svc.list());

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('hist-1');
  });
});

describe('HistoricalStudiesService.getFile', () => {
  it('throws when the record does not exist or is not visible to the caller', async () => {
    const tenant = fakeTenant({ rows: [] });
    const svc = new HistoricalStudiesService(
      tenant as never,
      fakeStorage() as never,
      fakeStudyConfig() as never,
      fakeNeedsImport() as never,
    );

    await expect(
      runAsOrg('org-a', 'user-1', () => svc.getFile('missing-id')),
    ).rejects.toMatchObject({ response: { error: { code: 'HISTORICAL_STUDY_NOT_FOUND' } } });
  });
});

// RIO-DATA-002 / FR-17 — the archived pre-platform file has to reach the
// unified dashboard as real Need rows under a real Study, not stay a
// downloadable attachment.
describe('HistoricalStudiesService.importToDashboard', () => {
  function importableRow(overrides: Partial<FakeRow> = {}): FakeRow {
    return {
      id: 'hist-1',
      orgId: 'org-a',
      title: 'Al Rawdah Baseline (2022)',
      region: ['Ad-Dawadmi'],
      governorateIds: ['gov-1'],
      centerIds: ['center-1'],
      targetSector: 'Health',
      studyDate: new Date('2022-03-15T00:00:00Z'),
      author: 'Dr. Fatima Al-Zahrani',
      methodologyVersionLabel: 'Internal manual scoring, v1',
      fileName: 'legacy-needs.xlsx',
      fileType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileSize: 2048,
      storageKey: 'legacy-needs.xlsx',
      fileHash: 'fake-hash',
      uploadedBy: 'user-1',
      uploadedAt: new Date('2026-09-04T00:00:00Z'),
      ...overrides,
    };
  }

  function build(seed: Parameters<typeof fakeTenant>[0], needsImport = fakeNeedsImport()) {
    const tenant = fakeTenant(seed);
    const svc = new HistoricalStudiesService(
      tenant as never,
      fakeStorage() as never,
      fakeStudyConfig() as never,
      needsImport as never,
    );
    return { tenant, svc, needsImport };
  }

  it('creates a historical Study and imports the file through the shared needs importer', async () => {
    const { tenant, svc, needsImport } = build({ rows: [importableRow()] });

    const result = await runAsOrg('org-a', 'user-1', () => svc.importToDashboard('hist-1'));

    expect(result.imported).toBe(3);
    expect(result.totalRows).toBe(3);
    expect(result.studyTitle).toBe('Al Rawdah Baseline (2022)');
    // The file is parsed by NeedsImportService, not a second copy of the parser.
    expect(needsImport.calls).toEqual([{ studyId: result.studyId, originalname: 'legacy-needs.xlsx' }]);

    const study = tenant.studies[0]!;
    expect(study.isHistorical).toBe(true);
    expect(study.historicalStudyId).toBe('hist-1');
    // The date the study was conducted, not the date it was imported —
    // otherwise a 2022 study cannot be compared against a 2026 one.
    expect(study.historicalStudyDate).toEqual(new Date('2022-03-15T00:00:00Z'));
    expect(study.targetSector).toBe('Health');
  });

  it('numbers the first import as cycle 0 so it sits before cycle 1', async () => {
    const { tenant, svc } = build({ rows: [importableRow()] });

    await runAsOrg('org-a', 'user-1', () => svc.importToDashboard('hist-1'));

    expect(tenant.studies[0]!.cycleNumber).toBe(0);
  });

  it('counts backwards from the lowest existing cycle so the unique constraint holds', async () => {
    const { tenant, svc } = build({
      rows: [importableRow()],
      studies: [{ id: 'study-existing', orgId: 'org-a', cycleNumber: 0, historicalStudyId: 'hist-old' }],
    });

    await runAsOrg('org-a', 'user-1', () => svc.importToDashboard('hist-1'));

    expect(tenant.studies.at(-1)!.cycleNumber).toBe(-1);
  });

  it('copies the archive entry geography onto the Study so dashboard filters see it', async () => {
    const { tenant, svc } = build({ rows: [importableRow()] });

    const result = await runAsOrg('org-a', 'user-1', () => svc.importToDashboard('hist-1'));

    expect(tenant.studyGovernorates).toEqual([
      { studyId: result.studyId, orgId: 'org-a', governorateId: 'gov-1' },
    ]);
    expect(tenant.studyCenters).toEqual([{ studyId: result.studyId, orgId: 'org-a', centerId: 'center-1' }]);
  });

  it('refuses a file type the needs importer cannot parse', async () => {
    const { svc } = build({ rows: [importableRow({ fileName: 'legacy-study.pdf' })] });

    await expect(
      runAsOrg('org-a', 'user-1', () => svc.importToDashboard('hist-1')),
    ).rejects.toMatchObject({ response: { error: { code: 'UNSUPPORTED_FILE_TYPE' } } });
  });

  it('refuses a second import of the same archive entry', async () => {
    const { svc } = build({
      rows: [importableRow()],
      studies: [{ id: 'study-existing', orgId: 'org-a', cycleNumber: 0, historicalStudyId: 'hist-1', title: 'Already There' }],
    });

    await expect(
      runAsOrg('org-a', 'user-1', () => svc.importToDashboard('hist-1')),
    ).rejects.toMatchObject({ response: { error: { code: 'ALREADY_IMPORTED' } } });
  });

  it('hides another entity\'s archive entry from an ordinary role', async () => {
    const { svc } = build({ rows: [importableRow({ orgId: 'org-b' })] });

    // RLS already stops a single-entity role at the read, so the import
    // never reaches the cross-org guard exercised below.
    await expect(
      runAsOrg('org-a', 'user-1', () => svc.importToDashboard('hist-1')),
    ).rejects.toMatchObject({ response: { error: { code: 'HISTORICAL_STUDY_NOT_FOUND' } } });
  });

  it('refuses another entity\'s archive entry even for a cross-entity role', async () => {
    const { tenant, svc } = build({ rows: [importableRow({ orgId: 'org-b' })] });

    // A cross-entity role *can* read org-b's entry — that is the point of
    // the role — but the Study and Needs an import produces are org-scoped,
    // so importing here would file org-b's data under org-a.
    await expect(
      runAsCrossEntityOrg('org-a', 'user-1', () => svc.importToDashboard('hist-1')),
    ).rejects.toMatchObject({ response: { error: { code: 'CROSS_ORG_IMPORT_FORBIDDEN' } } });
    expect(tenant.studies).toHaveLength(0);
  });

  it('rolls the Study back when every row fails validation', async () => {
    const { tenant, svc } = build(
      { rows: [importableRow()] },
      fakeNeedsImport({ totalRows: 2, imported: 0, failed: 2, errors: [{ row: 1, message: 'Title is required', type: 'validation' }] }),
    );

    await expect(
      runAsOrg('org-a', 'user-1', () => svc.importToDashboard('hist-1')),
    ).rejects.toMatchObject({ response: { error: { code: 'NO_ROWS_IMPORTED' } } });

    // No empty shell left behind, and the UNIQUE does not block a retry
    // after the file is fixed.
    expect(tenant.studies).toHaveLength(0);
  });

  it('rolls the Study back when the importer throws', async () => {
    const throwingImport = {
      calls: [],
      importFromFile: async () => {
        throw new BadRequestException({ error: { code: 'IMPORT_TOO_LARGE', message: 'too big' } });
      },
    };
    const { tenant, svc } = build({ rows: [importableRow()] }, throwingImport as never);

    await expect(
      runAsOrg('org-a', 'user-1', () => svc.importToDashboard('hist-1')),
    ).rejects.toMatchObject({ response: { error: { code: 'IMPORT_TOO_LARGE' } } });
    expect(tenant.studies).toHaveLength(0);
  });

  it('reports row-level failures from a partial import', async () => {
    const { svc } = build(
      { rows: [importableRow()] },
      fakeNeedsImport({
        totalRows: 5,
        imported: 3,
        failed: 2,
        errors: [
          { row: 2, message: 'Affected population "~400" is not a number', type: 'validation' },
          { row: 4, message: 'Duplicate of an earlier row', type: 'duplicate' },
        ],
      }),
    );

    const result = await runAsOrg('org-a', 'user-1', () => svc.importToDashboard('hist-1'));

    expect(result).toMatchObject({ totalRows: 5, imported: 3, failed: 2 });
    expect(result.errors).toHaveLength(2);
  });
});
