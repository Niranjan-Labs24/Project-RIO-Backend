import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { formatRiyadhTime, parseExportFormat, toCsv, toXlsx, UTF8_BOM } from './tabular-export';

// UAT AUD-03 — exported files must open in Excel with Arabic readable and one
// value per column.
describe('tabular export (UAT AUD-03)', () => {
  const table = {
    headers: ['المستخدم', 'الإجراء', 'Note'],
    rows: [
      ['محمد', 'login', 'said "hi", then left'],
      ['Sara', '=HYPERLINK("x")', null],
      ['line\nbreak', 42, -5],
    ],
  };

  it('writes CSV as UTF-8 with a BOM, CRLF rows and quoted cells', () => {
    const csv = toCsv(table);
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    expect(Buffer.from(csv, 'utf8').subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe('"المستخدم","الإجراء","Note"');
    expect(lines[1]).toBe('"محمد","login","said ""hi"", then left"');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('neutralises spreadsheet formulas in text but keeps real numbers', () => {
    const csv = toCsv(table);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"42","-5"');
  });

  it('writes a real .xlsx with the headers, a right-to-left sheet for Arabic', async () => {
    const buffer = await toXlsx(table, { sheetName: 'سجل التدقيق', rightToLeft: true });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = wb.worksheets[0]!;
    expect(sheet.name).toBe('سجل التدقيق');
    expect(sheet.views[0]?.rightToLeft).toBe(true);
    expect(sheet.getRow(1).values).toEqual([undefined, 'المستخدم', 'الإجراء', 'Note']);
    expect(sheet.getRow(2).getCell(1).value).toBe('محمد');
    expect(sheet.getRow(4).getCell(2).value).toBe(42);
  });

  it('accepts excel as an alias of xlsx and defaults to csv', () => {
    expect(parseExportFormat('excel')).toBe('xlsx');
    expect(parseExportFormat('xlsx')).toBe('xlsx');
    expect(parseExportFormat(undefined)).toBe('csv');
    expect(parseExportFormat('pdf')).toBe('csv');
  });

  it('shows times in Riyadh time, readable', () => {
    expect(formatRiyadhTime('2026-11-09T06:23:45.088Z')).toBe('2026-11-09 09:23:45');
  });
});
