import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pdf = vi.hoisted(() => ({ text: '' as string | string[], fail: false }));
vi.mock('unpdf', () => ({
  getDocumentProxy: vi.fn(async () => {
    if (pdf.fail) throw new Error('broken pdf');
    return {};
  }),
  extractText: vi.fn(async () => ({ text: pdf.text })),
}));
const mammothState = vi.hoisted(() => ({ value: '', fail: false }));
vi.mock('mammoth', () => ({
  extractRawText: vi.fn(async () => {
    if (mammothState.fail) throw new Error('bad docx');
    return { value: mammothState.value };
  }),
}));

import {
  parseCsvNeeds,
  parseExcelNeeds,
  parsePdfNeeds,
  parseSurveyDocumentNeeds,
} from './needs-import.parser';

const csv = (text: string) => Buffer.from(text, 'utf-8');

describe('parseCsvNeeds', () => {
  it('reads the columns by their aliases and numbers rows from 2', () => {
    const rows = parseCsvNeeds(
      csv(
        'Need Title,Need Statement,Governorate,Ref ID,People Affected\nWells,No water,Riyadh,R-1,120\n',
      ),
    );
    expect(rows).toEqual([
      {
        row: 2,
        title: 'Wells',
        statement: 'No water',
        village: 'Riyadh',
        referenceId: 'R-1',
        affectedPopulation: '120',
      },
    ]);
  });

  it('detects semicolon and tab delimiters', () => {
    expect(parseCsvNeeds(csv('title;statement\nA;B\n'))[0]).toMatchObject({
      title: 'A',
      statement: 'B',
    });
    expect(parseCsvNeeds(csv('title\tstatement\nA\tB\n'))[0]).toMatchObject({
      title: 'A',
      statement: 'B',
    });
  });

  it('handles quoted cells, escaped quotes, embedded newlines, CRLF and a BOM', () => {
    const text = '﻿title,statement\r\n"Wells, deep","He said ""no""\nagain"\r\nPlain,Row\r\n';
    const rows = parseCsvNeeds(csv(text));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ title: 'Wells, deep', statement: 'He said "no"\nagain' });
    expect(rows[1]).toMatchObject({ title: 'Plain', statement: 'Row' });
  });

  it('handles bare carriage-return line endings and a missing final newline', () => {
    const rows = parseCsvNeeds(csv('title,statement\rA,B\rC,D'));
    expect(rows.map((r) => r.title)).toEqual(['A', 'C']);
  });

  it('returns nothing for empty input or a header-only file, and blank columns for unknown headers', () => {
    expect(parseCsvNeeds(csv('   '))).toEqual([]);
    expect(parseCsvNeeds(csv('title,statement\n'))).toEqual([]);
    expect(parseCsvNeeds(csv('foo,bar\n1,2\n'))[0]).toMatchObject({ title: '', statement: '' });
  });

  it('skips fully blank lines and tolerates short rows', () => {
    const rows = parseCsvNeeds(csv('title,statement,village\nA\n\n,,\nB,C,D\n'));
    expect(rows.map((r) => r.title)).toEqual(['A', 'B']);
  });
});

describe('parseExcelNeeds', () => {
  async function workbookBuffer(
    build: (ws: ExcelJS.Worksheet, wb: ExcelJS.Workbook) => void,
  ): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Needs');
    build(ws, wb);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it('reads rows under the header, skipping blank rows, and stringifies numbers', async () => {
    const buffer = await workbookBuffer((ws) => {
      ws.addRow(['Title', 'Statement', 'Village', 'Affected Population']);
      ws.addRow(['Wells', 'No water', 'Riyadh', 120]);
      ws.addRow([]);
      ws.addRow(['  ', '', '', '']);
      ws.addRow(['Roads', 'Broken', null, null]);
    });
    const rows = await parseExcelNeeds(buffer);
    expect(rows.map((r) => [r.row, r.title, r.affectedPopulation])).toEqual([
      [2, 'Wells', '120'],
      [5, 'Roads', ''],
    ]);
  });

  it('returns nothing when the workbook has no sheet', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('x');
    wb.removeWorksheet('x');
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    await expect(parseExcelNeeds(buffer)).resolves.toEqual([]);
  });
});

