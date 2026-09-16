/**
 * RIO-AI-003 AC 5 — "Summarization preserves key facts (location, need type,
 * affected group) without introducing unsupported claims."
 *
 * As written that is prose, not something a test can assert. This module turns
 * it into three mechanical checks that run on every generated summary and are
 * exercised against a fixture set in need-summary.verify.spec.ts:
 *
 *   1. FACT_NOT_IN_SOURCE — the model listed a "preserved fact" that does not
 *      occur in the source. It invented the fact and then vouched for it.
 *   2. FACT_DROPPED       — the model listed a fact it kept, but the fact is
 *      absent from its own summary. It knew what mattered and lost it anyway.
 *   3. NUMBER_INVENTED    — a number appears in the summary that appears
 *      nowhere in the source. This is the single highest-value check: a
 *      fabricated count ("about 50 households") reads as evidence and would
 *      travel straight into a report.
 *
 * These are deliberately CONSERVATIVE — they only fire on something provably
 * wrong, because a false alarm on every summary trains reviewers to ignore the
 * warning. Anything subtler (a reversed meaning, an unsupported causal claim)
 * is what the human confirmation gate in AC 3 is for; no string check finds it.
 */

export type SummaryWarningCode = 'FACT_NOT_IN_SOURCE' | 'FACT_DROPPED' | 'NUMBER_INVENTED';

export interface SummaryWarning {
  code: SummaryWarningCode;
  /** The offending fact or number, so the reviewer is pointed at it directly. */
  detail: string;
}

/**
 * Arabic-Indic digits map onto ASCII so a number written ٥٠ in an Arabic
 * statement and 50 in the summary (or the reverse) is recognised as the same
 * number rather than reported as invented. The client's threshold decision is
 * language-neutral; this check has to be too.
 */
const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EASTERN_ARABIC_INDIC = '۰۱۲۳۴۵۶۷۸۹';

function normalizeDigits(text: string): string {
  let out = '';
  for (const ch of text) {
    const ai = ARABIC_INDIC.indexOf(ch);
    if (ai >= 0) { out += String(ai); continue; }
    const ea = EASTERN_ARABIC_INDIC.indexOf(ch);
    if (ea >= 0) { out += String(ea); continue; }
    out += ch;
  }
  return out;
}

/**
 * Comparison form: digits normalised, case folded, and every run of
 * whitespace or punctuation collapsed to a single space.
 *
 * The punctuation collapse matters more than it looks. A model routinely
 * returns "Al-Jumum North" for a source that reads "Al Jumum North", or drops a
 * comma inside a list of villages. Treating those as different strings would
 * make FACT_DROPPED fire constantly on summaries that are in fact correct.
 */
function normalize(text: string): string {
  return normalizeDigits(text)
    .toLowerCase()
    .replace(/[\s،؛؟.,;:!?()[\]{}"'`_/\\-]+/g, ' ')
    .trim();
}

/** Numbers written as digits. Thousands separators and decimals are kept as
 *  part of one token, then stripped, so "13,800" and "13800" compare equal. */
function extractNumbers(text: string): string[] {
  const matches = normalizeDigits(text).match(/\d[\d,.٫٬]*/g) ?? [];
  return matches
    .map((m) => m.replace(/[,.٫٬]+$/, '').replace(/[,٬]/g, ''))
    .filter((m) => m.length > 0);
}

export function verifySummary(
  sourceStatement: string,
  summaryText: string,
  preservedFacts: string[],
): SummaryWarning[] {
  const warnings: SummaryWarning[] = [];
  const source = normalize(sourceStatement);
  const summary = normalize(summaryText);

  for (const raw of preservedFacts) {
    const fact = normalize(raw);
    // A one- or two-character "fact" matches almost any text by accident and
    // would make both checks below meaningless.
    if (fact.length < 3) continue;

    if (!source.includes(fact)) {
      warnings.push({ code: 'FACT_NOT_IN_SOURCE', detail: raw });
      // No point also asking whether an invented fact survived into the
      // summary — the first warning is the real problem.
      continue;
    }
    if (!summary.includes(fact)) {
      warnings.push({ code: 'FACT_DROPPED', detail: raw });
    }
  }

  const sourceNumbers = new Set(extractNumbers(sourceStatement));
  for (const n of extractNumbers(summaryText)) {
    if (!sourceNumbers.has(n)) {
      warnings.push({ code: 'NUMBER_INVENTED', detail: n });
    }
  }

  return warnings;
}

/** Stored on the summary row as `TEXT[]`, so the reviewer UI can show what to
 *  look at without re-running the checks. `CODE:detail` keeps it one flat
 *  array — a JSON column here would be over-engineering for two fields. */
export function encodeWarnings(warnings: SummaryWarning[]): string[] {
  return warnings.map((w) => `${w.code}:${w.detail}`);
}

export function decodeWarnings(encoded: string[]): SummaryWarning[] {
  return encoded.map((raw) => {
    const idx = raw.indexOf(':');
    return {
      code: raw.slice(0, idx) as SummaryWarningCode,
      detail: raw.slice(idx + 1),
    };
  });
}
