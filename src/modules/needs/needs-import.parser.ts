import ExcelJS from 'exceljs';
import { extname } from 'node:path';
import type { AiService } from '../ai/ai.service';
import {
  PDF_NEEDS_EXTRACTION_TASK,
  type PdfNeedsExtractionResponse,
} from '../ai/prompts/pdf-needs-extraction.task';
import {
  SURVEY_NEEDS_EXTRACTION_TASK,
  type SurveyNeedsExtractionResponse,
} from '../ai/prompts/survey-needs-extraction.task';

export interface ParsedNeedRow {
  row: number;
  title: string;
  statement: string;
  village: string;
  referenceId: string;
}

const HEADER_ALIASES: Record<keyof Omit<ParsedNeedRow, 'row'>, string[]> = {
  title: ['title', 'need title'],
  statement: ['statement', 'need statement'],
  village: ['governorate', 'governorates', 'village', 'villages'],
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
    referenceId: get('referenceId'),
  };
}

function detectDelimiter(firstLine: string): string {
  const commaCount = (firstLine.match(/,/g) || []).length;
  const semicolonCount = (firstLine.match(/;/g) || []).length;
  const tabCount = (firstLine.match(/\t/g) || []).length;

  if (semicolonCount > commaCount && semicolonCount > tabCount) return ';';
  if (tabCount > commaCount && tabCount > semicolonCount) return '\t';
  return ',';
}

function parseCsvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);

    if (inQuotes) {
      if (char === '"') {
        if (text.charAt(i + 1) === '"') {
          currentCell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentCell += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      currentRow.push(currentCell.trim());
      currentCell = '';
    } else if (char === '\r') {
      if (text.charAt(i + 1) === '\n') {
        i++;
      }
      currentRow.push(currentCell.trim());
      rows.push(currentRow);
      currentRow = [];
      currentCell = '';
    } else if (char === '\n') {
      currentRow.push(currentCell.trim());
      rows.push(currentRow);
      currentRow = [];
      currentCell = '';
    } else {
      currentCell += char;
    }
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell.trim());
    rows.push(currentRow);
  }

  return rows.filter((r) => r.some((c) => c.length > 0));
}

export function parseCsvNeeds(buffer: Buffer): ParsedNeedRow[] {
  const text = buffer.toString('utf-8').replace(/^﻿/, ''); // strip a UTF-8 BOM if present
  if (!text.trim()) return [];

  const firstLine = text.split(/\r\n|\r|\n/)[0] || '';
  const delimiter = detectDelimiter(firstLine);
  const parsedRows = parseCsvRows(text, delimiter);
  if (parsedRows.length < 2) return [];

  const headerCells = parsedRows[0]!;
  const index = buildColumnIndex(headerCells);

  return parsedRows.slice(1).map((cells, i) => cellsToRow(cells, index, i + 2));
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

function splitCombinedNeedItems(
  rawNeeds: Array<{ title: string; statement: string; village?: string; referenceId?: string }>,
): ParsedNeedRow[] {
  const result: ParsedNeedRow[] = [];

  for (const item of rawNeeds) {
    const rawStatement = (item.statement || '').trim();
    const rawTitle = (item.title || '').trim();
    const village = (item.village || '').trim();
    const referenceId = (item.referenceId || '').trim();

    // Look for embedded numbered lists: e.g. "1. First ... 2. Second ..." or "Problem 1: ... Problem 2: ..."
    const multiItemRegex = /(?:^|\n|\.\s+)(?:(?:problem|issue|need|item)\s*\d+[\s:.-]+|\d+[\s).-]+|[a-z][\).\s]+)/gi;
    const matches = Array.from(rawStatement.matchAll(multiItemRegex));

    if (matches.length > 1) {
      const parts: string[] = [];
      for (let i = 0; i < matches.length; i++) {
        const start = matches[i]!.index! + matches[i]![0].length;
        const end = i < matches.length - 1 ? matches[i + 1]!.index! : rawStatement.length;
        const partText = rawStatement.slice(start, end).trim();
        if (partText) {
          parts.push(partText);
        }
      }

      if (parts.length > 1) {
        parts.forEach((p) => {
          const subTitle = p.length > 80 ? `${p.slice(0, 77)}...` : p;
          result.push({
            row: result.length + 1,
            title: subTitle,
            statement: p,
            village,
            referenceId,
          });
        });
        continue;
      }
    }

    result.push({
      row: result.length + 1,
      title: rawTitle || rawStatement.slice(0, 80),
      statement: rawStatement || rawTitle,
      village,
      referenceId,
    });
  }

  return result;
}