describe('parsePdfNeeds', () => {
  beforeEach(() => {
    pdf.text = '';
    pdf.fail = false;
  });

  it('turns text blocks into needs, picking up labelled fields', async () => {
    pdf.text =
      'Title: Water shortage\nStatement: Wells are dry\nGovernorate: Riyadh\nRef ID: R-7\n\nRoads\nThe road is broken and unsafe';
    const rows = await parsePdfNeeds(Buffer.from('x'));
    expect(rows[0]).toMatchObject({
      title: 'Water shortage',
      statement: 'Wells are dry',
      village: 'Riyadh',
      referenceId: 'R-7',
    });
    expect(rows[1]).toMatchObject({ title: 'Roads', statement: 'The road is broken and unsafe' });
  });

  it('joins pages returned as an array and uses a single line as both title and statement', async () => {
    pdf.text = ['First page single line', 'Second page'];
    const rows = await parsePdfNeeds(Buffer.from('x'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('First page single line');
  });

  it('explains an unreadable PDF and one with no text layer', async () => {
    pdf.fail = true;
    await expect(parsePdfNeeds(Buffer.from('x'))).rejects.toThrow('could not be read: broken pdf');
    pdf.fail = false;
    pdf.text = '   ';
    await expect(parsePdfNeeds(Buffer.from('x'))).rejects.toThrow('no extractable text layer');
  });

  it('uses the AI result and splits a numbered statement into separate needs', async () => {
    pdf.text = 'anything';
    const run = vi.fn().mockResolvedValue({
      response: {
        needs: [
          {
            title: 'Combined',
            statement: '1. No water in the village. 2. No school nearby. 3. Clinic is closed',
            village: 'Hail',
            referenceId: 'X',
          },
          { title: 'Single', statement: 'Just one problem', village: '', referenceId: '' },
          { title: '', statement: 'x'.repeat(100) },
        ],
      },
    });
    const rows = await parsePdfNeeds(Buffer.from('x'), { run } as never);
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(rows[0]).toMatchObject({ village: 'Hail', referenceId: 'X' });
    expect(rows.some((r) => r.title === 'Single')).toBe(true);
    expect(rows.at(-1)!.title.length).toBeLessThanOrEqual(80);
  });

  it('falls back to the text blocks when the AI fails or returns nothing', async () => {
    pdf.text = 'Roads\nBroken road';
    const failing = { run: vi.fn().mockRejectedValue(new Error('ai down')) };
    expect(await parsePdfNeeds(Buffer.from('x'), failing as never)).toHaveLength(1);
    const empty = { run: vi.fn().mockResolvedValue({ response: { needs: [] } }) };
    expect(await parsePdfNeeds(Buffer.from('x'), empty as never)).toHaveLength(1);
  });
});

describe('parseSurveyDocumentNeeds', () => {
  beforeEach(() => {
    pdf.text = 'Water\nNo water at all';
    pdf.fail = false;
    mammothState.value = 'Health\nNo clinic nearby';
    mammothState.fail = false;
  });

  it('reads a PDF, a Word document, a CSV/TXT file and a spreadsheet', async () => {
    // Without an AI service every format ends in the shared text-block fallback.
    for (const name of ['a.pdf', 'a.docx', 'a.doc', 'a.txt', 'a.csv']) {
      const rows = await parseSurveyDocumentNeeds(Buffer.from('Roads\nBroken'), name);
      expect(rows.length, name).toBeGreaterThan(0);
    }
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('s').addRows([
      ['Schools', 'Too few'],
      ['', null],
      ['Clinics', 'Closed'],
    ]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    expect((await parseSurveyDocumentNeeds(buffer, 'a.xlsx')).length).toBeGreaterThan(0);
    expect((await parseSurveyDocumentNeeds(buffer, 'a.xls')).length).toBeGreaterThan(0);
  });

  it('explains unreadable files and empty documents', async () => {
    pdf.fail = true;
    await expect(parseSurveyDocumentNeeds(Buffer.from('x'), 'a.pdf')).rejects.toThrow(
      'survey PDF file could not be read',
    );
    mammothState.fail = true;
    await expect(parseSurveyDocumentNeeds(Buffer.from('x'), 'a.docx')).rejects.toThrow(
      'Word document could not be read',
    );
    await expect(parseSurveyDocumentNeeds(Buffer.from('x'), 'a.exe')).rejects.toThrow(
      'Unsupported file extension .exe',
    );
    await expect(parseSurveyDocumentNeeds(Buffer.from('   '), 'a.txt')).rejects.toThrow(
      'no readable text',
    );
  });

  it('prefers the AI extraction and falls back to text blocks when it fails', async () => {
    const good = {
      run: vi.fn().mockResolvedValue({ response: { needs: [{ title: 'T', statement: 'S' }] } }),
    };
    expect(
      (await parseSurveyDocumentNeeds(Buffer.from('Roads\nBroken'), 'a.txt', good as never))[0]!
        .title,
    ).toBe('T');
    const bad = { run: vi.fn().mockRejectedValue(new Error('x')) };
    pdf.text = 'Roads\nBroken';
    expect(
      (await parseSurveyDocumentNeeds(Buffer.from('Roads\nBroken'), 'a.txt', bad as never))[0]!
        .title,
    ).toBe('Roads');
  });
});
