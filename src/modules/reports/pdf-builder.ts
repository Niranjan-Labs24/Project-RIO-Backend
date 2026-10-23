import { chapterAnchorId, type CalloutTone, type CellTone, type DocSection, type DocTile, type ReportDoc } from "./report-doc";
import { PRESENTATION_PALETTE } from "./presentation/presentation.config";
import { hasArabic, shapeArabicAware, shapedWidth, getArabicFont, type ShapedChunk } from "./arabic-text";
import type { SupportedLocale } from "../translation/translation.types";
import { label } from "./i18n/report-labels";

// Dependency-free vector PDF renderer for a ReportDoc: a compact, professional
// 1–2 page layout — masthead, section headings, key/value blocks, tables, and
// real vector charts (bars, pies, gauge, radar), with a two-column primitive so
// related figures sit side by side.
//
// Text is Latin-1/WinAnsi — base Helvetica has no Arabic glyphs; common Unicode
// punctuation is folded to ASCII first. RIO-NFR-007 (Arabic RTL): any string
// containing Arabic script is detected in text()/textWidth() below and routed
// through arabic-text.ts instead — real contextual shaping and correct
// right-to-left run order via an embedded font (Amiri, SIL OFL), rather than
// esc()'s "?" fallback. Everything else in this file (wrap/truncate/table
// layout/right-align) is unaffected because it all goes through text()/
// textWidth(), which is the single chokepoint this fix hooks into.

export const PAGE_W = 612;
export const PAGE_H = 792;
export const LEFT = 46;
export const RIGHT = 46;
export const TOP = 50;
export const BOTTOM = 42;
export const CONTENT_W = PAGE_W - LEFT - RIGHT;

// Palette (r g b, 0–1), from the client's report design (NCNP feedback,
// Sept 2026 — hex values in presentation/presentation.config.ts).
const hex = (h: string): string =>
  [1, 3, 5].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255).toFixed(3)).join(" ");
export const ACCENT = hex(PRESENTATION_PALETTE.primaryText);
export const GRAY = "0.45 0.45 0.45";
export const LIGHT = hex(PRESENTATION_PALETTE.panel);
export const BAR = hex(PRESENTATION_PALETTE.accent);
const TONE: Record<CellTone, string> = {
  danger: hex(PRESENTATION_PALETTE.danger),
  ok: hex(PRESENTATION_PALETTE.strong),
  strong: hex(PRESENTATION_PALETTE.primaryText),
  medium: hex("#a8871a"),
};
const BAND_COLOR = {
  VERY_LOW: hex(PRESENTATION_PALETTE.veryLow),
  MEDIUM: hex(PRESENTATION_PALETTE.medium),
  STRONG: hex(PRESENTATION_PALETTE.strong),
} as const;
const CARD_BORDER = hex(PRESENTATION_PALETTE.cardBorder);
/** The design's table header: a light teal tint rather than grey. */
const HEADER_TINT = hex("#e4efed");
const MUTED = hex(PRESENTATION_PALETTE.muted);
const INK = "0.11 0.13 0.15";
/** Callout edge and label colours by tone (the medium label is darkened so it
 *  stays readable on the light panel). */
const EDGE: Record<CalloutTone, string> = {
  ok: hex(PRESENTATION_PALETTE.strong),
  medium: hex(PRESENTATION_PALETTE.medium),
  danger: hex(PRESENTATION_PALETTE.veryLow),
};
const EDGE_LABEL: Record<CalloutTone, string> = { ...EDGE, medium: hex("#a8871a") };
export const BLACK = "0 0 0";
export const WHITE = "1 1 1";
export const PIE_COLORS = ["0.16 0.47 0.84", "0.92 0.41 0.20", "0.10 0.69 0.48", "0.93 0.63 0.00", "0.91 0.48 0.64"];

function normalizeAscii(s: string): string {
  return s
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/…/g, "...")
    // The bullet folds to "-"; the middle dot is kept (StandardEncoding has
    // it), since "15-24 5 - 25-34 2" and "0 - 0 - 0" read as ranges.
    .replace(/[•]/g, "-")
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
    // Arabic exports: the "Open ›" link arrow, Arabic quotation marks, the
    // Arabic percent sign and maths symbols printed as "?" (Helvetica has no
    // glyph); bidi isolate / direction marks are invisible and are dropped.
    .replace(/›/g, ">")
    .replace(/‹/g, "<")
    .replace(/[«»]/g, '"')
    .replace(/÷/g, "/")
    .replace(/²/g, "2")
    .replace(/٪/g, "%")
    .replace(/[\u200E\u200F\u2060\u2066-\u2069]/g, "")
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
    // Middle dot: a placeholder here, its StandardEncoding code (octal 264)
    // after the escaping below, so its backslash is not doubled.
    out += ch === "\u00B7" ? "\u0001" : code >= 0x20 && code <= 0x7e ? ch : "?";
  }
  return out
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\u0001/g, "\\264");
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

