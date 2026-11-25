import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { PREVIEW_MAX_ROWS, readSpreadsheetPreview } from './spreadsheet-preview';

describe('readSpreadsheetPreview (UAT 26 Nov — Archive Excel preview)', () => {
  it('returns every sheet of a workbook, capped at the preview row limit', async () => {
    const wb = new ExcelJS.Workbook();
    const a = wb.addWorksheet('Results');
    a.addRow(['Village', 'Severity']);
    a.addRow(['Al Rawdah', 68]);
    const b = wb.addWorksheet('Long');
    for (let i = 0; i < PREVIEW_MAX_ROWS + 5; i++) b.addRow([`row ${i}`]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const preview = await readSpreadsheetPreview('study.xlsx', buffer);
    expect(preview?.sheets.map((s) => s.name)).toEqual(['Results', 'Long']);
    expect(preview?.sheets[0]?.rows).toEqual([['Village', 'Severity'], ['Al Rawdah', '68']]);
    expect(preview?.sheets[1]).toMatchObject({ totalRows: PREVIEW_MAX_ROWS + 5, truncated: true });
    expect(preview?.sheets[1]?.rows).toHaveLength(PREVIEW_MAX_ROWS);
  });

  it('reads a CSV and refuses a file it cannot read', async () => {
    const csv = await readSpreadsheetPreview('a.csv', Buffer.from('name,score\n"Arqah, east",41\n'));
    expect(csv?.sheets[0]?.rows).toEqual([['name', 'score'], ['Arqah, east', '41']]);
    expect(await readSpreadsheetPreview('old.xls', Buffer.from('not a workbook'))).toBeNull();
  });
});
