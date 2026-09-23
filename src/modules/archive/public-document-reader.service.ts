import { Injectable, Logger } from "@nestjs/common";
import { EvidenceStorageService } from "../evidence/evidence.storage.service";
import type { PublicDocumentView } from "./public-archive.types";

/**
 * RIO-DATA-002 — an uploaded document, turned into page content.
 *
 * ── THE POINT ───────────────────────────────────────────────────────────────
 * The client asked on 2026-09-23 for uploaded files to be readable on the
 * public page but not downloadable. Those two only hold together if the file
 * itself never reaches the browser: a PDF served inline opens in the browser's
 * own viewer, and that viewer has a save button no web page can remove. A
 * spreadsheet cannot even be displayed — a browser handed an .xlsx downloads
 * it, which is the exact opposite of what was asked.
 *
 * So nothing here returns bytes. The file is read on the server and converted
 * into ordinary JSON — rows for a spreadsheet, text per page for a PDF — which
 * the page renders as a table or as paragraphs. What the reader receives is a
 * web page, not a document, so there is no file for them to save.
 *
 * ── LIMITS, AND WHY ─────────────────────────────────────────────────────────
 * This runs on an unauthenticated route, so every call parses a file for a
 * caller who has proved nothing. Results are cached by storage key, and both
 * the number of rows and the amount of text are capped — a large upload must
 * not turn one request into an expensive one, repeatedly.
 */

/** Parsing is far more expensive than serving the result, and the files never
 *  change once uploaded — the storage key is content-addressed at upload. */
const CACHE_LIMIT = 40;

/** Caps on what one document may return. A reader who needs more than this
 *  is reading a working file, not a public record; the page says so rather
 *  than quietly truncating. */
const MAX_ROWS_PER_SHEET = 500;
const MAX_COLUMNS = 40;
const MAX_TEXT_PER_PAGE = 20_000;

@Injectable()
export class PublicDocumentReaderService {
  private readonly logger = new Logger(PublicDocumentReaderService.name);
  private readonly cache = new Map<string, PublicDocumentView>();

  constructor(private readonly storage: EvidenceStorageService) {}

  async read(storageKey: string, fileName: string | null): Promise<PublicDocumentView> {
    const cached = this.cache.get(storageKey);
    if (cached) return cached;

    const view = await this.parse(storageKey, fileName).catch((error: unknown) => {
      // A file that will not parse is a fact about the record, not an outage.
      // The page says it cannot be displayed rather than showing an error, and
      // the reason stays in the log where it is useful.
      this.logger.warn(
        `Public view failed for ${storageKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { type: "unavailable", reason: "unreadable" } satisfies PublicDocumentView;
    });

    if (this.cache.size >= CACHE_LIMIT) {
      // Oldest first — Map preserves insertion order.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(storageKey, view);
    return view;
  }

  private async parse(storageKey: string, fileName: string | null): Promise<PublicDocumentView> {
    // The extension on the stored key, not the browser-supplied file name or
    // MIME type: three of the uploads here were sent as
    // `application/octet-stream` and are really spreadsheets.
    const ext = (storageKey.split(".").pop() ?? "").toLowerCase();

    // Reads through EvidenceStorageService, which resolves the path and
    // refuses anything that escapes the storage directory. Nothing here
    // builds a path of its own.
    const buffer = await this.storage.read(storageKey);

    switch (ext) {
      case "xlsx":
      case "xls":
        return this.readWorkbook(buffer);
      case "csv":
        return this.readCsv(buffer);
      case "pdf":
        return this.readPdf(buffer);
      default:
        return {
          type: "unavailable",
          reason: "unsupported",
          detail: fileName ? ext.toUpperCase() : undefined,
        };
    }
  }

  private async readWorkbook(buffer: Buffer): Promise<PublicDocumentView> {
    const ExcelJS = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

    const sheets = workbook.worksheets.map((sheet) => {
      const columns = Math.min(sheet.columnCount, MAX_COLUMNS);
      const rows: string[][] = [];
      let truncated = false;

      sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber > MAX_ROWS_PER_SHEET) {
          truncated = true;
          return;
        }
        const cells: string[] = [];
        for (let c = 1; c <= columns; c++) {
          cells.push(cellText(row.getCell(c).value));
        }
        // A row of nothing but empty cells is spreadsheet padding, not data.
        if (cells.some((v) => v !== "")) rows.push(cells);
      });

      return { name: sheet.name, rows, truncated, totalRows: sheet.rowCount };
    });

    if (sheets.length === 0) return { type: "unavailable", reason: "empty" };
    return { type: "sheets", sheets };
  }

  private readCsv(buffer: Buffer): PublicDocumentView {
    const text = buffer.toString("utf8").replace(/^﻿/, "");
    const allRows = splitCsv(text);
    const rows = allRows.slice(0, MAX_ROWS_PER_SHEET).map((r) => r.slice(0, MAX_COLUMNS));
    if (rows.length === 0) return { type: "unavailable", reason: "empty" };
    return {
      type: "sheets",
      sheets: [
        {
          name: "CSV",
          rows,
          truncated: allRows.length > MAX_ROWS_PER_SHEET,
          totalRows: allRows.length,
        },
      ],
    };
  }

  private async readPdf(buffer: Buffer): Promise<PublicDocumentView> {
    // unpdf is ESM-first; resolved lazily so the CJS build stays happy and the
    // pdf.js bundle is only loaded when a PDF is actually opened. Same form
    // EvidenceDocumentsService uses — resolving the path by hand instead
    // breaks under the build, which is how the first version of this failed.
    const { extractText, getDocumentProxy } = await import("unpdf");

    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    // `mergePages: false` gives one string per page, so the page break the
    // author put there survives into what the reader sees.
    const { totalPages, text } = await extractText(pdf, { mergePages: false });

    const pages = (Array.isArray(text) ? text : [text]).map((pageText, i) => ({
      number: i + 1,
      text: pageText.slice(0, MAX_TEXT_PER_PAGE).trim(),
    }));

    // A PDF of scanned images has pages but no extractable text. Saying so is
    // more use than showing a run of blank pages.
    if (pages.every((p) => p.text === "")) {
      return { type: "unavailable", reason: "noTextLayer", detail: String(totalPages) };
    }
    return { type: "pages", pages, totalPages };
  }
}

/** ExcelJS cell values are a union of primitives, dates, formulas and rich
 *  text. Only their displayed text is published. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const v = value as {
      text?: string;
      result?: unknown;
      richText?: { text: string }[];
      hyperlink?: string;
    };
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
    if (typeof v.text === "string") return v.text;
    // A formula cell publishes its result, never the formula itself.
    if (v.result !== undefined) return cellText(v.result);
    return "";
  }
  return String(value);
}

/** A small CSV reader rather than a dependency: handles quoted fields,
 *  doubled quotes and newlines inside quotes, which a `split(",")` does not
 *  and which is exactly what breaks a table on screen. */
function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }

  row.push(field);
  if (row.some((v) => v !== "")) rows.push(row);
  return rows;
}
