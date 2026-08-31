import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import type { DocSection, ReportDoc } from "./report-doc";
import { DEFAULT_APP_LOCALE } from "../../i18n/locale";
import { translator, type Translator } from "../../i18n/translate";

const ACCENT = "FF1F5A99";
const LIGHT = "FFE6EEF7";
const LINK_BLUE = "FF1155CC";

/**
 * Sheet name for a drill target.
 *
 * Derived from the anchor id, not from workbook order, so the name is stable
 * across regenerations and can be resolved in a pre-pass — which is what lets a
 * hyperlink point FORWARD at a sheet that has not been created yet. Excel caps
 * names at 31 characters and rejects the six characters stripped below, so the
 * readable part is trimmed and a short hash of the full id keeps it unique.
 */
function drillSheetName(anchorId: string, heading?: string): string {
  const hash = createHash("sha1").update(anchorId).digest("hex").slice(0, 4);
  const base = (heading || anchorId).replace(/[[\]*/\\?:]/g, " ").trim();
  return `${base.slice(0, 26)} ${hash}`.trim().slice(0, 31);
}

/** Excel's own in-workbook jump. Quoting matters: a sheet name containing a
 *  space breaks the reference without the single quotes. */
function sheetLink(sheetName: string, label: string): ExcelJS.CellValue {
  return {
    formula: `HYPERLINK("#'${sheetName.replace(/'/g, "''")}'!A1","${label.replace(/"/g, '""')}")`,
  } as ExcelJS.CellValue;
}

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

function addTableSheet(
  wb: ExcelJS.Workbook,
  t: Translator,
  heading: string,
  columns: string[],
  rows: string[][],
  // Anchor id per row, already resolved to sheet names. A row whose target has
  // no sheet gets no link rather than a broken reference.
  rowLinkSheets?: Array<string | null>,
): void {
  const hasLinks = rowLinkSheets?.some((t) => t !== null) === true;
  const sheet = wb.addWorksheet(uniqueSheetName(wb, heading));
  sheet.columns = [
    ...columns.map((c) => ({ header: c, key: c, width: Math.max(16, Math.min(40, c.length + 6)) })),
    // The drill column is what carries the PDF's clickable row into the
    // workbook. Without it the spreadsheet silently loses the interaction and
    // the two exports stop being the same report.
    ...(hasLinks ? [{ header: t("label.detail"), key: "__drill", width: 14 }] : []),
  ];
  styleHeaderRow(sheet.getRow(1));
  rows.forEach((r, i) => {
    // Column width is sized off the header, not the data — a long cell
    // value (a domain name, a KPI label, ...) with no wrap would otherwise
    // render past its own column into whatever's next, rather than
    // wrapping inside the cell it actually belongs to.
    const row = sheet.addRow(r);
    row.eachCell((cell) => (cell.alignment = { wrapText: true, vertical: "top" }));
    const target = rowLinkSheets?.[i] ?? null;
    if (hasLinks && target) {
      const cell = row.getCell(columns.length + 1);
      cell.value = sheetLink(target, t("label.viewDetail"));
      cell.font = { color: { argb: LINK_BLUE }, underline: true };
    }
  });
}

