import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { PublicArchiveService } from './public-archive.service';

const ID = '01a0d7dc-0c02-7d28-9309-76e7cb292391';
const at = (s: string) => new Date(s);

const region = { name: 'Central', nameAr: 'الوسطى' };
const govs = [
  { id: 'g1', name: 'Riyadh', nameAr: 'الرياض', region },
  { id: 'g2', name: 'Diriyah', nameAr: null, region },
  { id: 'g3', name: 'Orphan', nameAr: null, region: null },
];

function makeTx(over: Record<string, unknown> = {}) {
  return {
    organisation: {
      findMany: vi.fn().mockResolvedValue([{ id: 'o1', name: 'Acme NGO' }]),
      findUnique: vi.fn().mockResolvedValue({ name: 'Acme NGO' }),
    },
    study: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null) },
    studyGovernorate: { findMany: vi.fn().mockResolvedValue([]) },
    report: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    need: { findMany: vi.fn().mockResolvedValue([]) },
    historicalStudy: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    governorate: { findMany: vi.fn().mockResolvedValue(govs) },
    region: { findMany: vi.fn().mockResolvedValue([region]) },
    targetSectorOption: {
      findMany: vi.fn().mockResolvedValue([{ name: 'Health', nameAr: 'الصحة' }]),
    },
    domain: { findMany: vi.fn().mockResolvedValue([{ name: 'Water', nameAr: 'المياه' }]) },
    ...over,
  };
}

function setup(txOver: Record<string, unknown> = {}) {
  const tx = makeTx(txOver);
  const documents = {
    read: vi.fn().mockResolvedValue({ type: 'pages', pages: [], totalPages: 0 }),
  };
  const tenant = { runAsSupervisor: async (fn: (t: unknown) => unknown) => fn(tx) };
  return { tx, documents, svc: new PublicArchiveService(tenant as never, documents as never) };
}