export async function parsePdfNeeds(
  buffer: Buffer,
  aiService?: AiService,
): Promise<ParsedNeedRow[]> {
  const { extractText, getDocumentProxy } = await import('unpdf');

  let text = '';
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const extracted = await extractText(pdf, { mergePages: true });
    text = Array.isArray(extracted.text) ? extracted.text.join('\n') : extracted.text;
  } catch (err: unknown) {
    throw new Error(`The PDF file could not be read: ${err instanceof Error ? err.message : 'damaged or invalid PDF'}`);
  }

  const cleanedText = text.trim();
  if (!cleanedText) {
    throw new Error('PDF file was read successfully but contains no extractable text layer.');
  }

  if (aiService) {
    try {
      const { response } = await aiService.run<PdfNeedsExtractionResponse>(
        PDF_NEEDS_EXTRACTION_TASK,
        `MANDATORY REQUIREMENT: EXTRACT EACH PROBLEM STATEMENT AS A SEPARATE STANDALONE NEED ITEM. NEVER COMBINE PROBLEMS.\n\nDocument Content:\n${cleanedText.slice(0, 30_000)}`,
      );
      if (response && Array.isArray(response.needs) && response.needs.length > 0) {
        return splitCombinedNeedItems(response.needs);
      }
    } catch {
      // Fallback to text block parsing if AI call fails
    }
  }

  const blocks = cleanedText.split(/\n\s*\n/).filter((b) => b.trim().length > 0);
  const rawFallback: Array<{ title: string; statement: string; village?: string; referenceId?: string }> = [];

  blocks.forEach((block) => {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return;

    let title = lines[0]!.slice(0, 300);
    let statement = lines.length > 1 ? lines.slice(1).join(' ').slice(0, 5000) : lines[0]!;
    let village = '';
    let referenceId = '';

    for (const line of lines) {
      const matchVillage = line.match(/^(?:governorate|village|location)\s*:\s*(.+)$/i);
      if (matchVillage?.[1]) village = matchVillage[1].trim();

      const matchRef = line.match(/^(?:reference\s*id|ref\s*id|id|code)\s*:\s*(.+)$/i);
      if (matchRef?.[1]) referenceId = matchRef[1].trim();

      const matchTitle = line.match(/^(?:title|need\s*title)\s*:\s*(.+)$/i);
      if (matchTitle?.[1]) title = matchTitle[1].trim();

      const matchStmt = line.match(/^(?:statement|description|need\s*statement)\s*:\s*(.+)$/i);
      if (matchStmt?.[1]) statement = matchStmt[1].trim();
    }

    rawFallback.push({ title, statement, village, referenceId });
  });

  return splitCombinedNeedItems(rawFallback);
}

export async function parseSurveyDocumentNeeds(
  buffer: Buffer,
  fileName: string,
  aiService?: AiService,
): Promise<ParsedNeedRow[]> {
  const ext = extname(fileName).toLowerCase();
  let extractedText = '';

  if (ext === '.pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf');
    try {
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const extracted = await extractText(pdf, { mergePages: true });
      extractedText = Array.isArray(extracted.text) ? extracted.text.join('\n') : extracted.text;
    } catch (err: unknown) {
      throw new Error(`The survey PDF file could not be read: ${err instanceof Error ? err.message : 'damaged PDF'}`);
    }
  } else if (ext === '.docx' || ext === '.doc') {
    const mammoth = await import('mammoth');
    try {
      const res = await mammoth.extractRawText({ buffer });
      extractedText = res.value;
    } catch (err: unknown) {
      throw new Error(`The survey Word document could not be read: ${err instanceof Error ? err.message : 'damaged DOCX'}`);
    }
  } else if (ext === '.xlsx' || ext === '.xls') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const lines: string[] = [];
    workbook.eachSheet((sheet) => {
      sheet.eachRow((row) => {
        const values = Array.isArray(row.values)
          ? row.values.slice(1).map((v) => (v !== null && v !== undefined ? String(v) : '')).join(' | ')
          : '';
        if (values.trim()) lines.push(values);
      });
    });
    extractedText = lines.join('\n');
  } else if (ext === '.csv' || ext === '.txt') {
    extractedText = buffer.toString('utf-8').replace(/^﻿/, '');
  } else {
    throw new Error(`Unsupported file extension ${ext}. Only PDF, DOCX, XLSX, and CSV are supported.`);
  }

  const cleanedText = extractedText.trim();
  if (!cleanedText) {
    throw new Error('Survey document contains no readable text content.');
  }

  if (aiService) {
    try {
      const { response } = await aiService.run<SurveyNeedsExtractionResponse>(
        SURVEY_NEEDS_EXTRACTION_TASK,
        `MANDATORY REQUIREMENT: ANALYZE SURVEY RESULTS, METRICS, LOW RATINGS & FINDINGS. EXTRACT EVERY DISTINCT NEED ITEM. DO NOT MERGE PROBLEMS.\n\nSurvey Document Content:\n${cleanedText.slice(0, 30_000)}`,
      );
      if (response && Array.isArray(response.needs) && response.needs.length > 0) {
        return splitCombinedNeedItems(response.needs);
      }
    } catch {
      // Fallback
    }
  }

  // Fallback to text block parsing
  return parsePdfNeeds(buffer, aiService);
}
