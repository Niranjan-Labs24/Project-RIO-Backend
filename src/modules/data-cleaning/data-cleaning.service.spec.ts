import { describe, expect, it, vi } from "vitest";
import { DataCleaningService } from "./data-cleaning.service";
import type { CleaningContext } from "./cleaning-context.service";
import { evaluateNeed, type NeedCleaningInput } from "./rules/need.rules";
import { evaluateSurveyResponse, maskPii } from "./rules/survey-response.rules";
import { evaluateImportRows } from "./rules/import-row.rules";
import {
  deriveExpectedUnit,
  evaluateNumericAnswers,
  type RawNumericAnswer,
} from "./rules/response-answer.rules";

const CONTEXT: CleaningContext = {
  settings: {
    ruleSetVersion: "fr002-v1",
    dontKnowTreatment: "excluded_answer",
    requiredNeedFields: ["title", "statement", "domain", "geography", "source"],
    softNeedFields: [],
    requiredSurveyResponseFields: ["contact"],
    piiFields: ["contact", "mobile", "contactName"],
    phoneDefaultRegion: "SA",
    villageMatchAcceptThreshold: 0.92,
    villageMatchProposeThreshold: 0.75,
    villageMatchMaxCandidates: 5,
    classificationNearMatchThreshold: 0.5,
    literalDuplicateThreshold: 0.85,
    duplicateScopes: { withinStudy: true, withinOrg: true, crossOrg: false },
  },
  vocabulary: [
    { domain: "Health", subDomains: ["Access to Basic Healthcare"] },
    { domain: "Education", subDomains: ["School Access"] },
  ],
  places: [
    { code: "0101-001", name: "المخواة", governorate: "الباحة" },
    { code: "0102-004", name: "المذنب", governorate: "القصيم" },
  ],
  numericQuestions: new Map([
    [
      "v5:HLT-02",
      {
        questionCode: "HLT-02",
        questionText: "how many minutes does a one-way trip normally take?",
        expectedUnit: "minutes" as const,
        scoringFloor: 0,
        scoringCeiling: 120,
      },
    ],
  ]),
};

function need(overrides: Partial<NeedCleaningInput> = {}): NeedCleaningInput {
  return {
    id: "need-1",
    title: "Clinic access",
    statement: "No clinic within 20km.",
    village: [],
    domain: "Health",
    subDomain: "Access to Basic Healthcare",
    source: "manual_entry",
    affectedPopulation: null,
    urgency: null,
    gapType: null,
    centerIds: ["c1"],
    governorateIds: [],
    ...overrides,
  };
}

describe("evaluateNeed", () => {
  it("says nothing about a clean need", () => {
    expect(evaluateNeed(need(), CONTEXT)).toEqual([]);
  });

  it("does not report missing geography when the need has linked centers", () => {
    // NeedsService.create defaults governorates/centers from the Study, so
    // most needs carry structured geography with an empty village array.
    // Flagging those would make ~90% of the queue false alarm.
    const flags = evaluateNeed(need({ village: [], centerIds: ["c1"] }), CONTEXT);
    expect(flags.find((f) => f.field === "geography")).toBeUndefined();
  });

  it("reports missing geography when there is none of any kind", () => {
    const flags = evaluateNeed(
      need({ village: [], centerIds: [], governorateIds: [] }),
      CONTEXT,
    );
    expect(flags.find((f) => f.field === "geography")?.ruleCode).toBe("MISSING_REQUIRED");
  });

  it("reports a missing domain exactly once", () => {
    const flags = evaluateNeed(need({ domain: null, subDomain: null }), CONTEXT);
    const domainFlags = flags.filter((f) => f.field === "domain");
    expect(domainFlags).toHaveLength(1);
    expect(domainFlags[0]?.ruleCode).toBe("MISSING_REQUIRED");
  });

  it("raises one flag per village value, indexed", () => {
    const flags = evaluateNeed(need({ village: ["المخواه", "nowhere-at-all"] }), CONTEXT);
    expect(flags.map((f) => f.field)).toEqual(["village[0]", "village[1]"]);
    expect(flags[0]?.proposedValue).toBe("0101-001");
    expect(flags[1]?.ruleCode).toBe("VILLAGE_UNMATCHED");
  });

  it("stays silent on vocabulary when no reference data is loaded", () => {
    // An empty vocabulary says something about the deployment, not about the
    // need — flagging every domain as unapproved would be noise.
    const bare = { ...CONTEXT, vocabulary: [], places: [] };
    expect(evaluateNeed(need(), bare)).toEqual([]);
  });

  it("still reports a missing domain with no vocabulary loaded", () => {
    const bare = { ...CONTEXT, vocabulary: [], places: [] };
    const flags = evaluateNeed(need({ domain: null }), bare);
    expect(flags.map((f) => f.field)).toContain("domain");
  });

  it("never proposes a value for a missing field", () => {
    // The cleaning_flags_missing_has_no_proposal CHECK enforces this at the
    // database; a rule that produced one would fail the insert.
    const flags = evaluateNeed(
      need({ title: "", statement: "", domain: null, centerIds: [], governorateIds: [] }),
      CONTEXT,
    );
    for (const flag of flags.filter((f) => f.severity === "missing")) {
      expect(flag.proposedValue).toBeNull();
    }
  });
});

