import type { DocSection, ReportDoc } from "./report-doc";

// Dependency-free vector PDF renderer for a ReportDoc: a compact, professional
// 1–2 page layout — masthead, section headings, key/value blocks, tables, and
// real vector charts (bars, pies, gauge, radar), with a two-column primitive so
// related figures sit side by side.
//
// Text is Latin-1/WinAnsi — base Helvetica has no Arabic glyphs; common Unicode
// punctuation is folded to ASCII first. Arabic RTL (RIO-NFR-007) is a later step
// (embedded font + shaping); this renderer is swapped then.

const PAGE_W = 612;
const PAGE_H = 792;
const LEFT = 46;
const RIGHT = 46;
const TOP = 50;
const BOTTOM = 42;
const CONTENT_W = PAGE_W - LEFT - RIGHT;

// Palette (r g b, 0–1) — a single accent + neutral grays.
const ACCENT = "0.12 0.35 0.60";
const GRAY = "0.45 0.45 0.45";
const LIGHT = "0.90 0.93 0.97";
const BAR = "0.20 0.50 0.75";
const BLACK = "0 0 0";
const PIE_COLORS = ["0.16 0.47 0.84", "0.92 0.41 0.20", "0.10 0.69 0.48", "0.93 0.63 0.00", "0.91 0.48 0.64"];

