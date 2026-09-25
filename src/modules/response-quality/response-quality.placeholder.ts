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

export interface ConfidenceFlagSettings {
  dontKnowRatioThreshold: number;
  minRespondentsForStandardConfidence: number;
}

// Data-quality indicators per response: completeness (share of non-empty
// answers), missing fields, and a confidence flag — "low" when the batch has
// fewer respondents than `minRespondentsForStandardConfidence` or the share of
// "Don't know" answers exceeds `dontKnowRatioThreshold` (scope.md §Confidence
// Flag). `settings` comes from the Methodology Configuration screen
// (MethodologyConfigService), never hardcoded here. Duplicates are exact
// matches on (contact, serialized answers) within the same batch.
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
