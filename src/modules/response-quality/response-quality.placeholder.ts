import type { SupportedLocale } from "../translation/translation.types";
export interface ResponseSubject {
  id: string;
  answers: Record<string, unknown>;
  contact: string;
}

export interface QualityAssessment {
  surveyResponseId: string;
  completenessScore: number;
  missingFields: string[];
  confidenceFlag: "standard" | "low";
  isDuplicate: boolean;
  duplicateOfId: string | null;
}

export interface SummaryResult {
  summaryText: string;
  responseCount: number;
}

export interface ConfidenceFlagSettings {
  dontKnowRatioThreshold: number;
  minRespondentsForStandardConfidence: number;
}

// TODO(RIO-Response-Quality): completeness/confidence are simple placeholder
// heuristics (missing-answer ratio, "Don't know" count) pending the
// buyer-provided methodology package's real Data Quality Indicators
// definition (scope.md §Confidence Flag: standard/low when respondents <10
// or "Don't know" >20%). `settings` comes from the Methodology Configuration
// screen (MethodologyConfigService), never hardcoded here. Duplicate
// detection here is exact-match on (contact, serialized answers) within the
// same batch — a real fuzzy/near-duplicate detector replaces just this
// function later.
export function assessResponseQuality(
  responses: ResponseSubject[],
  settings: ConfidenceFlagSettings,
): QualityAssessment[] {
  const seen = new Map<string, string>();
  const lowRespondentCount = responses.length < settings.minRespondentsForStandardConfidence;

  return responses.map((response) => {
    const answerValues = Object.values(response.answers);
    const missingFields = Object.entries(response.answers)
      .filter(([, value]) => value === undefined || value === null || value === "")
      .map(([key]) => key);
    const completenessScore =
      answerValues.length === 0
        ? 0
        : Math.round(((answerValues.length - missingFields.length) / answerValues.length) * 100);
    const dontKnowCount = answerValues.filter(
      (value) => typeof value === "string" && value.trim().toLowerCase() === "don't know",
    ).length;
    const dontKnowRatio = answerValues.length === 0 ? 0 : dontKnowCount / answerValues.length;
    const confidenceFlag: "standard" | "low" =
      lowRespondentCount || dontKnowRatio > settings.dontKnowRatioThreshold ? "low" : "standard";

    const dedupeKey = `${response.contact}::${JSON.stringify(response.answers)}`;
    const duplicateOfId = seen.get(dedupeKey) ?? null;
    if (!duplicateOfId) seen.set(dedupeKey, response.id);

    return {
      surveyResponseId: response.id,
      completenessScore,
      missingFields,
      confidenceFlag,
      isDuplicate: duplicateOfId !== null,
      duplicateOfId,
    };
  });
}

// TODO(RIO-AI-Summary): canned template summary pending real LLM
// integration — see classification.placeholder.ts for the same pattern
// applied to AI Classification.
//
// Written in the requester's app language: this text is stored, so a
// template that only ever produced English left Arabic users an English
// "AI summary" that nothing downstream translated.
export function generateAiSummary(
  responses: ResponseSubject[],
  locale: SupportedLocale = "en",
): SummaryResult {
  const n = responses.length;
  if (n === 0) {
    return {
      summaryText:
        locale === "ar"
          ? "لم تُقدَّم أي ردود على المسح لهذه الدراسة حتى الآن."
          : "No survey responses have been submitted for this study yet.",
      responseCount: 0,
    };
  }
  return {
    summaryText:
      locale === "ar"
        ? `ملخص مبدئي: تم استلام ${n} رد. ستظهر هنا الموضوعات المشتركة ومؤشرات الأولوية بعد تفعيل التلخيص بالذكاء الاصطناعي.`
        : `Placeholder AI summary: ${n} response(s) received. ` +
          `Common themes and priority signals will be surfaced here once real AI summarization is integrated.`,
    responseCount: n,
  };
}
