import ExcelJS from "exceljs";
import type { DocSection, ReportDoc } from "./report-doc";

const ACCENT = "FF1F5A99";
const LIGHT = "FFE6EEF7";

function uniqueSheetName(wb: ExcelJS.Workbook, base: string): string {
  // Excel sheet names: <=31 chars, unique, no []*/\?: characters.
  const clean = base.replace(/[[\]*/\\?:]/g, " ").slice(0, 31) || "Sheet";
  let name = clean;
  let i = 2;
  while (wb.getWorksheet(name)) name = `${clean.slice(0, 28)} ${i++}`;
  return name;
}

function styleHeaderRow(row: ExcelJS.Row): void {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT } };
  });
}

function addTableSheet(wb: ExcelJS.Workbook, heading: string, columns: string[], rows: string[][]): void {
  const sheet = wb.addWorksheet(uniqueSheetName(wb, heading));
  sheet.columns = columns.map((c) => ({ header: c, key: c, width: Math.max(16, Math.min(40, c.length + 6)) }));
  styleHeaderRow(sheet.getRow(1));
  for (const r of rows) {
    // Column width is sized off the header, not the data — a long cell
    // value (a domain name, a KPI label, ...) with no wrap would otherwise
    // render past its own column into whatever's next, rather than
    // wrapping inside the cell it actually belongs to.
    const row = sheet.addRow(r);
    row.eachCell((cell) => (cell.alignment = { wrapText: true, vertical: "top" }));
  }
}

function addBarsSheet(wb: ExcelJS.Workbook, s: Extract<DocSection, { kind: "bars" }>): void {
  const sheet = wb.addWorksheet(uniqueSheetName(wb, s.heading));
  sheet.columns = [
    { header: "Item", key: "label", width: 34 },
    { header: "Value", key: "value", width: 16 },
  ];
  styleHeaderRow(sheet.getRow(1));
  for (const b of s.bars) sheet.addRow({ label: b.label, value: b.value });
  // Data-bar conditional formatting = an in-cell bar chart over the Value col.
  if (s.bars.length) {
    const options = {
      ref: `B2:B${s.bars.length + 1}`,
      rules: [
        {
          type: "dataBar",
          cfvo: [{ type: "num", value: 0 }, { type: "num", value: s.max }],
          color: { argb: ACCENT },
        },
      ],
    } as unknown as Parameters<typeof sheet.addConditionalFormatting>[0];
    sheet.addConditionalFormatting(options);
  }
}

export async function renderReportExcel(doc: ReportDoc): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "RIO";
  wb.created = new Date();

  const summary = wb.addWorksheet("Summary");
  summary.columns = [
    { header: "Field", key: "field", width: 34 },
    { header: "Value", key: "value", width: 70 },
  ];

  // Title band across both columns.
  summary.mergeCells("A1:B1");
  const titleCell = summary.getCell("A1");
  titleCell.value = doc.title;
  titleCell.font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT } };
  summary.addRow([]);

  const kv = (label: string, value: string, shaded = false) => {
    const row = summary.addRow({ field: label, value });
    // Executive Summary/Key Findings/etc. routinely run several sentences
    // long — without wrapText, Excel renders that past column B's own
    // width into whatever empty cells sit to the right instead of actually
    // wrapping inside the cell, looking like the text "overlaps" other
    // cells (it's the same underlying issue addTableSheet fixes for table
    // sheets).
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
    if (shaded) row.eachCell((c) => (c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT } }));
  };

  if (doc.headerBand.length) {
    summary.addRow({ field: "— Header —", value: "" }).font = { bold: true };
    for (const h of doc.headerBand) kv(h.label, h.value, true);
  }

  // Tables and bar charts get their own sheets; text sections fold into Summary.
  // Columns are a PDF-only layout concern — flatten them for the workbook.
  const flat = doc.sections.flatMap((s) => (s.kind === "columns" ? s.children : [s]));
  for (const s of flat) {
    switch (s.kind) {
      case "table":
        addTableSheet(wb, s.heading, s.columns, s.rows);
        break;
      case "bars":
        addBarsSheet(wb, s);
        break;
      case "pie": {
        const total = s.slices.reduce((a, b) => a + b.value, 0) || 1;
        addBarsSheet(wb, {
          kind: "bars",
          heading: s.heading,
          max: Math.max(1, ...s.slices.map((sl) => sl.value)),
          bars: s.slices.map((sl) => ({ label: `${sl.label} (${Math.round((sl.value / total) * 100)}%)`, value: sl.value })),
        });
        break;
      }
      case "gauge":
        summary.addRow({ field: `— ${s.heading} —`, value: "" }).font = { bold: true };
        kv(s.heading, `${s.value} / ${s.max}${s.sub ? ` (${s.sub})` : ""}`, true);
        break;
      case "radar": {
        const sheet = wb.addWorksheet(uniqueSheetName(wb, s.heading));
        sheet.columns = [
          { header: "Domain", key: "axis", width: 28 },
          ...s.series.map((se, i) => ({ header: se.name, key: `s${i}`, width: 16 })),
        ];
        styleHeaderRow(sheet.getRow(1));
        s.axes.forEach((ax, ai) => {
          const row: Record<string, string | number> = { axis: ax };
          s.series.forEach((se, si) => (row[`s${si}`] = se.values[ai] ?? 0));
          sheet.addRow(row);
        });
        break;
      }
      case "keyvalue":
        summary.addRow({ field: `— ${s.heading} —`, value: "" }).font = { bold: true };
        for (const r of s.rows) kv(r.label, r.value);
        break;
      case "list":
        summary.addRow({ field: `— ${s.heading} —`, value: "" }).font = { bold: true };
        s.items.forEach((item, i) => kv(String(i + 1), item));
        break;
      case "note":
        summary.addRow({ field: `— ${s.heading} —`, value: "" }).font = { bold: true };
        kv("", s.text);
        break;
    }
  }

  if (doc.audit.length) {
    summary.addRow({ field: "— Audit Trail —", value: "" }).font = { bold: true };
    for (const a of doc.audit) kv(a.label, a.value, true);
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
