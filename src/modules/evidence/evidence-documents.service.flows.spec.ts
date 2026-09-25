import ExcelJS from 'exceljs';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orgContext } from '../../tenancy/org-context';
import { EvidenceDocumentsService } from './evidence-documents.service';

const pdf = vi.hoisted(() => ({ text: 'Some PDF text' as string | string[], fail: false }));
vi.mock('unpdf', () => ({
  getDocumentProxy: vi.fn(async () => {
    if (pdf.fail) throw new Error('damaged');
    return {};
  }),
  extractText: vi.fn(async () => ({ text: pdf.text })),
}));
const docx = vi.hoisted(() => ({ value: 'Word text', fail: false }));
vi.mock('mammoth', () => ({
  extractRawText: vi.fn(async () => {
    if (docx.fail) throw new Error('bad docx');
    return { value: docx.value };
  }),
}));
const localize = vi.hoisted(() => ({
  result: {
    locale: 'en',
    status: 'ready',
    output: { a: 1 } as Record<string, unknown>,
    toPersist: null as unknown,
  },
}));
vi.mock('../translation/summary-localization', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  localizeSummaryOutput: vi.fn(async () => localize.result),
  cachedSummaryOutput: vi.fn(() => ({ locale: 'en', status: 'cached', output: {} })),
}));

const asActor = <T>(fn: () => Promise<T>) =>
  orgContext.run({ requestId: 'r', orgId: 'org-1', actorId: 'u1' }, fn);

function setup() {
  const tx = {
    evidenceDocument: {
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    evidenceDocumentChunk: { createMany: vi.fn() },
    evidenceDocumentSummary: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    combinedReportSummary: { updateMany: vi.fn() },
  };
  const tenant = {
    runInOrgContext: async (fn: (t: unknown) => unknown) => fn(tx),
    runRead: async (fn: (t: unknown) => unknown) => fn(tx),
  };
  const storage = {
    save: vi.fn().mockResolvedValue('key.pdf'),
    read: vi.fn().mockResolvedValue(Buffer.from('file')),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  return {
    tx,
    storage,
    audit,
    svc: new EvidenceDocumentsService(
      tenant as never,
      storage as never,
      audit as never,
      {} as never,
    ),
  };
}

const summary = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  aiOutputJson: { s: 1 },
  officerEditedOutputJson: null,
  outputLocale: 'en',
  localizedOutputs: null,
  createdAt: new Date(),
  ...over,
});

describe('EvidenceDocumentsService parsing', () => {
  beforeEach(() => {
    pdf.text = 'Some PDF text';
    pdf.fail = false;
    docx.value = 'Word text';
    docx.fail = false;
  });

  it('reads spreadsheets sheet by sheet', async () => {
    const { svc } = setup();
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Data').addRows([
      ['A', 1],
      ['', null],
      ['B', 2],
    ]);
    const result = await svc.parseDocumentText('t.xlsx', Buffer.from(await wb.xlsx.writeBuffer()));
    expect(result.text).toContain('Sheet: Data');
    expect(result.text).toContain('B | 2');
  });

  it('reads Word and PDF documents, joining PDF pages and tidying whitespace', async () => {
    const { svc } = setup();
    docx.value = 'Line  one\r\n\r\n\r\n\r\nLine\ttwo';
    expect((await svc.parseDocumentText('a.docx', Buffer.from('x'))).text).toBe(
      'Line one\n\nLine two',
    );
    pdf.text = ['Page one', 'Page two'];
    expect((await svc.parseDocumentText('a.pdf', Buffer.from('x'))).text).toBe(
      'Page one\nPage two',
    );
  });

  it('explains files it cannot read, by kind', async () => {
    const { svc } = setup();
    const msg = async (name: string) =>
      (await svc.parseDocumentText(name, Buffer.from('x')).catch((e) => e)).getResponse().error;
    expect((await msg('a.png')).message).toContain('optical character recognition');
    expect((await msg('a.doc')).message).toContain('.docx');
    expect((await msg('a.xls')).message).toContain('.xlsx');
    expect((await msg('a.zip')).message).toContain('Supported extensions');
  });

  it('reports damaged PDFs and Word files, scanned PDFs and empty documents', async () => {
    const { svc } = setup();
    pdf.fail = true;
    await expect(svc.parseDocumentText('a.pdf', Buffer.from('x'))).rejects.toMatchObject({
      response: { error: { code: 'PARSING_FAILED' } },
    });
    pdf.fail = false;
    pdf.text = '   ';
    await expect(svc.parseDocumentText('a.pdf', Buffer.from('x'))).rejects.toMatchObject({
      response: { error: { code: 'PDF_NO_TEXT_LAYER' } },
    });
    docx.fail = true;
    await expect(svc.parseDocumentText('a.docx', Buffer.from('x'))).rejects.toMatchObject({
      response: { error: { code: 'PARSING_FAILED' } },
    });
    await expect(svc.parseDocumentText('a.txt', Buffer.from('  \n'))).rejects.toMatchObject({
      response: { error: { code: 'NO_TEXT_CONTENT' } },
    });
  });

  it('splits long text into 4000-character chunks with section references', () => {
    const { svc } = setup();
    const chunks = svc.splitChunks('x'.repeat(8500));
    expect(chunks).toHaveLength(3);
    expect(chunks[2]!.sectionReference).toBe('Section 3 (Chars 8001-8500)');
  });
});

