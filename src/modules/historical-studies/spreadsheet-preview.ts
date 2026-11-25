import ExcelJS from 'exceljs';
import { extname } from 'node:path';
import { loadXlsx } from '../../common/excel/load-xlsx';
import { detectDelimiter, parseCsvRows } from '../needs/needs-import.parser';

/**
 * UAT 26 Nov (Archive) — a browser cannot display an Excel file, so Preview
 * downloaded it. The server now reads the spreadsheet and returns its rows,
 * which the Archive page shows as a table (one tab per sheet). The file never
 * leaves the server and nothing new is installed: ExcelJS already reads
 * workbooks for imports and writes them for exports.
 */

export const PREVIEWABLE_EXTENSIONS = ['.xlsx', '.xls', '.csv'] as const;

/** Enough to recognise a file; Download gives the whole of it. */
export const PREVIEW_MAX_ROWS = 200;
export const PREVIEW_MAX_COLUMNS = 50;
export const PREVIEW_MAX_SHEETS = 20;

export interface SpreadsheetPreviewSheet {
  name: string;
  rows: string[][];
  /** Rows in the sheet, including any not returned. */
  totalRows: number;
  truncated: boolean;
}

export interface SpreadsheetPreview {
  kind: 'spreadsheet';
  fileName: string;
  sheets: SpreadsheetPreviewSheet[];
}

export function isPreviewable(fileName: string): boolean {
  return (PREVIEWABLE_EXTENSIONS as readonly string[]).includes(extname(fileName).toLowerCase());
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((r) => r.text).join('');
    if ('error' in value) return String(value.error);
    if ('result' in value) return value.result === undefined ? '' : cellText(value.result);
    if ('text' in value) return String(value.text);
    return '';
  }
  return String(value);
}

/** Pads rows to one width so the table lines up. */
function rectangular(rows: string[][]): string[][] {
  const width = Math.min(PREVIEW_MAX_COLUMNS, Math.max(0, ...rows.map((r) => r.length)));
  return rows.map((r) => {
    const cut = r.slice(0, width);
    return cut.length < width ? [...cut, ...Array<string>(width - cut.length).fill('')] : cut;
  });
}

async function previewWorkbook(buffer: Buffer): Promise<SpreadsheetPreviewSheet[]> {
  const workbook = new ExcelJS.Workbook();
  await loadXlsx(workbook, buffer);
  return workbook.worksheets.slice(0, PREVIEW_MAX_SHEETS).map((sheet) => {
    const rows: string[][] = [];
    let totalRows = 0;
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        if (col <= PREVIEW_MAX_COLUMNS) cells[col - 1] = cellText(cell.value);
      });
      const filled = Array.from(cells, (c) => c ?? '');
      if (filled.every((c) => c.trim() === '')) return;
      totalRows += 1;
      if (rows.length < PREVIEW_MAX_ROWS) rows.push(filled);
    });
    return { name: sheet.name, rows: rectangular(rows), totalRows, truncated: totalRows > rows.length };
  });
}

function previewCsv(buffer: Buffer): SpreadsheetPreviewSheet[] {
  const text = buffer.toString('utf-8').replace(/^﻿/, '');
  const all = parseCsvRows(text, detectDelimiter(text.split(/\r\n|\r|\n/)[0] ?? ''));
  return [
    {
      name: '',
      rows: rectangular(all.slice(0, PREVIEW_MAX_ROWS)),
      totalRows: all.length,
      truncated: all.length > PREVIEW_MAX_ROWS,
    },
  ];
}

/**
 * The file's rows, or null when it cannot be read as a spreadsheet (for
 * example an old binary .xls, which ExcelJS does not read) — the caller then
 * offers Download instead.
 */
export async function readSpreadsheetPreview(fileName: string, buffer: Buffer): Promise<SpreadsheetPreview | null> {
  const ext = extname(fileName).toLowerCase();
  try {
    const sheets = ext === '.csv' ? previewCsv(buffer) : await previewWorkbook(buffer);
    return { kind: 'spreadsheet', fileName, sheets };
  } catch {
    return null;
  }
}
