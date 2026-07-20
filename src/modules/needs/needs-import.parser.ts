import ExcelJS from 'exceljs';

export interface ParsedNeedRow {
  // 1-based, counting the header row as row 1 — matches what a person
  // looking at the spreadsheet in Excel/a text editor would call "row N",
  // so an error message can point them straight at it.
  row: number;
  title: string;
  statement: string;
  village: string;
  source: string;
  referenceId: string;
}

// Recognized header names, case/whitespace-insensitive — a submitter's own
// column labels ("Need Title" vs "Title", "Data Source" vs "Source") don't
// have to match one exact string.
const HEADER_ALIASES: Record<keyof Omit<ParsedNeedRow, 'row'>, string[]> = {
  title: ['title', 'need title'],
  statement: ['statement', 'need statement'],
  // "Governorate" is what the UI now calls this field; the older "village"
  // labels stay accepted so previously-distributed templates keep importing.
  village: ['governorate', 'governorates', 'village', 'villages'],
  source: ['source', 'data source'],
  referenceId: ['reference id', 'referenceid', 'reference', 'ref id'],
};

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildColumnIndex(headerCells: string[]): Partial<Record<keyof ParsedNeedRow, number>> {
  const normalized = headerCells.map(normalizeHeader);
  const index: Partial<Record<keyof ParsedNeedRow, number>> = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [
    keyof Omit<ParsedNeedRow, 'row'>,
    string[],
  ][]) {
    const colIdx = normalized.findIndex((h) => aliases.includes(h));
    if (colIdx !== -1) index[field] = colIdx;
  }
  return index;
}

function cellsToRow(cells: string[], index: Partial<Record<keyof ParsedNeedRow, number>>, rowNumber: number): ParsedNeedRow {
  const get = (field: keyof Omit<ParsedNeedRow, 'row'>): string => {
    const idx = index[field];
    return idx === undefined ? '' : (cells[idx] ?? '').trim();
  };
  return {
    row: rowNumber,
    title: get('title'),
    statement: get('statement'),
    village: get('village'),
    source: get('source'),
    referenceId: get('referenceId'),
  };
}

// Minimal RFC-4180-ish CSV line splitter: handles double-quoted fields
// (including embedded commas and escaped `""` quotes) without pulling in a
// dependency for what's otherwise a one-line `.split(',')`.
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

export function parseCsvNeeds(buffer: Buffer): ParsedNeedRow[] {
  const text = buffer.toString('utf-8').replace(/^﻿/, ''); // strip a UTF-8 BOM if present
  const lines = text.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0);
  const headerLine = lines[0];
  if (headerLine === undefined) return [];
  const index = buildColumnIndex(parseCsvLine(headerLine));
  return lines.slice(1).map((line, i) => cellsToRow(parseCsvLine(line), index, i + 2));
}

export async function parseExcelNeeds(buffer: Buffer): Promise<ParsedNeedRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const headerRow = sheet.getRow(1);
  const headerCells: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headerCells[colNumber - 1] = String(cell.value ?? '');
  });
  const index = buildColumnIndex(headerCells);

  const rows: ParsedNeedRow[] = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    if (row.cellCount === 0) continue;
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cells[colNumber - 1] = cell.value === null || cell.value === undefined ? '' : String(cell.value);
    });
    if (cells.every((c) => !c || c.trim() === '')) continue; // a fully blank row (trailing rows Excel sometimes keeps)
    rows.push(cellsToRow(cells, index, r));
  }
  return rows;
}
