// The client's confidence bands in the AI summaries (Oct 2026): the narrative
// should say "very low / medium / strong", as the rest of the report does, not
// the methodology's LOW / STANDARD. The AI is handed the band itself — decided
// here by the same rule as the report (presentation.config.ts) — rather than
// asked to work it out, so its wording cannot disagree with the report.
// Applies to newly generated summaries; stored ones are left as they are.

import { confidenceBandOf } from './build-presentation';

const BAND_WORDS = { VERY_LOW: 'Very low', MEDIUM: 'Medium', STRONG: 'Strong' } as const;
const METHODOLOGY_LEVEL = /^(LOW|STANDARD|HIGH)$/i;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const CONFIDENCE_BAND_INSTRUCTION =
  'Confidence wording: every confidence value in the data is already one of three bands — "Very low", ' +
  '"Medium" or "Strong" — with its reason. Describe confidence only with these words (lower-case in a ' +
  'sentence) and the supplied reason. Never write LOW, STANDARD or "standard confidence".';

/** A copy of the AI's input with every methodology confidence level replaced
 *  by its band and reason. `overallValid` is used where an item has no count. */
export function withConfidenceBands<T>(data: T, requiredSampleSize: number | null, overallValid: number): T {
  const reasonFor = (band: keyof typeof BAND_WORDS, valid: number): string =>
    band === 'VERY_LOW'
      ? `Very low: ${valid} valid response(s), fewer than 10.${requiredSampleSize != null ? ` ${requiredSampleSize} are required for strong confidence.` : ''}`
      : band === 'MEDIUM'
        ? `Medium: ${valid} valid responses${requiredSampleSize != null ? `, below the ${requiredSampleSize} required for strong confidence` : ''}.`
        : `Strong: ${valid} valid responses, meeting the ${requiredSampleSize} required.`;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isObj(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x);
    const valid =
      typeof v.validResponseCount === 'number'
        ? v.validResponseCount
        : typeof v.validResponses === 'number'
          ? v.validResponses
          : overallValid;
    const band = confidenceBandOf(valid, requiredSampleSize);
    for (const key of ['confidenceLevel', 'confidence', 'overallConfidence']) {
      if (typeof v[key] === 'string' && METHODOLOGY_LEVEL.test(v[key])) out[key] = BAND_WORDS[band];
    }
    if (typeof v.confidenceReason === 'string' && Object.keys(out).some((k) => out[k] !== v[k])) {
      out.confidenceReason = reasonFor(band, valid);
    }
    return out;
  };
  return walk(data) as T;
}