function asciiTextWidth(str: string, size: number, bold = false): number {
  const table = bold ? HELV_BOLD_W : HELV_W;
  let units = 0;
  // Measure exactly what esc() draws: the folds widen symbols ("≥" → ">=",
  // "←" → "<-", "±" → "+/-"), and measuring the unfolded character made the
  // next chunk of an Arabic line overprint it ("حرجة،" ran into "≥50").
  for (const ch of normalizeAscii(str)) {
    const code = ch.codePointAt(0) ?? 0;
    // Anything off the table is drawn as "?" by esc(), so measure it as one.
    // Middle dot: periodcentered, 278 in both weights.
    units += code === 0xb7 ? 278 : ((code >= 32 && code <= 126 ? table[code - 32] : table[31]) ?? 556);
  }
  return (units * size) / 1000;
}
export function textWidth(str: string, size: number, bold = false): number {
  if (hasArabic(str)) {
    const chunks = shapeArabicAware(str, bold ? "bold" : "regular");
    return shapedWidth(chunks, size, (s, sz) => asciiTextWidth(s, sz, bold));
  }
  return asciiTextWidth(str, size, bold);
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

  // RIO-NFR-007 — page direction.
  //
  // Every rectangular thing this renderer draws (text runs, cell and row
  // backgrounds, bars, rules) is positioned by a left edge inside the current
  // column [rx, rx + rw]. Mirroring is therefore ONE formula applied at the
  // three primitives that place those edges, rather than per-section geometry
  // scattered through 1,500 lines:
  //
  //     x' = rx + rw - (x - rx) - width
  //
  // Because text and the boxes behind it go through the same formula, they stay
  // registered with each other: a right-aligned Arabic cell still sits inside
  // its own shaded background, and a bar that grew rightwards now grows
  // leftwards from the right edge, which is what an RTL reader expects.
  //
  // EVERY primitive mirrors, including the circular ones. Exempting them was
  // the first attempt and it was wrong: a pie's disc stayed at the left margin
  // while its legend — drawn with text() — mirrored to the right, so the two
  // landed on top of each other and the chart read as a solid blob with a label
  // through it. A figure and the text that describes it have to move together;
  // "a disc is symmetric so it does not matter" ignores that its POSITION does.
  dir: "ltr" | "rtl" = "ltr";
  /** The export language — for the few fixed words drawn inside a figure. */
  locale: SupportedLocale = "en";
  /** The client's design (ReportDoc.design): headings, key/values and the
   *  chapter furniture drawn in its style. */
  design = false;

  /** Mirror a left edge within the current column. Identity in LTR. */
  private mx(x: number, width: number): number {
    if (this.dir === "ltr") return x;
    return this.rx + this.rw - (x - this.rx) - width;
  }

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

  // RIO-NFR-007 — glyph id -> its width (1000-unit em, matching the /W array
  // convention every other font in this file already uses), for every glyph
  // this document actually draws from the embedded Arabic font. assemble()
  // only embeds the Arabic font objects at all when one of these is non-empty,
  // so a report with no Arabic content stays byte-for-byte the size it always
  // was — no embedded-font cost paid unless the document actually needs it.
  arabicGlyphWidthsRegular = new Map<number, number>();
  arabicGlyphWidthsBold = new Map<number, number>();

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
    // Mirrored by the run's own measured width, so a right-aligned line ends at
    // the column's right edge instead of starting there.
    x = this.mx(x, this.dir === "rtl" ? textWidth(str, size, bold) : 0);
    if (hasArabic(str)) {
      this.textArabicAware(x, baseline, size, bold, str, color);
      return;
    }
    const font = family === "serif" ? (bold ? "F3" : "F4") : bold ? "F1" : "F2";
    this.ops.push(`${color} rg BT /${font} ${size} Tf 1 0 0 1 ${x} ${this.py(baseline)} Tm (${esc(str)}) Tj ET`);
  }

  // RIO-NFR-007 — draws a string containing Arabic script, chunk by chunk in
  // final visual (left-to-right paint) order: a Latin/number chunk uses the
  // existing Helvetica path unchanged, an Arabic chunk uses the embedded
  // Arabic font's already-shaped glyph ids via Identity-H hex Tj. Each chunk
  // advances `x` by its own real shaped width so mixed Arabic/Latin content
  // (e.g. an Arabic sentence containing an English question ID) lines up
  // exactly the way textWidth() measured it for wrapping/right-align.
  private textArabicAware(x: number, baseline: number, size: number, bold: boolean, str: string, color: string): void {
    const chunks: ShapedChunk[] = shapeArabicAware(str, bold ? "bold" : "regular");
    const arabicFont = bold ? "F6" : "F5";
    const latinFont = bold ? "F1" : "F2";
    const widthMap = bold ? this.arabicGlyphWidthsBold : this.arabicGlyphWidthsRegular;
    let cursor = x;
    const y = this.py(baseline);
    for (const chunk of chunks) {
      if (chunk.kind === "latin") {
        if (chunk.text.length > 0) {
          this.ops.push(`${color} rg BT /${latinFont} ${size} Tf 1 0 0 1 ${cursor} ${y} Tm (${esc(chunk.text)}) Tj ET`);
        }
        cursor += asciiTextWidth(chunk.text, size, bold);
      } else {
        // The font's /W table holds ONE width per glyph, but Amiri's
        // positioning gives the same glyph a different advance in different
        // words. Overwriting the width with each new context moved letters
        // in every other word that uses the glyph — "الوصول" printed with
        // its alef pulled away from the rest. The first width seen stays in
        // /W; any other advance is a per-glyph TJ adjustment (thousandths of
        // an em, positive = move left).
        const parts = chunk.glyphIds.map((id, i) => {
          const advance = chunk.advances1000[i]!;
          if (!widthMap.has(id)) widthMap.set(id, advance);
          const adjust = widthMap.get(id)! - advance;
          const hex = `<${id.toString(16).padStart(4, "0")}>`;
          return adjust === 0 ? hex : `${hex} ${adjust}`;
        });
        if (parts.length > 0) {
          this.ops.push(`${color} rg BT /${arabicFont} ${size} Tf 1 0 0 1 ${cursor} ${y} Tm [${parts.join(" ")}] TJ ET`);
        }
        cursor += (chunk.advances1000.reduce((a, b) => a + b, 0) * size) / 1000;
      }
    }
  }
  // An unfilled rectangle border — used for card-style framing (e.g. KPI
  // stat tiles, a bordered page-content frame) where rect()'s solid fill
  // would be too heavy.
  strokeRect(x: number, w: number, h: number, color: string, thickness = 1): void {
    const top = this.y;
    // NOT mirrored here: it delegates to strokePath, which mirrors every vertex
    // itself. Doing both would reflect the rectangle twice and put it back
    // where it started.
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
  /** Rounded-rectangle path (PDF space) for the box at the current y. */
  private roundPath(x: number, w: number, h: number, r: number): string {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    const k = r * 0.5523;
    const x0 = this.mx(x, w);
    const x1 = x0 + w;
    const yb = this.py(this.y + h);
    const yt = this.py(this.y);
    const f = (n: number) => n.toFixed(2);
    return [
      `${f(x0 + r)} ${f(yb)} m`,
      `${f(x1 - r)} ${f(yb)} l`,
      `${f(x1 - r + k)} ${f(yb)} ${f(x1)} ${f(yb + r - k)} ${f(x1)} ${f(yb + r)} c`,
      `${f(x1)} ${f(yt - r)} l`,
      `${f(x1)} ${f(yt - r + k)} ${f(x1 - r + k)} ${f(yt)} ${f(x1 - r)} ${f(yt)} c`,
      `${f(x0 + r)} ${f(yt)} l`,
      `${f(x0 + r - k)} ${f(yt)} ${f(x0)} ${f(yt - r + k)} ${f(x0)} ${f(yt - r)} c`,
      `${f(x0)} ${f(yb + r)} l`,
      // Ends exactly where it began, at the middle of a straight edge, so no
      // explicit close is needed (and the path stays distinguishable from the
      // closed pie wedges the chart checks look for).
      `${f(x0)} ${f(yb + r - k)} ${f(x0 + r - k)} ${f(yb)} ${f(x0 + r)} ${f(yb)} c`,
    ].join(" ");
  }
  /** A rounded box at the current y: filled, outlined, or both. */
  roundRect(x: number, w: number, h: number, r: number, fill: string | null, stroke: string | null, lineW = 0.8): void {
    const path = this.roundPath(x, w, h, r);
    if (fill && stroke) this.ops.push(`${fill} rg ${stroke} RG ${lineW} w ${path} B`);
    else if (fill) this.ops.push(`${fill} rg ${path} f`);
    else if (stroke) this.ops.push(`${stroke} RG ${lineW} w ${path} S`);
  }
  /** Clip what follows to a rounded box at the current y, until unclip(). */
  clipRound(x: number, w: number, h: number, r: number): void {
    this.ops.push(`q ${this.roundPath(x, w, h, r)} W n`);
  }
  unclip(): void {
    this.ops.push("Q");
  }
  rect(x: number, w: number, h: number, color: string): void {
    this.ops.push(`${color} rg ${this.mx(x, w)} ${this.py(this.y + h)} ${w} ${h} re f`);
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
    const cx = this.mx(xLeft, 2 * r) + r;
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
    cxAbs = this.mx(cxAbs, 0);
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
    points = points.map(([x, y]): [number, number] => [this.mx(x, 0), y]);
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
    points = points.map(([x, y]): [number, number] => [this.mx(x, 0), y]);
    const [x0, y0] = points[0]!;
    const parts = [`${color} rg ${x0.toFixed(2)} ${this.py(y0).toFixed(2)} m`];
    for (let i = 1; i < points.length; i++) {
      const [x, y] = points[i]!;
      parts.push(`${x.toFixed(2)} ${this.py(y).toFixed(2)} l`);
    }
    parts.push("h f");
    this.ops.push(parts.join(" "));
  }
  /** Clip what follows to a closed polygon, until unclip(). Mirrors like
   *  fillPolygon. */
  clipPolygon(points: Array<[number, number]>): void {
    if (points.length === 0) return;
    const pts = points.map(([x, y]): [number, number] => [this.mx(x, 0), y]);
    const parts = pts.map(([x, y], i) => `${x.toFixed(2)} ${this.py(y).toFixed(2)} ${i === 0 ? "m" : "l"}`);
    this.ops.push(`q ${parts.join(" ")} h W n`);
  }
  /** Draw `fn` rotated by `deg` (counter-clockwise) about a point given in
   *  layout coordinates (left edge mirrored like every other primitive). Used
   *  for the usage-status watermark. */
  withRotation(cx: number, cyFromTop: number, deg: number, fn: () => void): void {
    const x = this.mx(cx, 0);
    const y = this.py(cyFromTop);
    const r = (deg * Math.PI) / 180;
    const c = Math.cos(r).toFixed(4);
    const s = Math.sin(r).toFixed(4);
    const f = (n: number) => n.toFixed(2);
    this.ops.push(`q 1 0 0 1 ${f(x)} ${f(y)} cm ${c} ${s} ${(-Math.sin(r)).toFixed(4)} ${c} 0 0 cm 1 0 0 1 ${f(-x)} ${f(-y)} cm`);
    fn();
    this.ops.push("Q");
  }
  /** Draw `fn` see-through (every page declares the /GSwm opacity), so a
   *  watermark laid over the content leaves the text under it legible. */
  withWatermarkOpacity(fn: () => void): void {
    this.ops.push("q /GSwm gs");
    fn();
    this.ops.push("Q");
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

  /** 1-based page an anchor was registered on, or null — for a contents
   *  line that states real page numbers from a first render pass. */
  anchorPage(id: string): number | null {
    const a = this.anchors.get(id);
    return a ? a.pageIndex + 1 : null;
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
      { regular: this.arabicGlyphWidthsRegular, bold: this.arabicGlyphWidthsBold },
    );
  }
}

