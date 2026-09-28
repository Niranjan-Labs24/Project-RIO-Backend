import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../../tenancy/org-context';

const parser = vi.hoisted(() => ({
  csv: vi.fn(),
  excel: vi.fn(),
  pdf: vi.fn(),
  survey: vi.fn(),
}));
vi.mock('./needs-import.parser', () => ({
  parseCsvNeeds: parser.csv,
  parseExcelNeeds: parser.excel,
  parsePdfNeeds: parser.pdf,
  parseSurveyDocumentNeeds: parser.survey,
}));

import { NeedsImportService } from './needs-import.service';

const asActor = <T>(fn: () => Promise<T>) => orgContext.run({ requestId: 'r', orgId: 'org-1', actorId: 'u1' }, fn);

const row = (over: Record<string, unknown> = {}) => ({
  row: 2, title: 'Wells', statement: 'No water', village: 'Riyadh', referenceId: '', affectedPopulation: '', ...over,
});

function setup() {
  const tx = {
    study: {
      findUnique: vi.fn().mockResolvedValue({ id: 's1', title: 'Study', studyGovernorates: [{ governorateId: 'g1' }], studyCenters: [{ centerId: 'c1' }] }),
    },
    need: {
      findMany: vi.fn().mockResolvedValue([{ title: 'Existing', village: ['Hail'], referenceId: null }, { title: 'Other', village: [], referenceId: 'REF-1' }]),
      create: vi.fn().mockImplementation(async () => ({ id: `need-${Math.random()}` })),
    },
  };
  const tenant = { runInOrgContext: async (fn: (t: unknown) => unknown) => fn(tx) };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const aiDecisions = { classifyAutomatically: vi.fn().mockResolvedValue(undefined) };
  const needSummaries = { maybeGenerateForNeed: vi.fn().mockResolvedValue(undefined) };
  const dataCleaning = { cleanImportBatch: vi.fn().mockResolvedValue(undefined) };
  const ai = { run: vi.fn() };
  return {
    tx, audit, aiDecisions, needSummaries, dataCleaning,
    svc: new NeedsImportService(tenant as never, audit as never, aiDecisions as never, needSummaries as never, dataCleaning as never, ai as never),
  };
}

describe('NeedsImportService previews', () => {
  it('previews the needs found in a PDF', async () => {
    const { svc } = setup();
    parser.pdf.mockResolvedValue([row(), row({ title: 'Roads' })]);
    const preview = await svc.previewPdfFromFile('s1', { originalname: 'a.PDF', buffer: Buffer.from('x') });
    expect(preview).toMatchObject({ totalExtracted: 2, needs: [{ id: 'extracted-1', title: 'Wells' }, { id: 'extracted-2' }] });
  });

  it('refuses a non-PDF preview and reports an unreadable PDF or survey document', async () => {
    const { svc } = setup();
    await expect(svc.previewPdfFromFile('s1', { originalname: 'a.docx', buffer: Buffer.from('x') })).rejects.toMatchObject({ response: { error: { code: 'UNSUPPORTED_FILE_TYPE' } } });
    parser.pdf.mockRejectedValue(new Error('damaged'));
    await expect(svc.previewPdfFromFile('s1', { originalname: 'a.pdf', buffer: Buffer.from('x') })).rejects.toMatchObject({ response: { error: { code: 'PDF_PARSING_FAILED', message: 'damaged' } } });
    parser.pdf.mockRejectedValue('weird');
    await expect(svc.previewPdfFromFile('s1', { originalname: 'a.pdf', buffer: Buffer.from('x') })).rejects.toMatchObject({ response: { error: { message: 'Failed to parse PDF document.' } } });
    parser.survey.mockRejectedValue(new Error('nope'));
    await expect(svc.previewSurveyResultsFromFile('s1', { originalname: 'a.docx', buffer: Buffer.from('x') })).rejects.toMatchObject({ response: { error: { code: 'SURVEY_PARSING_FAILED' } } });
    parser.survey.mockRejectedValue(42);
    await expect(svc.previewSurveyResultsFromFile('s1', { originalname: 'a.docx', buffer: Buffer.from('x') })).rejects.toMatchObject({ response: { error: { message: 'Failed to parse survey results document.' } } });
  });

  it('previews the needs found in a survey results document', async () => {
    const { svc } = setup();
    parser.survey.mockResolvedValue([row()]);
    expect((await svc.previewSurveyResultsFromFile('s1', { originalname: 'a.docx', buffer: Buffer.from('x') })).needs[0]!.id).toBe('survey-extracted-1');
  });
});

