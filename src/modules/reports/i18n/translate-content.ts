import type { SupportedLocale } from '../../translation/translation.types';

// The free-text half of RIO-NFR-007: the prose in a report that nobody has a
// pre-existing translation for — AI narrative, officer recommendations,
// qualitative evidence summaries, reviewer notes.
//
// This is the only part of the export that costs AI spend, so what it does NOT
// send matters as much as what it does.
//
// ## Why it runs on `content`, not on the built document
//
// By the time report-doc.ts has produced a ReportDoc, every string is just a
// cell or a list item — the provenance is gone, and an AI recommendation is
// indistinguishable from a methodology sentence that happens to read like one.
// Guessing from the text is exactly the mistake to avoid here: sending a
// deterministic sentence to the translator means paying for a new cache entry
// on every distinct number in it, forever, and letting a model rewrite figures
// that must reconcile with the Priority Dashboard.
//
// So this walks NAMED PATHS in the content contract (report-content.types.ts).
// A field is translated because it was declared free prose, not because it
// looked like prose.

/** A field that holds human- or AI-authored prose. Paths use dots for objects
 *  and `[]` for "every element of this array". */
const PROSE_PATHS: readonly string[] = [
  // ── AI narrative block (RPT01 / RPT10 / RPT13 / RPT14) ──
  'aiSummary.executiveSummary',
  'aiSummary.keyFindings',
  'aiSummary.recommendations[]',
  // Promoted first-class copies of two of the above.
  'dataQualityNote',
  'trendNote',

  // ── RPT16 / RPT17 ──
  'recommendations[]',
  'qualitativeEvidence[].theme',
  'qualitativeEvidence[].summary',
  'evidenceSection.documents[].title',
  'evidenceSection.documents[].description',
  // The two nested narratives. These carry the bulk of RPT16's prose — the
  // findings, the domain insights and the priority explanation a reader
  // actually reads — and were the largest block of untranslated text in the
  // first real-data run.
  'scoreSummarySection.executiveSummary',
  'scoreSummarySection.dataQualityNote',
  'scoreSummarySection.trendNote',
  'scoreSummarySection.priorityExplanation',
  'scoreSummarySection.keyFindings[].title',
  'scoreSummarySection.keyFindings[].summary',
  'scoreSummarySection.domainInsights[].summary',
  'combinedSummarySection.executiveSummary',
  'combinedSummarySection.dataQualityNote',
  'combinedSummarySection.trendNote',
  'combinedSummarySection.priorityExplanation',
  'combinedSummarySection.keyFindings[].title',
  'combinedSummarySection.keyFindings[].summary',
  'combinedSummarySection.domainInsights[].summary',

  // ── Reviewer / officer notes ──
  'reviewerNotes[].note',
  'collective.reviewerNotes[].note',

  // ── Composed explanatory notes (RPT10) ──
  // Sentences the provider writes about scope and completeness. They carry
  // figures, but the figure is embedded in a sentence that is otherwise
  // authored prose, and there is no template to parameterise them from.
  'dataCollection.scope.note',
  'dataCollection.abandonment.note',
  'dataCollection.invalidResponses.basis',
  'dataCollection.unansweredRequired.note',

  // ── Per-record explanations ──
  // Why a record was flagged, why a confidence band was assigned, why equity
  // could not be evaluated. Written for a human to read.
  'flaggedRecords[].reason',
  'responseQuality.confidenceReason',
  'severity.domains[].confidenceReason',
  'needRecords[].confidenceReason',
  'needRecords[].equityDetail.reason',
  'unitGeo.scopeLabel',

  // ── Methodology explanations (RPT01 / RPT03 / RPT09) ──
  // The "how this was calculated" and "how to read these columns" blocks: long
  // explanatory paragraphs sitting directly under the tables they explain, and
  // the most visible English left in a real export.
  //
  // Paths verified against a stored report rather than inferred from the
  // types — an earlier guess at these names ('calculationBasis.needsIndex',
  // 'priority.scoreDirection') matched nothing and silently changed nothing.
  'calculationBasis.needsIndexFormula',
  'calculationBasis.priorityScoreFormula',
  'calculationBasis.severityBandingRule',
  'calculationBasis.confidenceRule',
  'calculationBasis.equityRule',
  'calculationBasis.gapTypeRule',
  'priorityNeeds.rankingBasis',
  'priorityNeeds.villagePriority.coverageBasis',
  'priorityNeeds.villagePriority.scoreDirectionNote',
  'priorityNeeds.needs[].equityDetail.reason',
  'priorityNeeds.needs[].confidenceReason',
  'priorityNeeds.needs[].notes',

  // ── Pattern analysis (RPT01) ──
  'patternAnalysis.evidenceNote',
  'patternAnalysis.patterns[].pattern',
  'patternAnalysis.patterns[].scopeLabel',
  'patternAnalysis.patterns[].evidence',
  'patternAnalysis.gaps[].description',

  // ── Report basis badges ──
  // "SURVEY-ONLY — derived from survey responses, no document evidence" and its
  // QUANTITATIVE counterpart, printed on the cover of every report.
  'reportMeta.sourceBasis',
  'reportMeta.evidenceType',

  // ── Flagged records / not-measured explanations ──
  'flaggedRecords[].notMeasuredReason',
  'needRecords[].notes',
  'needRecords[].notMeasuredReason',
];