function renderHeader(pdf: Pdf, doc: ReportDoc): void {
  // As the client's design: the report title large in teal, wrapped rather
  // than cut (the subject after the dash is what tells sibling reports apart),
  // the organisation as a badge on the opposite side, then the reference
  // details in a light rounded panel.
  const badge = doc.badge?.trim();
  const BADGE_SIZE = 8;
  const badgeW = badge ? Math.min(textWidth(badge, BADGE_SIZE, true) + 20, CONTENT_W * 0.38) : 0;
  const titleW = CONTENT_W - (badge ? badgeW + 16 : 0);
  const top = pdf.y;
  if (badge) {
    const lbl = truncate(badge, BADGE_SIZE, badgeW - 16, true);
    pdf.roundRect(LEFT + CONTENT_W - badgeW, badgeW, 24, 4, LIGHT, hex(PRESENTATION_PALETTE.summaryLabel), 0.8);
    pdf.y = top + 8;
    pdf.text(LEFT + CONTENT_W - badgeW + (badgeW - textWidth(lbl, BADGE_SIZE, true)) / 2, BADGE_SIZE, true, lbl, ACCENT);
    // The badge is the owning organisation; NCNP is named as platform owner.
    const owner = truncate(label("presentation.platformOwner", pdf.dir === "rtl" ? "ar" : "en"), 7, CONTENT_W * 0.45);
    pdf.y = top + 30;
    pdf.text(LEFT + CONTENT_W - textWidth(owner, 7), 7, false, owner, MUTED);
  }
  const [typeName, ...subjectParts] = doc.title.split("—");
  const heading = (typeName ?? doc.title).trim();
  const subject = subjectParts.join("—").trim();
  pdf.y = top;
  for (const ln of wrap(subject ? `${heading} — ${subject}` : heading, 17, titleW, true)) {
    pdf.text(LEFT, 17, true, ln, ACCENT);
    pdf.y += 21;
  }
  pdf.y = Math.max(pdf.y, top + (badge ? 40 : 28)) + 8;
  if (doc.headerBand.length) {
    // Single full-width row per field, wrapped rather than truncated — a
    // fixed two-column grid left long values (e.g. a Methodology Version
    // sentence) truncated mid-word since each value only got ~154pt.
    const PAD = 12;
    const labelW = 110;
    const valW = CONTENT_W - labelW - PAD * 2;
    const size = 8;
    const LINE = 11.5;
    const linesPerRow = doc.headerBand.map((m) => wrap(m.value, size, valW));
    const bandH = linesPerRow.reduce((h, lines) => h + Math.max(1, lines.length) * LINE, 0) + PAD * 2 - 3;
    pdf.roundRect(LEFT, CONTENT_W, bandH, 8, LIGHT, null);
    let rowY = pdf.y + PAD;
    doc.headerBand.forEach((m, i) => {
      const x = LEFT + PAD;
      pdf.y = rowY;
      pdf.text(x, size, true, m.label, BAR);
      const lines = linesPerRow[i]!;
      lines.forEach((ln, li) => {
        pdf.y = rowY + li * LINE;
        pdf.text(x + labelW, size, false, ln, INK);
      });
      rowY += Math.max(1, lines.length) * LINE;
    });
    pdf.y = rowY + PAD - 3;
  }
  pdf.y += 16;
}

export function heading(pdf: Pdf, text: string): void {
  if (pdf.design) {
    // Room for the heading and the start of what it heads, so a heading is
    // never left alone at the foot of a page.
    pdf.ensure(80);
    for (const ln of wrap(text, 13, pdf.rw, true)) {
      pdf.text(pdf.rx, 13, true, ln, ACCENT);
      pdf.y += 17;
    }
    // Underlined, as the report's headings always were.
    pdf.y += 1;
    pdf.rule(hex(PRESENTATION_PALETTE.summaryDivider), 0.8);
    pdf.y += 9;
    return;
  }
  pdf.ensure(22);
  pdf.y += 4;
  pdf.text(pdf.rx, 11.5, true, truncate(text, 11.5, pdf.rw), ACCENT);
  pdf.y += 14;
  pdf.rule(GRAY, 0.5);
  pdf.y += 5;
}

