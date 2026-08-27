import type { DocSection, DocTile, ReportDoc } from "./report-doc";

// Dependency-free vector PDF renderer for a ReportDoc: a compact, professional
// 1–2 page layout — masthead, section headings, key/value blocks, tables, and
// real vector charts (bars, pies, gauge, radar), with a two-column primitive so
// related figures sit side by side.
//
// Text is Latin-1/WinAnsi — base Helvetica has no Arabic glyphs; common Unicode
// punctuation is folded to ASCII first. Arabic RTL (RIO-NFR-007) is a later step
// (embedded font + shaping); this renderer is swapped then.

export const PAGE_W = 612;
export const PAGE_H = 792;
export const LEFT = 46;
export const RIGHT = 46;
export const TOP = 50;
export const BOTTOM = 42;
export const CONTENT_W = PAGE_W - LEFT - RIGHT;

// Palette (r g b, 0–1) — a single accent + neutral grays.
export const ACCENT = "0.12 0.35 0.60";
export const GRAY = "0.45 0.45 0.45";
export const LIGHT = "0.90 0.93 0.97";
export const BAR = "0.20 0.50 0.75";
export const BLACK = "0 0 0";
export const WHITE = "1 1 1";
export const PIE_COLORS = ["0.16 0.47 0.84", "0.92 0.41 0.20", "0.10 0.69 0.48", "0.93 0.63 0.00", "0.91 0.48 0.64"];