// Paths deliberately NOT listed above, and why — this is the half of the design
// that keeps the export correct and the AI bill finite:
//
//   *.domainCode, *.domainKey, *.severityBand, *.priorityStatus, approval.status,
//   survey.surveyStatus, flaggedRecords[].flag, sourceRef.kind, reportKind,
//   gapType, sourceType, severityScorePolicy
//       Enum values. They drive colour selection, banding and lookups, and they
//       need a value-position mapping to fixed Arabic — not a model's paraphrase.
//
//   *.name on domains, subDomain, indicatorName, kpiName, geography.*
//       Master data. Authoritative Arabic already exists in nameAr /
//       indicatorAr / kpiAr, and asking the AI instead would make the PDF
//       disagree with the screen.
//
//   *.surveyId, *.studyId, snapshotId, needId, methodologyVersionId
//       Identifiers.
//
//   coverageStatement and the calculation traces
//       Deterministic sentences with interpolated figures. Every distinct
//       number would be a new permanent cache entry, and a model rewriting
//       33.72 breaks reconciliation with the Priority Dashboard.

/** Never sent, whatever path they sit on. */
function isTranslatable(text: string): boolean {
  const s = text.trim();
  if (s.length < 2) return false;
  // No Latin letters to translate.
  if (!/[A-Za-z]{2,}/.test(s)) return false;
  // Deliberately NO "contains Arabic -> skip" rule.
  //
  // That check was here and was wrong. A backend-composed string frequently
  // mixes a fixed English template with an Arabic value —
  //   This survey, part of the 'تقييم خدمات الرعاية الصحية الأولية' assessment
  //   in Ad-Dawadmi, Riyadh, reveals a MEDIUM overall need severity score...
  // — which is majority-Arabic by character count while its English half is
  // entirely untranslated. Skipping on the presence of any Arabic left every
  // one of those stuck in English, and it was invisible next to a sibling
  // field that happened to be pure English and therefore translated fine.
  //
  // TranslationService already gets this right: `needsTranslation` looks for
  // the OPPOSITE script rather than comparing dominant-script labels, and its
  // own comment describes this exact failure. A fully-Arabic string handed to
  // it costs nothing — it short-circuits before calling the provider — so the
  // right thing is to let it decide instead of second-guessing it here.
  // The `[A-Za-z]{2,}` test above already excludes strings with no Latin at
  // all, which is the only case worth filtering locally.
  // Enum identifiers, codes, ids: SCREAMING_SNAKE, RPT01, UUIDs.
  if (/^[A-Z0-9_]+$/.test(s)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s)) return false;
  // ISO timestamps and plain dates.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return false;
  return true;
}

