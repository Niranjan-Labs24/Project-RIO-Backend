import path from "node:path";
import PDFDocument from "pdfkit";
import type { DocChapter, DocSection, DocTile, ReportDoc } from "../report-doc";
import { bidiRuns, containsArabic, type BidiRun, type RunDirection } from "./bidi";
import { DEFAULT_APP_LOCALE } from "../../../i18n/locale";
import { translator, type Translator } from "../../../i18n/translate";

/**
 * A Unicode-capable PDF renderer for a ReportDoc — the Arabic path.
 *
 * WHY A SECOND RENDERER RATHER THAN A REWRITE OF THE FIRST
 *
 * `pdf-builder.ts` is a hand-written, dependency-free vector renderer whose
 * `esc()` maps every code point outside printable ASCII to "?". Its own header
 * comment says it was scoped to be replaced when Arabic arrived (RIO-NFR-007).
 * Replacing it outright would change every English PDF the client has already
 * reviewed and signed off, for no benefit to them.
 *
 * So this renderer serves `locale === "ar"` only. English exports keep the
 * existing renderer byte-for-byte, which makes this change impossible to
 * regress English output. Once Arabic output has been signed off, the two can
 * be merged deliberately rather than as a side effect.
 *
 * HOW ARABIC ACTUALLY WORKS HERE
 *
 * Three things have to be right, and they are three separate problems:
 *
 *  1. GLYPHS — the base-14 PDF fonts have no Arabic. An embedded TrueType font
 *     is required. Noto Naskh Arabic ships under the SIL Open Font License, so
 *     unlike a system font it can legally live in the repo and the container.
 *  2. SHAPING — Arabic letters take different forms depending on their
 *     neighbours. pdfkit delegates TrueType layout to fontkit, which has a real
 *     OpenType shaper and handles this, including lam-alef ligatures. We get it
 *     by embedding the font; there is nothing to implement.
 *  3. ORDERING — fontkit reverses the glyphs of an RTL run, but does not
 *     reorder a line that MIXES directions, and these reports mix constantly
 *     ("33 / 100 (متوسط)"). That is what `bidi.ts` resolves, and why text goes
 *     through `drawLine` rather than straight to `doc.text`.
 *
 * Character order inside a run is never touched here — see bidi.ts.
 */

const FONT_DIR = path.resolve(process.cwd(), "assets", "fonts");
const REGULAR = path.join(FONT_DIR, "NotoNaskhArabic-Regular.ttf");
const BOLD = path.join(FONT_DIR, "NotoNaskhArabic-Bold.ttf");

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 46;
const CONTENT_W = PAGE_W - MARGIN * 2;

const ACCENT = "#1F5A99";
const GRAY = "#737373";
const LIGHT = "#E6EEF7";
const BLACK = "#000000";
const BAR = "#3380BF";
const PIE_COLORS = ["#2978D6", "#EB6933", "#1AB07A", "#EDA100", "#E87BA3", "#7B61FF"];

interface Ctx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: any;
  rtl: boolean;
  y: number;
  /**
   * Anchor ids that actually exist in this document.
   *
   * Collected in a pre-pass, because a contents tile is drawn BEFORE the page
   * it points at. A link to a destination that never gets registered is a dead
   * click in every viewer, so a tile whose target is missing is drawn as plain
   * text instead of a link — visibly inert rather than deceptively clickable.
   */
  anchors: Set<string>;
  /** Named destination for the contents page, so every section can offer a
   *  way back. */
  readonly contentsDest: string;
  /** Catalogue lookup for the renderer's own chrome — the affordance labels
   *  ("Open", "Back to Contents") that the document itself introduces rather
   *  than receiving from the ReportDoc. */
  t: Translator;
}

/** PDF named destinations must be simple, stable strings. Anchor ids come from
 *  report content and can contain anything, so they are normalised rather than
 *  trusted. */
