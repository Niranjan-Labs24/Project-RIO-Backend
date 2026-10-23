// Core Needs Report (RPT18) — Excel. The same view model as the PDF and the
// in-app report, laid out as rows (client confirmation 1e: "same information,
// rows rather than cards"). One sheet per part of the report; Arabic sheets
// read right to left.

import ExcelJS from "exceljs";
import type { Cell, CoreView } from "./core-needs-view";

const TEAL = "FF155463";
const TINT = "FFE4EFED";

function sheet(wb: ExcelJS.Workbook, name: string, v: CoreView): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(name.slice(0, 31).replace(/[\\/?*[\]:]/g, " "));
  if (v.dir === "rtl") ws.views = [{ rightToLeft: true }];
  ws.properties.defaultColWidth = 22;
  return ws;
}

function title(ws: ExcelJS.Worksheet, text: string, size = 14): void {
  const row = ws.addRow([text]);
  row.font = { bold: true, size, color: { argb: TEAL } };
}

function note(ws: ExcelJS.Worksheet, text: string): void {
  const row = ws.addRow([text]);
  row.font = { italic: true, size: 9, color: { argb: "FF6B7280" } };
}

function kv(ws: ExcelJS.Worksheet, rows: Array<{ label: string; value: string }>): void {
  for (const r of rows) {
    const row = ws.addRow([r.label, r.value]);
    row.getCell(1).font = { bold: true };
  }
}

function table(ws: ExcelJS.Worksheet, columns: string[], rows: Cell[][]): void {
  const head = ws.addRow(columns);
  head.eachCell((c) => {
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TEAL } };
  });
  for (const r of rows) {
    const row = ws.addRow(r.map((c) => (c.sub ? `${c.text}\n${c.sub}` : c.text)));
    row.alignment = { wrapText: true, vertical: "top" };
    r.forEach((c, i) => {
      if (c.bold) row.getCell(i + 1).font = { bold: true };
    });
  }
}

function blank(ws: ExcelJS.Worksheet): void {
  ws.addRow([]);
}

