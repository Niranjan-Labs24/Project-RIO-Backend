import type { ConfidenceFlag, NeedRecord, Thresholds } from "../need-record.types";
import { dontKnowBandOf, type DontKnowBand } from "./severity-bands";

export interface DataQualityNotesBlock {
  /** Literal true — Section 6 is mandatory and can never be absent, even when
   *  every sub-field below is empty. */
  present: true;
  responseQuality: {
    submitted: number;
    valid: number;
    excluded: number;
    validResponseRatePct: number;
    dontKnowRatePct: number;
    dontKnowBand: DontKnowBand;
    duplicatesFlagged: number;
    lowConfidenceFlagged: number;
  };
  confidence: {
    flag: ConfidenceFlag;
    reason: string;
    sampleSize: number;
    sampleThreshold: number;
  };
  exclusionBreakdown: Array<{ status: string; count: number; sharePct: number }>;
  totalAnswers: number;
  notMeasuredCount: number;
  notMeasured: Array<{ indicatorName: string; domain: string; reason: string }>;
  domainsNotAssessed: string[];
  dontKnowRateByDomain: Array<{ domain: string; rate: number }>;
  /** Deterministic. Composed from the fields above — never LLM-authored, so it
   *  cannot contradict them the way "3.13% … a high rate" did. */
  narrative: string;
  trendNote: string;
}

export function composeDataQualityNotes(input: {
  submitted: number;
  valid: number;
  excluded: number;
  dontKnowRate: number;
  dontKnowRateByDomain: Array<{ domain: string; rate: number }>;
  exclusionBreakdown: Array<{ status: string; count: number }>;
  totalAnswers: number;
  duplicatesFlagged: number;
  lowConfidenceFlagged: number;
  needRecords: NeedRecord[];
  domainsNotAssessed: string[];
  domainsInMethodology: number;
  confidenceFlag: ConfidenceFlag;
  confidenceReason: string;
  thresholds: Thresholds;
  trendNote: string;
}): DataQualityNotesBlock {
  const {
    submitted,
    valid,
    excluded,
    dontKnowRate,
    dontKnowRateByDomain,
    exclusionBreakdown,
    totalAnswers,
    duplicatesFlagged,
    lowConfidenceFlagged,
    needRecords,
    domainsNotAssessed,
    domainsInMethodology,
    confidenceFlag,
    confidenceReason,
    thresholds,
    trendNote,
  } = input;

  const notMeasured = needRecords.filter((n) => n.severityScore === null);
  // No submissions → 100 (nothing was dropped), the same convention the
  // valid-response ratio uses everywhere else.
  const validPct = submitted > 0 ? Math.round((valid / submitted) * 100) : 100;
  const band = dontKnowBandOf(dontKnowRate);
  const equityBlocked = needRecords.find((n) => n.equityDetail.evaluable === false);

  const sentences = [
    `This assessment rests on ${submitted} submitted response(s), of which ${valid} were valid (${validPct}% valid-response rate)${excluded > 0 ? ` and ${excluded} were excluded` : ""}.`,
    `Overall confidence is ${confidenceFlag}. ${confidenceReason}`,
    `The don't-know rate was ${(dontKnowRate * 100).toFixed(2)}% across the survey, which is ${band}.`,
  ];
  if (dontKnowRateByDomain.length) {
    sentences.push(
      `By domain: ${dontKnowRateByDomain.map((d) => `${d.domain} ${(d.rate * 100).toFixed(2)}%`).join(", ")}.`,
    );
  }
  if (notMeasured.length) {
    sentences.push(
      `${notMeasured.length} of ${needRecords.length} indicator(s) returned no measurable responses and are excluded from all averages.`,
    );
  }
  if (equityBlocked && equityBlocked.equityDetail.evaluable === false) {
    sentences.push(`Equity variance could not be evaluated: ${equityBlocked.equityDetail.reason}`);
  }
  if (domainsNotAssessed.length) {
    sentences.push(
      `${domainsNotAssessed.length} of ${domainsInMethodology} methodology domains were not assessed: ${domainsNotAssessed.join(", ")}.`,
    );
  }
  if (duplicatesFlagged > 0 || lowConfidenceFlagged > 0) {
    sentences.push(
      `Response screening flagged ${duplicatesFlagged} potential duplicate(s) and ${lowConfidenceFlagged} low-confidence response(s).`,
    );
  }

  return {
    present: true,
    responseQuality: {
      submitted,
      valid,
      excluded,
      validResponseRatePct: validPct,
      dontKnowRatePct: Number((dontKnowRate * 100).toFixed(2)),
      dontKnowBand: band,
      duplicatesFlagged,
      lowConfidenceFlagged,
    },
    confidence: {
      flag: confidenceFlag,
      reason: confidenceReason,
      sampleSize: valid,
      sampleThreshold: thresholds.confidenceMinSample,
    },
    exclusionBreakdown: exclusionBreakdown.map((e) => ({
      ...e,
      sharePct: totalAnswers > 0 ? Number(((e.count / totalAnswers) * 100).toFixed(1)) : 0,
    })),
    totalAnswers,
    notMeasuredCount: notMeasured.length,
    notMeasured: notMeasured.map((n) => ({
      indicatorName: n.indicatorName,
      domain: n.domain,
      reason: n.notMeasuredReason ?? "",
    })),
    domainsNotAssessed,
    dontKnowRateByDomain,
    narrative: sentences.join(" "),
    trendNote,
  };
}
