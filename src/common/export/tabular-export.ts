import ExcelJS from 'exceljs';

/**
 * UAT AUD-03 — one way to write a table as CSV or Excel, shared by the audit
 * log, system logs and survey-response exports.
 *
 * Why the CSV looked broken in Excel ("everything in one column, Arabic as
 * garbled characters"): the files had no byte-order mark, so Excel decoded the
 * UTF-8 bytes in the Windows code page, and used bare LF line endings. Every
 * CSV now starts with the UTF-8 BOM (EF BB BF), separates rows with CRLF and
 * quotes every cell (RFC 4180), which Excel, LibreOffice and Google Sheets all
 * open correctly. The delimiter stays a comma: a `sep=` hint line would stop
 * Excel honouring the BOM. For anyone whose Excel is set to a different list
 * separator, the same data is also offered as a real .xlsx, which has no
 * delimiter or encoding to get wrong.
 */
export type ExportCell = string | number | null | undefined;

export interface ExportTable {
  headers: string[];
  rows: ExportCell[][];
}

export type ExportFormat = 'csv' | 'xlsx';

export const UTF8_BOM = '﻿';

export const EXPORT_CONTENT_TYPE: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** `?format=` → a supported format; "excel" is accepted as an alias of xlsx. */
export function parseExportFormat(value: string | undefined): ExportFormat {
  return value === 'xlsx' || value === 'excel' ? 'xlsx' : 'csv';
}

/**
 * A text cell starting with = + - @ would be run as a formula by a
 * spreadsheet (CSV injection), e.g. a log message an attacker controls. Such
 * cells are prefixed with an apostrophe, which spreadsheets show as text.
 * Real numbers are passed as numbers and never touched.
 */
function safeText(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function csvCell(value: ExportCell): string {
  if (value === null || value === undefined) return '""';
  const text = typeof value === 'number' ? String(value) : safeText(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(table: ExportTable): string {
  const lines = [table.headers, ...table.rows].map((row) => row.map(csvCell).join(','));
  return UTF8_BOM + lines.join('\r\n') + '\r\n';
}

export async function toXlsx(
  table: ExportTable,
  options: { sheetName: string; rightToLeft?: boolean },
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  // Excel limits sheet names to 31 characters and forbids []:*?/\
  const name = options.sheetName.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet1';
  const sheet = workbook.addWorksheet(name, {
    views: [{ rightToLeft: options.rightToLeft ?? false, state: 'frozen', ySplit: 1 }],
  });
  sheet.addRow(table.headers).font = { bold: true };
  for (const row of table.rows) {
    sheet.addRow(row.map((v) => (typeof v === 'string' ? safeText(v) : (v ?? ''))));
  }
  sheet.columns.forEach((column, i) => {
    const longest = Math.max(
      table.headers[i]?.length ?? 0,
      ...table.rows.slice(0, 200).map((r) => String(r[i] ?? '').length),
    );
    column.width = Math.min(Math.max(longest + 2, 10), 60);
  });
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: table.headers.length } };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function exportFilename(base: string, format: ExportFormat): string {
  return `${base}-${new Date().toISOString().slice(0, 10)}.${format}`;
}

/** "2026-11-09 14:05:33" in Asia/Riyadh — readable and still sortable. */
export function formatRiyadhTime(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}
