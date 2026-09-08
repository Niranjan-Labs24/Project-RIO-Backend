import { describe, expect, it } from "vitest";
import { classifyPresence, isDontKnow } from "./dont-know";
import { matchPlace, type PlaceReference } from "./match-place";
import { normalizeDate } from "./normalize-date";
import { normalizeDomain, normalizeSubDomain, type MethodologyVocabulary } from "./normalize-classification";
import { normalizeNumber } from "./normalize-number";
import { normalizePhone } from "./normalize-phone";

const DK = { dontKnowTreatment: "excluded_answer" } as const;

// ─────────────────────────────────────────────────────────────────────────────
// Q13 — "Don't know" is an answer, not a gap
// ─────────────────────────────────────────────────────────────────────────────

describe("isDontKnow (Q13)", () => {
  it.each([
    "Don't know",
    "DON'T KNOW",
    "dont know",
    "Prefer not to answer",
    "N/A",
    "لا أعرف",
    "لا اعرف",
    "أفضل عدم الإجابة",
  ])("recognises %s", (value) => {
    expect(isDontKnow(value)).toBe(true);
  });

  it("does not treat 0 as a refusal", () => {
    // Zero clinics and zero school days missed are findings, not absences.
    // The question bank lists "0" as an option alongside "Don't know".
    expect(isDontKnow("0")).toBe(false);
  });

  it("does not treat ordinary text as a refusal", () => {
    expect(isDontKnow("لا يوجد مركز صحي")).toBe(false);
    expect(isDontKnow("5")).toBe(false);
  });
});