function normalizeAscii(s: string): string {
  return s
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/…/g, "...")
    .replace(/[•·]/g, "-")
    .replace(/×/g, "x")
    // Base Helvetica is WinAnsi — anything outside it becomes "?", which is how
    // "Domain → Sub-domain → Indicator" printed as "Domain ??? Sub-domain".
    // Fold the symbols our own copy actually uses to ASCII equivalents.
    .replace(/[→⇒]/g, "->")
    .replace(/[←⇐]/g, "<-")
    .replace(/≥/g, ">=")
    .replace(/≤/g, "<=")
    .replace(/≠/g, "!=")
    .replace(/[Σ∑]/g, "Sum")
    // "+/-8.4 pts" printed as "??8.4 pts": the plus-minus sign survived this
    // fold, then the UTF-8 -> Latin-1 round-trip below turned its two bytes
    // into two question marks. Every symbol these reports actually use is
    // folded here, and esc() no longer multiplies one stray character into a
    // run of question marks.
    .replace(/±/g, "+/-")
    .replace(/≈/g, "~")
    .replace(/√/g, "sqrt")
    .replace(/°/g, " deg")
    .replace(/[⚑✓✗]/g, "")
    .replace(/[   ]/g, " ");
}
function esc(raw: string): string {
  // Per CODE POINT, not per byte. Base Helvetica is WinAnsi and this renderer
  // restricts itself to ASCII, so anything left after the folds above costs
  // exactly one "?" - never a run of them that reads like part of the value.
  let out = "";
  for (const ch of normalizeAscii(raw)) {
    const code = ch.codePointAt(0) ?? 0;
    out += code >= 0x20 && code <= 0x7e ? ch : "?";
  }
  return out.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

// ── Text metrics ────────────────────────────────────────────────────────────
//
// Real Helvetica advance widths (1/1000 em, from the base-14 AFMs), for
// printable ASCII 32-126. A flat "0.52 em per character" average used to stand
// in for these, and it is wrong in exactly the direction that breaks a layout:
// capitals are 0.61-0.94 em, so an all-caps cell ("DOMAIN_NOT_ASSESSED") was
// measured ~25% narrower than it draws and spilled over the next column.
// Everything that reserves space for text - column widths, truncation, wrapping,
// right-alignment - goes through these, so measuring right fixes all of them.
const HELV_W: readonly number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELV_BOLD_W: readonly number[] = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

export function textWidth(str: string, size: number, bold = false): number {
  const table = bold ? HELV_BOLD_W : HELV_W;
  let units = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    // Anything off the table is drawn as "?" by esc(), so measure it as one.
    units += (code >= 32 && code <= 126 ? table[code - 32] : table[31]) ?? 556;
  }
  return (units * size) / 1000;
}
function fits(str: string, size: number, width: number, bold = false): boolean {
  return textWidth(str, size, bold) <= width;
}
export function truncate(str: string, size: number, width: number, bold = false): string {
  if (fits(str, size, width, bold)) return str;
  let s = str;
  while (s.length > 1 && !fits(s + "..", size, width, bold)) s = s.slice(0, -1);
  return s + "..";
}
export function wrap(str: string, size: number, width: number, bold = false): string[] {
  const words = str.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (fits(next, size, width, bold)) cur = next;
    else {
      if (cur) lines.push(cur);
      cur = fits(w, size, width, bold) ? w : truncate(w, size, width, bold);
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}
function isNumericColumn(rows: string[][], i: number): boolean {
  const vals = rows.map((r) => r[i] ?? "").filter((v) => v !== "" && v !== "-" && v !== "—");
  return vals.length > 0 && vals.every((v) => /^-?\d[\d,.\s%]*$/.test(v.trim()));
}

export class Pdf {
  private pages: string[][] = [];
  private ops: string[] = [];
  y = TOP;
  // Current layout region (a column narrows this temporarily).
  rx = LEFT;
  rw = CONTENT_W;

  // `knownAnchorIds` comes from a first render pass. Drill targets are almost
  // always FORWARD references — an index is drawn before the detail pages it
  // points at — so a single pass cannot know whether a target will exist. See
  // renderReportPdf's two-pass comment.
  // ── Optional content (PDF layers) ──
  //
  // Every chapter is drawn into its own layer, all onto the SAME pages, and the
  // document's default state hides them. Clicking a box on the contents page
  // turns exactly one layer on; Close turns it back off. That is what makes the
  // detail genuinely invisible rather than merely somewhere else in the file.
  //
  // The cost, which cannot be engineered away: hiding is a property of the
  // document's default configuration, so a viewer that renders layers but
  // cannot toggle them (Chrome, Edge) shows the collapsed state permanently.
  private layerOrder: string[] = [];
  /** Layer id -> the pages it has marked content on, so each page's Resources
   *  declares only the layers that page actually uses. */
  private layerPages = new Map<string, Set<number>>();
  private openLayer: string | null = null;

  constructor(private readonly knownAnchorIds?: ReadonlySet<string>) {
    this.pages.push(this.ops);
  }

  /** Begin drawing into `id`; content until endLayer() belongs to that layer. */
  beginLayer(id: string): void {
    if (this.openLayer) this.endLayer();
    if (!this.layerOrder.includes(id)) this.layerOrder.push(id);
    this.openLayer = id;
    this.markLayerStart();
  }

  endLayer(): void {
    if (!this.openLayer) return;
    this.ops.push("EMC");
    this.openLayer = null;
  }

  private markLayerStart(): void {
    const id = this.openLayer;
    if (!id) return;
    const pageIndex = this.pages.length - 1;
    const pages = this.layerPages.get(id) ?? new Set<number>();
    pages.add(pageIndex);
    this.layerPages.set(id, pages);
    this.ops.push(`/OC /${id} BDC`);
  }

  /**
   * Move drawing to an existing page (creating pages up to it), resetting to
   * the top of the text area.
   *
   * Chapters are OVERLAID: each one starts again at the same physical page, so
   * only the visible layer occupies the reader's screen. Without this, every
   * chapter would append after the last — the page-per-chapter layout this
   * replaces.
   */
  gotoPage(index: number): void {
    while (this.pages.length <= index) this.pages.push([]);
    // Marked content cannot span a page boundary: close it on the page being
    // left and reopen it on the page landed on, or the stream is malformed.
    const resume = this.openLayer;
    if (resume) this.endLayer();
    this.ops = this.pages[index]!;
    this.y = TOP;
    this.rx = LEFT;
    this.rw = CONTENT_W;
    if (resume) {
      this.openLayer = resume;
      this.markLayerStart();
    }
  }

  /** Index of the page currently being drawn on. */
  get pageIndex(): number {
    return this.pages.indexOf(this.ops);
  }
  // The true physical page number reached so far (1-indexed) — used by
  // renderers that need an accurate "Page K of N" footer rather than a
  // fixed conceptual page count, since real data volume can push content
  // across more physical pages than a document's nominal page count.
  get pageCount(): number {
    return this.pages.length;
  }
  /** When set, chapters share physical pages: a break moves to the NEXT canvas
   *  page rather than appending one, so chapter 2's page 2 is the same sheet as
   *  chapter 1's page 2. Without this each chapter's overflow would append and
   *  the document would grow to the sum of every chapter's length. */
  overlay = false;

  private addPage(): void {
    if (this.overlay) {
      this.gotoPage(this.pageIndex + 1);
      return;
    }
    // A chapter longer than one page keeps its layer across the break.
    const resume = this.openLayer;
    if (resume) this.endLayer();
    this.ops = [];
    this.pages.push(this.ops);
    this.y = TOP;
    if (resume) {
      this.openLayer = resume;
      this.markLayerStart();
    }
  }
  // Start a fresh page unconditionally. Reports with a fixed physical page
  // structure (e.g. the NCNP consolidated report) drive their own page loop
  // rather than letting content flow, so they need an explicit break.
  newPage(): void {
    this.addPage();
  }
  // Returns true when a page break actually happened, so callers that draw
  // repeating chrome (a table's column header) can redraw it on the new page.
  ensure(space: number): boolean {
    if (this.y + space > PAGE_H - BOTTOM) {
      this.addPage();
      return true;
    }
    return false;
  }
  private py(fromTop: number): number {
    return PAGE_H - fromTop;
  }
  text(x: number, size: number, bold: boolean, str: string, color = BLACK, family: "sans" | "serif" = "sans"): void {
    // `y` is the TOP of the text line — put the baseline ~0.76em below it so
    // text and rects/rules share one top-down origin (otherwise divider rules
    // strike through the following row's glyphs).
    const baseline = this.y + size * 0.76;
    const font = family === "serif" ? (bold ? "F3" : "F4") : bold ? "F1" : "F2";
    this.ops.push(`${color} rg BT /${font} ${size} Tf 1 0 0 1 ${x} ${this.py(baseline)} Tm (${esc(str)}) Tj ET`);
  }
  // An unfilled rectangle border — used for card-style framing (e.g. KPI
  // stat tiles, a bordered page-content frame) where rect()'s solid fill
  // would be too heavy.
  strokeRect(x: number, w: number, h: number, color: string, thickness = 1): void {
    const top = this.y;
    this.strokePath(
      [
        [x, top],
        [x + w, top],
        [x + w, top + h],
        [x, top + h],
        [x, top],
      ],
      color,
      thickness,
    );
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
  /**
   * Crisp separators between pie slices, plus a thin outer ring.
   *
   * Two adjacent slices in similar tones read as one wedge without a gap
   * between them; the ring stops the chart from bleeding into the page. Drawn
   * as an overlay so pie() stays a plain fill and every existing caller is
   * unaffected.
   */
  pieOutline(xLeft: number, r: number, slices: number[], gap = 2): void {
    const cx = xLeft + r;
    const cyCenter = this.y + r;
    const total = slices.reduce((s, v) => s + v, 0) || 1;

    // A separator per boundary — but only where two slices actually meet. A
    // single-slice chart is a full circle and has no internal boundary.
    if (slices.filter((v) => v > 0).length > 1) {
      let a = -Math.PI / 2;
      for (const v of slices) {
        this.strokePath(
          [
            [cx, cyCenter],
            [cx + r * Math.cos(a), cyCenter + r * Math.sin(a)],
          ],
          WHITE,
          gap,
        );
        a += (v / total) * 2 * Math.PI;
      }
    }

    const steps = 72;
    const ring: Array<[number, number]> = [];
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * 2 * Math.PI;
      ring.push([cx + r * Math.cos(a), cyCenter + r * Math.sin(a)]);
    }
    this.strokePath(ring, GRAY, 0.6);
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
  // A filled, closed polygon — same path-building as strokePath but ending
  // in a fill ("f") rather than a stroke ("S"). Used for the kingdom map's
  // country-outline fill.
  fillPolygon(points: Array<[number, number]>, color: string): void {
    if (points.length === 0) return;
    const [x0, y0] = points[0]!;
    const parts = [`${color} rg ${x0.toFixed(2)} ${this.py(y0).toFixed(2)} m`];
    for (let i = 1; i < points.length; i++) {
      const [x, y] = points[i]!;
      parts.push(`${x.toFixed(2)} ${this.py(y).toFixed(2)} l`);
    }
    parts.push("h f");
    this.ops.push(parts.join(" "));
  }
  swatch(x: number, colorIndex: number, size = 7): void {
    this.rect(x, size, size, PIE_COLORS[colorIndex % PIE_COLORS.length]!);
  }

  // ── Drill-down primitives ──
  //
  // Anchors are symbolic so a link can target a page that has not been emitted
  // yet — forward references are the NORMAL case here, since an index is drawn
  // before the detail pages it points at. Resolution happens once, in
  // assemble().

  private anchors = new Map<string, { pageIndex: number; yFromTop: number }>();
  private links: Array<{
    pageIndex: number;
    rect: [number, number, number, number];
    to: string;
    /** Layer to switch ON (all others off) when this link is followed. When
     *  `hideAll` is set instead, every layer is turned off — the Close control. */
    showLayer?: string;
    hideAll?: boolean;
  }> = [];

  /** Register the current position as a named jump target. */
  anchor(id: string): void {
    // First registration wins. A duplicate id is a generator bug, but silently
    // repointing every existing link at the later one would be a worse
    // outcome than keeping the first — and the spec asserts uniqueness.
    if (!this.anchors.has(id)) {
      this.anchors.set(id, { pageIndex: this.pages.length - 1, yFromTop: this.y });
    }
  }

  /**
   * Lay a transparent clickable rectangle over content already drawn.
   *
   * `x`/`w`/`h` are in the same top-down space every draw call uses, and the
   * conversion to PDF's bottom-up space happens here — the geometry is computed
   * from the caller's own draw coordinates rather than duplicated, because a
   * drift between the drawn box and the clickable box is the classic bug in
   * hand-built PDF link layers.
   */
  link(
    x: number,
    w: number,
    h: number,
    to: string,
    layerAction?: { showLayer?: string; hideAll?: boolean },
  ): void {
    const y1 = this.py(this.y);
    const y0 = this.py(this.y + h);
    // Clamp to the MediaBox: some viewers drop a page's ENTIRE /Annots array
    // when one rect falls outside it, which would silently kill every link on
    // that page rather than just the offending one.
    const rect: [number, number, number, number] = [
      Math.max(0, Math.min(x, PAGE_W)),
      Math.max(0, Math.min(y0, PAGE_H)),
      Math.max(0, Math.min(x + w, PAGE_W)),
      Math.max(0, Math.min(y1, PAGE_H)),
    ];
    this.links.push({
      // NOT pages.length - 1: with overlaid chapters the writer moves between
      // existing pages, so the link belongs to whichever page is being drawn on
      // now, which is not necessarily the last one created.
      pageIndex: this.pageIndex,
      rect,
      to,
      ...layerAction,
    });
  }

  /** Anchor ids registered during this pass — feeds the second render pass. */
  anchorIds(): ReadonlySet<string> {
    return new Set(this.anchors.keys());
  }

  build(): Buffer {
    this.endLayer();
    return assemble(
      this.pages.map((ops) => ops.join("\n")),
      this.anchors,
      this.links,
      { order: this.layerOrder, pages: this.layerPages },
    );
  }
}

function renderHeader(pdf: Pdf, doc: ReportDoc): void {
  // Generators name a report "<Report type> — <subject>" (survey / village /
  // study). One 16pt line only fits ~55 characters, so a long subject used to
  // be swallowed by the ellipsis — losing the very field that tells two
  // sibling reports apart. Split at the dash: report type on the masthead
  // line, subject wrapped beneath it at a smaller size.
  const [typeName, ...subjectParts] = doc.title.split("—");
  const heading = (typeName ?? doc.title).trim();
  const subject = subjectParts.join("—").trim();

  pdf.text(LEFT, 16, true, truncate(heading, 16, CONTENT_W), ACCENT);
  pdf.y += 21;
  if (subject) {
    for (const line of wrap(subject, 12, CONTENT_W)) {
      pdf.text(LEFT, 12, true, line, ACCENT);
      pdf.y += 15;
    }
    pdf.y += 2;
  }
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

export function heading(pdf: Pdf, text: string): void {
  pdf.ensure(22);
  pdf.y += 4;
  pdf.text(pdf.rx, 11.5, true, truncate(text, 11.5, pdf.rw), ACCENT);
  pdf.y += 14;
  pdf.rule(GRAY, 0.5);
  pdf.y += 5;
}

function renderKeyValue(pdf: Pdf, rows: Array<{ label: string; value: string }>): void {
  const size = 8.5;
  const LINE = 11;
  const GAP = 10;
  // The label column is measured from the labels themselves rather than fixed
  // at 150pt. A fixed column truncated every long label in "Calculation Basis
  // - Thresholds Applied" ("Severity at or above which a sust..") while its
  // two-digit value sat alone in half a page of white space. Bounded at 62% of
  // the region so one very long label still cannot squeeze the values out, and
  // labels now WRAP rather than truncate - a threshold a reader cannot finish
  // reading is, to them, a threshold that was never stated.
  const labelNeed = Math.max(0, ...rows.map((r) => textWidth(r.label, size, true))) + GAP;
  const valueNeed = Math.max(0, ...rows.map((r) => textWidth(r.value, size)));
  const labelW =
    labelNeed + valueNeed <= pdf.rw
      ? Math.max(60, labelNeed)
      : Math.max(60, Math.min(labelNeed, pdf.rw * 0.62));
  const valX = pdf.rx + labelW;
  const valW = pdf.rx + pdf.rw - valX;
  for (const { label, value } of rows) {
    const labelLines = wrap(label, size, labelW - GAP, true);
    const valueLines = wrap(value, size, valW);
    const lineCount = Math.max(labelLines.length, valueLines.length);
    pdf.ensure(lineCount * LINE + 2);
    // Both columns are drawn from the SAME top, so a wrapped label and a
    // wrapped value stay on the rows they belong to.
    const top = pdf.y;
    labelLines.forEach((ln, i) => {
      pdf.y = top + i * LINE;
      pdf.text(pdf.rx + 1, size, true, ln);
    });
    valueLines.forEach((ln, i) => {
      pdf.y = top + i * LINE;
      pdf.text(valX, size, false, ln);
    });
    pdf.y = top + lineCount * LINE + 1.5;
  }
}


/** The widest single word in a cell — text that cannot be wrapped, so a column
 *  narrower than this must truncate mid-word ("Livelihood" → "Livel.."). */
function widestWord(str: string, size: number, bold = false): number {
  // The hierarchy's indent is part of the first word's unbreakable width.
  const indent = /^\s+/.exec(str)?.[0] ?? "";
  return str
    .trim()
    .split(/\s+/)
    .reduce((max, w, i) => Math.max(max, textWidth((i === 0 ? indent : "") + w, size, bold)), 0);
}

function renderTable(
  pdf: Pdf,
  columns: string[],
  rows: string[][],
  rowLinks?: Array<string | null>,
): void {
  const n = columns.length || 1;
  const size = n > 6 ? 7 : n > 4 ? 7.5 : 8.5;
  const rowH = size + 5;

  // Minimum width per column = whatever CANNOT be broken: its own header, and
  // the widest unbreakable word in its cells. Sizing on the header alone left
  // "Domain" 32pt wide, so every "Livelihood" printed as "Livel.." — the column
  // was legally full while its only value was unreadable.
  const minW = columns.map((c, i) => {
    const header = textWidth(c, size, true);
    const word = Math.max(0, ...rows.map((r) => widestWord(r[i] ?? "", size)));
    // +12 is the cell's own padding (3pt in, 3pt out) plus a hair of gutter, so
    // two adjacent columns never read as one run of text.
    return Math.max(header, word) + 12;
  });
  const minSum = minW.reduce((a, b) => a + b, 0) || 1;
  // How much room each column's FULL content wants, measured the same way it
  // is drawn - character-width totals, not a character count, or a prose column
  // of narrow lowercase claims slack that an all-caps column actually needs.
  const wantW = columns.map((c, i) =>
    Math.max(textWidth(c, size, true), ...rows.map((r) => textWidth(r[i] ?? "", size))),
  );

  let widths: number[];
  if (minSum <= pdf.rw) {
    // Everything unbreakable fits. Hand out the slack proportional to how much
    // each column's full content still overflows, so a long prose column (Notes)
    // takes most of it without starving the short ones.
    const extra = pdf.rw - minSum;
    const overflow = wantW.map((want, i) => Math.max(0, want - minW[i]!));
    const totalOverflow = overflow.reduce((a, b) => a + b, 0);
    widths = minW.map((w, i) => w + (totalOverflow > 0 ? (overflow[i]! / totalOverflow) * extra : extra / n));
  } else {
    // Too many columns for the page. Scale the minimums down together — some
    // mid-word truncation is then unavoidable, and the right fix is a narrower
    // column set (see report-doc's compact vs full need-record columns).
    widths = minW.map((w) => Math.max(26, (w / minSum) * pdf.rw));
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
  // Prose cells (a Notes column) wrap over several lines rather than being cut
  // off — a reason a reader cannot finish reading is no reason at all.
  const MAX_LINES = 4;
  const rowHeight = (cells: string[], wrapCells: boolean, bold = false): number => {
    const cellLines = cells.map((c, i) => {
      const w = widths[i] ?? 40;
      if (!wrapCells) return [truncate(c, size, w - 6, bold)];
      const lines = wrap(c, size, w - 6, bold);
      if (lines.length <= MAX_LINES) return lines;
      return [...lines.slice(0, MAX_LINES - 1), truncate(lines.slice(MAX_LINES - 1).join(" "), size, w - 6, bold)];
    });
    const lineCount = Math.max(1, ...cellLines.map((l) => l.length));
    return size + 5 + (lineCount - 1) * (size + 1);
  };
  const drawRow = (cells: string[], bold: boolean, wrapCells: boolean) => {
    const cellLines = cells.map((c, i) => {
      const w = widths[i] ?? 40;
      if (!wrapCells) return [truncate(c, size, w - 6, bold)];
      const lines = wrap(c, size, w - 6, bold);
      if (lines.length <= MAX_LINES) return lines;
      return [...lines.slice(0, MAX_LINES - 1), truncate(lines.slice(MAX_LINES - 1).join(" "), size, w - 6, bold)];
    });
    const lineCount = Math.max(1, ...cellLines.map((l) => l.length));
    const h = size + 5 + (lineCount - 1) * (size + 1);
    const top = pdf.y;
    cellLines.forEach((lines, i) => {
      const w = widths[i] ?? 40;
      const cx = xs[i] ?? pdf.rx;
      lines.forEach((ln, li) => {
        pdf.y = top + li * (size + 1);
        pdf.text(numeric[i] ? cx + w - 4 - textWidth(ln, size, bold) : cx + 3, size, bold, ln);
      });
    });
    pdf.y = top + h;
  };
  const drawHeader = () => {
    pdf.rect(pdf.rx, pdf.rw, rowH, LIGHT);
    drawRow(columns, true, false);
    pdf.rule(GRAY, 0.5);
    pdf.y += 2;
  };
  const headerH = rowHeight(columns, false, true);
  // Small tables (the "top N" / "Showing N of Total" summary tables this
  // report is built from — see this file's own header comment) are placed
  // as one atomic block: header + every row reserved together upfront. Without
  // this, a table that's short but not quite short enough can still trigger
  // two distinct orphan patterns: the header separated from its body (only
  // the first row was ever checked), or — just as visibly — the table's
  // *last* row spilling alone onto an otherwise-blank next page while the
  // rest fit fine on the previous one. Reserving the whole thing at once
  // avoids both. Large/unbounded tables (rare, but not capped by this
  // report's "top N" convention) fall back to per-row breaks — atomically
  // reserving a 200-row table would just force the entire thing onto a fresh
  // page for no benefit — and repeat the header on whichever row's break
  // actually lands, so a continuation page is never headerless.
  const SMALL_TABLE_MAX_ROWS = 20;
  if (rows.length <= SMALL_TABLE_MAX_ROWS) {
    const totalH = rows.reduce((sum, row) => sum + rowHeight(row, true), headerH);
    pdf.ensure(totalH + 4);
  } else {
    const firstRowH = rows.length > 0 ? rowHeight(rows[0]!, true) : 0;
    pdf.ensure(headerH + firstRowH + 4);
  }
  drawHeader();
  rows.forEach((row, i) => {
    if (pdf.ensure(rowHeight(row, true) + 2)) drawHeader();
    const target = rowLinks?.[i] ?? null;
    // The link rect is derived from the SAME y/height this row is about to be
    // drawn with — never recomputed independently, or the clickable box drifts
    // from the visible row and the reader clicks the wrong thing.
    const h = rowHeight(row, true);
    // Deliberately NOT guarded on the anchor existing. Skipping an unresolvable
    // target here would quietly drop the link and leave a generator bug
    // invisible; recording it means assemble() throws with the offending id.
    // Failing the build beats shipping a row that looks clickable and isn't.
    if (target !== null) {
      pdf.link(pdf.rx, pdf.rw, h, target);
      // A drill affordance the reader can see. Without it a clickable row is
      // indistinguishable from a static one and nobody discovers the drill.
      const marker = ">";
      pdf.text(pdf.rx + pdf.rw - textWidth(marker, 8) - 2, 8, true, marker, ACCENT);
    }
    drawRow(row, false, true);
  });
}

// The drill-down index: a grid of clickable tiles. Each tile is plain vector
// content with a transparent link annotation laid over it — the same two
// primitives the client's reference artefact uses, and the reason its
// interactivity survives being emailed as a single file.
function renderNavGrid(pdf: Pdf, tiles: DocTile[]): void {
  const COLS = 3;
  const GAP = 10;
  const TILE_H = 46;
  const tileW = (pdf.rw - GAP * (COLS - 1)) / COLS;
  const rowCount = Math.ceil(tiles.length / COLS);

  // Reserve the whole grid: a tile split across a page boundary would put its
  // label on one page and its clickable rect on the next.
  pdf.ensure(rowCount * (TILE_H + GAP));

  tiles.forEach((tile, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = pdf.rx + col * (tileW + GAP);
    const top = pdf.y + row * (TILE_H + GAP);
    const savedY = pdf.y;

    pdf.y = top;
    pdf.rect(x, tileW, TILE_H, LIGHT);
    pdf.strokeRect(x, tileW, TILE_H, GRAY, 0.5);

    pdf.y = top + 8;
    pdf.text(x + 8, 9, true, truncate(tile.label, 9, tileW - 16));
    pdf.y = top + 22;
    pdf.text(x + 8, 7.5, false, truncate(tile.sub, 7.5, tileW - 16), GRAY);
    pdf.y = top + 33;
    pdf.text(x + 8, 7.5, true, "View detail >", ACCENT);

    pdf.y = top;
    pdf.link(x, tileW, TILE_H, tile.to);
    pdf.y = savedY;
  });

  pdf.y += rowCount * (TILE_H + GAP);
}

// "Back to …" trail at the top of a detail page. Without a way back, a
// materialised detail page is a one-way trip and the reader is stranded.
function renderBreadcrumb(pdf: Pdf, trail: Array<{ label: string; to?: string }>): void {
  pdf.ensure(16);
  let x = pdf.rx;
  trail.forEach((crumb, i) => {
    if (i > 0) {
      pdf.text(x, 7.5, false, "/", GRAY);
      x += textWidth("/ ", 7.5) + 3;
    }
    // A crumb with no target is the current page — legitimately not a link.
    const clickable = crumb.to !== undefined;
    const w = textWidth(crumb.label, 7.5);
    pdf.text(x, 7.5, clickable, crumb.label, clickable ? ACCENT : GRAY);
    if (clickable) pdf.link(x, w, 11, crumb.to!);
    x += w + 5;
  });
  pdf.y += 14;
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

function renderPie(
  pdf: Pdf,
  slices: Array<{ label: string; value: number }>,
  emphasis = false,
): void {
  const total = slices.reduce((s, d) => s + d.value, 0) || 1;
  if (emphasis) return renderPieLarge(pdf, slices, total);

  const r = 30;
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

/**
 * The large treatment: the chart is the point of the section, so it gets the
 * width rather than being squeezed beside another chart.
 *
 * Pie and legend are laid out as ONE group and that group is centred, with the
 * legend stacked vertically to the right of the circle and centred against its
 * height. Centring the circle alone and hanging the legend off it would put the
 * visual weight left of the page axis while claiming to be centred.
 */
function renderPieLarge(
  pdf: Pdf,
  slices: Array<{ label: string; value: number }>,
  total: number,
): void {
  // Type first, then the circle. The legend's width depends on the font, and
  // the circle takes whatever is left — sizing the circle first and shrinking
  // the text to fit is what left a small chart stranded on a half-empty page.
  const SIZE = 14;
  const SWATCH = 12;
  const ROW_H = 26;
  const GAP = 32;
  const MIN_R = 60;
  const MAX_R = 90;
  // Breathing room under the section heading. heading() leaves 5pt, which is
  // right for a table butting up against its own title bar but reads as
  // cramped under a figure this size.
  const HEAD_GAP = 14;

  const entries = slices.map((d) => ({
    ...d,
    text: `${d.label}: ${d.value} (${Math.round((d.value / total) * 100)}%)`,
  }));

  // The legend takes what it needs, capped at half the width so a long category
  // name ("Prefer not to say") cannot squeeze the circle to nothing. At 17pt
  // that longest label needs ~250pt, so a tighter cap would truncate the very
  // label the cap exists to accommodate.
  const legendW = Math.min(
    pdf.rw * 0.5,
    Math.max(...entries.map((e) => SWATCH + 8 + textWidth(e.text, SIZE))),
  );

  // Fill the width that is left. MAX_R stops a two-entry legend on a wide page
  // from producing a circle that dwarfs the section it belongs to.
  const r = Math.max(MIN_R, Math.min(MAX_R, (pdf.rw - GAP - legendW) / 2));

  const groupW = 2 * r + GAP + legendW;
  const legendH = entries.length * ROW_H;
  const figureH = Math.max(2 * r, legendH);

  // Reserve the whole figure INCLUDING the gap above it: a chart split from its
  // own legend across a page break is unreadable in either half.
  pdf.ensure(HEAD_GAP + figureH + 14);
  pdf.y += HEAD_GAP;
  const top = pdf.y;
  const groupLeft = pdf.rx + Math.max(0, (pdf.rw - groupW) / 2);

  // Both halves are centred against the taller of the two, so a two-entry
  // legend sits level with the circle's middle rather than its top edge.
  const pieTop = top + (figureH - 2 * r) / 2;
  pdf.y = pieTop;
  const values = entries.map((e) => e.value);
  pdf.pie(groupLeft, r, values);
  // Separators and ring go on top of the fills, so they are not painted over
  // by the next slice.
  pdf.pieOutline(groupLeft, r, values);

  const legX = groupLeft + 2 * r + GAP;
  let rowTop = top + (figureH - legendH) / 2;
  entries.forEach((e, i) => {
    // Nudge the swatch onto the text's optical centre rather than its cap
    // height — the offset scales with the type, or the alignment that looks
    // right at 9.5pt drifts visibly at 13pt.
    pdf.y = rowTop + (SIZE - SWATCH) / 2 + 2;
    pdf.swatch(legX, i, SWATCH);
    pdf.y = rowTop;
    pdf.text(legX + SWATCH + 8, SIZE, false, truncate(e.text, SIZE, legendW - SWATCH - 8));
    rowTop += ROW_H;
  });

  pdf.y = top + figureH + 10;
}

function renderGauge(pdf: Pdf, value: number, max: number, sub?: string): void {
  // Sized to the column it sits in rather than a fixed 30pt radius, and centred
  // in it — the dial used to hug the left edge of a half-width column with the
  // rest of the space empty, which read as a rendering fault.
  const r = Math.max(30, Math.min(46, pdf.rw / 2 - 14));
  const scaleH = 12;
  pdf.ensure(2 * r + scaleH + 10);
  const top = pdf.y;
  const cx = pdf.rx + pdf.rw / 2;
  const cyc = top + r;
  const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;

  pdf.pie(cx - r, r, frac >= 1 ? [1] : [frac, 1 - frac], [BAR, LIGHT]);
  pdf.disc(cx, cyc, r * 0.64, "1 1 1");

  const valStr = String(value);
  const valSize = r >= 40 ? 18 : 15;
  pdf.y = cyc - valSize * 0.78;
  pdf.text(cx - textWidth(valStr, valSize) / 2, valSize, true, valStr, ACCENT);
  if (sub) {
    pdf.y = cyc + 4;
    pdf.text(cx - textWidth(sub, 8) / 2, 8, true, sub, GRAY);
  }

  // States the scale the dial is on. A ring with a bare number in it does not
  // say whether 51 is good or bad, or out of what.
  pdf.y = top + 2 * r + 5;
  const scale = `0-${max} - higher = worse`;
  pdf.text(cx - textWidth(scale, 7) / 2, 7, false, scale, GRAY);
  pdf.y += scaleH;
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

// Headline-count tiles, laid out in a grid: big value, small label under it,
// optional sub-line. Three per row at full width, two inside a `columns` child
// (which halves rw), so the value never has to shrink to fit.
function renderStats(pdf: Pdf, tiles: Array<{ label: string; value: string; sub?: string }>): void {
  const perRow = pdf.rw > 300 ? 3 : 2;
  const gap = 8;
  const tileW = (pdf.rw - gap * (perRow - 1)) / perRow;

  for (let i = 0; i < tiles.length; i += perRow) {
    const row = tiles.slice(i, i + perRow);
    const hasSub = row.some((t) => t.sub);
    const tileH = hasSub ? 44 : 36;
    pdf.ensure(tileH + 6);
    const top = pdf.y;

    row.forEach((tile, c) => {
      const x = pdf.rx + c * (tileW + gap);
      pdf.y = top;
      pdf.rect(x, tileW, tileH, LIGHT);

      pdf.y = top + 15;
      pdf.text(x + 7, 15, true, truncate(tile.value, 15, tileW - 14), ACCENT);

      pdf.y = top + 26;
      pdf.text(x + 7, 7, false, truncate(tile.label, 7, tileW - 14), GRAY);

      if (tile.sub) {
        pdf.y = top + 36;
        pdf.text(x + 7, 6.5, false, truncate(tile.sub, 6.5, tileW - 14), GRAY);
      }
    });

    pdf.y = top + tileH + 6;
  }
}

// Paired bars: one track per group, each series drawn as a thinner bar stacked
// within the group's slot. The gap between the two bars IS the finding, so they
// share one scale and sit adjacent rather than on separate charts.
function renderGroupedBars(
  pdf: Pdf,
  max: number,
  groups: string[],
  series: Array<{ name: string; values: number[] }>,
): void {
  const labelW = Math.min(140, pdf.rw * 0.4);
  const trackX = pdf.rx + labelW;
  const trackW = pdf.rw - labelW - 34;
  const barH = 7;
  const rowH = series.length * (barH + 2) + 8;

  groups.forEach((group, gi) => {
    pdf.ensure(rowH);
    const top = pdf.y;
    pdf.y = top + barH;
    pdf.text(pdf.rx + 2, 8, false, truncate(group, 8, labelW - 6));

    series.forEach((s, si) => {
      const value = s.values[gi] ?? 0;
      const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
      pdf.y = top + si * (barH + 2);
      pdf.rect(trackX, trackW, barH, LIGHT);
      if (frac > 0) pdf.rect(trackX, Math.max(1, trackW * frac), barH, PIE_COLORS[si % PIE_COLORS.length]!);
      pdf.y = top + si * (barH + 2) + barH - 0.5;
      pdf.text(trackX + trackW + 5, 7, false, String(Math.round(value)));
    });

    pdf.y = top + rowH;
  });

  // Legend — without it the two colours are unattributable.
  pdf.ensure(14);
  let lx = pdf.rx;
  series.forEach((s, si) => {
    pdf.swatch(lx, si);
    pdf.text(lx + 11, 8, false, s.name);
    lx += 11 + textWidth(s.name, 8) + 16;
  });
  pdf.y += 13;
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

function renderColumns(pdf: Pdf, children: DocSection[], gap = 14, weights?: number[]): void {
  pdf.ensure(158);
  const startY = pdf.y;
  const n = children.length || 1;
  // Equal split unless the caller states a ratio. A chart beside a long
  // key/value block wants the narrower half — an even split left the gauge in a
  // sea of white space while the block's values wrapped four lines deep.
  const w = weights?.length === n ? weights : children.map(() => 1);
  const total = w.reduce((a, b) => a + b, 0) || 1;
  const usable = pdf.rw - gap * (n - 1);
  const colW = w.map((f) => (f / total) * usable);
  let maxEnd = startY;
  let x = pdf.rx;
  children.forEach((child, i) => {
    const end = pdf.column(x, colW[i]!, startY, () => renderSection(pdf, child));
    x += colW[i]! + gap;
    maxEnd = Math.max(maxEnd, end);
  });
  pdf.y = maxEnd;
}

export function renderSection(pdf: Pdf, s: DocSection): void {
  if (s.kind === "columns") return renderColumns(pdf, s.children);
  // An empty heading string still cost a full heading()'s worth of vertical
  // space (ensure + rule line) for nothing visible — callers that
  // deliberately omit a heading (e.g. a table nested under a heading drawn
  // separately just above it) shouldn't pay for one.
  // `pageBreak` draws its own heading AFTER breaking the page — drawing it here
  // would put the detail page's title on the bottom of the previous page.
  // `anchor` and `breadcrumb` have no heading at all.
  if ("heading" in s && s.heading && s.kind !== "pageBreak") heading(pdf, s.heading);
  switch (s.kind) {
    case "keyvalue": return renderKeyValue(pdf, s.rows);
    case "table": return renderTable(pdf, s.columns, s.rows, s.rowLinks);
    case "anchor": return pdf.anchor(s.id);
    case "navGrid": return renderNavGrid(pdf, s.tiles);
    case "breadcrumb": return renderBreadcrumb(pdf, s.trail);
    case "pageBreak": {
      // Drill targets must be MATERIALISED pages: a PDF has no lazy loading,
      // so the detail a link jumps to has to physically exist first.
      pdf.newPage();
      pdf.anchor(s.anchorId);
      if (s.heading) heading(pdf, s.heading);
      return;
    }
    case "bars": return renderBars(pdf, s.max, s.bars);
    case "pie": return renderPie(pdf, s.slices, s.emphasis);
    case "gauge": return renderGauge(pdf, s.value, s.max, s.sub);
    case "radar": return renderRadar(pdf, s.axes, s.max, s.series);
    case "list": return renderList(pdf, s.items);
    case "note": return renderNote(pdf, s.text);
    case "stats": return renderStats(pdf, s.tiles);
    case "groupedBars": return renderGroupedBars(pdf, s.max, s.groups, s.series);
  }
}

function renderPass(
  doc: ReportDoc,
  knownAnchorIds?: ReadonlySet<string>,
  mode: PdfInteractivity = "pages",
): Pdf {
  const pdf = new Pdf(knownAnchorIds);
  renderHeader(pdf, doc);

  if (doc.chapters?.length) {
    // Page 1 is the contents grid; each chapter follows.
    renderContentsPage(pdf, doc.chapters, mode);
    if (doc.audit.length) {
      renderSection(pdf, { kind: "keyvalue", heading: "Audit Trail", rows: doc.audit });
    }
    const canvasPage = pdf.pageCount; // first page after the contents
    // In layer mode chapters overlay onto the same canvas pages, so the file
    // does not grow to the sum of every chapter's length.
    pdf.overlay = mode === "layers";
    doc.chapters.forEach((chapter, i) => renderChapter(pdf, chapter, i, canvasPage, mode));
    pdf.overlay = false;
    return pdf;
  }

  for (const section of doc.sections) {
    renderSection(pdf, section);
    pdf.y += 6;
  }
  if (doc.audit.length) renderSection(pdf, { kind: "keyvalue", heading: "Audit Trail", rows: doc.audit });
  return pdf;
}

const CONTENTS_ANCHOR = "contents";
/** PDF names cannot carry arbitrary text; layers are addressed by index. */
const layerId = (i: number): string => `L${i}`;
const chapterAnchor = (i: number): string => `chapter:${i}`;

/**
 * How the exported PDF realises "click a box, see that section".
 *
 * "pages"  — each chapter is its own page; a box jumps to it. Works identically
 *            in Acrobat, Chrome, Edge and Preview, and prints correctly. The
 *            detail pages exist in the file, so scrolling reaches them.
 * "layers" — each chapter is a hidden optional-content layer; a box reveals it
 *            and Close hides it again, so nothing is visible until opened.
 *            Requires a viewer that supports /SetOCGState: Acrobat does,
 *            browsers' built-in viewers do NOT, and there the sections cannot
 *            be opened at all. Only for Acrobat-only distribution.
 */
export type PdfInteractivity = "pages" | "layers";

/** The contents page: a grid of boxes, one per chapter. */
function renderContentsPage(
  pdf: Pdf,
  chapters: ReportDoc["chapters"] = [],
  mode: PdfInteractivity = "pages",
): void {
  pdf.anchor(CONTENTS_ANCHOR);
  heading(pdf, "Contents");

  const COLS = 2;
  const GAP = 12;
  const TILE_H = 54;
  const tileW = (pdf.rw - GAP * (COLS - 1)) / COLS;
  const rows = Math.ceil(chapters.length / COLS);
  pdf.ensure(rows * (TILE_H + GAP) + 30);

  const top0 = pdf.y;
  chapters.forEach((c, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = pdf.rx + col * (tileW + GAP);
    const top = top0 + row * (TILE_H + GAP);

    pdf.y = top;
    pdf.rect(x, tileW, TILE_H, LIGHT);
    pdf.strokeRect(x, tileW, TILE_H, GRAY, 0.5);
    // A number on each box so a reader can refer to a chapter out loud, and so
    // the grid reads as an ordered document rather than a menu.
    pdf.y = top + 9;
    pdf.text(x + 10, 8, true, String(i + 1).padStart(2, "0"), ACCENT);
    pdf.text(x + 30, 10.5, true, truncate(c.name, 10.5, tileW - 44));
    pdf.y = top + 26;
    pdf.text(x + 30, 8, false, truncate(c.summary, 8, tileW - 44), GRAY);
    pdf.y = top + 39;
    pdf.text(x + 30, 8, true, "Open >", ACCENT);

    pdf.y = top;
    // In "pages" mode the box is a plain jump — no layer state to change.
    pdf.link(
      x,
      tileW,
      TILE_H,
      chapterAnchor(i),
      mode === "layers" ? { showLayer: layerId(i) } : undefined,
    );
  });

  pdf.y = top0 + rows * (TILE_H + GAP) + 4;
  renderNote(
    pdf,
    mode === "layers"
      ? "Click a box to open that section; Close returns here. Sections stay hidden until " +
          "opened, which requires Adobe Acrobat Reader — a browser's built-in PDF viewer " +
          "cannot open them."
      : "Click a box to open that section. Each section has a link back to this page.",
  );
}

/**
 * One chapter — either onto its own page, or into its own hidden layer on the
 * shared canvas page.
 */
function renderChapter(
  pdf: Pdf,
  chapter: NonNullable<ReportDoc["chapters"]>[number],
  index: number,
  canvasPage: number,
  mode: PdfInteractivity,
): void {
  if (mode === "layers") {
    pdf.gotoPage(canvasPage);
    pdf.beginLayer(layerId(index));
  } else {
    pdf.newPage();
  }
  pdf.anchor(chapterAnchor(index));

  // Chapter bar: title on the left, Close on the right. Close hides every
  // layer and returns to the contents page, which is what makes "closed" mean
  // invisible rather than merely scrolled past.
  const barTop = pdf.y;
  pdf.rect(pdf.rx, pdf.rw, 22, LIGHT);
  pdf.y = barTop + 6;
  pdf.text(pdf.rx + 8, 11, true, truncate(chapter.name, 11, pdf.rw - 120));
  const closeLabel = mode === "layers" ? "< Close" : "< Contents";
  const closeW = textWidth(closeLabel, 9) + 10;
  pdf.text(pdf.rx + pdf.rw - closeW, 9, true, closeLabel, ACCENT);
  pdf.y = barTop;
  pdf.link(
    pdf.rx + pdf.rw - closeW - 4,
    closeW + 8,
    22,
    CONTENTS_ANCHOR,
    mode === "layers" ? { hideAll: true } : undefined,
  );
  pdf.y = barTop + 30;

  for (const section of chapter.sections) {
    renderSection(pdf, section);
    pdf.y += 6;
  }
  if (mode === "layers") pdf.endLayer();
}

export function renderReportPdf(doc: ReportDoc, mode: PdfInteractivity = "pages"): Buffer {
  // Two passes. The first discovers which anchors the document actually
  // materialises; the second draws the links, now that a forward reference can
  // be recognised as valid.
  //
  // Layout is identical between passes: the only thing the second pass draws
  // that the first does not is the ">" drill affordance, which is placed at the
  // current y and advances nothing. So the anchor positions the second pass
  // records are the positions the emitted pages actually have.
  const discovery = renderPass(doc, undefined, mode);
  const ids = discovery.anchorIds();
  // Nothing drillable — skip the second pass entirely rather than paying for it
  // on every ordinary report.
  if (ids.size === 0) return discovery.build();
  return renderPass(doc, ids, mode).build();
}

export interface LayerInfo {
  /** Layer ids in document order — becomes /OCProperties /D /Order. */
  order: string[];
  /** Layer id -> page indices it draws on. */
  pages: Map<string, Set<number>>;
}

function assemble(
  pageStreams: string[],
  anchors: Map<string, { pageIndex: number; yFromTop: number }> = new Map(),
  links: Array<{
    pageIndex: number;
    rect: [number, number, number, number];
    to: string;
    showLayer?: string;
    hideAll?: boolean;
  }> = [],
  layers: LayerInfo = { order: [], pages: new Map() },
): Buffer {
  const pageCount = pageStreams.length || 1;
  if (pageStreams.length === 0) pageStreams.push("");
  const pageObjNums = pageStreams.map((_, i) => 3 + i);
  const fontBold = 3 + pageCount;
  const fontReg = fontBold + 1;
  // Times-Bold/Times-Roman are standard base-14 fonts (no embedding needed,
  // same as Helvetica above) — used for the serif display title on reports
  // that want one (e.g. the NCNP Consolidated Report's masthead), unused
  // resource entries otherwise cost nothing.
  const fontSerifBold = fontReg + 1;
  const fontSerifReg = fontSerifBold + 1;
  const firstContent = fontSerifReg + 1;

  // Annotation objects come after the content streams. Their count is known up
  // front, so the numbering stays a simple offset rather than needing a
  // two-pass allocator — and every page can name its own /Annots before the
  // annotation objects themselves are emitted.
  const firstAnnot = firstContent + pageCount;
  const firstOcg = firstAnnot + links.length;
  const ocgNum = new Map(layers.order.map((id, i) => [id, firstOcg + i]));
  const allOcgRefs = layers.order.map((id) => `${ocgNum.get(id)} 0 R`);
  const allOcgs = allOcgRefs.join(" ");

  // Resolve symbolic targets. An unresolved anchor is a HARD failure: a link
  // pointing at a page that was never materialised is a dead click in the
  // reader's hands, and a silent no-op here is exactly how that ships.
  const resolved = links.map((l, i) => {
    const target = anchors.get(l.to);
    if (!target) {
      throw new Error(
        `PDF drill-down: link #${i} on page ${l.pageIndex + 1} targets unknown anchor "${l.to}". ` +
          `Every drill target must be materialised as a page before it can be linked to.`,
      );
    }
    return { ...l, target, objNum: firstAnnot + i };
  });

  const annotsByPage = new Map<number, number[]>();
  for (const l of resolved) {
    const list = annotsByPage.get(l.pageIndex);
    if (list) list.push(l.objNum);
    else annotsByPage.set(l.pageIndex, [l.objNum]);
  }

  const objects: string[] = [];
  const ocProps = layers.order.length
    ? ` /OCProperties << /OCGs [${allOcgs}] /D << /Order [${allOcgs}] /OFF [${allOcgs}] >> >>`
    : "";
  objects.push(`<< /Type /Catalog /Pages 2 0 R${ocProps} >>`);
  objects.push(`<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageCount} >>`);
  pageStreams.forEach((_, i) => {
    const annots = annotsByPage.get(i);
    const annotsEntry = annots?.length ? ` /Annots [${annots.map((n) => `${n} 0 R`).join(" ")}]` : "";
    // A page's Resources must name every layer its content stream marks, or the
    // /OC operator refers to nothing and the whole stream is invalid.
    const onThisPage = layers.order.filter((id) => layers.pages.get(id)?.has(i));
    const propsEntry = onThisPage.length
      ? ` /Properties << ${onThisPage.map((id) => `/${id} ${ocgNum.get(id)} 0 R`).join(" ")} >>`
      : "";
    objects.push(
      `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ${fontBold} 0 R /F2 ${fontReg} 0 R /F3 ${fontSerifBold} 0 R /F4 ${fontSerifReg} 0 R >>${propsEntry} >> /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${firstContent + i} 0 R${annotsEntry} >>`,
    );
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>");
  for (const stream of pageStreams) {
    objects.push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
  }
  // /Border [0 0 0] hides the viewer's default link box — without it every
  // clickable row renders inside a black rectangle.
  //
  // /XYZ null <top> null rather than /Fit: several drill targets can share one
  // physical page, so the jump must land at the anchor's own vertical position
  // instead of scrolling the whole page into view.
  for (const l of resolved) {
    const top = PAGE_H - l.target.yFromTop;
    const goTo = `<< /S /GoTo /D [${pageObjNums[l.target.pageIndex]} 0 R /XYZ null ${top.toFixed(2)} null] >>`;

    // A box that opens a chapter turns every layer off and its own back on, so
    // opening one chapter closes whichever was open. Close turns them all off.
    // The jump is chained as /Next: the state change happens first, then the
    // navigation, which is what stops the reader landing on a page that is
    // still blank.
    let action = goTo;
    if (l.hideAll) {
      action = `<< /S /SetOCGState /State [/OFF ${allOcgRefs.join(" ")}] /Next ${goTo} >>`;
    } else if (l.showLayer && ocgNum.has(l.showLayer)) {
      const on = `${ocgNum.get(l.showLayer)} 0 R`;
      const others = layers.order
        .filter((id) => id !== l.showLayer)
        .map((id) => `${ocgNum.get(id)} 0 R`);
      const state = others.length ? `/OFF ${others.join(" ")} /ON ${on}` : `/ON ${on}`;
      action = `<< /S /SetOCGState /State [${state}] /Next ${goTo} >>`;
    }

    objects.push(
      `<< /Type /Annot /Subtype /Link /Rect [${l.rect.map((n) => n.toFixed(2)).join(" ")}] ` +
        `/Border [0 0 0] /A ${action} >>`,
    );
  }

  // OCG objects, then the document's default configuration. /OFF listing every
  // layer is what makes the report open collapsed; /Order drives the layer
  // panel a viewer shows. /BaseState stays default (ON) so a layer the config
  // forgets is visible rather than lost.
  for (const id of layers.order) {
    const label = id.replace(/^L\d+_/, "").replace(/_/g, " ");
    objects.push(`<< /Type /OCG /Name (${esc(label)}) >>`);
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