export async function renderCoreNeedsExcel(v: CoreView): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();

  // ── Summary (also the Executive Summary) ──
  const s = sheet(wb, v.header.kicker, v);
  s.getColumn(1).width = 34;
  s.getColumn(2).width = 90;
  title(s, `${v.header.title} — ${v.header.study}`, 16);
  kv(s, [
    { label: v.header.organization, value: v.header.platformOwner },
    ...v.header.chips.map((c) => ({ label: "", value: c })),
  ]);
  blank(s);
  title(s, v.profile.title, 12);
  note(s, v.profile.source);
  kv(s, v.profile.tiles);
  if (v.profile.inStudy) note(s, v.profile.inStudy);
  blank(s);
  if (v.usage.show) kv(s, [{ label: v.usage.label, value: `${v.running.usage} — ${v.usage.text}` }]);
  blank(s);
  title(s, v.decision.title, 12);
  if (v.decision.issuedAlone) note(s, v.decision.issuedAlone);
  kv(s, [
    { label: v.decision.find.q, value: v.decision.find.text },
    { label: v.decision.confident.q, value: v.decision.confident.text },
    { label: v.decision.decide.q, value: v.decision.decide.text },
  ]);
  blank(s);
  title(s, v.confidence.title, 12);
  note(s, v.confidence.rule);
  kv(s, v.confidence.rows.map((r) => ({ label: r.label, value: `${r.value} · ${r.bandLabel}` })));
  blank(s);
  note(s, v.approval);
  s.eachRow((row) => (row.alignment = { wrapText: true, vertical: "top" }));

  if (v.output === "FULL") {
    // ── Where and what to intervene ──
    const w = sheet(wb, v.where.title, v);
    title(w, v.where.title);
    note(w, v.where.lead);
    if (v.where.units) {
      blank(w);
      title(w, v.where.units.title, 12);
      table(w, v.where.units.columns, v.where.units.rows);
      note(w, v.where.units.note);
      note(w, v.where.units.ranking);
    }
    if (v.where.villages) {
      blank(w);
      title(w, v.where.villages.title, 12);
      if (v.where.villages.rows.length) table(w, v.where.villages.columns, v.where.villages.rows);
      note(w, v.where.villages.note);
    }
    blank(w);
    title(w, v.where.needs.provisional ? `${v.where.needs.title} — ${v.where.needs.provisional}` : v.where.needs.title, 12);
    if (v.where.needs.rows.length) table(w, v.where.needs.columns, v.where.needs.rows);
    else note(w, v.where.needs.empty);
    w.getColumn(2).width = 50;

    // ── Needs for programme design ──
    const d = sheet(wb, v.design.title, v);
    title(d, v.design.title);
    note(d, v.design.lead);
    blank(d);
    title(d, v.design.domains.title, 12);
    table(
      d,
      ["", v.design.hierarchy.columns[2]!, "", v.design.hierarchy.columns[4]!],
      v.design.domains.rows.map((r) => [
        { text: r.flag ? `${r.name} — ${r.flag}` : r.name, bold: true },
        { text: r.value },
        { text: r.weight },
        { text: r.fit },
      ]),
    );
    if (v.design.domains.others) note(d, v.design.domains.others);
    blank(d);
    title(d, v.design.hierarchy.title, 12);
    const hRows: Cell[][] = [];
    for (const g of v.design.hierarchy.groups) {
      hRows.push([{ text: g.title, bold: true }, { text: "" }, { text: g.severity, bold: true }]);
      hRows.push(...g.rows);
    }
    table(d, v.design.hierarchy.columns, hRows);
    d.getRows(d.rowCount - hRows.length + 1, hRows.length)?.forEach((row, i) => {
      if (hRows[i]!.length === 3) row.eachCell((c) => (c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TINT } }));
    });
    note(d, v.design.hierarchy.note);
    blank(d);
    title(d, v.design.reading.title, 12);
    for (const l of v.design.reading.lines) d.addRow([l.lead ? `${l.lead}: ${l.text}` : l.text]);
    if (v.design.links.show) {
      blank(d);
      title(d, `${v.design.links.title} (${v.design.links.tag})`, 12);
      for (const l of v.design.links.lines) d.addRow([l]);
    }
    d.getColumn(1).width = 50;

    // ── Evidence and data quality ──
    const e = sheet(wb, v.evidence.title, v);
    title(e, v.evidence.title);
    note(e, v.evidence.lead);
    blank(e);
    title(e, v.evidence.distribution.title, 12);
    table(e, v.evidence.distribution.columns, v.evidence.distribution.rows);
    note(e, `${v.evidence.distribution.flag ? `${v.evidence.distribution.flag} · ` : ""}${v.evidence.distribution.note}`);
    blank(e);
    title(e, v.evidence.responses.title, 12);
    kv(e, [...v.evidence.responses.rows, ...v.evidence.responses.gender.map((g) => ({ label: g.label, value: String(g.count) }))]);
    note(e, v.evidence.responses.age);
    note(e, v.evidence.responses.note);
    blank(e);
    title(e, v.evidence.fit.title, 12);
    table(e, v.evidence.fit.columns, v.evidence.fit.rows);
    blank(e);
    title(e, v.evidence.next.title, 12);
    v.evidence.next.items.forEach((it, i) => e.addRow([`${i + 1}. ${it}`]));
    if (v.evidence.studies) {
      blank(e);
      title(e, v.evidence.studies.title, 12);
      table(e, v.evidence.studies.columns, v.evidence.studies.rows);
      note(e, v.evidence.studies.rule);
    }
    for (const card of v.evidence.cards) {
      blank(e);
      title(e, `${card.title} — ${card.status}`, 12);
      kv(e, card.fields);
      if (card.footer) note(e, card.footer);
    }
    blank(e);
    kv(e, v.evidence.audit);
    e.getColumn(1).width = 40;
    e.getColumn(2).width = 40;
    e.getColumn(3).width = 40;
  }

  // Arabic: every cell right-aligned and read right to left. Left to the
  // sheet's default, a cell opening with a Latin name ("Reviewer, …") or a
  // number aligned left on an otherwise right-to-left sheet.
  if (v.dir === "rtl")
    wb.eachSheet((ws) =>
      ws.eachRow((row) =>
        row.eachCell((cell) => {
          cell.alignment = { ...cell.alignment, horizontal: "right", readingOrder: "rtl" };
        }),
      ),
    );
  return Buffer.from(await wb.xlsx.writeBuffer());
}