function addBarsSheet(wb: ExcelJS.Workbook, t: Translator, s: Extract<DocSection, { kind: "bars" }>): void {
  const sheet = wb.addWorksheet(uniqueSheetName(wb, s.heading));
  sheet.columns = [
    { header: t("label.item"), key: "label", width: 34 },
    { header: t("label.value"), key: "value", width: 16 },
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

  const t = translator(doc.locale ?? DEFAULT_APP_LOCALE);
  // Held in a variable rather than repeated as a literal: the back-links below
  // reference this sheet BY NAME, so a translated name and a hardcoded
  // "Summary" would produce a workbook whose every "back" link is broken.
  const summaryName = t("sheet.summary");

  const summary = wb.addWorksheet(summaryName);
  summary.columns = [
    { header: t("label.field"), key: "field", width: 34 },
    { header: t("label.value"), key: "value", width: 70 },
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

  // ── Drill-down pre-pass ──
  //
  // Resolve every anchor id to the sheet it will live on BEFORE rendering, so a
  // hyperlink can point forward at a sheet that does not exist yet. Forward
  // references are the normal case: the index is written before the detail.
  const anchorSheets = new Map<string, string>();
  {
    let current = "Summary";
    for (const s of flat) {
      if (s.kind === "pageBreak") {
        current = drillSheetName(s.anchorId, s.heading);
        anchorSheets.set(s.anchorId, current);
      } else if (s.kind === "anchor") {
        anchorSheets.set(s.id, current);
      }
    }
  }
  const sheetFor = (anchorId: string | null | undefined): string | null =>
    anchorId ? (anchorSheets.get(anchorId) ?? null) : null;

  // Sections after a pageBreak belong to that detail sheet, not to Summary —
  // otherwise every drill target's prose collapses back onto one page and the
  // "detail" a link jumps to is empty.
  let detail: ExcelJS.Worksheet | null = null;
  const textSheet = () => detail ?? summary;
  const addText = (label: string, value: string, shaded = false) => {
    if (!detail) return kv(label, value, shaded);
    const row = detail.addRow([label, value]);
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
    return undefined;
  };

  for (const s of flat) {
    switch (s.kind) {
      case "anchor":
        // Position marker only — the pre-pass already recorded its sheet.
        break;
      case "pageBreak": {
        // One worksheet per drill target — the workbook equivalent of the
        // PDF's materialised page.
        const name = anchorSheets.get(s.anchorId) ?? drillSheetName(s.anchorId, s.heading);
        detail = wb.getWorksheet(name) ?? wb.addWorksheet(name);
        detail.columns = [
          { header: t("label.field"), key: "field", width: 34 },
          { header: t("label.value"), key: "value", width: 70 },
        ];
        styleHeaderRow(detail.getRow(1));
        if (s.heading) detail.addRow([`— ${s.heading} —`, ""]).font = { bold: true };
        // Every detail sheet gets a way back, or the reader is stranded on it.
        const back = detail.addRow(["", ""]);
        back.getCell(1).value = sheetLink(summaryName, t("label.backToSummary"));
        back.getCell(1).font = { color: { argb: LINK_BLUE }, underline: true };
        break;
      }
      case "breadcrumb": {
        const sheet = textSheet();
        const row = sheet.addRow(["", ""]);
        const cell = row.getCell(1);
        const first = s.trail.find((c) => c.to && sheetFor(c.to));
        // A breadcrumb is a navigation control; with no resolvable target it is
        // just decoration, so render it as plain text rather than a dead link.
        if (first) {
          cell.value = sheetLink(sheetFor(first.to)!, s.trail.map((c) => c.label).join(" / "));
          cell.font = { color: { argb: LINK_BLUE }, underline: true };
        } else {
          cell.value = s.trail.map((c) => c.label).join(" / ");
        }
        break;
      }
      case "navGrid": {
        // The index grid becomes a sheet of hyperlinks — the same set of jumps
        // the PDF's tiles offer.
        const sheet = wb.addWorksheet(uniqueSheetName(wb, s.heading));
        sheet.columns = [
          { header: t("label.item"), key: "label", width: 40 },
          { header: t("label.summary"), key: "sub", width: 46 },
          { header: t("label.detail"), key: "link", width: 18 },
        ];
        styleHeaderRow(sheet.getRow(1));
        for (const tile of s.tiles) {
          const row = sheet.addRow([tile.label, tile.sub, ""]);
          const target = sheetFor(tile.to);
          if (target) {
            const cell = row.getCell(3);
            cell.value = sheetLink(target, t("label.viewDetail"));
            cell.font = { color: { argb: LINK_BLUE }, underline: true };
          }
        }
        break;
      }
      case "table":
        addTableSheet(
          wb,
          t,
          s.heading,
          s.columns,
          s.rows,
          // Named `anchor`, not `t` — `t` is the translator in this scope now,
          // and shadowing it here would be a trap for the next edit.
          s.rowLinks?.map((anchor) => sheetFor(anchor)),
        );
        break;
      case "bars":
        addBarsSheet(wb, t, s);
        break;
      case "pie": {
        const total = s.slices.reduce((a, b) => a + b.value, 0) || 1;
        addBarsSheet(wb, t, {
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
        textSheet().addRow([`— ${s.heading} —`, ""]).font = { bold: true };
        for (const r of s.rows) addText(r.label, r.value);
        break;
      case "list":
        textSheet().addRow([`— ${s.heading} —`, ""]).font = { bold: true };
        s.items.forEach((item, i) => addText(String(i + 1), item));
        break;
      case "note":
        textSheet().addRow([`— ${s.heading} —`, ""]).font = { bold: true };
        addText("", s.text);
        break;
      // Count tiles are label/value pairs — they belong on the Summary sheet
      // next to the rest of the report's identity, not on a chart sheet of
      // their own (the figures are unrelated to each other by design).
      case "stats":
        summary.addRow({ field: `— ${s.heading} —`, value: "" }).font = { bold: true };
        for (const t of s.tiles) kv(t.label, t.sub ? `${t.value} (${t.sub})` : t.value, true);
        break;
      // One row per group, one column per series, plus the delta — the same
      // comparison the PDF draws as paired bars, in the form a spreadsheet
      // user can actually sort and filter.
      case "groupedBars": {
        const sheet = wb.addWorksheet(uniqueSheetName(wb, s.heading));
        sheet.columns = [
          { header: "Metric", key: "group", width: 30 },
          ...s.series.map((se, i) => ({ header: se.name, key: `s${i}`, width: 18 })),
          ...(s.series.length === 2 ? [{ header: "Difference", key: "delta", width: 14 }] : []),
        ];
        styleHeaderRow(sheet.getRow(1));
        s.groups.forEach((g, gi) => {
          const row: Record<string, string | number> = { group: g };
          s.series.forEach((se, si) => (row[`s${si}`] = se.values[gi] ?? 0));
          if (s.series.length === 2) {
            row.delta = (s.series[0]!.values[gi] ?? 0) - (s.series[1]!.values[gi] ?? 0);
          }
          sheet.addRow(row);
        });
        break;
      }
    }
  }

  if (doc.audit.length) {
    summary.addRow({ field: "— Audit Trail —", value: "" }).font = { bold: true };
    for (const a of doc.audit) kv(a.label, a.value, true);
  }

  // Sheet direction, applied to EVERY worksheet in one pass at the end rather
  // than at each `addWorksheet` call. There are eight creation sites and more
  // will be added; setting it here means a new sheet cannot be born
  // left-to-right inside an Arabic workbook by omission.
  //
  // `rightToLeft` flips column order and cell alignment. It does NOT reverse
  // the characters inside a cell — Excel does its own bidi on cell text, which
  // is why Arabic works here and does not in the PDF renderer.
  if (doc.rtl) {
    for (const ws of wb.worksheets) {
      ws.views = ws.views?.length
        ? ws.views.map((v) => ({ ...v, rightToLeft: true }))
        : [{ rightToLeft: true }];
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