function renderKeyValue(pdf: Pdf, rows: Array<{ label: string; value: string }>): void {
  const size = pdf.design ? 10 : 8.5;
  const LINE = pdf.design ? 13.5 : 11;
  // The design keeps a clear, even gap between label and value, and one
  // label column width for every block on the page where it fits.
  const GAP = pdf.design ? 24 : 10;
  // The label column is measured from the labels themselves rather than fixed
  // at 150pt. A fixed column truncated every long label in "Calculation Basis
  // - Thresholds Applied" ("Severity at or above which a sust..") while its
  // two-digit value sat alone in half a page of white space. Bounded at 62% of
  // the region so one very long label still cannot squeeze the values out, and
  // labels now WRAP rather than truncate - a threshold a reader cannot finish
  // reading is, to them, a threshold that was never stated.
  const labelNeed = Math.max(0, ...rows.map((r) => textWidth(r.label, size, true))) + GAP;
  const valueNeed = Math.max(0, ...rows.map((r) => textWidth(r.value, size)));
  const labelW = pdf.design
    ? Math.min(pdf.rw * 0.45, Math.max(170, labelNeed))
    : labelNeed + valueNeed <= pdf.rw
      ? Math.max(60, labelNeed)
      : Math.max(60, Math.min(labelNeed, pdf.rw * 0.62));
  const valX = pdf.rx + labelW;
  const valW = pdf.rx + pdf.rw - valX;
  for (const [i, { label, value }] of rows.entries()) {
    const labelLines = wrap(label, size, labelW - GAP, true);
    const valueLines = wrap(value, size, valW);
    const lineCount = Math.max(labelLines.length, valueLines.length);
    pdf.ensure(lineCount * LINE + 2);
    // Both columns are drawn from the SAME top, so a wrapped label and a
    // wrapped value stay on the rows they belong to.
    const top = pdf.y + (pdf.design ? 4 : 0);
    labelLines.forEach((ln, i) => {
      pdf.y = top + i * LINE;
      pdf.text(pdf.rx + 1, size, true, ln, pdf.design ? BAR : BLACK);
    });
    valueLines.forEach((ln, i) => {
      pdf.y = top + i * LINE;
      pdf.text(valX, size, false, ln, pdf.design ? INK : BLACK);
    });
    pdf.y = top + lineCount * LINE + 1.5;
    // The design's rows are separated by a hairline, as in its tables.
    if (pdf.design && i < rows.length - 1) {
      pdf.y += 3;
      pdf.rule(CARD_BORDER, 0.6);
    }
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
  tones?: Array<Array<CellTone | null>>,
  roomy = false,
): void {
  const n = columns.length || 1;
  // The design's tables: larger type (stepping down only as columns are
  // added), padded rows, hairline separators, a teal-tinted header.
  const designed = roomy || pdf.design;
  const size = designed
    ? n <= 6
      ? 10
      : n <= 8
        ? 9.5
        : n <= 10
          ? 8.5
          : 8
    : n > 6
      ? 7
      : n > 4
        ? 7.5
        : 8.5;
  // Vertical padding inside each row, and the gap between wrapped lines.
  const PADV = designed ? 7 : 0;
  const LEAD = designed ? size + 3 : size + 1;
  // Room at the row end for the drill chevron, so it never sits on a value.
  const GUTTER = rowLinks?.some((l) => l !== null) ? 16 : 0;
  const tableW = pdf.rw - GUTTER;
  // Horizontal room a cell keeps free (badge outline and side padding).
  const INSET = roomy ? (n > 5 ? 20 : 26) : designed ? (n > 8 ? 8 : 10) : 6;
  const rowH = size + 5 + PADV * 2;

  // Minimum width per column = whatever CANNOT be broken: its own header, and
  // the widest unbreakable word in its cells. Sizing on the header alone left
  // "Domain" 32pt wide, so every "Livelihood" printed as "Livel.." — the column
  // was legally full while its only value was unreadable.
  const minW = columns.map((c, i) => {
    // Design-style headers wrap, so only their longest word is unbreakable.
    const header = designed ? widestWord(c, size, true) : textWidth(c, size, true);
    // A badge (coloured word cell) reads as one unit, so it is not wrapped.
    const word = Math.max(
      0,
      ...rows.map((r, ri) =>
        roomy && tones?.[ri]?.[i] && tones[ri][i] !== "strong"
          ? textWidth(r[i] ?? "", size - 0.5) + 14
          : widestWord(r[i] ?? "", size),
      ),
    );
    // +12 is the cell's own padding (3pt in, 3pt out) plus a hair of gutter, so
    // two adjacent columns never read as one run of text.
    return (
      Math.max(header, word) + (roomy ? (n > 5 ? 22 : 28) : designed ? (n > 8 ? 10 : 14) : 12)
    );
  });
  const minSum = minW.reduce((a, b) => a + b, 0) || 1;
  // How much room each column's FULL content wants, measured the same way it
  // is drawn - character-width totals, not a character count, or a prose column
  // of narrow lowercase claims slack that an all-caps column actually needs.
  const wantW = columns.map((c, i) =>
    Math.max(textWidth(c, size, true), ...rows.map((r) => textWidth(r[i] ?? "", size))),
  );

  let widths: number[];
  if (minSum <= tableW) {
    // Everything unbreakable fits. Hand out the slack proportional to how much
    // each column's full content still overflows, so a long prose column (Notes)
    // takes most of it without starving the short ones.
    const extra = tableW - minSum;
    const overflow = wantW.map((want, i) => Math.max(0, want - minW[i]!));
    const totalOverflow = overflow.reduce((a, b) => a + b, 0);
    widths = minW.map((w, i) => w + (totalOverflow > 0 ? (overflow[i]! / totalOverflow) * extra : extra / n));
  } else {
    // Too many columns for the page. Scale the minimums down together — some
    // mid-word truncation is then unavoidable, and the right fix is a narrower
    // column set (see report-doc's compact vs full need-record columns).
    widths = minW.map((w) => Math.max(26, (w / minSum) * tableW));
  }
  const sum = widths.reduce((a, b) => a + b, 0);
  if (sum > tableW) widths = widths.map((w) => (w / sum) * tableW);

  const xs: number[] = [];
  let cursor = pdf.rx;
  for (const w of widths) {
    xs.push(cursor);
    cursor += w;
  }
  // The design's tables read left to right throughout, figures included.
  const numeric = columns.map((_, i) => !designed && isNumericColumn(rows, i));
  // Prose cells (a Notes column) wrap over several lines rather than being cut
  // off — a reason a reader cannot finish reading is no reason at all.
  const MAX_LINES = 4;
  const rowHeight = (cells: string[], wrapCells: boolean, bold = false): number => {
    const cellLines = cells.map((c, i) => {
      const w = widths[i] ?? 40;
      if (!wrapCells) return [truncate(c, size, w - INSET, bold)];
      const lines = wrap(c, size, w - INSET, bold);
      if (lines.length <= MAX_LINES) return lines;
      return [...lines.slice(0, MAX_LINES - 1), truncate(lines.slice(MAX_LINES - 1).join(" "), size, w - INSET, bold)];
    });
    const lineCount = Math.max(1, ...cellLines.map((l) => l.length));
    return size + 5 + PADV * 2 + (lineCount - 1) * LEAD;
  };
  const drawRow = (
    cells: string[],
    bold: boolean,
    wrapCells: boolean,
    rowTones?: Array<CellTone | null>,
  ) => {
    const cellLines = cells.map((c, i) => {
      const w = widths[i] ?? 40;
      if (!wrapCells) return [truncate(c, size, w - INSET, bold)];
      const lines = wrap(c, size, w - INSET, bold);
      if (lines.length <= MAX_LINES) return lines;
      return [...lines.slice(0, MAX_LINES - 1), truncate(lines.slice(MAX_LINES - 1).join(" "), size, w - INSET, bold)];
    });
    const lineCount = Math.max(1, ...cellLines.map((l) => l.length));
    const h = size + 5 + PADV * 2 + (lineCount - 1) * LEAD;
    const top = pdf.y;
    cellLines.forEach((lines, i) => {
      const w = widths[i] ?? 40;
      const cx = xs[i] ?? pdf.rx;
      const tone = rowTones?.[i];
      // A coloured word cell ("Fully concentrated", "Not yet — …") is a badge
      // in the design: outlined in its colour, regular weight.
      const badge = roomy && !!tone && tone !== "strong" && /[^\d\s.,%—-]/.test(cells[i] ?? "");
      if (badge) {
        const bw = Math.min(w - 6, Math.max(...lines.map((ln) => textWidth(ln, size - 0.5))) + 18);
        pdf.y = top + PADV - 4;
        pdf.roundRect(cx + 4, bw, lines.length * LEAD + 6, 4, null, TONE[tone], 0.8);
      }
      lines.forEach((ln, li) => {
        pdf.y = top + PADV + li * LEAD;
        if (badge) {
          pdf.text(cx + 13, size - 0.5, false, ln, TONE[tone]);
          return;
        }
        pdf.text(
          numeric[i] ? cx + w - 4 - textWidth(ln, size, bold || !!tone) : cx + (designed ? 8 : 3),
          size,
          bold || !!tone,
          ln,
          tone ? TONE[tone] : bold && designed ? ACCENT : designed ? INK : BLACK,
        );
      });
    });
    pdf.y = top + h;
  };
  const drawHeader = () => {
    pdf.rect(pdf.rx, pdf.rw, designed ? rowHeight(columns, true, true) : rowH, designed ? HEADER_TINT : LIGHT);
    drawRow(columns, true, designed);
    pdf.rule(designed ? hex(PRESENTATION_PALETTE.summaryDivider) : GRAY, designed ? 0.9 : 0.5);
    if (!designed) pdf.y += 2;
  };
  const headerH = rowHeight(columns, designed, true);
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
      // A drawn chevron in its own gutter, so it never overlaps a value.
      const mx = pdf.rx + pdf.rw - 10;
      const my = pdf.y + PADV + size * 0.5;
      pdf.strokePath(
        [
          [mx, my - 3.5],
          [mx + 3.5, my],
          [mx, my + 3.5],
        ],
        BAR,
        1.4,
      );
    }
    drawRow(row, false, true, tones?.[i] ?? undefined);
    if (designed && i < rows.length - 1) pdf.rule(CARD_BORDER, 0.6);
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
    pdf.text(x + 8, 7.5, true, pdf.locale === "en" ? "View detail >" : label("pdf.viewDetail", pdf.locale), ACCENT);

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
  // The catalogue wording is for the 0-100 severity scale; English keeps its
  // existing text.
  const scale = pdf.locale !== "en" && max === 100 ? label("scale.severity", pdf.locale) : `0-${max} - higher = worse`;
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
  const size = pdf.design ? 10 : 8.5;
  const line = pdf.design ? 14 : 11;
  for (const item of items) {
    const lines = wrap(item, size, textW);
    pdf.ensure(lines.length * line + 1);
    lines.forEach((ln, i) => {
      pdf.text(pdf.rx + 2, size, false, i === 0 ? `- ${ln}` : `  ${ln}`, pdf.design ? INK : BLACK);
      pdf.y += line;
    });
    pdf.y += 2;
  }
}