export interface Translator {
  translate(
    text: string,
    targetLocale: SupportedLocale,
  ): Promise<{ translatedText: string; unchanged: boolean }>;
}

export interface TranslateContentResult {
  content: Record<string, unknown>;
  /** Distinct strings sent. Zero on a second export of the same report, because
   *  TranslationService caches permanently — that is the property the budget
   *  test asserts. */
  requested: number;
  /** How many came back unchanged because the provider was unavailable. A
   *  degraded export is legitimate but must not be silent. */
  failed: number;
}

/** A string found at a declared path, plus how to write it back. */
type Visit = (text: string, write: (value: string) => void) => void;

/**
 * Walk one declared path and hand every string slot it addresses to `visit`.
 *
 * The grammar is deliberately tiny — a dot descends into an object, `[]`
 * iterates an array — because the paths describe a typed contract, not
 * arbitrary JSON. Anything the path does not name is never touched, which is
 * the property that keeps deterministic sentences and figures away from the
 * translator.
 */
function walkPath(node: unknown, segments: readonly string[], visit: Visit): void {
  if (node === null || node === undefined) return;

  const [head, ...rest] = segments;

  if (head === undefined) return;

  if (head === '[]') {
    if (!Array.isArray(node)) return;
    const arr = node as unknown[];
    arr.forEach((item, i) => {
      if (rest.length === 0) {
        if (typeof item === 'string') visit(item, (v) => (arr[i] = v));
      } else {
        walkPath(item, rest, visit);
      }
    });
    return;
  }

  if (typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;

  if (rest.length === 0) {
    const value = obj[head];
    if (typeof value === 'string') visit(value, (v) => (obj[head] = v));
    return;
  }
  walkPath(obj[head], rest, visit);
}

function parsePath(path: string): string[] {
  return path
    .replace(/\[\]/g, '.[]')
    .split('.')
    .filter(Boolean);
}

/**
 * Translate a report's free prose into `locale`.
 *
 * Mutates a deep copy, never the caller's object — a stored report's content is
 * the record of what was generated and must not change because someone
 * downloaded it in Arabic.
 */
export async function translateReportContent(
  content: Record<string, unknown>,
  locale: SupportedLocale,
  translator: Translator,
  options: { concurrency?: number } = {},
): Promise<TranslateContentResult> {
  if (locale === 'en') return { content, requested: 0, failed: 0 };

  const copy = structuredClone(content) as Record<string, unknown>;

  // Pass 1 — gather distinct strings and where each one goes.
  const writers = new Map<string, Array<(v: string) => void>>();
  const visit: Visit = (text, write) => {
    if (!isTranslatable(text)) return;
    const list = writers.get(text);
    if (list) list.push(write);
    else writers.set(text, [write]);
  };
  for (const path of PROSE_PATHS) walkPath(copy, parsePath(path), visit);

  const distinct = [...writers.keys()];
  if (distinct.length === 0) return { content: copy, requested: 0, failed: 0 };

  // Pass 2 — translate, bounded. An unbounded Promise.all over a
  // first-generation report can be hundreds of concurrent calls to the AI
  // provider; cache hits are free, but the misses all land at once.
  const results = new Map<string, string>();
  let failed = 0;
  const limit = Math.max(1, options.concurrency ?? 8);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= distinct.length) return;
      const source = distinct[index]!;
      const out = await translator.translate(source, locale);
      // `unchanged` covers both "already in the target language" and "the
      // provider failed and we fell back to the source" — TranslationService
      // never throws. Only the second is a degradation, and the two are
      // indistinguishable from here, so this counts anything that came back
      // identical and reports it as a tally rather than a per-string warning.
      if (out.translatedText === source) failed++;
      results.set(source, out.translatedText);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, distinct.length) }, worker));

  // Pass 3 — write back. Every occurrence of a string gets the same
  // translation, which is why the map is keyed by text.
  for (const [source, write] of writers) {
    const translated = results.get(source);
    if (translated === undefined) continue;
    for (const w of write) w(translated);
  }

  return { content: copy, requested: distinct.length, failed };
}
