/**
 * Splits a line of mixed-direction text into directional runs, in the visual
 * order a left-to-right renderer must draw them.
 *
 * WHY RUNS, AND NOT A REORDERED STRING
 *
 * fontkit (which pdfkit uses for TrueType text) already does two things for an
 * Arabic string: it applies the Arabic shaper so letters take their contextual
 * forms, and it emits the glyphs of an RTL run in right-to-left order. Handing
 * it a string we had already reversed ourselves would reverse it twice AND
 * compute the contextual forms against the wrong neighbours, producing
 * disconnected, backwards Arabic — worse than the question marks we started
 * with.
 *
 * So this module must not touch character order inside a run. Its only job is
 * to decide WHICH RUN GOES WHERE, and let fontkit render each one natively.
 *
 * The problem it solves, observed in a real RPT04 export:
 *
 *     "مؤشر الاحتياجات: 33 / 100 (متوسط)"
 *
 * Drawn as one string, fontkit treats the whole line as RTL and the figure ends
 * up on the wrong side of the phrase. Split into runs — Arabic, number, Arabic
 * — and emitted in visual order, each run renders correctly and the line reads
 * right.
 *
 * WHAT IT IMPLEMENTS
 *
 * A pragmatic subset of the Unicode Bidirectional Algorithm for a paragraph
 * whose base direction is RTL:
 *
 *   1. Classify each character R (Arabic), L (Latin/digits) or N (neutral).
 *   2. Numbers absorb their own separators and a trailing sign — "41.6%" and
 *      "33.33" are single left-to-right tokens, never split.
 *   3. Resolve neutrals (UBA N1/N2, simplified): a neutral run between two runs
 *      of the same direction joins them; otherwise it takes the paragraph
 *      direction, which is RTL here.
 *   4. Emit the runs in reverse order — RTL base direction — mirroring paired
 *      punctuation that sits at RTL level so brackets open on the correct side.
 *
 * Full UBA handles embedding levels, explicit direction marks and isolates.
 * None of those appear in generated report text (prose, names and figures), so
 * the subset is sufficient and directly testable. If report content ever
 * carries user-authored bidi controls, replace this with a real UBA library
 * rather than growing it.
 */

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const LATIN = /[A-Za-zÀ-ɏ]/;
const DIGIT = /[0-9]/;

export type RunDirection = 'rtl' | 'ltr';

export interface BidiRun {
  text: string;
  dir: RunDirection;
}

type Dir = 'R' | 'L' | 'N';

/** Paired characters whose glyph must flip when drawn at RTL level. */
const MIRROR: Record<string, string> = {
  '(': ')',
  ')': '(',
  '[': ']',
  ']': '[',
  '{': '}',
  '}': '{',
  '<': '>',
  '>': '<',
};

export function containsArabic(text: string): boolean {
  return ARABIC.test(text);
}

function classify(ch: string): Dir {
  if (ARABIC.test(ch)) return 'R';
  if (LATIN.test(ch) || DIGIT.test(ch)) return 'L';
  return 'N';
}

/**
 * Directional runs of `text`, in the order they must be drawn left to right.
 *
 * Text containing no Arabic returns a single LTR run holding the original
 * string, so every English string in the document takes an identity path and
 * the English PDF is unaffected.
 */
export function bidiRuns(text: string): BidiRun[] {
  if (!containsArabic(text)) return [{ text, dir: 'ltr' }];

  const chars = [...text];
  const dirs: Dir[] = chars.map(classify);

  // Numbers are single LTR tokens: a separator or percent sign flanked the
  // right way by digits belongs to the number, not to the neutral run around
  // it. Without this, "41.6%" splits and renders as "6.14%" or "%41.6".
  const NUMBER = /\d(?:[\d.,:]*\d)?%?/gu;
  for (const m of text.matchAll(NUMBER)) {
    const start = [...text.slice(0, m.index)].length;
    for (let k = 0; k < [...m[0]].length; k++) dirs[start + k] = 'L';
  }

  // Resolve neutral runs (UBA N1/N2, simplified). Sequence boundaries count as
  // the paragraph direction, so leading and trailing punctuation stays with the
  // Arabic rather than being stranded on the wrong edge.
  for (let i = 0; i < dirs.length; i++) {
    if (dirs[i] !== 'N') continue;
    let end = i;
    while (end + 1 < dirs.length && dirs[end + 1] === 'N') end++;
    const before: Dir = i > 0 ? dirs[i - 1]! : 'R';
    const after: Dir = end + 1 < dirs.length ? dirs[end + 1]! : 'R';
    const resolved: Dir = before === after && before !== 'N' ? before : 'R';
    for (let j = i; j <= end; j++) dirs[j] = resolved;
    i = end;
  }

  // Group into maximal same-direction runs, in logical order.
  const logical: BidiRun[] = [];
  let i = 0;
  while (i < chars.length) {
    const d = dirs[i]!;
    let end = i;
    while (end + 1 < chars.length && dirs[end + 1] === d) end++;
    let segment = chars.slice(i, end + 1).join('');
    if (d === 'R') {
      // Mirror paired punctuation sitting at RTL level. Characters inside an
      // LTR run keep their glyphs — "(100%)" is read left to right and its
      // brackets must not flip.
      segment = [...segment].map((c) => MIRROR[c] ?? c).join('');
    }
    logical.push({ text: segment, dir: d === 'L' ? 'ltr' : 'rtl' });
    i = end + 1;
  }

  // RTL paragraph: the first logical run is drawn rightmost, so visual order is
  // the reverse of logical order. Characters WITHIN each run are untouched —
  // fontkit reverses RTL glyphs itself.
  return logical.reverse();
}

/** Convenience for callers that only need to know whether a line needs the
 *  run-by-run drawing path at all. */
export function isSimpleLine(text: string): boolean {
  return bidiRuns(text).length <= 1;
}