function renderSubheading(pdf: Pdf, text: string): void {
  const size = pdf.design ? 9.5 : 7.5;
  const line = pdf.design ? 13 : 10;
  for (const ln of wrap(text, size, pdf.rw)) {
    pdf.ensure(line);
    pdf.text(pdf.rx, size, false, ln, BAR);
    pdf.y += line;
  }
  pdf.y += pdf.design ? 6 : 3;
}

/** The one-page executive summary: a dark teal panel of labelled columns. */
function renderSummaryPanel(
  pdf: Pdf,
  title: string,
  columns: Array<{ label: string; text: string; lead?: string; caveat?: string }>,
): void {
  const PAD = 20;
  const GAP = 16;
  const SIZE = 10.5;
  const LINE = 15;
  const n = columns.length || 1;
  const colW = (pdf.rw - PAD * 2 - GAP * (n - 1)) / n;
  const bodies = columns.map((c) => ({
    lead: c.lead ? wrap(c.lead, SIZE, colW, true) : [],
    text: wrap(c.text, SIZE, colW),
    caveat: c.caveat ? wrap(c.caveat, 9, colW) : [],
  }));
  const bodyH = Math.max(
    ...bodies.map((b) => (b.lead.length + b.text.length) * LINE + (b.caveat.length ? 4 + b.caveat.length * 11 : 0)),
  );
  const titleLines = wrap(title, 15, pdf.rw - PAD * 2, true);
  const head = titleLines.length * 19 + 10;
  const h = PAD + head + 14 + 16 + bodyH + PAD - 4;
  pdf.ensure(h + 6);
  const top = pdf.y;
  pdf.roundRect(pdf.rx, pdf.rw, h, 10, hex(PRESENTATION_PALETTE.primary), null);
  pdf.y = top + PAD;
  for (const ln of titleLines) {
    pdf.text(pdf.rx + PAD, 15, true, ln, WHITE);
    pdf.y += 19;
  }
  pdf.y = top + PAD + head;
  pdf.rect(pdf.rx + PAD, pdf.rw - PAD * 2, 1.2, hex(PRESENTATION_PALETTE.summaryDivider));
  const colTop = top + PAD + head + 14;
  // Columns run in reading order: left to right in English, right to left in
  // Arabic (the page is mirrored by pdf.dir, so x is laid out LTR here).
  columns.forEach((c, i) => {
    const x = pdf.rx + PAD + i * (colW + GAP);
    pdf.y = colTop;
    pdf.text(x, 8, true, truncate(c.label.toUpperCase(), 8, colW, true), hex(PRESENTATION_PALETTE.summaryLabel));
    pdf.y += 16;
    const b = bodies[i]!;
    for (const ln of b.lead) {
      pdf.text(x, SIZE, true, ln, WHITE);
      pdf.y += LINE;
    }
    for (const ln of b.text) {
      pdf.text(x, SIZE, false, ln, WHITE);
      pdf.y += LINE;
    }
    if (b.caveat.length) pdf.y += 4;
    for (const ln of b.caveat) {
      pdf.text(x, 8, false, ln, "0.85 0.90 0.90");
      pdf.y += 11;
    }
  });
  pdf.y = top + h;
}

/** Confidence level by sample size: coloured segments, a marker under the
 *  current band, and the explanatory line. */
