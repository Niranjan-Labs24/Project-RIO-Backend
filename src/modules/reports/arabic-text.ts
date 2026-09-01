import fontkit from "fontkit";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import bidiFactory from "bidi-js";

// RIO-NFR-007 (Arabic RTL) / RIO-NFR-008 (Export Quality) — the PDF/Excel
// export path previously had no Arabic glyph support at all: pdf-builder.ts's
// esc() restricts every string to WinAnsi/ASCII and folds anything else to
// "?", so any Arabic value (a village name, a free-text note, a domain label)
// printed as a run of question marks in exported reports. This module gives
// the PDF renderer a real, embeddable Arabic font (Amiri, SIL OFL — see
// assets/fonts/Amiri-OFL.txt) with correct contextual letter shaping and
// right-to-left character ordering, so Arabic text in an export reads the
// same as it does on screen.
//
// Scope: this fixes the concrete defect that was found — Arabic CONTENT
// renders as real, correctly-shaped, correctly-ordered Arabic instead of "?"
// marks, wherever it appears in a report. It does not re-flow the report's
// overall page/column layout right-to-left (report copy itself is authored
// in English) — that would be a separate, much larger layout change.

const bidi = bidiFactory();

const FONT_DIR = join(__dirname, "../../../assets/fonts");

interface LoadedArabicFont {
  font: fontkit.Font;
  ttfLatin1: string;
  ttfByteLength: number;
}

let regular: LoadedArabicFont | null = null;
let bold: LoadedArabicFont | null = null;

function load(path: string): LoadedArabicFont {
  const bytes = readFileSync(path);
  const font = fontkit.openSync(path);
  if ("fonts" in font) {
    throw new Error(`Arabic font at ${path} is a font collection, expected a single font`);
  }
  return { font: font as fontkit.Font, ttfLatin1: bytes.toString("latin1"), ttfByteLength: bytes.length };
}

/** Lazily loads and caches the embedded Arabic fonts (regular + bold). */
export function getArabicFont(weight: "regular" | "bold"): LoadedArabicFont {
  if (weight === "bold") {
    if (!bold) bold = load(join(FONT_DIR, "Amiri-Bold.ttf"));
    return bold;
  }
  if (!regular) regular = load(join(FONT_DIR, "Amiri-Regular.ttf"));
  return regular;
}

// Arabic script Unicode ranges actually reachable from user/system input here:
// Arabic, Arabic Supplement, Arabic Presentation Forms A/B. Old-Arabic
// historical blocks and Extended-A are out of scope — no source in this app
// produces them.
const ARABIC_RE = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;

export function hasArabic(str: string): boolean {
  return ARABIC_RE.test(str);
}

export interface ShapedGlyphChunk {
  kind: "arabic";
  glyphIds: number[];
  /** Advance width per glyph, in 1000-unit em (matches the PDF /W convention
   *  used everywhere else in pdf-builder.ts). */
  advances1000: number[];
}
export interface LatinChunk {
  kind: "latin";
  text: string;
}
export type ShapedChunk = ShapedGlyphChunk | LatinChunk;

function isRtlChar(ch: string): boolean {
  return ARABIC_RE.test(ch);
}

/**
 * Splits `str` into alternating Arabic-script/non-Arabic runs in ORIGINAL
 * LOGICAL order, each tagged with its REAL Unicode bidi embedding level
 * (from bidi-js's full implementation of UAX #9 rules X1-I2) rather than a
 * naive "Arabic=1, other=0" guess. That distinction matters: inside an RTL
 * paragraph, an embedded Latin/number run (e.g. "Q-WASH-201") is correctly
 * assigned an even level ABOVE the base RTL level (level 2, not 0) — using
 * the naive guess here made every run's level alternate 1/0/1/0 with no two
 * adjacent runs ever sharing a level, so the L2 reversal below never found a
 * multi-run group to swap and mixed-direction lines silently kept their
 * storage order instead of their correct reading order.
 */