describe("evaluateSurveyResponse (RIO-NFR-002)", () => {
  it("masks the mobile number and proposes nothing for it", () => {
    const flags = evaluateSurveyResponse(
      { id: "r1", contact: "a@b.com", mobile: "0501234567", village: [] },
      CONTEXT,
    );
    const mobileFlag = flags.find((f) => f.field === "mobile");
    expect(mobileFlag?.ruleCode).toBe("PHONE_FORMAT");
    // The whole point: neither the original nor the normalized number is
    // copied into the reviewer-facing table.
    expect(mobileFlag?.originalValue).not.toBe("0501234567");
    expect(mobileFlag?.originalValue).toContain("•");
    expect(mobileFlag?.proposedValue).toBeNull();
    expect(mobileFlag?.detail).toMatchObject({ redacted: true });
  });

  it("stores the value in full when the field is not marked PII", () => {
    const permissive = {
      ...CONTEXT,
      settings: { ...CONTEXT.settings, piiFields: [] },
    };
    const flags = evaluateSurveyResponse(
      { id: "r1", contact: "a@b.com", mobile: "0501234567", village: [] },
      permissive,
    );
    expect(flags.find((f) => f.field === "mobile")?.proposedValue).toBe("+966501234567");
  });

  it("does not require a mobile — an email-verified response has none", () => {
    const flags = evaluateSurveyResponse(
      { id: "r1", contact: "a@b.com", mobile: null, village: [] },
      CONTEXT,
    );
    expect(flags).toEqual([]);
  });
});

describe("maskPii", () => {
  it("keeps an email recognisable without revealing the local part", () => {
    expect(maskPii("sarah@example.com")).toBe("sa•••@example.com");
  });

  it("keeps a phone number recognisable at both ends", () => {
    expect(maskPii("+966501234567")).toBe("+9665••••••67");
  });

  it("preserves length, which is the diagnostic the reviewer needs", () => {
    // A too-short number is the most common phone defect, and a reviewer
    // cannot see that from a fixed-width mask. Length is the one property
    // worth revealing; the digits are not.
    expect(maskPii("05012345")).toHaveLength("05012345".length);
    expect(maskPii("0501234567")).toHaveLength("0501234567".length);
  });

  it("reveals nothing at all for a very short value", () => {
    expect(maskPii("123")).toBe("•••");
  });
});

describe("evaluateImportRows", () => {
  it("records a rejected row as a flag rather than losing it with the response", () => {
    const flags = evaluateImportRows([
      { rowNumber: 3, field: "title", message: "Title is required.", kind: "validation", originalValue: null },
    ]);
    expect(flags[0]).toMatchObject({
      entityType: "import_row",
      entityId: null,
      rowNumber: 3,
      ruleCode: "IMPORT_ROW_REJECTED",
      severity: "missing",
      proposedValue: null,
    });
  });

  it("records a duplicate row with its own code and keeps the value", () => {
    const flags = evaluateImportRows([
      { rowNumber: 7, field: "referenceId", message: "Duplicate Reference ID", kind: "duplicate", originalValue: "REF-9" },
    ]);
    expect(flags[0]?.ruleCode).toBe("IMPORT_DUPLICATE_ROW");
    expect(flags[0]?.originalValue).toBe("REF-9");
  });
});