function renderBandScale(
  pdf: Pdf,
  segments: Array<{ band: "VERY_LOW" | "MEDIUM" | "STRONG"; label: string; grow: number; active: boolean }>,
  note: string,
): void {
  const H = 22;
  const SIZE = 8;
  pdf.ensure(H + 44);
  const top = pdf.y;
  const total = segments.reduce((n, g) => n + g.grow, 0) || 1;
  pdf.clipRound(pdf.rx, pdf.rw, H, 4);
  let x = pdf.rx;
  for (const g of segments) {
    const w = (g.grow / total) * pdf.rw;
    pdf.y = top;
    pdf.rect(x, w, H, BAND_COLOR[g.band]);
    const lbl = truncate(g.label, SIZE, w - 6, true);
    pdf.y = top + (H - SIZE) / 2 - 0.5;
    pdf.text(x + (w - textWidth(lbl, SIZE, true)) / 2, SIZE, true, lbl, WHITE);
    x += w;
  }
  pdf.unclip();
  // The marker under the current band.
  x = pdf.rx;
  for (const g of segments) {
    const w = (g.grow / total) * pdf.rw;
    if (g.active) {
      const cx = x + w / 2;
      pdf.fillPolygon(
        [
          [cx - 5, top + H + 10],
          [cx + 5, top + H + 10],
          [cx, top + H + 3],
        ],
        INK,
      );
    }
    x += w;
  }
  pdf.y = top + H + 18;
  for (const ln of wrap(note, 9.5, pdf.rw)) {
    pdf.ensure(13);
    pdf.text(pdf.rx, 9.5, false, ln, BAR);
    pdf.y += 13;
  }
}

/** Design card: rounded outline, padded, its title and hint inside. Measured
 *  on a scratch page first so the frame fits what is drawn; a card taller than
 *  a page is drawn unframed rather than split. */
const CARD_PAD = 18;
function cardBody(pdf: Pdf, s: Extract<DocSection, { kind: "card" }>): void {
  const end = pdf.column(pdf.rx + CARD_PAD, pdf.rw - CARD_PAD * 2, pdf.y + CARD_PAD, () => {
    if (s.heading) {
      for (const ln of wrap(s.heading, 13, pdf.rw, true)) {
        pdf.ensure(18);
        pdf.text(pdf.rx, 13, true, ln, ACCENT);
        pdf.y += 17;
      }
    }
    if (s.hint) {
      pdf.y += 1;
      for (const ln of wrap(s.hint, 9, pdf.rw)) {
        pdf.text(pdf.rx, 9, false, ln, BAR);
        pdf.y += 12;
      }
    }
    if (s.heading || s.hint) pdf.y += 10;
    s.children.forEach((child, i) => {
      // Sections of one chapter, each under its own heading, are separated
      // by a hairline rather than boxed separately.
      // Headed sections carry their own underline; a gap separates them.
      const headed = "heading" in child && !!child.heading && child.kind !== "card";
      if (i) pdf.y += headed ? 18 : 10;
      renderSection(pdf, child);
    });
  });
  pdf.y = end + CARD_PAD;
}

function renderCard(pdf: Pdf, s: Extract<DocSection, { kind: "card" }>): void {
  const probe = new Pdf();
  probe.dir = pdf.dir;
  probe.design = pdf.design;
  probe.rx = pdf.rx;
  probe.rw = pdf.rw;
  probe.y = TOP;
  cardBody(probe, s);
  const h = probe.y - TOP;
  const spaceLeft = PAGE_H - BOTTOM - pdf.y;
  if (probe.pageCount > 1 || (s.flow && h > spaceLeft)) {
    cardBody(pdf, s);
    return;
  }
  pdf.ensure(h);
  const top = pdf.y;
  pdf.roundRect(pdf.rx, pdf.rw, h, 10, WHITE, CARD_BORDER, 1);
  cardBody(pdf, s);
  pdf.y = top + h;
}

/** Ring segment colours, one per share (Male, Female, …), as the earlier
 *  pie's distinct colours so every share can be told apart. */
const RING_COLORS = ["#4a80b4", "#e07a3f", "#59a694", "#dccf6e", "#b05a8c"].map(hex);
const RING_TRACK = hex("#e3e8e6");

/** The design's demographic rings, side by side: each share an arc in its own
 *  colour, the breakdown's name and a coloured legend beneath. */
function renderRings(pdf: Pdf, items: Array<{ label: string; slices: Array<{ label: string; value: number }> }>): void {
  const R = 38;
  const W = 11;
  const n = Math.max(1, items.length);
  const colW = pdf.rw / Math.max(n, 2);
  const offset = (pdf.rw - colW * n) / 2;
  const LEG = 13;
  const legendRows = Math.max(...items.map((it) => it.slices.length), 1);
  const h = R * 2 + W + 30 + legendRows * LEG;
  pdf.ensure(h);
  const top = pdf.y;
  items.forEach((it) => {
    const i = items.indexOf(it);
    const cx = pdf.rx + offset + colW * i + colW / 2;
    const cy = top + W / 2 + R;
    const total = it.slices.reduce((a, b2) => a + b2.value, 0);
    const arc = (from: number, to: number): Array<[number, number]> => {
      const steps = Math.max(2, Math.ceil((to - from) * 60));
      return Array.from({ length: steps + 1 }, (_, k) => {
        const a2 = -Math.PI / 2 + 2 * Math.PI * (from + ((to - from) * k) / steps);
        return [cx + R * Math.cos(a2), cy + R * Math.sin(a2)] as [number, number];
      });
    };
    pdf.strokePath(arc(0, 1), RING_TRACK, W);
    let at = 0;
    it.slices.forEach((x, k) => {
      const share = total > 0 ? x.value / total : 0;
      if (share > 0) pdf.strokePath(arc(at, at + share), RING_COLORS[k % RING_COLORS.length]!, W);
      at += share;
    });
    pdf.y = top + R * 2 + W + 8;
    const name = truncate(it.label, 10.5, colW - 8, true);
    pdf.text(cx - textWidth(name, 10.5, true) / 2, 10.5, true, name, INK);
    pdf.y += 17;
    // Legend: a colour dot per share, then "Male 25%".
    it.slices.forEach((x, k) => {
      const pct = total > 0 ? Math.round((x.value / total) * 100) : 0;
      const txt = truncate(`${x.label} ${pct}%`, 9.5, colW - 24);
      const w = textWidth(txt, 9.5) + 12;
      const x0 = cx - w / 2;
      pdf.disc(x0 + 3.5, pdf.y + 4.5, 3.5, RING_COLORS[k % RING_COLORS.length]!);
      pdf.text(x0 + 12, 9.5, false, txt, INK);
      pdf.y += LEG;
    });
  });
  pdf.y = top + h;
}

/** Every top-level section framed as a design card, its heading inside. */
function designCard(s: DocSection): DocSection {
  switch (s.kind) {
    case "anchor":
    case "pageBreak":
    case "breadcrumb":
    case "navGrid":
    case "card":
    case "summaryPanel":
      return s;
    case "columns":
      return { kind: "card", heading: "", children: [s] };
    default: {
      const heading = "heading" in s ? s.heading : "";
      return { kind: "card", heading, children: [{ ...s, heading: "" } as DocSection] };
    }
  }
}

function renderCaption(pdf: Pdf, text: string): void {
  pdf.ensure(28);
  for (const ln of wrap(text.toUpperCase(), 8.5, pdf.rw, true)) {
    pdf.text(pdf.rx, 8.5, true, ln, BAR);
    pdf.y += 12;
  }
  pdf.y += 4;
}