function splitRuns(str: string): Array<{ text: string; rtl: boolean; level: number }> {
  const { levels } = bidi.getEmbeddingLevels(str);
  const runs: Array<{ text: string; rtl: boolean; level: number }> = [];
  let cur = "";
  let curRtl = false;
  let curLevel = -1;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]!;
    const rtl = isRtlChar(ch);
    const level = levels[i] ?? 0;
    if (cur === "") {
      cur = ch;
      curRtl = rtl;
      curLevel = level;
    } else if (rtl === curRtl) {
      cur += ch;
      // A run keeps the highest level any of its characters actually has —
      // whitespace between two Arabic words is classified non-Arabic by
      // ARABIC_RE but bidi-js resolves it to the surrounding RTL level, and
      // the run must carry that real level for L2 below, not a lower one
      // that would wrongly split an otherwise-uniform Arabic phrase's order.
      curLevel = Math.max(curLevel, level);
    } else {
      runs.push({ text: cur, rtl: curRtl, level: curLevel });
      cur = ch;
      curRtl = rtl;
      curLevel = level;
    }
  }
  if (cur) runs.push({ text: cur, rtl: curRtl, level: curLevel });
  return runs;
}

/**
 * Reorders logical runs into final left-to-right PAINT order per the
 * Unicode Bidirectional Algorithm's run-swap rule (UAX #9 L2): from the
 * highest level down to 1, reverse the ORDER of maximal contiguous groups of
 * runs at that level or higher. Applied to whole runs (each internally
 * uniform in level) rather than individual characters — equivalent to the
 * character-level rule as long as each run's `level` is its real bidi level
 * (see splitRuns), and simpler to get right for report-sized text.
 */
function reorderRuns<T extends { level: number }>(runs: T[]): T[] {
  let ordered = runs.slice();
  const maxLevel = Math.max(0, ...runs.map((r) => r.level));
  for (let level = maxLevel; level >= 1; level--) {
    const next: T[] = [];
    let i = 0;
    while (i < ordered.length) {
      if (ordered[i]!.level >= level) {
        let j = i;
        while (j < ordered.length && ordered[j]!.level >= level) j++;
        next.push(...ordered.slice(i, j).reverse());
        i = j;
      } else {
        next.push(ordered[i]!);
        i++;
      }
    }
    ordered = next;
  }
  return ordered;
}

/**
 * Shapes `str` into an ordered list of paint-ready chunks: Arabic runs are
 * shaped through the embedded font (real contextual joining via the font's
 * own GSUB tables, courtesy of fontkit) and returned as glyph id + advance
 * pairs already in left-to-right paint order for that run; non-Arabic runs
 * are returned untouched for the existing ASCII/Helvetica path. Chunks are
 * returned in final visual (left-to-right drawing) order for the whole
 * string, so a caller just draws them one after another.
 */
export function shapeArabicAware(str: string, weight: "regular" | "bold" = "regular"): ShapedChunk[] {
  const runs = splitRuns(str);
  const visualRuns = reorderRuns(runs);
  const { font } = getArabicFont(weight);
  const chunks: ShapedChunk[] = [];
  for (const run of visualRuns) {
    if (!run.rtl) {
      chunks.push({ kind: "latin", text: run.text });
      continue;
    }
    const glyphRun = font.layout(run.text, undefined, undefined, undefined, "rtl");
    const glyphIds: number[] = [];
    const advances1000: number[] = [];
    glyphRun.glyphs.forEach((g: fontkit.Glyph, i: number) => {
      glyphIds.push(g.id);
      advances1000.push(Math.round((glyphRun.positions[i]!.xAdvance / font.unitsPerEm) * 1000));
    });
    chunks.push({ kind: "arabic", glyphIds, advances1000 });
  }
  return chunks;
}

/** Sum of a shaped chunk list's advance widths, in PDF points at `size`. */
export function shapedWidth(chunks: ShapedChunk[], size: number, asciiWidth: (s: string, size: number) => number): number {
  let w = 0;
  for (const c of chunks) {
    if (c.kind === "latin") w += asciiWidth(c.text, size);
    else w += (c.advances1000.reduce((a, b) => a + b, 0) * size) / 1000;
  }
  return w;
}

// Exposed for tests / the assemble() pass that builds the embedded font's
// PDF objects (FontFile2 stream, FontDescriptor, CIDFontType2, Type0).
export { bidi };