describe('PublicArchiveService.list', () => {
  it('lists released reports, standalone historical studies and uploaded ones, newest first', async () => {
    const { svc, tx } = setup();
    tx.study.findMany.mockResolvedValue([
      {
        id: 's1',
        title: 'Old study',
        orgId: 'o1',
        createdAt: at('2024-01-01'),
        targetSector: 'Health',
        isHistorical: true,
        historicalStudyDate: at('2023-05-01'),
        historicalStudyId: null,
      },
      {
        id: 's2',
        title: 'Imported',
        orgId: 'o1',
        createdAt: at('2024-02-01'),
        targetSector: null,
        isHistorical: true,
        historicalStudyDate: null,
        historicalStudyId: 'h1',
      },
      {
        id: 's3',
        title: 'Live study',
        orgId: 'o1',
        createdAt: at('2025-01-01'),
        targetSector: null,
        isHistorical: false,
        historicalStudyDate: null,
        historicalStudyId: null,
      },
    ]);
    tx.studyGovernorate.findMany.mockResolvedValue([
      { studyId: 's1', governorateId: 'g1' },
      { studyId: 's1', governorateId: 'g2' },
      { studyId: 's2', governorateId: 'g3' },
      { studyId: 's3', governorateId: 'g1' },
    ]);
    tx.report.findMany.mockResolvedValue([
      { id: 'r1', title: 'Report', orgId: 'o1', studyId: 's3', generatedAt: at('2026-01-01') },
      {
        id: 'r2',
        title: 'Orphan report',
        orgId: 'o-unknown',
        studyId: null,
        generatedAt: at('2025-06-01'),
      },
    ]);
    tx.need.findMany.mockResolvedValue([
      { studyId: 's3', mergedIntoNeedId: null, domain: 'Water' },
      { studyId: 's3', mergedIntoNeedId: null, domain: 'Custom domain' },
      { studyId: 's3', mergedIntoNeedId: 'x', domain: 'Merged away' },
      { studyId: 's3', mergedIntoNeedId: null, domain: null },
    ]);
    tx.historicalStudy.findMany.mockResolvedValue([
      {
        id: 'h1',
        title: 'Uploaded imported',
        orgId: 'o1',
        targetSector: 'Unlisted',
        studyDate: at('2022-03-01'),
        governorateIds: ['g1'],
      },
      {
        id: 'h2',
        title: 'Uploaded plain',
        orgId: 'o1',
        targetSector: null,
        studyDate: null,
        governorateIds: null,
      },
    ]);

    const result = await svc.list();

    const dates = result.entries.map((e) => e.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    const report = result.entries.find((e) => e.id === 'r1')!;
    expect(report).toMatchObject({ kind: 'report', organizationName: 'Acme NGO' });
    expect(report.domains).toEqual([
      { name: 'Custom domain', nameAr: null },
      { name: 'Water', nameAr: 'المياه' },
    ]);
    expect(report.governorates.map((g) => g.name)).toEqual(['Riyadh']);
    expect(report.regions).toEqual([{ name: 'Central', nameAr: 'الوسطى' }]);
    expect(result.entries.find((e) => e.id === 'r2')!.organizationName).toBe('');
    expect(result.entries.find((e) => e.id === 's1')!.sector).toEqual({
      name: 'Health',
      nameAr: 'الصحة',
    });
    expect(result.entries.find((e) => e.id === 's2')).toBeUndefined(); // imported copy shows as its upload
    expect(result.entries.find((e) => e.id === 'h1')).toMatchObject({
      sector: { name: 'Unlisted', nameAr: null },
    });
    expect(result.entries.find((e) => e.id === 'h1')!.governorates.map((g) => g.name)).toEqual([
      'Orphan',
    ]);
    expect(result.summary).toMatchObject({ reports: 2, historical: 3, organisations: 1 });
    expect(result.summary.earliest).toBeTruthy();
    expect(result.available.domains).toEqual([{ name: 'Water', nameAr: 'المياه' }]);
    expect(result.available.years[0]).toBe(String(new Date().getFullYear()));
    expect(result.available.years.at(-1)).toBe('2015');
  });

  it('returns an empty summary when nothing is public', async () => {
    const { svc } = setup();
    const result = await svc.list();
    expect(result.entries).toEqual([]);
    expect(result.summary).toMatchObject({
      reports: 0,
      historical: 0,
      organisations: 0,
      earliest: null,
      latest: null,
    });
  });
});

describe('PublicArchiveService.detail', () => {
  it('rejects a malformed id before touching the database', async () => {
    const { svc, tx } = setup();
    await expect(svc.detail('report', 'not-a-uuid')).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.governorate.findMany).not.toHaveBeenCalled();
  });

  it('returns a released report with its places and content', async () => {
    const { svc, tx } = setup();
    tx.report.findFirst.mockResolvedValue({
      id: ID,
      title: 'R',
      orgId: 'o1',
      studyId: 's1',
      generatedAt: at('2026-01-01'),
      reportType: 'RPT01',
      content: { a: 1 },
    });
    tx.studyGovernorate.findMany.mockResolvedValue([{ governorateId: 'g1' }]);
    const detail = await svc.detail('report', ID);
    expect(detail).toMatchObject({
      kind: 'report',
      organizationName: 'Acme NGO',
      report: { reportType: 'RPT01', content: { a: 1 } },
      historical: null,
    });
    expect(detail.governorates).toHaveLength(1);
  });

  it('returns a report with no study, and 404s a missing or unreleased one', async () => {
    const { svc, tx } = setup();
    tx.report.findFirst.mockResolvedValueOnce({
      id: ID,
      title: 'R',
      orgId: 'o1',
      studyId: null,
      generatedAt: at('2026-01-01'),
      reportType: 'RPT01',
      content: {},
    });
    expect((await svc.detail('report', ID)).governorates).toEqual([]);
    tx.report.findFirst.mockResolvedValueOnce(null);
    await expect(svc.detail('report', ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns a historical study recorded as a study, and hides live or imported ones', async () => {
    const { svc, tx } = setup();
    const study = {
      id: ID,
      title: 'S',
      orgId: 'o1',
      createdAt: at('2024-01-01'),
      targetSector: 'Health',
      isHistorical: true,
      historicalStudyDate: null,
      historicalStudyId: null,
    };
    tx.study.findUnique.mockResolvedValueOnce(study);
    expect(await svc.detail('historical', ID)).toMatchObject({
      kind: 'historical',
      sector: { name: 'Health' },
      historical: { hasDocument: false },
    });
    tx.study.findUnique.mockResolvedValueOnce({ ...study, isHistorical: false });
    await expect(svc.detail('historical', ID)).rejects.toBeInstanceOf(NotFoundException);
    tx.study.findUnique.mockResolvedValueOnce({ ...study, historicalStudyId: 'h1' });
    await expect(svc.detail('historical', ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns an uploaded historical study with its file details, and 404s when unknown', async () => {
    const { svc, tx } = setup();
    tx.historicalStudy.findUnique.mockResolvedValueOnce({
      id: ID,
      title: 'H',
      orgId: 'o1',
      targetSector: null,
      studyDate: at('2022-01-01'),
      governorateIds: ['g1'],
      author: 'Ana',
      methodologyVersionLabel: 'v1',
      fileName: 'a.pdf',
      fileType: 'pdf',
      fileSize: 10,
      storageKey: 'k.pdf',
    });
    expect(await svc.detail('historical', ID)).toMatchObject({
      historical: { author: 'Ana', hasDocument: true },
    });
    tx.historicalStudy.findUnique.mockResolvedValueOnce({
      id: ID,
      title: 'H',
      orgId: 'o1',
      targetSector: null,
      studyDate: null,
      governorateIds: null,
      author: null,
      methodologyVersionLabel: null,
      fileName: null,
      fileType: null,
      fileSize: null,
      storageKey: null,
    });
    expect(await svc.detail('historical', ID)).toMatchObject({
      historical: { hasDocument: false },
    });
    await expect(svc.detail('historical', ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PublicArchiveService.document', () => {
  it('reads the document view for an uploaded study', async () => {
    const { svc, tx, documents } = setup();
    tx.historicalStudy.findUnique.mockResolvedValue({
      storageKey: 'k.pdf',
      fileName: 'a.pdf',
      fileType: 'pdf',
      fileSize: 10,
    });
    const doc = await svc.document(ID);
    expect(doc).toMatchObject({ fileName: 'a.pdf', view: { type: 'pages' } });
    expect(documents.read).toHaveBeenCalledWith('k.pdf', 'a.pdf');
  });

  it('404s a malformed id, an unknown study and one without a stored file', async () => {
    const { svc, tx } = setup();
    await expect(svc.document('bad')).rejects.toBeInstanceOf(NotFoundException);
    tx.historicalStudy.findUnique.mockResolvedValueOnce(null);
    await expect(svc.document(ID)).rejects.toBeInstanceOf(NotFoundException);
    tx.historicalStudy.findUnique.mockResolvedValueOnce({
      storageKey: null,
      fileName: null,
      fileType: null,
      fileSize: null,
    });
    await expect(svc.document(ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});