function renderCallouts(pdf: Pdf, items: Array<{ label: string; text: string; tone: CalloutTone }>): void {
  const GAP = 10;
  const PAD = 12;
  const SIZE = 10;
  const LINE = 14.5;
  const n = items.length || 1;
  const w = (pdf.rw - GAP * (n - 1)) / n;
  const inner = w - PAD * 2 - 3;
  const bodies = items.map((it) => ({
    label: wrap(it.label.toUpperCase(), 8, inner, true),
    text: wrap(it.text, SIZE, inner),
  }));
  const h = PAD * 2 + Math.max(...bodies.map((b) => b.label.length * 11 + 6 + b.text.length * LINE)) - 3;
  pdf.ensure(h + 2);
  const top = pdf.y;
  items.forEach((it, i) => {
    const x = pdf.rx + i * (w + GAP);
    pdf.y = top;
    pdf.clipRound(x, w, h, 5);
    pdf.rect(x, w, h, LIGHT);
    pdf.rect(x, 3.5, h, EDGE[it.tone]);
    pdf.unclip();
    let y = top + PAD;
    for (const ln of bodies[i]!.label) {
      pdf.y = y;
      pdf.text(x + PAD + 3, 8, true, ln, EDGE_LABEL[it.tone]);
      y += 10;
    }
    y += 5;
    for (const ln of bodies[i]!.text) {
      pdf.y = y;
      pdf.text(x + PAD + 3, SIZE, false, ln, INK);
      y += LINE;
    }
  });
  pdf.y = top + h;
}

function renderPanel(pdf: Pdf, text: string): void {
  const PAD = 12;
  const SIZE = 10;
  const LINE = 14.5;
  const lines = wrap(text, SIZE, pdf.rw - PAD * 2);
  const h = PAD * 2 + lines.length * LINE - 3;
  pdf.ensure(h);
  const top = pdf.y;
  pdf.roundRect(pdf.rx, pdf.rw, h, 5, LIGHT, null);
  lines.forEach((ln, i) => {
    pdf.y = top + PAD + i * LINE;
    pdf.text(pdf.rx + PAD, SIZE, false, ln, INK);
  });
  pdf.y = top + h;
}

function renderFootnote(pdf: Pdf, text: string): void {
  pdf.ensure(30);
  pdf.y += 3;
  pdf.rule(CARD_BORDER, 0.8);
  pdf.y += 10;
  for (const ln of wrap(text, 9.5, pdf.rw)) {
    pdf.text(pdf.rx, 9.5, false, ln, MUTED);
    pdf.y += 13;
  }
}