describe('EvidenceDocumentsService upload and reads', () => {
  const payload = {
    studyId: 's1',
    title: 'Report',
    fileName: 'r.txt',
    fileBuffer: Buffer.from('Hello world'),
    documentType: 'FIELD_REPORT',
    sourceReferenceId: 'REF',
    collectedDate: '2026-01-01',
  } as never;

  it('stores the file, extracts text and chunks, and audits the upload', async () => {
    const { svc, tx, audit } = setup();
    tx.evidenceDocument.create.mockResolvedValue({ id: 'd1', title: 'Report' });
    await asActor(() => svc.uploadDocument(payload));
    expect(tx.evidenceDocument.create.mock.calls[0]![0].data).toMatchObject({
      parsingStatus: 'PARSED',
      fileType: '.txt',
      isIncludedInCombinedReport: true,
    });
    expect(tx.evidenceDocumentChunk.createMany).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'upload_evidence_document' }),
    );
  });

  it('keeps an unreadable file with a failed status and the reason', async () => {
    const { svc, tx } = setup();
    tx.evidenceDocument.create.mockResolvedValue({ id: 'd1', title: 'Report' });
    await asActor(() =>
      svc.uploadDocument({ ...(payload as object), fileBuffer: Buffer.from('  ') } as never),
    );
    expect(tx.evidenceDocument.create.mock.calls[0]![0].data).toMatchObject({
      parsingStatus: 'FAILED',
      parsedAt: null,
    });
    expect(tx.evidenceDocument.create.mock.calls[0]![0].data.parseError).toContain(
      'contains no text',
    );
    expect(tx.evidenceDocumentChunk.createMany).not.toHaveBeenCalled();
  });

  it('refuses an unsupported extension before saving anything', async () => {
    const { svc, storage } = setup();
    await expect(
      asActor(() => svc.uploadDocument({ ...(payload as object), fileName: 'r.exe' } as never)),
    ).rejects.toMatchObject({
      response: { error: { code: 'UNSUPPORTED_FILE_TYPE' } },
    });
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('lists documents with the search and filters applied, with localized summaries', async () => {
    const { svc, tx } = setup();
    tx.evidenceDocument.findMany.mockResolvedValue([
      { id: 'd1', summaries: [summary('s1', { outputLocale: 'ar' })] },
    ]);
    const docs = await asActor(() =>
      svc.listDocuments({
        studyId: 's1',
        documentType: 'FIELD_REPORT',
        linkedDomainId: 'dm',
        search: 'x',
      } as never),
    );
    expect(docs[0]!.summaries[0]!.localized).toMatchObject({ status: 'cached' });
    const where = tx.evidenceDocument.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({
      orgId: 'org-1',
      studyId: 's1',
      documentType: 'FIELD_REPORT',
      linkedDomainId: 'dm',
    });
    expect(where.OR).toHaveLength(3);
    await asActor(() => svc.listDocuments({ studyId: 's1' } as never));
  });

  it('returns one document, localizing the latest summary and caching the translation when there is one', async () => {
    const { svc, tx } = setup();
    tx.evidenceDocument.findFirst.mockResolvedValue({
      id: 'd1',
      summaries: [summary('s1'), summary('s2')],
    });
    localize.result = {
      locale: 'ar',
      status: 'ready',
      output: { a: 1 },
      toPersist: { ar: { a: 1 } },
    };
    const doc = await asActor(() => svc.getDocumentDetails('d1'));
    expect(doc.summaries[0]!.localized).toMatchObject({ locale: 'ar', status: 'ready' });
    expect(doc.summaries[1]!.localized).toMatchObject({ status: 'cached' });
    expect(tx.evidenceDocumentSummary.updateMany).toHaveBeenCalled();
  });

  it('does not fail the read when caching the translation fails', async () => {
    const { svc, tx } = setup();
    tx.evidenceDocument.findFirst.mockResolvedValue({ id: 'd1', summaries: [summary('s1')] });
    localize.result = { locale: 'ar', status: 'ready', output: {}, toPersist: { ar: {} } };
    tx.evidenceDocumentSummary.updateMany.mockRejectedValue(new Error('db'));
    await expect(asActor(() => svc.getDocumentDetails('d1'))).resolves.toBeTruthy();
    localize.result = { locale: 'en', status: 'ready', output: {}, toPersist: null };
  });

  it('404s a missing document in every read and write path', async () => {
    const { svc, tx } = setup();
    tx.evidenceDocument.findFirst.mockResolvedValue(null);
    const calls: Array<() => Promise<unknown>> = [
      () => svc.getDocumentDetails('x'),
      () => svc.getDocumentFile('x'),
      () => svc.toggleInclusion('x', true),
      () => svc.deleteDocument('x'),
    ];
    for (const call of calls) {
      await expect(asActor(call)).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('serves the stored file and audits the download', async () => {
    const { svc, tx, audit } = setup();
    tx.evidenceDocument.findFirst.mockResolvedValue({
      storageKey: 'k',
      fileName: 'f.pdf',
      fileType: '.pdf',
      title: 'T',
    });
    expect(await asActor(() => svc.getDocumentFile('d1'))).toMatchObject({
      fileName: 'f.pdf',
      fileType: '.pdf',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'download_evidence_document' }),
    );
  });

  it('toggles inclusion and marks confirmed combined summaries stale', async () => {
    const { svc, tx } = setup();
    tx.evidenceDocument.findFirst.mockResolvedValue({ id: 'd1', studyId: 's1' });
    tx.evidenceDocument.update.mockResolvedValue({ id: 'd1', isIncludedInCombinedReport: false });
    await asActor(() => svc.toggleInclusion('d1', false));
    expect(tx.combinedReportSummary.updateMany).toHaveBeenCalledWith({
      where: { studyId: 's1', status: 'OFFICER_CONFIRMED' },
      data: { status: 'STALE' },
    });
  });

  it('deletes an unused document but refuses one in a confirmed combined report', async () => {
    const { svc, tx, audit } = setup();
    tx.evidenceDocument.findFirst.mockResolvedValueOnce({
      id: 'd1',
      title: 'T',
      combinedSources: [{ combinedSummary: { status: 'DRAFT' } }],
    });
    expect(await asActor(() => svc.deleteDocument('d1'))).toEqual({ success: true });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'delete_evidence_document' }),
    );
    tx.evidenceDocument.findFirst.mockResolvedValueOnce({
      id: 'd1',
      title: 'T',
      combinedSources: [{ combinedSummary: { status: 'OFFICER_CONFIRMED' } }],
    });
    await expect(asActor(() => svc.deleteDocument('d1'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