function destName(anchorId: string): string {
  return `sec_${anchorId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** Every anchor the document will register, found before anything is drawn. */
function collectAnchors(sections: DocSection[], into: Set<string>): Set<string> {
  for (const s of sections) {
    if (s.kind === "anchor") into.add(s.id);
    else if (s.kind === "pageBreak") into.add(s.anchorId);
    else if (s.kind === "columns") collectAnchors(s.children, into);
  }
  return into;
}

/** Vertical space left on the page. */
function remaining(c: Ctx): number {
  return PAGE_H - MARGIN - c.y;
}

function newPage(c: Ctx): void {
  c.doc.addPage({ size: [PAGE_W, PAGE_H], margin: MARGIN });
  c.y = MARGIN;
}

/** Adds a page when `need` points would overflow the current one. */
function ensure(c: Ctx, need: number): void {
  if (remaining(c) < need) newPage(c);
}

/**
 * Per-run font selection.
 *
 * Arabic runs use Noto Naskh; Latin runs use Helvetica. Noto Naskh does carry
 * Latin glyphs, but using it for English text costs twice: the Latin design is
 * secondary to the Arabic and reads noticeably worse at table sizes, and
 * pdfkit's subset for it emits an incomplete ToUnicode map, so English text in
 * the exported file could not be reliably selected, searched or copied.
 *
 * Mixing the two is safe because runs are drawn independently at computed
 * positions — nothing relies on one font's metrics spanning a whole line.
 */
function setFont(c: Ctx, bold: boolean, size: number, script: RunDirection = "rtl"): void {
  const name = script === "ltr" ? (bold ? "Helvetica-Bold" : "Helvetica") : bold ? "AR-Bold" : "AR-Regular";
  c.doc.font(name).fontSize(size);
}


/**
 * UTF-16BE hex, BOM-prefixed — the encoding a PDF text string uses inside an
 * /ActualText entry.
 *
 * Surrogate pairs fall out of `charCodeAt` naturally, because JavaScript
 * strings are already UTF-16.
 */
function pdfTextHex(text: string): string {
  let out = "FEFF";
  for (let i = 0; i < text.length; i++) {
    out += text.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  }
  return out;
}

/**
 * Wraps drawn text in a marked-content span carrying the LOGICAL string.
 *
 * Without this, extracting, searching or copying Arabic out of the PDF is
 * broken, for two independent reasons — both confirmed against Noto Naskh:
 *
 *  1. GSUB emits glyphs that have NO reverse code-point mapping. Laying out
 *     "المحتويات" (9 characters) produces 12 glyphs, three of which report
 *     `codePoints: []`. pdfkit builds its /ToUnicode CMap from `glyph.codePoints`
 *     (js/pdfkit.js `encode`), so those three map to nothing and surface as
 *     control characters in extracted text.
 *  2. fontkit emits RTL glyphs in VISUAL order, so even the glyphs that do map
 *     back come out reversed — a search for a word never matches, because the
 *     extracted string is the word backwards.
 *
 * /ActualText (PDF 32000-1 §14.9.4) is the mechanism the spec provides for
 * exactly this: extractors use the supplied string in place of anything derived
 * from the glyphs. One span per LINE rather than per run, so the logical
 * reading order of a mixed Arabic/Latin line is preserved too — spans are
 * concatenated in draw order, which is visual, so per-run spans would fix the
 * characters and leave the order wrong.
 *
 * Applied only when the text actually needs it. A pure-Latin line already
 * extracts correctly, and wrapping it would add bytes to every English page for
 * nothing.
 */
function withActualText(c: Ctx, logical: string, draw: () => void): void {
  const needed = containsArabic(logical) && logical.trim().length > 0;
  if (!needed) {
    draw();
    return;
  }
  c.doc.addContent(`/Span << /ActualText <${pdfTextHex(logical)}> >> BDC`);
  draw();
  c.doc.addContent("EMC");
  drawSearchLayer(c, logical);
}

/**
 * Glyph-composition features, switched OFF for the invisible search layer only.
 *
 * `ccmp` is what decomposes a dotted Arabic letter into a skeleton glyph plus a
 * separate dot-mark glyph — and that mark glyph carries NO reverse code-point
 * mapping, so it lands in /ToUnicode as an empty entry and surfaces as a
 * control character in extracted text. Measured on Noto Naskh: "ت" lays out as
 * two glyphs (294 unmapped, plus 14 -> U+062A); with `ccmp` off it is a single
 * glyph that maps correctly. The same holds for every dotted letter.
 *
 * Turning this off would be wrong for VISIBLE text — the dots are the letter.
 * Here nothing is drawn, so the only thing that matters is that each character
 * yields exactly one glyph carrying its own code point.
 *
 * fontkit accepts an object of feature-tag booleans and pdfkit forwards
 * `features` to it untouched, though pdfkit's own typings describe only the
 * array form.
 */
const SEARCH_LAYER_FEATURES = { ccmp: false } as unknown as string[];


/**
 * An INVISIBLE copy of the line in logical order, so glyph-level extractors can
 * search and copy the Arabic.
 *
 * /ActualText above is the mechanism the PDF spec provides, and Acrobat honours
 * it — but pdf.js (Firefox, and most in-browser viewers) reports the marked
 * content boundary and drops the ActualText value, verified against this very
 * file. For those readers the only text that exists is what the glyphs say, and
 * the glyphs say the wrong thing twice over: three of every twelve carry no
 * reverse code-point mapping at all, and fontkit emits RTL glyphs in visual
 * order, so a search for a word is matched against that word backwards.
 *
 * This layer sidesteps both. Each character is drawn on its own, in logical
 * order, which:
 *   - shapes it in isolation, and an isolated form DOES map back to its own
 *     code point, so /ToUnicode is correct for every glyph;
 *   - makes draw order logical order, which is what an extractor concatenates.
 *
 * Text render mode 3 makes it invisible, so it costs the reader nothing. It is
 * emitted only for lines containing Arabic — Latin already extracts correctly,
 * and adding a second copy of every English line would inflate the file for no
 * gain.
 *
 * All characters are drawn at one position: they are never displayed, and
 * stacking them keeps the operator stream small.
 */
function drawSearchLayer(c: Ctx, logical: string): void {
  const y = c.y;
  // 3 Tr = neither fill nor stroke. The text is in the file and in the text
  // layer; it just does not mark the page.
  c.doc.addContent("3 Tr");

  // REVERSE logical order, advancing left to right.
  //
  // That reads backwards until you follow what the extractor does: it
  // reconstructs a line by ascending x. So the character that must come FIRST
  // in the output has to sit LEFTMOST — which, for a right-to-left string, is
  // its last character. Emitting the reversed string at increasing x therefore
  // reads back as the original.
  //
  // Both simpler arrangements were measured and both fail:
  //  - every character at one x: draw order survives, so the characters are
  //    right, but with no gaps the extractor sees no word boundaries and every
  //    space collapses ("تقرير القرية" → "تقريرالقرية"). Single words match a
  //    search; phrases do not.
  //  - logical order at increasing x: spaces survive, but the extractor then
  //    applies its own right-to-left pass on top and each word comes out
  //    reversed.
  //
  // Advancing by each character's real width is what gives the extractor the
  // inter-word gaps it needs; the values are otherwise meaningless, since none
  // of this is drawn.
  // Reversed by RUN, not by character.
  //
  // Reversing every character also reversed embedded English, so an Arabic line
  // quoting a KPI name extracted as "htlaeH" — the English words inside an
  // Arabic report were unsearchable, and copied text carried them backwards.
  // Reversing whole runs while leaving each run's own characters alone gives
  // the extractor the same shape the visible text has.
  const searchOrder = bidiRuns(logical)
    .map((run) => (run.dir === "rtl" ? [...run.text].reverse().join("") : run.text))
    .join("");

  let cursor = MARGIN;
  for (const ch of searchOrder) {
    if (ch === "\n" || ch === "\r") continue;
    // Per character, the same font rule the visible text uses. Drawing a Latin
    // character with the Arabic face emits .notdef, which carries no code point
    // — so the searchable copy of a mixed line would lose exactly the English
    // words a reader is most likely to search for.
    c.doc.font(arabicFaceHas(c, ch) ? "AR-Regular" : "Helvetica").fontSize(8);
    c.doc.text(ch, cursor, y, { lineBreak: false, width: 1000, features: SEARCH_LAYER_FEATURES });
    cursor += (c.doc.widthOfString(ch, { features: SEARCH_LAYER_FEATURES }) as number) || 3;
  }
  // Back to normal fill, or every later run on this page would be invisible.
  c.doc.addContent("0 Tr");
}

/**
 * Draws ONE line of possibly mixed-direction text and returns its height.
 *
 * The line is split into directional runs and each is drawn at its own x, so
 * fontkit shapes and reverses each run natively. Drawing the whole line as one
 * string is what produces the mis-ordered figures this function exists to fix.
 *
 * `align` is resolved against the document direction: in an RTL document a
 * "start"-aligned line begins at the right edge.
 */
/**
 * Whether the Arabic face can draw `ch`.
 *
 * Noto Naskh Arabic is an ARABIC font — it carries no Latin letters and, less
 * obviously, no "(", ")", "/", "%", "-" or em-dash either. Every one of those
 * inside an Arabic run rendered as a .notdef box, which is what covered the
 * first Arabic reports in small rectangles: the boxes were never a shaping
 * failure, they were characters the font simply does not contain.
 *
 * Answers are cached because a report asks this per character, per line.
 */
const arabicGlyphCache = new Map<string, boolean>();
function arabicFaceHas(c: Ctx, ch: string): boolean {
  const cached = arabicGlyphCache.get(ch);
  if (cached !== undefined) return cached;
  // The fontkit font behind the registered pdfkit font. Reached through pdfkit
  // rather than by importing fontkit directly, so there is one source of truth
  // for which file is actually embedded.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const embedded = (c.doc.font("AR-Regular") as any)._font;
  const glyphs = embedded?.font?.glyphsForString?.(ch);
  const has = Array.isArray(glyphs) && glyphs.length > 0 && glyphs[0]?.id !== 0;
  arabicGlyphCache.set(ch, has);
  return has;
}

/** A stretch of one run that a single font can draw. */
interface FontSegment {
  text: string;
  dir: RunDirection;
  /** false = draw with the Latin face, because the Arabic face lacks these
   *  characters entirely. */
  arabicFace: boolean;
}

/**
 * Splits a bidi run into stretches one font can actually draw.
 *
 * Punctuation and Latin characters inside an Arabic run go to the Latin face;
 * the Arabic letters keep the Arabic face and, crucially, keep their shaping —
 * the characters split out here are non-joining, so removing them from a shaped
 * stretch cannot change how the letters around them connect.
 */
function fontSegments(c: Ctx, run: BidiRun): FontSegment[] {
  if (run.dir === "ltr") return [{ text: run.text, dir: "ltr", arabicFace: false }];

  const segments: FontSegment[] = [];
  for (const ch of run.text) {
    const arabicFace = arabicFaceHas(c, ch);
    const last = segments[segments.length - 1];
    if (last && last.arabicFace === arabicFace) last.text += ch;
    else segments.push({ text: ch, dir: "rtl", arabicFace });
  }
  return segments;
}

/** Font for a segment, resolved identically in measurement and in drawing —
 *  measuring with one face and drawing with another is what makes a line
 *  overflow its column and collide with the text beside it. */
function segmentFontName(seg: FontSegment, bold: boolean): string {
  if (seg.arabicFace) return bold ? "AR-Bold" : "AR-Regular";
  return bold ? "Helvetica-Bold" : "Helvetica";
}

/** The segments of a line, in visual left-to-right order. */
function visualSegments(c: Ctx, text: string): FontSegment[] {
  return bidiRuns(text).flatMap((run) => {
    const segs = fontSegments(c, run);
    // An RTL run reads right to left, so its segments are emitted in reverse.
    // Characters WITHIN a segment are untouched — fontkit reverses an Arabic
    // stretch itself.
    return run.dir === "rtl" ? segs.reverse() : segs;
  });
}

/** Width of a line, measured with the same fonts it will be drawn with. */
function measureLine(c: Ctx, text: string, bold: boolean, size: number): number {
  let total = 0;
  for (const seg of visualSegments(c, text)) {
    c.doc.font(segmentFontName(seg, bold)).fontSize(size);
    total += c.doc.widthOfString(seg.text) as number;
  }
  return total;
}

function drawLine(
  c: Ctx,
  text: string,
  x: number,
  width: number,
  opts: { bold?: boolean; size?: number; color?: string; align?: "start" | "end" | "center" } = {},
): number {
  const bold = opts.bold ?? false;
  const size = opts.size ?? 9.5;
  const segments = visualSegments(c, text);
  c.doc.fillColor(opts.color ?? BLACK);

  // Measured with the SAME font each segment is drawn with. Measuring a mixed
  // line with one face and drawing it with two is what made lines overflow
  // their column and overlap their neighbours.
  const widths = segments.map((seg) => {
    c.doc.font(segmentFontName(seg, bold)).fontSize(size);
    return c.doc.widthOfString(seg.text) as number;
  });
  const total = widths.reduce((sum, w) => sum + w, 0);
  const align = opts.align ?? "start";
  const startAtRight = c.rtl ? align !== "end" : align === "end";

  let cursor = x;
  if (align === "center") cursor = x + Math.max(0, (width - total) / 2);
  else if (startAtRight) cursor = x + Math.max(0, width - total);

  // One span for the whole line, carrying the original logical string — see
  // withActualText. `text` is the caller's untouched input: the runs below have
  // been reordered and had brackets mirrored for display, and neither belongs
  // in what a reader copies out.
  withActualText(c, text, () => {
    for (const [i, seg] of segments.entries()) {
      const w = widths[i]!;
      c.doc.font(segmentFontName(seg, bold)).fontSize(size);
      // `lineBreak: false` is essential: pdfkit would otherwise re-wrap a
      // segment and undo the positioning this function just computed.
      c.doc.text(seg.text, cursor, c.y, { lineBreak: false, width: w + 2 });
      cursor += w;
    }
  });
  // Line height from the Arabic face, which is the taller of the two — using
  // Helvetica's would clip Arabic descenders on a mixed line.
  setFont(c, bold, size, "rtl");
  return c.doc.currentLineHeight();
}

/** Word-wraps `text` to `width`, returning the lines. Wrapping happens on the
 *  LOGICAL string, before any bidi run splitting — breaking a line is a
 *  typographic decision, reordering it is a rendering one, and doing them in
 *  the other order would let a run straddle a line break. */
function wrap(c: Ctx, text: string, width: number, bold: boolean, size: number): string[] {
  const out: string[] = [];
  for (const paragraph of String(text).split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (measureLine(c, candidate, bold, size) <= width || !line) {
        line = candidate;
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

function drawParagraph(
  c: Ctx,
  text: string,
  x: number,
  width: number,
  opts: { bold?: boolean; size?: number; color?: string; align?: "start" | "end" | "center" } = {},
): void {
  const size = opts.size ?? 9.5;
  for (const line of wrap(c, text, width, opts.bold ?? false, size)) {
    ensure(c, size * 2);
    const h = drawLine(c, line, x, width, opts);
    c.y += h;
  }
}

function sectionHeading(c: Ctx, text: string): void {
  if (!text) return;
  ensure(c, 42);
  c.y += 8;
  drawLine(c, text, MARGIN, CONTENT_W, { bold: true, size: 12, color: ACCENT });
  c.y += 15;
  c.doc.moveTo(MARGIN, c.y).lineTo(PAGE_W - MARGIN, c.y).lineWidth(0.7).strokeColor(ACCENT).stroke();
  c.y += 7;
}

/** Laid-out height of a key/value block, without drawing it. Used where a
 *  background has to be painted before the text that sits on it. */
function keyValueHeight(c: Ctx, rows: Array<{ label: string; value: string }>): number {
  const labelW = 150;
  const valueW = CONTENT_W - labelW - 10;
  let h = 0;
  for (const row of rows) {
    const lines = Math.max(
      wrap(c, String(row.value ?? ""), valueW, false, 9.5).length,
      wrap(c, String(row.label ?? ""), labelW, true, 9.5).length,
      1,
    );
    h += lines * 13 + 2;
  }
  return h + 4;
}

function keyValueRows(c: Ctx, rows: Array<{ label: string; value: string }>): void {
  const labelW = 150;
  const valueW = CONTENT_W - labelW - 10;
  // In an RTL document the label column sits on the right.
  const labelX = c.rtl ? MARGIN + valueW + 10 : MARGIN;
  const valueX = c.rtl ? MARGIN : MARGIN + labelW + 10;

  for (const row of rows) {
    const valueLines = wrap(c, String(row.value ?? ""), valueW, false, 9.5);
    const labelLines = wrap(c, String(row.label ?? ""), labelW, true, 9.5);
    const lines = Math.max(valueLines.length, labelLines.length, 1);
    ensure(c, lines * 13 + 6);

    const top = c.y;
    for (const [i, line] of labelLines.entries()) {
      c.y = top + i * 13;
      drawLine(c, line, labelX, labelW, { bold: true, size: 9.5 });
    }
    for (const [i, line] of valueLines.entries()) {
      c.y = top + i * 13;
      drawLine(c, line, valueX, valueW, { size: 9.5 });
    }
    c.y = top + lines * 13 + 2;
  }
  c.y += 4;
}

function table(c: Ctx, columns: string[], rows: string[][]): void {
  if (columns.length === 0) return;
  const colW = CONTENT_W / columns.length;
  // RTL tables read right to left, so column 0 is the rightmost.
  const xFor = (i: number) => (c.rtl ? PAGE_W - MARGIN - (i + 1) * colW : MARGIN + i * colW);

  // Header cells WRAP, exactly like body cells.
  //
  // They used to be drawn as single unwrapped lines, so an Arabic header longer
  // than its column ran straight over its neighbour — a wide table came out as
  // a band of overlapping words. Arabic headers are routinely longer than the
  // English ones they replace ("Valid Response Count" becomes four words), so
  // this stops being an edge case the moment the report is translated.
  const headerLines = columns.map((col) => wrap(c, col, colW - 6, true, 8.5));
  const headerRows = Math.max(1, ...headerLines.map((l) => l.length));
  const headerH = headerRows * 11 + 5;

  const header = () => {
    ensure(c, headerH + 14);
    c.doc.rect(MARGIN, c.y - 2, CONTENT_W, headerH).fillColor(ACCENT).fill();
    const top = c.y;
    for (const [i] of columns.entries()) {
      for (const [j, line] of (headerLines[i] ?? []).entries()) {
        c.y = top + j * 11;
        drawLine(c, line, xFor(i) + 3, colW - 6, { bold: true, size: 8.5, color: "#FFFFFF" });
      }
    }
    c.y = top + headerH;
  };

  header();
  for (const [r, row] of rows.entries()) {
    const cellLines = columns.map((_, i) => wrap(c, String(row[i] ?? ""), colW - 6, false, 8.5));
    const lines = Math.max(1, ...cellLines.map((l) => l.length));
    const height = lines * 11 + 3;
    if (remaining(c) < height + 20) {
      newPage(c);
      header();
    }
    if (r % 2 === 1) c.doc.rect(MARGIN, c.y - 2, CONTENT_W, height).fillColor(LIGHT).fill();
    const top = c.y;
    for (const [i] of columns.entries()) {
      for (const [j, line] of (cellLines[i] ?? []).entries()) {
        c.y = top + j * 11;
        drawLine(c, line, xFor(i) + 3, colW - 6, { size: 8.5 });
      }
    }
    c.y = top + height;
  }
  c.y += 6;
}

function bars(c: Ctx, items: Array<{ label: string; value: number }>, max: number): void {
  const labelW = 150;
  const trackW = CONTENT_W - labelW - 60;
  for (const b of items) {
    ensure(c, 20);
    const frac = max > 0 ? Math.max(0, Math.min(1, b.value / max)) : 0;
    const labelX = c.rtl ? PAGE_W - MARGIN - labelW : MARGIN;
    const trackX = c.rtl ? MARGIN + 60 : MARGIN + labelW + 10;
    drawLine(c, b.label, labelX, labelW, { size: 8.5 });
    c.doc.rect(trackX, c.y + 1, trackW, 9).fillColor(LIGHT).fill();
    // The bar grows from the reading edge — right in an RTL document.
    const w = trackW * frac;
    c.doc.rect(c.rtl ? trackX + trackW - w : trackX, c.y + 1, w, 9).fillColor(BAR).fill();
    const numX = c.rtl ? MARGIN : trackX + trackW + 6;
    drawLine(c, String(Math.round(b.value)), numX, 54, { size: 8.5, color: GRAY });
    c.y += 15;
  }
  c.y += 4;
}

function pie(c: Ctx, slices: Array<{ label: string; value: number }>): void {
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return;
  const r = 58;
  ensure(c, r * 2 + 30);
  const cx = c.rtl ? PAGE_W - MARGIN - r - 10 : MARGIN + r + 10;
  const cy = c.y + r;
  let angle = -Math.PI / 2;
  for (const [i, s] of slices.entries()) {
    const sweep = (s.value / total) * Math.PI * 2;
    // pdfkit exposes no arc primitive, so the wedge is built from line
    // segments — exact enough at this radius and still a real vector path.
    const steps = Math.max(2, Math.ceil((sweep / (Math.PI * 2)) * 60));
    c.doc.moveTo(cx, cy);
    for (let k = 0; k <= steps; k++) {
      const a = angle + (sweep * k) / steps;
      c.doc.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    c.doc.closePath().fillColor(PIE_COLORS[i % PIE_COLORS.length]!).fill();
    angle += sweep;
  }

  // Legend, down the side opposite the pie.
  const legendX = c.rtl ? MARGIN : cx + r + 18;
  const legendW = CONTENT_W - r * 2 - 30;
  const top = c.y;
  for (const [i, s] of slices.entries()) {
    const ly = top + i * 14;
    const swatchX = c.rtl ? legendX + legendW - 9 : legendX;
    c.doc.rect(swatchX, ly + 2, 8, 8).fillColor(PIE_COLORS[i % PIE_COLORS.length]!).fill();
    c.y = ly;
    const pct = Math.round((s.value / total) * 100);
    drawLine(c, `${s.label} — ${pct}%`, c.rtl ? legendX : legendX + 12, legendW - 12, { size: 8.5 });
  }
  c.y = Math.max(top + slices.length * 14, cy + r) + 10;
}

function gauge(c: Ctx, value: number, max: number, sub?: string): void {
  ensure(c, 60);
  const w = CONTENT_W;
  const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  c.doc.rect(MARGIN, c.y + 4, w, 14).fillColor(LIGHT).fill();
  const barW = w * frac;
  c.doc.rect(c.rtl ? MARGIN + w - barW : MARGIN, c.y + 4, barW, 14).fillColor(ACCENT).fill();
  c.y += 22;
  drawLine(c, sub ? `${Math.round(value)} / ${max} — ${sub}` : `${Math.round(value)} / ${max}`, MARGIN, w, {
    bold: true,
    size: 10,
  });
  c.y += 16;
}

function statTiles(c: Ctx, tiles: Array<{ label: string; value: string; sub?: string }>): void {
  const perRow = Math.min(4, Math.max(1, tiles.length));
  const tileW = CONTENT_W / perRow;
  for (let i = 0; i < tiles.length; i += perRow) {
    const row = tiles.slice(i, i + perRow);
    ensure(c, 52);
    const top = c.y;
    for (const [j, t] of row.entries()) {
      const idx = c.rtl ? perRow - 1 - j : j;
      const x = MARGIN + idx * tileW;
      c.doc.rect(x + 2, top, tileW - 4, 44).fillColor(LIGHT).fill();
      c.y = top + 6;
      drawLine(c, t.value, x + 8, tileW - 16, { bold: true, size: 14, color: ACCENT });
      c.y = top + 24;
      drawLine(c, t.label, x + 8, tileW - 16, { size: 8, color: GRAY });
      if (t.sub) {
        c.y = top + 34;
        drawLine(c, t.sub, x + 8, tileW - 16, { size: 7.5, color: GRAY });
      }
    }
    c.y = top + 50;
  }
}

/**
 * The contents grid, as clickable boxes.
 *
 * This is the Arabic edition's answer to the English renderer's collapsible
 * chapters. That renderer uses PDF optional-content groups (/OCG) with
 * /SetOCGState actions, which only Acrobat honours and which pdfkit does not
 * expose at all. Page-based navigation — tile jumps to a real page, page
 * offers a way back — is the same interaction, works in every viewer including
 * browser previews, and degrades to a perfectly readable printed document.
 *
 * A tile whose target does not exist is drawn without a link rather than as a
 * dead click.
 */
function navTiles(c: Ctx, tiles: DocTile[]): void {
  const perRow = 2;
  const tileW = CONTENT_W / perRow;
  const tileH = 52;

  for (let i = 0; i < tiles.length; i += perRow) {
    const row = tiles.slice(i, i + perRow);
    ensure(c, tileH + 8);
    const top = c.y;
    for (const [j, tile] of row.entries()) {
      // Reading order: in an RTL document the first tile sits on the right.
      const slot = c.rtl ? perRow - 1 - j : j;
      const x = MARGIN + slot * tileW;
      const linked = c.anchors.has(tile.to);

      c.doc.rect(x + 3, top, tileW - 6, tileH).lineWidth(0.8).strokeColor(ACCENT).stroke();

      c.y = top + 8;
      drawLine(c, tile.label, x + 10, tileW - 20, { bold: true, size: 10, color: BLACK });
      c.y = top + 24;
      drawLine(c, tile.sub, x + 10, tileW - 20, { size: 8, color: GRAY });
      if (linked) {
        c.y = top + 36;
        drawLine(c, c.t("label.open"), x + 10, tileW - 20, { bold: true, size: 8.5, color: ACCENT });
        const w = measureLine(c, c.t("label.open"), true, 8.5);
        chevron(c, c.rtl ? x + tileW - 10 - w - 7 : x + 10 + w + 3, top + 37, 8.5, ACCENT);
        // The whole box is the hit area, not just the label — a 40-point-wide
        // link inside a 280-point box is a target people miss.
        c.doc.goTo(x + 3, top, tileW - 6, tileH, destName(tile.to));
      }
    }
    c.y = top + tileH + 8;
  }
  c.y += 4;
}

/**
 * A small "open this" chevron, drawn as a vector rather than typed as a
 * character.
 *
 * "\u203a" and "\u2192" are not in Noto Naskh Arabic — nor is "-", "(" or "/" — so any
 * of them beside Arabic came out as a .notdef box. Those characters now route
 * to the Latin face automatically, but an affordance marker is a graphic, not
 * prose: drawing it keeps it in the accent colour, sized to the text, and
 * pointing the right way for the reading direction without depending on any
 * font's coverage at all.
 */
function chevron(c: Ctx, x: number, y: number, size: number, colour: string): void {
  const h = size * 0.5;
  // Points the way the eye travels: left in an RTL document, right in an LTR one.
  const dir = c.rtl ? -1 : 1;
  c.doc
    .moveTo(x, y)
    .lineTo(x + dir * h * 0.6, y + h / 2)
    .lineTo(x, y + h)
    .lineWidth(1.1)
    .strokeColor(colour)
    .stroke();
}

/** Destination for chapter `i`. Index-based rather than name-based: chapter
 *  names are report content and two chapters can legitimately share one. */
function chapterDest(index: number): string {
  return `chapter_${index}`;
}

/**
 * The contents page — one numbered, clickable box per chapter.
 *
 * Mirrors the English edition's contents grid, including its numbering, so a
 * reader comparing the two language editions of one report sees the same
 * document rather than two different ones.
 */
function chapterContents(c: Ctx, chapters: DocChapter[]): void {
  sectionHeading(c, c.t("label.contents"));

  const perRow = 2;
  const tileW = CONTENT_W / perRow;
  const tileH = 58;

  for (let i = 0; i < chapters.length; i += perRow) {
    const row = chapters.slice(i, i + perRow);
    ensure(c, tileH + 8);
    const top = c.y;
    for (const [j, chapter] of row.entries()) {
      const index = i + j;
      // In an RTL document the first chapter belongs on the right.
      const slot = c.rtl ? perRow - 1 - j : j;
      const x = MARGIN + slot * tileW;

      c.doc.rect(x + 3, top, tileW - 6, tileH).lineWidth(0.8).strokeColor(ACCENT).stroke();

      // Two-digit ordinal, as the English contents page numbers them.
      const ord = String(index + 1).padStart(2, "0");
      c.y = top + 9;
      const ordW = 22;
      const ordX = c.rtl ? x + tileW - 9 - ordW : x + 9;
      drawLine(c, ord, ordX, ordW, { bold: true, size: 11, color: GRAY });

      const textX = c.rtl ? x + 9 : x + 9 + ordW + 4;
      const textW = tileW - 18 - ordW - 4;
      drawLine(c, chapter.name, textX, textW, { bold: true, size: 10.5 });
      c.y = top + 26;
      drawLine(c, chapter.summary, textX, textW, { size: 8, color: GRAY });
      c.y = top + 40;
      drawLine(c, c.t("label.open"), textX, textW, { bold: true, size: 8.5, color: ACCENT });
      // Sits on the reading edge of the label, pointing the way the eye travels.
      const openW = measureLine(c, c.t("label.open"), true, 8.5);
      chevron(c, c.rtl ? textX + textW - openW - 7 : textX + openW + 3, top + 41, 8.5, ACCENT);

      // Whole box is the hit area.
      c.doc.goTo(x + 3, top, tileW - 6, tileH, chapterDest(index));
    }
    c.y = top + tileH + 8;
  }

  c.y += 6;
  drawParagraph(c, c.t("label.contentsHint"), MARGIN, CONTENT_W, { size: 8, color: GRAY });
}

/** "Back to contents", drawn at the top of every drill-down page. Without it a
 *  reader who clicked into a section has no way out but scrolling. */
function backLink(c: Ctx): void {
  const top = c.y;
  const label = c.t("label.backToContents");
  drawLine(c, label, MARGIN, CONTENT_W, { size: 8.5, color: ACCENT, align: "start" });
  // Mirrored relative to the "open" chevron: this one points back the way the
  // reader came, so the two affordances are not confusable at a glance.
  const w = measureLine(c, label, false, 8.5);
  const back: Ctx = { ...c, rtl: !c.rtl };
  chevron(back, c.rtl ? PAGE_W - MARGIN - w - 7 : MARGIN + w + 3, top + 1, 8.5, ACCENT);
  c.doc.goTo(MARGIN, top - 2, CONTENT_W, 12, c.contentsDest);
  c.y += 14;
}

function renderSection(c: Ctx, s: DocSection): void {
  switch (s.kind) {
    case "anchor":
      // Marks a jump target in the flow without drawing anything.
      c.doc.addNamedDestination(destName(s.id));
      return;

    case "pageBreak":
      newPage(c);
      // Registered at the top of its own page, so a tile click lands on the
      // section rather than somewhere inside the previous one.
      c.doc.addNamedDestination(destName(s.anchorId));
      backLink(c);
      if (s.heading) sectionHeading(c, s.heading);
      return;

    case "breadcrumb": {
      const text = s.trail.map((t) => t.label).join("  ›  ");
      const top = c.y;
      drawLine(c, text, MARGIN, CONTENT_W, { size: 8, color: GRAY });
      // The last crumb that names a target is the one worth linking — a
      // breadcrumb the reader cannot click is just decoration on a page they
      // arrived at by clicking.
      const target = [...s.trail].reverse().find((t) => t.to && c.anchors.has(t.to));
      if (target?.to) c.doc.goTo(MARGIN, top - 2, CONTENT_W, 12, destName(target.to));
      c.y += 14;
      return;
    }

    case "keyvalue":
      sectionHeading(c, s.heading);
      keyValueRows(c, s.rows);
      return;

    case "table":
      sectionHeading(c, s.heading);
      table(c, s.columns, s.rows);
      return;

    case "navGrid":
      sectionHeading(c, s.heading);
      navTiles(c, s.tiles);
      return;

    case "list":
      sectionHeading(c, s.heading);
      for (const [i, item] of s.items.entries()) {
        drawParagraph(c, `${i + 1}. ${item}`, MARGIN, CONTENT_W, { size: 9.5 });
        c.y += 3;
      }
      c.y += 4;
      return;

    case "note":
      sectionHeading(c, s.heading);
      drawParagraph(c, s.text, MARGIN, CONTENT_W, { size: 9.5 });
      c.y += 4;
      return;

    case "bars":
      sectionHeading(c, s.heading);
      bars(c, s.bars, s.max);
      return;

    case "pie":
      sectionHeading(c, s.heading);
      pie(c, s.slices);
      return;

    case "gauge":
      sectionHeading(c, s.heading);
      gauge(c, s.value, s.max, s.sub);
      return;

    case "stats":
      sectionHeading(c, s.heading);
      statTiles(c, s.tiles);
      return;

    case "radar":
      // A radar plot of N axes carries the same numbers as an N-row table, and
      // a table is legible in both directions without a bidi-aware polar
      // layout. Rendered as data rather than omitted — nothing is lost.
      sectionHeading(c, s.heading);
      table(
        c,
        ["", ...s.series.map((x) => x.name)],
        s.axes.map((axis, i) => [axis, ...s.series.map((se) => String(se.values[i] ?? ""))]),
      );
      return;

    case "groupedBars":
      sectionHeading(c, s.heading);
      table(
        c,
        ["", ...s.series.map((x) => x.name)],
        s.groups.map((g, i) => [g, ...s.series.map((se) => String(se.values[i] ?? ""))]),
      );
      return;

    case "columns":
      // Stacked rather than side by side: a two-column layout with RTL text
      // needs column-order flipping as well as content mirroring, and stacking
      // costs only vertical space while keeping every figure in place.
      for (const child of s.children) renderSection(c, child);
      return;

    default: {
      const _never: never = s;
      return _never;
    }
  }
}

/**
 * Renders `doc` to a PDF with embedded Noto Naskh Arabic.
 *
 * Async because pdfkit streams: the buffer is only complete once the document
 * has ended. `buildExportStub` is already async, so this costs nothing at the
 * call site.
 */
export function renderReportPdfUnicode(doc: ReportDoc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: [PAGE_W, PAGE_H], margin: MARGIN, autoFirstPage: true });
    const chunks: Buffer[] = [];
    pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);

    try {
      pdf.registerFont("AR-Regular", REGULAR);
      pdf.registerFont("AR-Bold", BOLD);
    } catch (err) {
      // A missing font must fail loudly. Falling back to Helvetica would
      // silently reproduce the "?????" output this renderer exists to replace.
      reject(
        new Error(
          `Arabic report font not found under ${FONT_DIR}. ` +
            `Expected NotoNaskhArabic-Regular.ttf and NotoNaskhArabic-Bold.ttf. ` +
            `Original error: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }

    const c: Ctx = {
      doc: pdf,
      rtl: doc.rtl === true,
      y: MARGIN,
      anchors: collectAnchors(
        doc.chapters?.length ? doc.chapters.flatMap((ch) => ch.sections) : doc.sections,
        new Set(),
      ),
      contentsDest: "contents",
      t: translator(doc.locale ?? DEFAULT_APP_LOCALE),
    };
    // The contents page is the first thing drawn, so its destination is
    // registered before any "back" link can reference it.
    pdf.addNamedDestination(c.contentsDest);

    // Masthead. WRAPPED, not a single line: a study title is long, RTL, and
    // often carries an English fragment, and drawing it with `lineBreak: false`
    // ran it straight off the right edge of the page — the first thing a reader
    // saw was a clipped title.
    for (const line of wrap(c, doc.title, CONTENT_W, true, 16)) {
      ensure(c, 34);
      drawLine(c, line, MARGIN, CONTENT_W, { bold: true, size: 16, color: ACCENT });
      c.y += 21;
    }
    c.y += 6;
    if (doc.headerBand.length) {
      const bandTop = c.y;
      // Measured before drawing, not by drawing twice: the band's tint has to
      // go down first or it would cover the text, and its height is not known
      // until the rows have been wrapped.
      const bandHeight = keyValueHeight(c, doc.headerBand) + 10;
      pdf.rect(MARGIN - 6, bandTop, CONTENT_W + 12, bandHeight).fillColor(LIGHT).fill();
      c.y = bandTop + 5;
      keyValueRows(c, doc.headerBand);
      c.y = bandTop + bandHeight + 4;
    }

    if (doc.chapters?.length) {
      // Chapter layout, matching the English edition's structure: a contents
      // page of clickable boxes, then one page per chapter with a way back.
      //
      // The English renderer reveals chapters as PDF optional-content layers
      // (/OCG + /SetOCGState), which only Acrobat honours and which pdfkit does
      // not expose. Real pages give the same navigation in every viewer,
      // including browser previews, and print correctly — which an
      // all-collapsed layered document does not.
      //
      // `doc.sections` carries the SAME content in reading order, so rendering
      // both would print the whole report twice.
      chapterContents(c, doc.chapters);
      for (const [i, chapter] of doc.chapters.entries()) {
        newPage(c);
        c.doc.addNamedDestination(chapterDest(i));
        backLink(c);
        sectionHeading(c, chapter.name);
        for (const section of chapter.sections) renderSection(c, section);
      }
    } else {
      for (const section of doc.sections) renderSection(c, section);
    }

    if (doc.audit.length) {
      sectionHeading(c, "");
      keyValueRows(c, doc.audit);
    }

    pdf.end();
  });
}
