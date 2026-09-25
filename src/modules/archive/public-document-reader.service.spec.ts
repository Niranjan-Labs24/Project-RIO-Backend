import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pdf = vi.hoisted(() => ({ text: [] as string[] | string, total: 1 }));
vi.mock('unpdf', () => ({
  getDocumentProxy: vi.fn(async () => ({})),
  extractText: vi.fn(async () => ({ totalPages: pdf.total, text: pdf.text })),
}));

import { PublicDocumentReaderService } from './public-document-reader.service';

function service(files: Record<string, Buffer | Error>) {
  const read = vi.fn(async (key: string) => {
    const f = files[key];
    if (f instanceof Error) throw f;
    return f ?? Buffer.from('');
  });
  return { svc: new PublicDocumentReaderService({ read } as never), read };
}

describe('PublicDocumentReaderService', () => {
  beforeEach(() => {
    pdf.text = ['Page one text', 'Page two text'];
    pdf.total = 2;
  });

  it('reads a spreadsheet into sheets, rendering dates, rich text, formulas and links as text', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Data');
    ws.addRow(['Name', 'When', 'Note']);
    ws.addRow([
      'A',
      new Date('2026-03-04T00:00:00Z'),
      { richText: [{ text: 'Rich ' }, { text: 'text' }] },
    ]);
    ws.addRow(['B', { formula: '1+1', result: 2 }, { text: 'Link', hyperlink: 'https://x' }]);
    ws.addRow([null, null, null]);
    wb.addWorksheet('Empty');
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const { svc } = service({ 'k.xlsx': buffer });
    const view = await svc.read('k.xlsx', 'k.xlsx');
    expect(view.type).toBe('sheets');
    if (view.type !== 'sheets') return;
    expect(view.sheets[0]!.rows[1]).toEqual(['A', '2026-03-04', 'Rich text']);
    expect(view.sheets[0]!.rows[2]).toEqual(['B', '2', 'Link']);
    expect(view.sheets[0]!.truncated).toBe(false);
  });

  it('truncates a very long sheet', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Big');
    for (let i = 1; i <= 505; i++) ws.addRow([`r${i}`]);
    const { svc } = service({ 'big.xlsx': Buffer.from(await wb.xlsx.writeBuffer()) });
    const view = await svc.read('big.xlsx', null);
    if (view.type !== 'sheets') throw new Error('expected sheets');
    expect(view.sheets[0]!.truncated).toBe(true);
    expect(view.sheets[0]!.rows).toHaveLength(500);
  });

  it('reads CSV with quotes, escaped quotes, CRLF and a BOM, and reports an empty file', async () => {
    const { svc } = service({
      'a.csv': Buffer.from('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\nlast,row'),
      'e.csv': Buffer.from('\n\n'),
    });
    const view = await svc.read('a.csv', 'a.csv');
    if (view.type !== 'sheets') throw new Error('expected sheets');
    expect(view.sheets[0]!.rows).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['last', 'row'],
    ]);
    expect(await svc.read('e.csv', 'e.csv')).toMatchObject({
      type: 'unavailable',
      reason: 'empty',
    });
  });

  it('truncates a very long CSV', async () => {
    const text = Array.from({ length: 510 }, (_, i) => `r${i}`).join('\n');
    const { svc } = service({ 'big.csv': Buffer.from(text) });
    const view = await svc.read('big.csv', null);
    if (view.type !== 'sheets') throw new Error('expected sheets');
    expect(view.sheets[0]!.truncated).toBe(true);
    expect(view.sheets[0]!.totalRows).toBe(510);
  });

  it('reads PDF pages, and reports a PDF with no text layer', async () => {
    const { svc } = service({ 'a.pdf': Buffer.from('x'), 'b.pdf': Buffer.from('x') });
    expect(await svc.read('a.pdf', 'a.pdf')).toMatchObject({ type: 'pages', totalPages: 2 });
    pdf.text = ['  ', ''];
    expect(await svc.read('b.pdf', 'b.pdf')).toMatchObject({
      type: 'unavailable',
      reason: 'noTextLayer',
      detail: '2',
    });
    pdf.text = 'single page as a string';
    const { svc: other } = service({ 'c.pdf': Buffer.from('x') });
    expect(await other.read('c.pdf', null)).toMatchObject({ type: 'pages' });
  });

  it('reports an unsupported type, with the extension when a file name is known', async () => {
    const { svc } = service({ 'a.docx': Buffer.from('x'), 'b.bin': Buffer.from('x') });
    expect(await svc.read('a.docx', 'a.docx')).toEqual({
      type: 'unavailable',
      reason: 'unsupported',
      detail: 'DOCX',
    });
    expect(await svc.read('b.bin', null)).toEqual({
      type: 'unavailable',
      reason: 'unsupported',
      detail: undefined,
    });
  });

  it('reports unreadable files instead of throwing', async () => {
    const { svc } = service({
      'gone.pdf': new Error('missing'),
      'bad.xlsx': Buffer.from('not a workbook'),
    });
    expect(await svc.read('gone.pdf', null)).toEqual({ type: 'unavailable', reason: 'unreadable' });
    expect(await svc.read('bad.xlsx', null)).toEqual({ type: 'unavailable', reason: 'unreadable' });
  });

  it('caches results and evicts the oldest entry past the limit', async () => {
    const files: Record<string, Buffer> = {};
    for (let i = 0; i < 42; i++) files[`f${i}.csv`] = Buffer.from(`a${i},b`);
    const { svc, read } = service(files);
    await svc.read('f0.csv', null);
    await svc.read('f0.csv', null);
    expect(read).toHaveBeenCalledTimes(1);
    for (let i = 1; i < 42; i++) await svc.read(`f${i}.csv`, null);
    await svc.read('f0.csv', null); // evicted, so read again
    expect(read).toHaveBeenCalledTimes(43);
  });
});