describe("classifyPresence (Q13)", () => {
  it("excludes a DK answer under the confirmed treatment", () => {
    expect(classifyPresence("Don't know", "excluded_answer")).toBe("excluded");
  });

  it("counts a DK answer as absent if the client rules the other way", () => {
    // The setting exists because the client asked us to confirm before
    // extending LIV-21 platform-wide.
    expect(classifyPresence("Don't know", "missing_value")).toBe("absent");
  });

  it("treats blank and whitespace as absent under either treatment", () => {
    expect(classifyPresence("   ", "excluded_answer")).toBe("absent");
    expect(classifyPresence(null, "excluded_answer")).toBe("absent");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dates
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeDate", () => {
  const opts = { field: "collectedAt", required: true, ...DK };

  it("leaves an ISO date alone", () => {
    const result = normalizeDate("2026-03-05", opts);
    expect(result).toEqual({ value: "2026-03-05", changed: false, flag: null });
  });

  it("reads an unambiguous three-part date day-first", () => {
    const result = normalizeDate("25/12/2026", opts);
    expect(result.value).toBe("2026-12-25");
    expect(result.flag?.ruleCode).toBe("DATE_FORMAT");
    expect(result.flag?.confidence).toBeNull();
  });

  it("flags a genuinely ambiguous date instead of silently choosing", () => {
    const result = normalizeDate("03/04/2026", opts);
    expect(result.flag?.ruleCode).toBe("DATE_AMBIGUOUS");
    expect(result.flag?.confidence).toBe(0.5);
    expect(result.flag?.detail).toMatchObject({
      dayFirst: "2026-04-03",
      monthFirst: "2026-03-04",
    });
  });

  it("does not call a same-day/month date ambiguous", () => {
    // 05/05 reads identically either way, so there is nothing to confirm.
    expect(normalizeDate("05/05/2026", opts).flag?.ruleCode).toBe("DATE_FORMAT");
  });

  it("accepts year-first with any separator", () => {
    expect(normalizeDate("2026/03/05", opts).value).toBe("2026-03-05");
    expect(normalizeDate("05.03.2026", opts).value).toBe("2026-03-05");
  });

  it("converts Arabic-Indic digits", () => {
    const result = normalizeDate("٢٠٢٦-٠٣-٠٥", opts);
    expect(result.value).toBe("2026-03-05");
    expect(result.flag?.ruleCode).toBe("DATE_FORMAT");
  });

  it("drops a time component from an ISO datetime", () => {
    expect(normalizeDate("2026-03-05T14:30:00Z", opts).value).toBe("2026-03-05");
  });

  it("rejects a date that is not on the calendar", () => {
    expect(normalizeDate("2026-02-30", opts).flag?.ruleCode).toBe("DATE_UNPARSEABLE");
    expect(normalizeDate("31/02/2026", opts).flag?.ruleCode).toBe("DATE_UNPARSEABLE");
  });

  it("accepts a real leap day", () => {
    expect(normalizeDate("29/02/2024", opts).value).toBe("2024-02-29");
  });

  it("refuses a two-digit year rather than assuming a century", () => {
    const result = normalizeDate("05/03/26", opts);
    expect(result.flag?.ruleCode).toBe("DATE_UNPARSEABLE");
    expect(result.flag?.detail).toMatchObject({ reason: "two_digit_year" });
    expect(result.flag?.proposedValue).toBeNull();
  });

  it("flags a required date that is absent", () => {
    const result = normalizeDate("", opts);
    expect(result.flag?.ruleCode).toBe("MISSING_REQUIRED");
    expect(result.flag?.severity).toBe("missing");
    expect(result.flag?.proposedValue).toBeNull();
  });

  it("says nothing about an optional date that is absent", () => {
    expect(normalizeDate("", { ...opts, required: false }).flag).toBeNull();
  });

  it("never flags a DK answer as missing (Q13)", () => {
    expect(normalizeDate("Don't know", opts).flag).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mobile numbers
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizePhone", () => {
  const opts = { field: "mobile", required: true, defaultRegion: "SA", ...DK };

  it.each([
    ["0501234567", "national trunk form"],
    ["501234567", "subscriber only"],
    ["966501234567", "country code without plus"],
    ["00966501234567", "international access prefix"],
    ["+966 50 123 4567", "spaced"],
    ["+966-50-123-4567", "dashed"],
    ["(966) 50 123 4567", "parenthesised"],
    ["٠٥٠١٢٣٤٥٦٧", "Arabic-Indic digits"],
  ])("normalizes %s (%s) to E.164", (input) => {
    expect(normalizePhone(input, opts).value).toBe("+966501234567");
  });

  it("leaves an already-standard number alone", () => {
    const result = normalizePhone("+966501234567", opts);
    expect(result).toEqual({ value: "+966501234567", changed: false, flag: null });
  });

  it("rejects a Saudi number that is not a mobile", () => {
    // Landlines start 01x, not 5. The unique constraint on SurveyResponse is
    // about identifying a person by their phone, and a landline does not.
    expect(normalizePhone("0112345678", opts).flag?.ruleCode).toBe("PHONE_UNPARSEABLE");
  });

  it("rejects a number with the wrong digit count", () => {
    expect(normalizePhone("05012345", opts).flag?.ruleCode).toBe("PHONE_UNPARSEABLE");
    expect(normalizePhone("050123456789", opts).flag?.ruleCode).toBe("PHONE_UNPARSEABLE");
  });

  it("passes a foreign international number through with formatting stripped", () => {
    const result = normalizePhone("+44 20 7946 0958", opts);
    expect(result.value).toBe("+442079460958");
    expect(result.flag?.ruleCode).toBe("PHONE_FORMAT");
  });

  it("rejects text with no digits", () => {
    const result = normalizePhone("no phone", opts);
    expect(result.flag?.ruleCode).toBe("PHONE_UNPARSEABLE");
    expect(result.flag?.proposedValue).toBeNull();
  });

  it("never flags a DK answer as missing (Q13)", () => {
    expect(normalizePhone("Prefer not to answer", opts).flag).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Numbers and units
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeNumber", () => {
  const opts = {
    field: "distanceKm",
    required: true,
    expectedUnit: "km" as const,
    floor: 0,
    ceiling: 500,
    ...DK,
  };

  it("leaves a bare number alone", () => {
    expect(normalizeNumber("5", opts)).toEqual({ value: 5, changed: false, flag: null });
  });

  it("strips the expected unit", () => {
    const result = normalizeNumber("5 km", opts);
    expect(result.value).toBe(5);
    expect(result.flag?.ruleCode).toBe("NUMBER_FORMAT");
    expect(result.flag?.proposedValue).toBe("5");
  });

  it("strips an Arabic unit", () => {
    expect(normalizeNumber("٥ كم", opts).value).toBe(5);
  });

  it("converts a unit the question did not ask for", () => {
    const result = normalizeNumber("1500 m", opts);
    expect(result.value).toBe(1.5);
    expect(result.flag?.ruleCode).toBe("UNIT_MISMATCH");
    expect(result.flag?.detail).toMatchObject({ writtenUnit: "m", expectedUnit: "km" });
  });

  it("refuses a conversion that does not exist", () => {
    const result = normalizeNumber("200 SAR", opts);
    expect(result.flag?.ruleCode).toBe("UNIT_MISMATCH");
    expect(result.flag?.proposedValue).toBeNull();
    expect(result.value).toBeNull();
  });

  it("handles thousands separators and decimal commas", () => {
    expect(normalizeNumber("1,200", { ...opts, ceiling: 5000 }).value).toBe(1200);
    expect(normalizeNumber("12,5", opts).value).toBe(12.5);
    expect(normalizeNumber("1٬200", { ...opts, ceiling: 5000 }).value).toBe(1200);
    expect(normalizeNumber("12٫5", opts).value).toBe(12.5);
  });

  it("strips an approximation marker", () => {
    expect(normalizeNumber("~5", opts).value).toBe(5);
    expect(normalizeNumber("about 5 km", opts).value).toBe(5);
    expect(normalizeNumber("حوالي 5", opts).value).toBe(5);
  });

  it("refuses a range rather than averaging it", () => {
    const result = normalizeNumber("5-7", opts);
    expect(result.flag?.ruleCode).toBe("NUMBER_UNPARSEABLE");
    expect(result.flag?.proposedValue).toBeNull();
  });

  it("flags an out-of-range value without clamping it", () => {
    const result = normalizeNumber("900", opts);
    expect(result.flag?.ruleCode).toBe("NUMBER_OUT_OF_RANGE");
    expect(result.flag?.proposedValue).toBeNull();
    expect(result.flag?.detail).toMatchObject({ parsedValue: 900, ceiling: 500 });
  });

  it("accepts zero as a real measurement", () => {
    expect(normalizeNumber("0", opts)).toEqual({ value: 0, changed: false, flag: null });
  });

  it("parses a negative rather than calling it unreadable", () => {
    // The caller decides what a negative means for its question — "negative
    // value" is a far more actionable finding than "not a number".
    const result = normalizeNumber("-3", { ...opts, floor: null, ceiling: null });
    expect(result.value).toBe(-3);
  });

  it("rejects text that is not a number", () => {
    expect(normalizeNumber("far away", opts).flag?.ruleCode).toBe("NUMBER_UNPARSEABLE");
  });

  it("never flags a DK answer as missing (Q13)", () => {
    expect(normalizeNumber("لا أعرف", opts).flag).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Domain / sub-domain vocabulary
// ─────────────────────────────────────────────────────────────────────────────

const VOCABULARY: MethodologyVocabulary[] = [
  { domain: "Health", subDomains: ["Access to Basic Healthcare", "Maternal Health"] },
  { domain: "Education", subDomains: ["School Access", "Learning Quality"] },
  { domain: "Water & Sanitation", subDomains: ["Drinking Water Access", "Sanitation"] },
];

describe("normalizeDomain", () => {
  const opts = {
    field: "domain",
    required: true,
    vocabulary: VOCABULARY,
    nearMatchThreshold: 0.5,
    ...DK,
  };

  it("leaves an approved value alone", () => {
    expect(normalizeDomain("Health", opts)).toEqual({ value: "Health", changed: false, flag: null });
  });

  it("proposes the canonical spelling of a folded match", () => {
    const result = normalizeDomain("  health  ", opts);
    expect(result.value).toBe("Health");
    expect(result.flag?.severity).toBe("non_standard");
    expect(result.flag?.confidence).toBeNull();
  });

  it("folds an ampersand-and-spacing variant", () => {
    expect(normalizeDomain("water & sanitation", opts).value).toBe("Water & Sanitation");
  });

  it("proposes a near match with a confidence and a shortlist", () => {
    const result = normalizeDomain("Healthcare", opts);
    expect(result.value).toBe("Health");
    expect(result.flag?.severity).toBe("out_of_vocabulary");
    expect(result.flag?.confidence).toBeGreaterThan(0);
    expect(result.flag?.detail?.candidates).toBeDefined();
  });

  it("proposes nothing when the value resembles nothing approved", () => {
    const result = normalizeDomain("Transport", opts);
    expect(result.value).toBeNull();
    expect(result.flag?.ruleCode).toBe("DOMAIN_NOT_IN_METHODOLOGY");
    expect(result.flag?.proposedValue).toBeNull();
  });
});

describe("normalizeSubDomain", () => {
  const opts = {
    field: "subDomain",
    required: true,
    vocabulary: VOCABULARY,
    nearMatchThreshold: 0.5,
    resolvedDomain: "Health",
    ...DK,
  };

  it("accepts a sub-domain of the resolved domain", () => {
    expect(normalizeSubDomain("Maternal Health", opts).flag).toBeNull();
  });

  it("catches an approved sub-domain filed under the wrong domain", () => {
    // Scores and reads cleanly at every other step, and nothing downstream
    // would catch it — so it gets its own rule code.
    const result = normalizeSubDomain("School Access", opts);
    expect(result.flag?.ruleCode).toBe("SUBDOMAIN_WRONG_DOMAIN");
    expect(result.flag?.detail).toMatchObject({ filedUnder: "Health", belongsTo: "Education" });
    expect(result.flag?.proposedValue).toBeNull();
  });

  it("searches the whole vocabulary when the domain is unresolved", () => {
    const result = normalizeSubDomain("School Access", { ...opts, resolvedDomain: null });
    expect(result.flag).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Village / place matching
// ─────────────────────────────────────────────────────────────────────────────

const CENTERS: PlaceReference[] = [
  { code: "0101-001", name: "المخواة", governorate: "الباحة" },
  { code: "0102-004", name: "المذنب", governorate: "القصيم" },
  { code: "0103-007", name: "الخالدية", governorate: "الرياض" },
  { code: "0104-009", name: "الخالدية", governorate: "مكة المكرمة" },
];

describe("matchPlace", () => {
  const opts = {
    field: "village",
    required: true,
    reference: CENTERS,
    acceptThreshold: 0.92,
    proposeThreshold: 0.75,
    maxCandidates: 5,
    ...DK,
  };

  it("says nothing when the stored name is already the reference spelling", () => {
    // Otherwise the queue fills with rows whose proposal equals their current
    // value — accepting changes nothing and the reviewer stops trusting it.
    const result = matchPlace("المخواة", opts);
    expect(result).toEqual({ value: "0101-001", changed: false, flag: null });
  });

  it("resolves a spelling variant to the center code", () => {
    const result = matchPlace("المخواه", opts);
    expect(result.value).toBe("0101-001");
    expect(result.flag?.ruleCode).toBe("VILLAGE_NEAR_MATCH");
    expect(result.flag?.confidence).toBe(1);
    expect(result.flag?.proposedValue).toBe("0101-001");
  });

  it("refuses to choose between two centers with the same name", () => {
    // A routine case in the Saudi reference, not an edge one.
    const result = matchPlace("الخالدية", opts);
    expect(result.flag?.ruleCode).toBe("VILLAGE_AMBIGUOUS");
    expect(result.value).toBeNull();
    expect(result.flag?.proposedValue).toBeNull();
  });

  it("flags an unmatched village rather than dropping it", () => {
    // Q4's principle: no need disappears from the totals because its village
    // did not match.
    const result = matchPlace("قرية غير موجودة", opts);
    expect(result.flag?.ruleCode).toBe("VILLAGE_UNMATCHED");
    expect(result.flag?.severity).toBe("out_of_vocabulary");
    expect(result.value).toBeNull();
  });

  it("never proposes a match below the accept threshold", () => {
    const result = matchPlace("المخ", opts);
    expect(result.flag?.proposedValue).toBeNull();
  });

  it("flags a required village that is absent", () => {
    expect(matchPlace("", opts).flag?.ruleCode).toBe("MISSING_REQUIRED");
  });
});