describe('NeedsImportService.importBulk', () => {
  const item = (over: Record<string, unknown> = {}) => ({ title: 'Wells', statement: 'No water', village: 'Riyadh, Diriyah', referenceId: '', affectedPopulation: 100, ...over });

  it('imports valid items, starts classification and summaries, audits and schedules data cleaning', async () => {
    const { svc, tx, audit, aiDecisions, needSummaries, dataCleaning } = setup();
    const result = await asActor(() => svc.importBulk('s1', { needs: [item(), item({ title: 'Roads', referenceId: 'REF-9' })] } as never));
    expect(result).toMatchObject({ totalRows: 2, imported: 2, failed: 0 });
    const data = tx.need.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ village: ['Riyadh', 'Diriyah'], source: 'file_upload', referenceId: null, createdBy: 'u1', status: 'pending_ai_classification' });
    expect(aiDecisions.classifyAutomatically).toHaveBeenCalledTimes(2);
    expect(needSummaries.maybeGenerateForNeed).toHaveBeenCalledWith(expect.any(String), 'pdf_import');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'create', entityType: 'need' }));
    expect(dataCleaning.cleanImportBatch).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-1', studyId: 's1' }));
  });

  it('reports items with no title or statement, and duplicates by reference or by title and place', async () => {
    const { svc, dataCleaning } = setup();
    const result = await asActor(() => svc.importBulk('s1', {
      needs: [
        item({ title: '  ' }), item({ statement: '' }),
        item({ title: 'X', referenceId: 'ref-1' }),
        item({ title: 'existing', village: 'hail', affectedPopulation: null }),
        item({ title: 'Dup', village: 'B, A' }), item({ title: 'dup', village: 'a,b' }),
      ],
    } as never));
    expect(result).toMatchObject({ imported: 1, failed: 5 });
    expect(result.errors.map((e) => [e.type, e.field])).toEqual([
      ['validation', 'title'], ['validation', 'statement'], ['duplicate', 'referenceId'], ['duplicate', 'title'], ['duplicate', 'title'],
    ]);
    expect(dataCleaning.cleanImportBatch.mock.calls[0]![0].rejectedRows).toHaveLength(5);
  });

  it('reports an item that cannot be saved and carries on', async () => {
    const { svc, tx, audit } = setup();
    tx.need.create.mockRejectedValueOnce(new Error('db'));
    const result = await asActor(() => svc.importBulk('s1', { needs: [item(), item({ title: 'B' })] } as never));
    expect(result).toMatchObject({ imported: 1, failed: 1 });
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('does not audit or clean when nothing came in, and survives background failures', async () => {
    const { svc, audit, dataCleaning, aiDecisions, needSummaries } = setup();
    await asActor(() => svc.importBulk('s1', { needs: [item({ title: 'Existing', village: 'Hail' })] } as never));
    expect(audit.record).not.toHaveBeenCalled();
    aiDecisions.classifyAutomatically.mockRejectedValue(new Error('ai'));
    needSummaries.maybeGenerateForNeed.mockRejectedValue(new Error('sum'));
    dataCleaning.cleanImportBatch.mockRejectedValue(new Error('clean'));
    await asActor(() => svc.importBulk('s1', { needs: [item({ title: 'New one' })] } as never));
    await new Promise((r) => setTimeout(r, 0));
  });

  it('rejects an empty or oversized payload and an unknown study', async () => {
    const { svc, tx } = setup();
    await expect(asActor(() => svc.importBulk('s1', { needs: [] } as never))).rejects.toMatchObject({ response: { error: { code: 'EMPTY_PAYLOAD' } } });
    await expect(asActor(() => svc.importBulk('s1', {} as never))).rejects.toMatchObject({ response: { error: { code: 'EMPTY_PAYLOAD' } } });
    await expect(asActor(() => svc.importBulk('s1', { needs: Array.from({ length: 2001 }, () => item()) } as never))).rejects.toMatchObject({ response: { error: { code: 'IMPORT_TOO_LARGE' } } });
    tx.study.findUnique.mockResolvedValueOnce(null);
    await expect(asActor(() => svc.importBulk('x', { needs: [item()] } as never))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('copes with a study that has no geography rows', async () => {
    const { svc, tx } = setup();
    tx.study.findUnique.mockResolvedValue({ id: 's1', title: 'S', studyGovernorates: undefined, studyCenters: undefined });
    await asActor(() => svc.importBulk('s1', { needs: [item()] } as never));
    expect(tx.need.create.mock.calls[0]![0].data.needGovernorates.createMany.data).toEqual([]);
  });
});

describe('NeedsImportService.importFromFile', () => {
  const file = (name: string) => ({ originalname: name, buffer: Buffer.from('x') });

  it('imports a CSV, validating each row and numbering errors by row', async () => {
    const { svc, aiDecisions, needSummaries } = setup();
    parser.csv.mockReturnValue([
      row({ row: 2 }),
      row({ row: 3, title: '' }),
      row({ row: 4, title: 'x'.repeat(301) }),
      row({ row: 5, statement: '' }),
      row({ row: 6, village: ' , ' }),
      row({ row: 7, affectedPopulation: 'many' }),
      row({ row: 8, referenceId: 'REF-1' }),
      row({ row: 9, title: 'Existing', village: 'Hail' }),
      row({ row: 10, title: 'With population', affectedPopulation: '1,500' }),
    ]);
    const result = await asActor(() => svc.importFromFile('s1', file('needs.CSV')));
    expect(result).toMatchObject({ totalRows: 9, imported: 2, failed: 7 });
    expect(result.errors.map((e) => [e.row, e.field])).toEqual([
      [3, 'title'], [4, 'title'], [5, 'statement'], [6, 'village'], [7, 'affectedPopulation'], [8, 'referenceId'], [9, 'title'],
    ]);
    expect(aiDecisions.classifyAutomatically).toHaveBeenCalledTimes(2);
    expect(needSummaries.maybeGenerateForNeed).toHaveBeenCalledWith(expect.any(String), 'bulk_import');
  });

  it('reads spreadsheets, and rejects other types and oversized files', async () => {
    const { svc } = setup();
    parser.excel.mockResolvedValue([row()]);
    expect((await asActor(() => svc.importFromFile('s1', file('a.xlsx')))).imported).toBe(1);
    expect((await asActor(() => svc.importFromFile('s1', file('a.xls')))).imported).toBe(1);
    await expect(asActor(() => svc.importFromFile('s1', file('a.pdf')))).rejects.toBeInstanceOf(BadRequestException);
    parser.csv.mockReturnValue(Array.from({ length: 2001 }, (_, i) => row({ row: i + 2 })));
    await expect(asActor(() => svc.importFromFile('s1', file('a.csv')))).rejects.toMatchObject({ response: { error: { code: 'IMPORT_TOO_LARGE' } } });
  });

  it('reports a row that cannot be saved, and does nothing for an unknown study', async () => {
    const { svc, tx, audit } = setup();
    parser.csv.mockReturnValue([row()]);
    tx.need.create.mockRejectedValueOnce(new Error('db'));
    const result = await asActor(() => svc.importFromFile('s1', file('a.csv')));
    expect(result).toMatchObject({ imported: 0, failed: 1 });
    expect(audit.record).not.toHaveBeenCalled();
    tx.study.findUnique.mockResolvedValueOnce(null);
    await expect(asActor(() => svc.importFromFile('x', file('a.csv')))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('skips cleaning when the file was empty', async () => {
    const { svc, dataCleaning } = setup();
    parser.csv.mockReturnValue([]);
    expect((await asActor(() => svc.importFromFile('s1', file('a.csv')))).totalRows).toBe(0);
    expect(dataCleaning.cleanImportBatch).not.toHaveBeenCalled();
  });

  it('copes with a study that has no geography rows, and background failures', async () => {
    const { svc, tx, aiDecisions, needSummaries, dataCleaning } = setup();
    tx.study.findUnique.mockResolvedValue({ id: 's1', title: 'S', studyGovernorates: undefined, studyCenters: undefined });
    aiDecisions.classifyAutomatically.mockRejectedValue(new Error('ai'));
    needSummaries.maybeGenerateForNeed.mockRejectedValue(new Error('sum'));
    dataCleaning.cleanImportBatch.mockRejectedValue(new Error('clean'));
    parser.csv.mockReturnValue([row()]);
    await asActor(() => svc.importFromFile('s1', file('a.csv')));
    await new Promise((r) => setTimeout(r, 0));
    expect(tx.need.create).toHaveBeenCalled();
  });
});
