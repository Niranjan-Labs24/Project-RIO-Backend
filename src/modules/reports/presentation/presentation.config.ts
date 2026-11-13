// Report presentation (NCNP feedback, Sept 2026 — "Design updated.pdf").
//
// Every rule the client may revisit lives in this one file: the confidence
// band thresholds, the Fit-to-Publish rule, the village-concentration levels,
// which blocks each report type shows, the decision rule, and the palette.
// The builder (build-presentation.ts) and both renderers (PDF here, the
// on-screen view in the frontend) only read these values, and all wording is
// in the shared label catalogue (frontend messages → app.reports.content.
// presentation, synced to report-labels.generated.ts) in English and Arabic.
// A change of rule or wording is therefore one edit, not a hunt.

/** Simplified confidence bands (client feedback point 2). */
export type ConfidenceBand = 'VERY_LOW' | 'MEDIUM' | 'STRONG';

export const CONFIDENCE_BANDS = {
  /** Fewer valid responses than this is "very low" — not to be relied on. */
  mediumFrom: 10,
  /** "Strong" from the study's own required sample size (computed from its
   *  population). When a study has none, strong is never reached. */
  strongFromRequiredSampleSize: true,
} as const;

/** A KPI is fit to publish only at or above this band. */
export const FIT_TO_PUBLISH_MIN_BAND: ConfidenceBand = 'STRONG';

/** How concentrated a governorate's responses are in one village. */
export type ParticipationStatus = 'FULLY_CONCENTRATED' | 'CONCENTRATED';
export const PARTICIPATION_STATUS = {
  /** One village holds this share (%) or more of the governorate's responses. */
  concentratedFromPct: 70,
} as const;

/** Blocks a report can carry, in the order they are drawn. */
export type PresentationBlock =
  'summary' | 'confidence' | 'participation' | 'kpis' | 'adaptiveWording' | 'excluded' | 'signOff';

const ALL_BLOCKS: PresentationBlock[] = [
  'summary',
  'confidence',
  'participation',
  'kpis',
  'adaptiveWording',
  'excluded',
  'signOff',
];

/**
 * Which blocks each report type shows. The client asked for the same template
 * on every report for now; narrowing one type later is a one-line change here.
 * A block whose data a report does not have is skipped automatically.
 */
// Switched off (client, 15 Oct 2026): the six current reports are replaced by
// the Core Needs Report (RPT18), and the bands these blocks print are not the
// v5.0 methodology's. The current reports keep their existing layout until then.
export const BLOCKS_BY_REPORT_TYPE: Record<string, PresentationBlock[]> = {
  default: [],
  // The sharing-status log is an access log, not a needs report.
  RPT12: [],
};

export function blocksFor(reportType: string): PresentationBlock[] {
  return BLOCKS_BY_REPORT_TYPE[reportType] ?? BLOCKS_BY_REPORT_TYPE.default!;
}

/**
 * Report types whose EXISTING sections are also restyled to the client's
 * design (cards, the design's tables and typography, confidence bands in
 * place of LOW/STANDARD, demographics as rings) — in the app and the PDF.
 * Rolled out one type at a time: add a type here once it has been checked.
 */
export const DESIGN_STYLE_REPORT_TYPES: readonly string[] = [];
/** Kept for when a block set is reintroduced; unused while the list is empty. */
export const ALL_PRESENTATION_BLOCKS = ALL_BLOCKS;

/**
 * Where each repeated section is printed in full (client confirmation, Oct
 * 2026): the Executive Summary holds the AI Summary and the demographics, the
 * Data-Quality report the data-quality note. The other design-style reports
 * show a one-line reference in their place.
 */
export type SharedSection = 'aiSummary' | 'demographics' | 'dataQualityNote';
export const SECTION_HOME: Record<SharedSection, string> = {
  aiSummary: 'RPT13',
  demographics: 'RPT13',
  dataQualityNote: 'RPT10',
};

/**
 * Sections printed in full in every report today (feedback point 1). They are
 * shown collapsed: an accordion on screen, and in the PDF a one-line entry
 * that links to the full text on its own page. Keys are content fields.
 */
export const COLLAPSED_SECTIONS: readonly ('aiSummary' | 'demographics' | 'dataQualityNote')[] = [];

/** What the summary recommends, by confidence band and overall severity. */
export type DecisionKey = 'collectMore' | 'confirmThenAct' | 'prioritise' | 'monitor';
export function decisionFor(band: ConfidenceBand, severityLabel: string | null): DecisionKey {
  if (band === 'VERY_LOW') return 'collectMore';
  const severe = severityLabel === 'CRITICAL' || severityLabel === 'HIGH';
  if (band === 'MEDIUM') return severe ? 'confirmThenAct' : 'monitor';
  return severe ? 'prioritise' : 'monitor';
}

/**
 * Report palette. Used by the PDF renderer; the frontend keeps the same
 * values in its report stylesheet, so the two must stay in step.
 *
 * These were eyedropped from the client's mockup and came out close to the
 * NCNP codes without matching them — #155463 against #145463, #3b7ca7
 * against #4080AB, #58a490 against #59A694. The identity usage note of
 * 10 Nov 2026 allows only the exact codes, so each is now the real one.
 *
 *   #145463  dominant    headings, rules, the header band
 *   #59A694  supporting  dividers, a met-standard bar
 *   #4080AB  occasional  secondary bars
 *   #69B2B0  secondary   a hairline, nothing larger
 *
 * The severity colours stay as they are: the note reserves red, amber and
 * green for status meaning, which is exactly what they carry.
 */
export const PRESENTATION_PALETTE = {
  primary: '#145463',
  primaryText: '#145463',
  accent: '#4080AB',
  summaryLabel: '#69B2B0',
  summaryDivider: '#59A694',
  veryLow: '#be3a2a',
  medium: '#ccaa2e',
  strong: '#59A694',
  danger: '#c94f4b',
  cardBorder: '#e5ebe9',
  panel: '#f5f7f6',
  noticeBg: '#f7f5de',
  noticeBorder: '#e9e0a4',
  muted: '#6b7280',
} as const;