describe("DataCleaningService", () => {
  it("never throws at its caller when the database is unreachable", () => {
    // Every call site is fire-and-forget after the record is already saved and
    // audited. A cleaning failure must not surface as a failed save.
    const tenant = {
      runAsOrg: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    };
    const context = { load: vi.fn(async () => CONTEXT) };
    // The literal duplicate pass swallows its own failures, so the stub only
    // has to resolve — its behaviour has its own coverage.
    const duplicates = { detectForNeed: vi.fn(async () => 0) };
    const service = new DataCleaningService(
      tenant as never,
      context as never,
      duplicates as never,
    );

    return expect(service.cleanNeed("need-1", "org-1", "manual_entry")).resolves.toBeUndefined();
  });

  it("returns null rather than throwing when an import batch fails", () => {
    const tenant = {
      runAsOrg: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    };
    const context = { load: vi.fn(async () => CONTEXT) };
    // The literal duplicate pass swallows its own failures, so the stub only
    // has to resolve — its behaviour has its own coverage.
    const duplicates = { detectForNeed: vi.fn(async () => 0) };
    const service = new DataCleaningService(
      tenant as never,
      context as never,
      duplicates as never,
    );

    return expect(
      service.cleanImportBatch({
        orgId: "org-1",
        studyId: "study-1",
        createdNeedIds: [],
        rejectedRows: [],
      }),
    ).resolves.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Numeric answers (Q12) — the rule that catches answers scoring silently drops
// ─────────────────────────────────────────────────────────────────────────────

const MINUTES_SPEC = {
  questionCode: "HLT-02",
  questionText:
    "Using your household's usual means of transport, how many minutes does a one-way trip take?",
  expectedUnit: "minutes" as const,
  scoringFloor: 0,
  scoringCeiling: 120,
};

function answer(raw: unknown, spec: RawNumericAnswer["spec"] = MINUTES_SPEC): RawNumericAnswer {
  return { surveyQuestionId: "sq-1", spec, raw };
}

describe("deriveExpectedUnit", () => {
  it.each([
    ["how many minutes does a one-way trip take?", "minutes"],
    ["how many calendar days elapsed from the first request?", "days"],
    ["on how many days was the water source unavailable?", "days"],
    ["In how many of the past 12 months did the household receive income?", "months"],
    ["Approximately how many Saudi riyals does an adult usually pay?", "sar"],
    ["Approximately how much did the household spend in the past 30 days?", "sar"],
    ["What is the approximate distance (in km) from the village center?", "km"],
  ])("reads %s as %s", (text, expected) => {
    expect(deriveExpectedUnit(text)).toBe(expected);
  });

  it("assigns no unit when the question names none", () => {
    // EDU-02 asks for a distance and never says km or metres. Guessing from
    // the scoring ceiling would be inventing methodology — the question bank
    // has to say, and this is a live question for the client.
    expect(
      deriveExpectedUnit("What is the approximate distance from this household to the school?"),
    ).toBeNull();
    expect(deriveExpectedUnit("How many separate bedrooms does the household use?")).toBeNull();
  });
});

describe("evaluateNumericAnswers", () => {
  it("says nothing about a bare number", () => {
    expect(evaluateNumericAnswers("r1", [answer("45")], CONTEXT)).toEqual([]);
  });

  it.each(["5 km", "1,200", "٥", "~5", "12,5", "200 SAR"])(
    "flags %s — the value scoring would silently drop",
    (raw) => {
      // DeterministicScoringService does Number(raw) for a NUMERIC question,
      // so each of these becomes NaN and then null, and is never scored.
      expect(Number.isNaN(Number(raw))).toBe(true);
      const flags = evaluateNumericAnswers("r1", [answer(raw)], CONTEXT);
      expect(flags).toHaveLength(1);
      expect(flags[0]?.field).toBe("answers[HLT-02]");
    },
  );

  it("carries the scoring scale as context but never range-checks against it", () => {
    // HLT-04 caps at 4 antenatal visits because 4+ is the methodology's best
    // band, not because a fifth visit is invalid. Flagging it would be wrong.
    const visits = {
      questionCode: "HLT-04",
      questionText: "how many antenatal care visits did you receive?",
      expectedUnit: null,
      scoringFloor: 0,
      scoringCeiling: 4,
    };
    expect(evaluateNumericAnswers("r1", [answer("9", visits)], CONTEXT)).toEqual([]);
  });

  it("flags a negative value, which no question in the bank can take", () => {
    const flags = evaluateNumericAnswers("r1", [answer("-3")], CONTEXT);
    expect(flags[0]?.ruleCode).toBe("NUMBER_OUT_OF_RANGE");
    expect(flags[0]?.proposedValue).toBeNull();
  });

  it("converts a unit the question did not ask for", () => {
    const flags = evaluateNumericAnswers("r1", [answer("2 hours")], CONTEXT);
    expect(flags[0]?.ruleCode).toBe("UNIT_MISMATCH");
    expect(flags[0]?.proposedValue).toBe("120");
  });

  it("keeps the surveyQuestionId so an accepted fix can be written back", () => {
    const flags = evaluateNumericAnswers("r1", [answer("5 km")], CONTEXT);
    expect(flags[0]?.detail).toMatchObject({
      surveyQuestionId: "sq-1",
      questionCode: "HLT-02",
      droppedFromScoring: true,
    });
  });

  it("never flags a DK answer (Q13)", () => {
    expect(evaluateNumericAnswers("r1", [answer("Don't know")], CONTEXT)).toEqual([]);
  });

  it("skips an unanswered question", () => {
    expect(evaluateNumericAnswers("r1", [answer(""), answer(null)], CONTEXT)).toEqual([]);
  });
});