function normalizeAscii(s: string): string {
  return s
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/…/g, "...")
    .replace(/[•·]/g, "-")
    .replace(/×/g, "x")
    .replace(/[   ]/g, " ");
}
function esc(raw: string): string {
  const latin1 = Buffer.from(normalizeAscii(raw), "utf-8").toString("latin1").replace(/[^\x20-\x7e]/g, "?");
  return latin1.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function fits(str: string, size: number, width: number): boolean {
  return str.length * size * 0.52 <= width;
}
function truncate(str: string, size: number, width: number): string {
  if (fits(str, size, width)) return str;
  let s = str;
  while (s.length > 1 && !fits(s + "..", size, width)) s = s.slice(0, -1);
  return s + "..";
}
function textWidth(str: string, size: number): number {
  return str.length * size * 0.52;
}
function wrap(str: string, size: number, width: number): string[] {
  const words = str.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (fits(next, size, width)) cur = next;
    else {
      if (cur) lines.push(cur);
      cur = fits(w, size, width) ? w : truncate(w, size, width);
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}
function isNumericColumn(rows: string[][], i: number): boolean {
  const vals = rows.map((r) => r[i] ?? "").filter((v) => v !== "" && v !== "-" && v !== "—");
  return vals.length > 0 && vals.every((v) => /^-?\d[\d,.\s%]*$/.test(v.trim()));
}

class Pdf {
  private pages: string[][] = [];
  private ops: string[] = [];
  y = TOP;
  // Current layout region (a column narrows this temporarily).
  rx = LEFT;
  rw = CONTENT_W;

  constructor() {
    this.pages.push(this.ops);
  }
  private addPage(): void {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = TOP;
  }
  ensure(space: number): void {
    if (this.y + space > PAGE_H - BOTTOM) this.addPage();
  }
  private py(fromTop: number): number {
    return PAGE_H - fromTop;
  }
  text(x: number, size: number, bold: boolean, str: string, color = BLACK): void {
    // `y` is the TOP of the text line — put the baseline ~0.76em below it so
    // text and rects/rules share one top-down origin (otherwise divider rules
    // strike through the following row's glyphs).
    const baseline = this.y + size * 0.76;
    this.ops.push(`${color} rg BT /${bold ? "F1" : "F2"} ${size} Tf 1 0 0 1 ${x} ${this.py(baseline)} Tm (${esc(str)}) Tj ET`);
  }
  rect(x: number, w: number, h: number, color: string): void {
    this.ops.push(`${color} rg ${x} ${this.py(this.y + h)} ${w} ${h} re f`);
  }
  rule(color = ACCENT, thickness = 1.2): void {
    this.rect(this.rx, this.rw, thickness, color);
    this.y += thickness;
  }
  // Render a callback within a narrowed region, returning the ending y.
  column(x: number, w: number, startY: number, fn: () => void): number {
    const ox = this.rx;
    const ow = this.rw;
    this.rx = x;
    this.rw = w;
    this.y = startY;
    fn();
    const end = this.y;
    this.rx = ox;
    this.rw = ow;
    return end;
  }
  pie(xLeft: number, r: number, slices: number[], colors: string[] = PIE_COLORS): void {
    const cx = xLeft + r;
    const cyCenter = this.y + r;
    const total = slices.reduce((s, v) => s + v, 0) || 1;
    let a0 = -Math.PI / 2;
    slices.forEach((v, i) => {
      const a1 = a0 + (v / total) * 2 * Math.PI;
      const steps = Math.max(2, Math.ceil(((a1 - a0) / Math.PI) * 24));
      const pts = [`${cx.toFixed(2)} ${this.py(cyCenter).toFixed(2)} m`];
      for (let s = 0; s <= steps; s++) {
        const a = a0 + ((a1 - a0) * s) / steps;
        pts.push(`${(cx + r * Math.cos(a)).toFixed(2)} ${this.py(cyCenter + r * Math.sin(a)).toFixed(2)} l`);
      }
      this.ops.push(`${colors[i % colors.length]} rg ${pts.join(" ")} h f`);
      a0 = a1;
    });
  }
  disc(cxAbs: number, cyFromTop: number, r: number, color: string): void {
    const steps = 48;
    const pts = [`${(cxAbs + r).toFixed(2)} ${this.py(cyFromTop).toFixed(2)} m`];
    for (let s = 1; s <= steps; s++) {
      const a = (s / steps) * 2 * Math.PI;
      pts.push(`${(cxAbs + r * Math.cos(a)).toFixed(2)} ${this.py(cyFromTop + r * Math.sin(a)).toFixed(2)} l`);
    }
    this.ops.push(`${color} rg ${pts.join(" ")} h f`);
  }
  strokePath(points: Array<[number, number]>, color: string, width: number, close = false): void {
    if (points.length === 0) return;
    const [x0, y0] = points[0]!;
    const parts = [`${color} RG ${width} w ${x0.toFixed(2)} ${this.py(y0).toFixed(2)} m`];
    for (let i = 1; i < points.length; i++) {
      const [x, y] = points[i]!;
      parts.push(`${x.toFixed(2)} ${this.py(y).toFixed(2)} l`);
    }
    if (close) parts.push("h");
    parts.push("S");
    this.ops.push(parts.join(" "));
  }
  swatch(x: number, colorIndex: number): void {
    this.rect(x, 7, 7, PIE_COLORS[colorIndex % PIE_COLORS.length]!);
  }

  build(): Buffer {
    return assemble(this.pages.map((ops) => ops.join("\n")));
  }
}

function renderHeader(pdf: Pdf, doc: ReportDoc): void {
  pdf.text(LEFT, 16, true, truncate(doc.title, 16, CONTENT_W), ACCENT);
  pdf.y += 21;
  pdf.rule(ACCENT, 1.4);
  pdf.y += 6;
  if (doc.headerBand.length) {
    // Single full-width row per field, wrapped rather than truncated — a
    // fixed two-column grid left long values (e.g. a Methodology Version
    // sentence) truncated mid-word since each value only got ~154pt.
    const labelW = 106;
    const valW = CONTENT_W - labelW - 10;
    const size = 8;
    const linesPerRow = doc.headerBand.map((m) => wrap(m.value, size, valW));
    const bandH = linesPerRow.reduce((h, lines) => h + Math.max(1, lines.length) * 11, 0) + 6;
    pdf.rect(LEFT, CONTENT_W, bandH, LIGHT);
    let rowY = pdf.y + 5;
    doc.headerBand.forEach((m, i) => {
      const x = LEFT + 5;
      pdf.y = rowY;
      pdf.text(x, size, true, `${m.label}:`);
      const lines = linesPerRow[i]!;
      lines.forEach((ln, li) => {
        pdf.y = rowY + li * 11;
        pdf.text(x + labelW, size, false, ln);
      });
      rowY += Math.max(1, lines.length) * 11;
    });
    pdf.y = rowY + 4;
  }
}

function heading(pdf: Pdf, text: string): void {
  pdf.ensure(22);
  pdf.y += 4;
  pdf.text(pdf.rx, 10.5, true, truncate(text, 10.5, pdf.rw), ACCENT);
  pdf.y += 13;
  pdf.rule(GRAY, 0.5);
  pdf.y += 5;
}

function renderKeyValue(pdf: Pdf, rows: Array<{ label: string; value: string }>): void {
  const valX = pdf.rx + Math.min(150, pdf.rw * 0.42);
  const valW = pdf.rx + pdf.rw - valX;
  for (const { label, value } of rows) {
    const lines = wrap(value, 8.5, valW);
    pdf.ensure(lines.length * 11 + 2);
    pdf.text(pdf.rx + 1, 8.5, true, truncate(label, 8.5, valX - pdf.rx - 6));
    lines.forEach((ln, i) => {
      if (i > 0) pdf.y += 11;
      pdf.text(valX, 8.5, false, ln);
    });
    pdf.y += 12.5;
  }
}

function renderTable(pdf: Pdf, columns: string[], rows: string[][]): void {
  const n = columns.length || 1;
  const size = n > 6 ? 7 : n > 4 ? 7.5 : 8.5;
  const rowH = size + 5;
  // Guarantee every column at least enough room for its own header text first
  // — a purely character-count-proportional split (the old approach) let one
  // long-text column (e.g. "KPI") starve the others below even their own
  // header's width, truncating "Severity"/"Confidence"/"Responses" headers
  // themselves. Only after every header fits do we hand out the remaining
  // space, proportional to how much each column's content actually overflows
  // its header width (so the long-text column still gets most of it).
  const headerMin = columns.map((c) => textWidth(c, size) + 10);
  const headerMinSum = headerMin.reduce((a, b) => a + b, 0) || 1;
  const chars = columns.map((c, i) => Math.max(c.length, ...rows.map((r) => (r[i] ?? "").length), 3));
  let widths: number[];
  if (headerMinSum <= pdf.rw) {
    const extra = pdf.rw - headerMinSum;
    const overflow = chars.map((ch, i) => Math.max(0, ch * size * 0.52 - headerMin[i]!));
    const totalOverflow = overflow.reduce((a, b) => a + b, 0);
    widths = headerMin.map((hw, i) => hw + (totalOverflow > 0 ? (overflow[i]! / totalOverflow) * extra : extra / n));
  } else {
    // Not even every header fits — best effort, proportional to header width.
    widths = headerMin.map((hw) => Math.max(26, (hw / headerMinSum) * pdf.rw));
  }
  const sum = widths.reduce((a, b) => a + b, 0);
  if (sum > pdf.rw) widths = widths.map((w) => (w / sum) * pdf.rw);
  const xs: number[] = [];
  let cursor = pdf.rx;
  for (const w of widths) {
    xs.push(cursor);
    cursor += w;
  }
  const numeric = columns.map((_, i) => isNumericColumn(rows, i));
  // Data cells wrap onto up to 2 lines instead of truncating with "..": a
  // value like "Core Methodology Domain" needs to actually be readable, not
  // just hinted at — single-line truncation was cutting real column values
  // (Domain, KPI text) off entirely even once headers themselves fit.
  const MAX_LINES = 2;
  const drawRow = (cells: string[], bold: boolean, wrapCells: boolean) => {
    const cellLines = cells.map((c, i) => {
      const w = widths[i] ?? 40;
      if (!wrapCells) return [truncate(c, size, w - 6)];
      const lines = wrap(c, size, w - 6);
      if (lines.length <= MAX_LINES) return lines;
      return [...lines.slice(0, MAX_LINES - 1), truncate(lines.slice(MAX_LINES - 1).join(" "), size, w - 6)];
    });
    const lineCount = Math.max(1, ...cellLines.map((l) => l.length));
    const h = size + 5 + (lineCount - 1) * (size + 1);
    pdf.ensure(h + 2);
    const top = pdf.y;
    cellLines.forEach((lines, i) => {
      const w = widths[i] ?? 40;
      const cx = xs[i] ?? pdf.rx;
      lines.forEach((ln, li) => {
        pdf.y = top + li * (size + 1);
        pdf.text(numeric[i] ? cx + w - 4 - textWidth(ln, size) : cx + 3, size, bold, ln);
      });
    });
    pdf.y = top + h;
  };
  pdf.rect(pdf.rx, pdf.rw, rowH, LIGHT);
  drawRow(columns, true, false);
  pdf.rule(GRAY, 0.5);
  pdf.y += 2;
  for (const row of rows) drawRow(row, false, true);
}

function renderBars(pdf: Pdf, max: number, bars: Array<{ label: string; value: number }>): void {
  const labelW = Math.min(140, pdf.rw * 0.4);
  const trackX = pdf.rx + labelW;
  const trackW = pdf.rw - labelW - 34;
  for (const { label, value } of bars) {
    pdf.ensure(15);
    const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
    pdf.text(pdf.rx + 2, 8.5, false, truncate(label, 8.5, labelW - 6));
    pdf.rect(trackX, trackW, 8, LIGHT);
    if (frac > 0) pdf.rect(trackX, Math.max(1, trackW * frac), 8, BAR);
    pdf.text(trackX + trackW + 5, 8.5, true, String(value));
    pdf.y += 14;
  }
}

function renderPie(pdf: Pdf, slices: Array<{ label: string; value: number }>): void {
  const r = 30;
  const total = slices.reduce((s, d) => s + d.value, 0) || 1;
  pdf.ensure(2 * r + 8);
  const top = pdf.y;
  pdf.pie(pdf.rx, r, slices.map((s) => s.value));
  const legX = pdf.rx + 2 * r + 16;
  pdf.y = top + 4;
  slices.forEach((d, i) => {
    const pct = Math.round((d.value / total) * 100);
    pdf.swatch(legX, i);
    pdf.text(legX + 12, 8.5, false, truncate(`${d.label}: ${d.value} (${pct}%)`, 8.5, pdf.rx + pdf.rw - legX - 14));
    pdf.y += 14;
  });
  pdf.y = top + 2 * r + 6;
}

function renderGauge(pdf: Pdf, value: number, max: number, sub?: string): void {
  const r = 30;
  pdf.ensure(2 * r + 6);
  const top = pdf.y;
  const cx = pdf.rx + r;
  const cyc = top + r;
  const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  pdf.pie(pdf.rx, r, frac >= 1 ? [1] : [frac, 1 - frac], [BAR, LIGHT]);
  pdf.disc(cx, cyc, r * 0.62, "1 1 1");
  const valStr = String(value);
  pdf.y = cyc - 11;
  pdf.text(cx - textWidth(valStr, 14) / 2, 14, true, valStr);
  if (sub) {
    pdf.y = cyc + 3;
    pdf.text(cx - textWidth(sub, 7.5) / 2, 7.5, false, sub, GRAY);
  }
  pdf.y = top + 2 * r + 5;
}

function renderRadar(pdf: Pdf, axes: string[], max: number, series: Array<{ name: string; values: number[] }>): void {
  const size = Math.min(150, pdf.rw);
  const r = size / 2 - 26;
  pdf.ensure(size + (series.length > 1 ? 16 : 2));
  const top = pdf.y;
  const cx = pdf.rx + pdf.rw / 2;
  const cyc = top + size / 2;
  const n = axes.length || 1;
  const ang = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const at = (i: number, frac: number): [number, number] => [cx + r * frac * Math.cos(ang(i)), cyc + r * frac * Math.sin(ang(i))];
  const GRID = "0.80 0.80 0.80";
  for (const f of [0.33, 0.66, 1]) pdf.strokePath(axes.map((_, i) => at(i, f)), GRID, 0.5, true);
  axes.forEach((a, i) => {
    pdf.strokePath([[cx, cyc], at(i, 1)], GRID, 0.5);
    const lx = cx + (r + 12) * Math.cos(ang(i));
    const ly = cyc + (r + 12) * Math.sin(ang(i));
    const cos = Math.cos(ang(i));
    const shown = truncate(a, 6.5, 70);
    const tx = Math.abs(cos) < 0.3 ? lx - textWidth(shown, 6.5) / 2 : cos > 0 ? lx : lx - textWidth(shown, 6.5);
    pdf.y = ly + 2.5;
    pdf.text(tx, 6.5, false, shown, GRAY);
  });
  series.forEach((s, si) => {
    pdf.strokePath(s.values.map((v, i) => at(i, max > 0 ? Math.max(0, Math.min(1, v / max)) : 0)), PIE_COLORS[si % PIE_COLORS.length]!, 1.5, true);
  });
  pdf.y = top + size + 2;
  if (series.length > 1) {
    let lx = pdf.rx;
    series.forEach((s, si) => {
      pdf.swatch(lx, si);
      pdf.text(lx + 11, 8, false, s.name);
      lx += 11 + textWidth(s.name, 8) + 16;
    });
    pdf.y += 13;
  }
}

function renderList(pdf: Pdf, items: string[]): void {
  const textW = pdf.rw - 12;
  for (const item of items) {
    const lines = wrap(item, 8.5, textW);
    pdf.ensure(lines.length * 11 + 1);
    lines.forEach((ln, i) => {
      pdf.text(pdf.rx + 2, 8.5, false, i === 0 ? `- ${ln}` : `  ${ln}`);
      pdf.y += 11;
    });
    pdf.y += 2;
  }
}

function renderNote(pdf: Pdf, text: string): void {
  for (const ln of wrap(text, 8.5, pdf.rw - 4)) {
    pdf.ensure(12);
    pdf.text(pdf.rx + 2, 8.5, false, ln, GRAY);
    pdf.y += 11;
  }
  pdf.y += 2;
}

function renderColumns(pdf: Pdf, children: DocSection[], gap = 14): void {
  pdf.ensure(158);
  const startY = pdf.y;
  const n = children.length || 1;
  const colW = (pdf.rw - gap * (n - 1)) / n;
  let maxEnd = startY;
  children.forEach((child, i) => {
    const x = pdf.rx + i * (colW + gap);
    const end = pdf.column(x, colW, startY, () => renderSection(pdf, child));
    maxEnd = Math.max(maxEnd, end);
  });
  pdf.y = maxEnd;
}

function renderSection(pdf: Pdf, s: DocSection): void {
  if (s.kind === "columns") return renderColumns(pdf, s.children);
  heading(pdf, s.heading);
  switch (s.kind) {
    case "keyvalue": return renderKeyValue(pdf, s.rows);
    case "table": return renderTable(pdf, s.columns, s.rows);
    case "bars": return renderBars(pdf, s.max, s.bars);
    case "pie": return renderPie(pdf, s.slices);
    case "gauge": return renderGauge(pdf, s.value, s.max, s.sub);
    case "radar": return renderRadar(pdf, s.axes, s.max, s.series);
    case "list": return renderList(pdf, s.items);
    case "note": return renderNote(pdf, s.text);
  }
}

export function renderReportPdf(doc: ReportDoc): Buffer {
  const pdf = new Pdf();
  renderHeader(pdf, doc);
  for (const section of doc.sections) {
    renderSection(pdf, section);
    pdf.y += 6;
  }
  if (doc.audit.length) renderSection(pdf, { kind: "keyvalue", heading: "Audit Trail", rows: doc.audit });
  return pdf.build();
}

function assemble(pageStreams: string[]): Buffer {
  const pageCount = pageStreams.length || 1;
  if (pageStreams.length === 0) pageStreams.push("");
  const pageObjNums = pageStreams.map((_, i) => 3 + i);
  const fontBold = 3 + pageCount;
  const fontReg = fontBold + 1;
  const firstContent = fontReg + 1;

  const objects: string[] = [];
  objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);
  objects.push(`<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageCount} >>`);
  pageStreams.forEach((_, i) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ${fontBold} 0 R /F2 ${fontReg} 0 R >> >> /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${firstContent + i} 0 R >>`,
    );
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (const stream of pageStreams) {
    objects.push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
  }

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${o.toString().padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}