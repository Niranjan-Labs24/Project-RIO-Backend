import PDFDocument from "pdfkit";
import type { FlattenedContent } from "./report-content-flatten";

// Real PDF rendering (RIO-NFR-008) via pdfkit — proper pagination, real
// tables with borders/column widths, and section headings, instead of the
// previous hand-rolled byte-level PDF writer that just dumped wrapped plain
// text. Arabic/RTL text support (RIO-NFR-007) and the final bespoke
// per-report-type visual design are deliberately out of scope here — the
// latter is Karthika's Village Assessment Report viewer, which this will
// switch to reusing (in a print/PDF mode) once that's merged; until then
// this covers "a real, well-formatted export" generically across all
// report types via the same flattened content model every export already
// uses.
const PAGE_MARGIN = 50;
const TABLE_ROW_HEIGHT = 22;
const MAX_ROWS_PER_PAGE_SLICE = 10_000; // guards against runaway content, not a real limit today

function ensureSpace(doc: PDFKit.PDFDocument, neededHeight: number): void {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + neededHeight > bottom) doc.addPage();
}

function drawSectionHeading(doc: PDFKit.PDFDocument, text: string): void {
  ensureSpace(doc, 30);
  doc.moveDown(0.5);
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#111827").text(text);
  doc
    .moveTo(doc.page.margins.left, doc.y + 2)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y + 2)
    .strokeColor("#d1d5db")
    .stroke();
  doc.moveDown(0.5);
}

function drawKeyValueRows(
  doc: PDFKit.PDFDocument,
  rows: Array<{ field: string; value: string }>,
): void {
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const labelWidth = usableWidth * 0.35;
  const valueWidth = usableWidth * 0.65;

  for (const row of rows.slice(0, MAX_ROWS_PER_PAGE_SLICE)) {
    ensureSpace(doc, TABLE_ROW_HEIGHT);
    const startY = doc.y;
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor("#374151")
      .text(row.field, doc.page.margins.left, startY, { width: labelWidth });
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#111827")
      .text(row.value, doc.page.margins.left + labelWidth, startY, { width: valueWidth });
    doc.y = Math.max(doc.y, startY + 14);
    doc.moveDown(0.15);
  }
}

function drawDataTable(
  doc: PDFKit.PDFDocument,
  table: { name: string; rows: Array<Record<string, unknown>> },
): void {
  drawSectionHeading(doc, table.name);
  if (table.rows.length === 0) {
    doc.font("Helvetica").fontSize(9).fillColor("#6b7280").text("No data.");
    return;
  }

  const columns = Array.from(new Set(table.rows.flatMap((row) => Object.keys(row))));
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidth = usableWidth / columns.length;

  function drawRow(values: string[], opts: { bold: boolean }) {
    ensureSpace(doc, TABLE_ROW_HEIGHT);
    const startY = doc.y;
    doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5);
    values.forEach((value, i) => {
      doc
        .fillColor(opts.bold ? "#111827" : "#374151")
        .text(value, doc.page.margins.left + i * colWidth, startY, {
          width: colWidth - 6,
          ellipsis: true,
        });
    });
    doc.y = startY + TABLE_ROW_HEIGHT;
    doc
      .moveTo(doc.page.margins.left, doc.y - 4)
      .lineTo(doc.page.width - doc.page.margins.right, doc.y - 4)
      .strokeColor("#e5e7eb")
      .stroke();
  }

  drawRow(
    columns.map((c) => c.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (ch) => ch.toUpperCase())),
    { bold: true },
  );
  for (const row of table.rows) {
    drawRow(
      columns.map((c) => {
        const v = row[c];
        return v === null || v === undefined ? "—" : String(v);
      }),
      { bold: false },
    );
  }
}

export function buildReportPdf(
  title: string,
  reportType: string,
  metaRows: Array<{ field: string; value: string }>,
  content: FlattenedContent,
): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  doc.font("Helvetica-Bold").fontSize(20).fillColor("#111827").text(title);
  doc.font("Helvetica").fontSize(10).fillColor("#6b7280").text(reportType);
  doc.moveDown(1);

  if (metaRows.length > 0) {
    drawSectionHeading(doc, "Report Details");
    drawKeyValueRows(doc, metaRows);
  }

  if (content.summaryRows.length > 0) {
    drawSectionHeading(doc, "Summary");
    drawKeyValueRows(doc, content.summaryRows);
  }

  for (const table of content.tables) {
    drawDataTable(doc, table);
  }

  // Page numbers footer, added after all content since page count isn't
  // known until everything's been laid out (bufferPages: true holds every
  // page in memory until doc.end() so this range switch is safe).
  const pageRange = doc.bufferedPageRange();
  for (let i = 0; i < pageRange.count; i++) {
    doc.switchToPage(pageRange.start + i);
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#9ca3af")
      .text(`Page ${i + 1} of ${pageRange.count}`, doc.page.margins.left, doc.page.height - 35, {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
        align: "center",
      });
  }

  return new Promise((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.end();
  });
}