function renderNote(pdf: Pdf, text: string): void {
  const size = pdf.design ? 10 : 8.5;
  const line = pdf.design ? 14 : 11;
  for (const ln of wrap(text, size, pdf.rw - 4)) {
    pdf.ensure(line + 1);
    pdf.text(pdf.rx + 2, size, false, ln, pdf.design ? "0.22 0.25 0.28" : GRAY);
    pdf.y += line;
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
  // A small table moves to the next page whole; keep its heading with it.
  if (pdf.design && s.kind === "table" && s.heading && s.rows.length <= 20) {
    pdf.ensure(Math.min(PAGE_H - TOP - BOTTOM - 40, 70 + s.rows.length * 30));
  }
  if ("heading" in s && s.heading && s.kind !== "pageBreak" && s.kind !== "card") heading(pdf, s.heading);
  switch (s.kind) {
    case "keyvalue": return renderKeyValue(pdf, s.rows);
    case "table":
      if (s.subheading) renderSubheading(pdf, s.subheading);
      return renderTable(pdf, s.columns, s.rows, s.rowLinks, s.tones, s.roomy);
    case "summaryPanel": return renderSummaryPanel(pdf, s.title, s.columns);
    case "bandScale": return renderBandScale(pdf, s.segments, s.note);
    case "card": return renderCard(pdf, s);
    case "caption": return renderCaption(pdf, s.text);
    case "callouts": return renderCallouts(pdf, s.items);
    case "panel": return renderPanel(pdf, s.text);
    case "footnote": return renderFootnote(pdf, s.text);
    case "rings": return renderRings(pdf, s.items);
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
  locale: SupportedLocale = "en",
): Pdf {
  const pdf = new Pdf(knownAnchorIds);
  pdf.dir = locale === "ar" ? "rtl" : "ltr";
  pdf.locale = locale;
  pdf.design = doc.design === true;
  renderHeader(pdf, doc);
  // One-page summary and the other presentation blocks, before anything else —
  // each its own rounded card, as in the client's design.
  for (const section of doc.lead ?? []) {
    renderSection(pdf, section);
    pdf.y += 16;
  }
  // The contents grid starts on its own page rather than as an orphaned
  // heading under the summary.
  if (doc.lead?.length && doc.chapters?.length) pdf.newPage();

  if (doc.chapters?.length) {
    // Page 1 is the contents grid; each chapter follows.
    renderContentsPage(pdf, doc.chapters, mode, locale);
    if (doc.audit.length) {
      if (pdf.design) pdf.y += 8;
      renderSection(pdf, frame(pdf, { kind: "keyvalue", heading: label("pdf.auditTrail", locale), rows: doc.audit }));
    }
    const canvasPage = pdf.pageCount; // first page after the contents
    // In layer mode chapters overlay onto the same canvas pages, so the file
    // does not grow to the sum of every chapter's length.
    pdf.overlay = mode === "layers";
    doc.chapters.forEach((chapter, i) => renderChapter(pdf, chapter, i, canvasPage, mode, locale));
    pdf.overlay = false;
    return pdf;
  }

  if (pdf.design) {
    renderSection(pdf, { kind: "card", heading: "", children: doc.sections, flow: true });
    pdf.y += 14;
  } else {
    for (const section of doc.sections) {
      renderSection(pdf, section);
      pdf.y += 6;
    }
  }
  if (doc.audit.length) {
    renderSection(pdf, frame(pdf, { kind: "keyvalue", heading: label("pdf.auditTrail", locale), rows: doc.audit }));
  }
  return pdf;
}

/** A section as the current style draws it: a design card, or unchanged. */
const frame = (pdf: Pdf, s: DocSection): DocSection => (pdf.design ? designCard(s) : s);

const CONTENTS_ANCHOR = "contents";
/** PDF names cannot carry arbitrary text; layers are addressed by index. */
const layerId = (i: number): string => `L${i}`;
const chapterAnchor = chapterAnchorId;

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
  locale: SupportedLocale = "en",
): void {
  pdf.anchor(CONTENTS_ANCHOR);
  heading(pdf, label("pdf.contents", locale));

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
    if (pdf.design) {
      pdf.roundRect(x, tileW, TILE_H, 8, WHITE, CARD_BORDER, 1);
    } else {
      pdf.rect(x, tileW, TILE_H, LIGHT);
      pdf.strokeRect(x, tileW, TILE_H, GRAY, 0.5);
    }
    // A number on each box so a reader can refer to a chapter out loud, and so
    // the grid reads as an ordered document rather than a menu.
    pdf.y = top + 9;
    pdf.text(x + 10, 8, true, String(i + 1).padStart(2, "0"), pdf.design ? BAR : ACCENT);
    pdf.text(x + 30, 10.5, true, truncate(c.name, 10.5, tileW - 44), pdf.design ? ACCENT : BLACK);
    pdf.y = top + 26;
    pdf.text(x + 30, 8, false, truncate(c.summary, 8, tileW - 44), pdf.design ? MUTED : GRAY);
    pdf.y = top + 39;
    pdf.text(x + 30, 8, true, label("pdf.open", locale), pdf.design ? BAR : ACCENT);

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
    label(mode === "layers" ? "pdf.contentsHintLayers" : "pdf.contentsHint", locale),
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
  locale: SupportedLocale = "en",
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
  if (pdf.design) {
    // The design's page title: large teal name over a divider, no grey bar.
    pdf.y = barTop + 2;
    pdf.text(pdf.rx, 15, true, truncate(chapter.name, 15, pdf.rw - 120, true), ACCENT);
    pdf.y = barTop + 6;
  } else {
    pdf.rect(pdf.rx, pdf.rw, 22, LIGHT);
    pdf.y = barTop + 6;
    pdf.text(pdf.rx + 8, 11, true, truncate(chapter.name, 11, pdf.rw - 120));
  }
  // Composed by the renderer, so it never reached the document localisation.
  // The chevron flips with the page direction along with the words.
  const closeLabel = label(mode === "layers" ? "pdf.close" : "pdf.backToContents", locale);
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
  if (pdf.design) {
    pdf.y = barTop + 24;
    pdf.rule(hex(PRESENTATION_PALETTE.summaryDivider), 1.2);
    pdf.y += 16;
  }

  if (pdf.design) {
    // One card for the chapter (as the earlier single-flow layout, in the
    // design's colours); drawn unframed when it runs past a page.
    renderSection(pdf, { kind: "card", heading: "", children: chapter.sections, flow: true });
  } else {
    for (const section of chapter.sections) {
      renderSection(pdf, section);
      pdf.y += 6;
    }
  }
  if (mode === "layers") pdf.endLayer();
}

/**
 * `locale` sets the page DIRECTION only — the document reaching here is already
 * translated. See Pdf.dir for what mirroring does and does not cover.
 */
export function renderReportPdf(
  doc: ReportDoc,
  mode: PdfInteractivity = "pages",
  locale: SupportedLocale = "en",
): Buffer {
  // Two passes. The first discovers which anchors the document actually
  // materialises; the second draws the links, now that a forward reference can
  // be recognised as valid.
  //
  // Layout is identical between passes: the only thing the second pass draws
  // that the first does not is the ">" drill affordance, which is placed at the
  // current y and advances nothing. So the anchor positions the second pass
  // records are the positions the emitted pages actually have.
  const discovery = renderPass(doc, undefined, mode, locale);
  const ids = discovery.anchorIds();
  // Nothing drillable — skip the second pass entirely rather than paying for it
  // on every ordinary report.
  if (ids.size === 0) return discovery.build();
  return renderPass(doc, ids, mode, locale).build();
}

export interface LayerInfo {
  /** Layer ids in document order — becomes /OCProperties /D /Order. */
  order: string[];
  /** Layer id -> page indices it draws on. */
  pages: Map<string, Set<number>>;
}

// RIO-NFR-007 — the four PDF objects that embed one weight of the Arabic
// font as a proper composite (Type0/CIDFontType2/Identity-H) font: the raw
// TTF bytes (FontFile2), its FontDescriptor (metrics fontkit already parsed
// out of the font, so nothing here is guessed), the CIDFontType2 descendant
// naming that descriptor with an explicit /W array for every glyph this
// document actually draws (so the viewer's own advance calculation matches
// the widths textWidth() used for wrapping/right-align), and the Type0
// wrapper that page Resources reference by name. CIDToGIDMap /Identity is
// correct because the font is embedded whole (unsubsetted) — CID N is
// literally glyph N in the file, no remapping table needed.
function buildArabicFontObjects(weight: "regular" | "bold", used: Map<number, number>, firstObjNum: number): string[] {
  const { font, ttfLatin1, ttfByteLength } = getArabicFont(weight);
  const bbox = font.bbox;
  const baseFontName = weight === "bold" ? "Amiri-Bold" : "Amiri-Regular";
  const fontFileNum = firstObjNum;
  const descNum = firstObjNum + 1;
  const cidNum = firstObjNum + 2;
  // Sorted so the /W array reads as ascending CID ranges — not required by
  // the spec, just easier to eyeball while debugging a generated PDF.
  const wEntries = [...used.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([cid, w]) => `${cid}[${w}]`)
    .join(" ");
  return [
    `<< /Length ${Buffer.byteLength(ttfLatin1, "latin1")} /Length1 ${ttfByteLength} >>\nstream\n${ttfLatin1}\nendstream`,
    `<< /Type /FontDescriptor /FontName /${baseFontName} /Flags 4 /FontBBox [${bbox.minX} ${bbox.minY} ${bbox.maxX} ${bbox.maxY}] /ItalicAngle 0 /Ascent ${Math.round(font.ascent)} /Descent ${Math.round(font.descent)} /CapHeight ${Math.round(font.capHeight || font.ascent)} /StemV 80 /FontFile2 ${fontFileNum} 0 R >>`,
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${baseFontName} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descNum} 0 R /CIDToGIDMap /Identity /DW 500${wEntries ? ` /W [${wEntries}]` : ""} >>`,
    `<< /Type /Font /Subtype /Type0 /BaseFont /${baseFontName} /Encoding /Identity-H /DescendantFonts [${cidNum} 0 R] >>`,
  ];
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
  arabicGlyphs: { regular: Map<number, number>; bold: Map<number, number> } = { regular: new Map(), bold: new Map() },
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

  // RIO-NFR-007 — the embedded Arabic font (Amiri) is only worth its ~400KB
  // per weight if this specific document actually drew Arabic text; an
  // all-English report stays exactly the object count/size it always was.
  // Each weight needs 4 objects: the raw TTF (FontFile2), its FontDescriptor,
  // the CIDFontType2 descendant naming that descriptor, and the Type0
  // wrapper actually referenced from page Resources as /F5 (regular) / /F6
  // (bold) — see buildArabicFontObjects below.
  const needsArabic = arabicGlyphs.regular.size > 0 || arabicGlyphs.bold.size > 0;
  const arabicRegularFirst = fontSerifReg + 1;
  const arabicBoldFirst = arabicRegularFirst + (needsArabic ? 4 : 0);
  const fontArabicRegularType0 = arabicRegularFirst + 3;
  const fontArabicBoldType0 = arabicBoldFirst + 3;
  const firstContent = arabicBoldFirst + (needsArabic ? 4 : 0);

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
    const arabicFontEntry = needsArabic ? ` /F5 ${fontArabicRegularType0} 0 R /F6 ${fontArabicBoldType0} 0 R` : "";
    objects.push(
      `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ${fontBold} 0 R /F2 ${fontReg} 0 R /F3 ${fontSerifBold} 0 R /F4 ${fontSerifReg} 0 R${arabicFontEntry} >> /ExtGState << /GSwm << /ca 0.3 /CA 0.3 >> >>${propsEntry} >> /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${firstContent + i} 0 R${annotsEntry} >>`,
    );
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>");
  if (needsArabic) {
    objects.push(...buildArabicFontObjects("regular", arabicGlyphs.regular, arabicRegularFirst));
    objects.push(...buildArabicFontObjects("bold", arabicGlyphs.bold, arabicBoldFirst));
  }
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