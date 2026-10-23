/**
 * Confidence wording shared by every report summary prompt (client structure
 * v2.1, 19 Oct 2026: "New AI-written text uses the same confidence wording
 * (meets the standard / Low) and the confidence-adaptive wording"). The
 * Core Needs Report uses the same two words, so a narrative and the report
 * it sits beside never describe confidence differently.
 *
 * A code field (confidenceLevel, confidence) still carries the canonical
 * code; only the prose changes.
 */
export const CONFIDENCE_WORDING_RULES = `Confidence wording — apply to every sentence you write:
- Describe confidence with exactly two phrases. A confidence code of STANDARD reads as "meets the standard"; LOW reads as "Low". In Arabic write "تستوفي المعيار" and "منخفضة".
- Never write any other confidence word: not "Very Low", "Medium", "Moderate", "Strong", "High confidence", "standard confidence" or "reliable".
- A JSON field whose value is a confidence code (confidenceLevel, confidence) keeps the code exactly as supplied (LOW or STANDARD). These phrases apply to the prose only.
- Where confidence is Low for a figure, area or domain:
  - Call its results "preliminary indicators", never "results", "findings" or "conclusions".
  - When its Priority Status is CRITICAL, write "Critical (provisional)" ("حرجة (مؤقتة)" in Arabic).
  - Make the first recommendation to complete data collection before allocating resources.
- Where confidence meets the standard, use normal wording and do not mention confidence unless the supplied data does.`;
