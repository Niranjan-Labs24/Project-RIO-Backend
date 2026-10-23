import { describe, expect, it } from "vitest";
import { computeUnitRollups, type QuestionMeta, type UnitAnswer } from "./compute-unit-rollups";
import { sampleResultOf, splitKpi, tierOf } from "./build-core-needs";
import { calculateSampleSize } from "../../studies/sample-size";
import { mergeCoreInputs } from "./ncnp-needs";
import { villageKey, villageLabels, type CoreInputs } from "./load-core-needs";

const q = (id: string, kpi: string, extra: Partial<QuestionMeta> = {}): QuestionMeta => ({
  questionId: id,
  domain: "Health",
  subDomain: "Access",
  indicator: "Facility",
  kpi,
  numeric: false,
  ...extra,
});
const a = (responseId: string, questionId: string, severity: number | null, status = "SCORED", exclusionReason: string | null = null): UnitAnswer => ({
  responseId,
  questionId,
  status,
  exclusionReason,
  severity,
  numericValue: null,
});
const settings = { minRespondents: 10, dontKnowRatio: 0.2, requiredSampleSize: null };

describe("computeUnitRollups", () => {
  it("counts a response once even when it is stored under two villages", () => {
    const questions = new Map([["Q1", q("Q1", "K1")]]);
    // r1 duplicated across its need's two villages; r2 once.
    const r = computeUnitRollups([a("r1", "Q1", 100), a("r1", "Q1", 100), a("r2", "Q1", 0)], questions, settings);
    expect(r.question.get("Q1")!.validResponseCount).toBe(2);
    expect(r.question.get("Q1")!.severityScore).toBe(50);
  });

  it("rolls up as the scoring engine does: each level the mean of its scored children", () => {
    const questions = new Map([
      ["Q1", q("Q1", "K1")],
      ["Q2", q("Q2", "K2")],
    ]);
    const r = computeUnitRollups([a("r1", "Q1", 80), a("r1", "Q2", 40)], questions, settings);
    expect(r.kpi.get("K1")!.severityScore).toBe(80);
    expect(r.indicator.get("Facility")!.severityScore).toBe(60);
    expect(r.domain.get("Health")!.severityScore).toBe(60);
    expect(r.overall!.severityScore).toBe(60);
  });

  it("keeps don't-know out of the average but in the don't-know rate", () => {
    const questions = new Map([["Q1", q("Q1", "K1")]]);
    const r = computeUnitRollups([a("r1", "Q1", 100), a("r2", "Q1", null, "EXCLUDED", "DONT_KNOW")], questions, settings);
    expect(r.question.get("Q1")!.severityScore).toBe(100);
    expect(r.question.get("Q1")!.dontKnowRate).toBe(0.5);
  });
});


describe("v5.0 rules (client, 15 Oct 2026)", () => {
  it("sample adequacy is LOW below the minimum or below the required sample", () => {
    expect(sampleResultOf(81, 81, 10)).toBe("MEETS");
    expect(sampleResultOf(40, 81, 10)).toBe("LOW");
    expect(sampleResultOf(9, null, 10)).toBe("LOW");
    expect(sampleResultOf(500, null, 10)).toBe("MEETS");
  });

  it("one tier rule at every level: Critical at the threshold for a KPI, domain or area", () => {
    const tiers = { critical: 80, high: 70, medium: 40 };
    expect(tierOf(85, tiers)).toBe("CRITICAL");
    expect(tierOf(80, tiers)).toBe("CRITICAL");
    expect(tierOf(79.9, tiers)).toBe("HIGH");
    expect(tierOf(55, tiers)).toBe("MEDIUM");
    expect(tierOf(39, tiers)).toBe("LOW");
    // v5.0 equity rule: High from 50 when results differ between groups.
    expect(tierOf(55, { ...tiers, equityHigh: 50 }, true, true)).toBe("HIGH");
    expect(tierOf(55, { ...tiers, equityHigh: 50 }, true, false)).toBe("MEDIUM");
  });
});

describe("splitKpi", () => {
  it("separates the methodology code from the KPI name", () => {
    expect(splitKpi("HLT-03 — % of households reporting transport as a barrier")).toEqual([
      "HLT-03",
      "% of households reporting transport as a barrier",
    ]);
    expect(splitKpi("Travel time to the nearest facility")).toEqual(["", "Travel time to the nearest facility"]);
  });
});

describe("mergeCoreInputs (NCNP report)", () => {
  const inputs = (id: string, mv: string, required: number): CoreInputs =>
    ({
      study: { id, title: id, orgId: id, organizationName: `Org ${id}`, population: 100, requiredSampleSize: required, marginOfError: 0.1, minimumDetectableEffect: 10, methodologyVersionId: mv, methodologyVersionLabel: "v" },
      survey: { id: `${id}-s`, needId: `${id}-n`, targetGroup: null, selectionApproach: null },
      surveyIds: [`${id}-s`],
      unit: { level: "KINGDOM", id: null, name: null, parents: [], regionId: null },
      villages: [],
      governorates: [],
      mapContext: [],
      governoratesInUnitTotal: null,
      answers: [{ ...a(`${id}-r`, "Q1", 50), surveyId: `${id}-s`, village: null, governorateId: null, centerId: null, regionId: null }],
      gapTypeBySurvey: new Map(),
      questions: new Map(),
      responses: [],
      needSources: [],
      collectedFrom: null,
      collectedTo: null,
      profiles: new Map(),
      domainConfigs: [],
      allDomains: [],
      otherOrganisations: [],
      confidence: { minRespondents: 10, dontKnowRatio: 0.2 },
      tiers: { critical: 80, high: 70, equityHigh: 50, medium: 40 },
      concentratedFromPct: null,
      coverageMinPct: null,
      governorateMinCentresPct: null,
      linkPairs: [],
      targetGroupBySurvey: new Map(),
      centresByGovernorate: new Map(),
      equitySpreadThreshold: 50,
      outsideGeography: 0,
      kpiSignature: new Map(),
      methodologySplit: [],
      allRegions: [],
    }) as CoreInputs;

  it("pools answers and recalculates the required sample from the combined population", () => {
    const m = mergeCoreInputs([inputs("A", "mv1", 70), inputs("B", "mv1", 30)]);
    expect(m.answers).toHaveLength(2);
    expect(m.study.requiredSampleSize).toBe(calculateSampleSize(200, 0.1).requiredSampleSize);
    expect(m.study.organizationName).toBe("Org A · Org B");
  });

  it("across methodology versions, combines an unchanged KPI and keeps a changed one apart", () => {
    const withKpi = (i: CoreInputs, label: string, sig: string): CoreInputs => ({
      ...i,
      study: { ...i.study, methodologyVersionLabel: label },
      questions: new Map([["Q1", { questionId: "Q1", domain: "Health", subDomain: "S", indicator: "I", kpi: "K1 — Access", numeric: false }]]),
      kpiSignature: new Map([["K1 — Access", sig]]),
    });
    const same = mergeCoreInputs([withKpi(inputs("A", "mv1", 70), "v5.0", "x"), withKpi(inputs("B", "mv2", 30), "v5.1", "x")]);
    expect(same.methodologySplit).toEqual([]);
    expect(same.answers.every((a) => a.questionId === "Q1")).toBe(true);

    const changed = mergeCoreInputs([withKpi(inputs("A", "mv1", 70), "v5.0", "x"), withKpi(inputs("B", "mv2", 30), "v5.1", "y")]);
    expect(changed.methodologySplit).toEqual([{ kpi: "K1 — Access", versions: ["v5.0", "v5.1"] }]);
    expect(changed.questions.get("Q1@mv2")?.kpi).toBe("K1 — Access (v5.1)");
    expect(changed.answers.map((a) => a.questionId).sort()).toEqual(["Q1", "Q1@mv2"]);
  });
});

describe("village reports are internal only", () => {
  it("blocks catalogue and sharing for a village-level Core Needs Report only", async () => {
    const { isInternalOnlyReport, assertShareable } = await import("./internal-only");
    expect(isInternalOnlyReport({ reportType: "RPT18", filters: { scopeLevel: "VILLAGE" } })).toBe(true);
    expect(isInternalOnlyReport({ reportType: "RPT18", filters: { scopeLevel: "GOVERNORATE" } })).toBe(false);
    expect(isInternalOnlyReport({ reportType: "RPT01", filters: { scopeLevel: "VILLAGE" } })).toBe(false);
    expect(() => assertShareable({ reportType: "RPT18", filters: { scopeLevel: "VILLAGE" } })).toThrow();
  });
});

describe("village identity (client, 15 Oct 2026: names kept mappable)", () => {
  it("is the governorate plus the name, ignoring capitals and spacing", () => {
    expect(villageKey("g1", "AL-JAFR ")).toBe(villageKey("g1", "Al-Jafr"));
    expect(villageKey("g1", "Al-Jafr")).not.toBe(villageKey("g2", "Al-Jafr"));
    // A different spelling stays apart until village master data maps it.
    expect(villageKey("g1", "al  jafr")).not.toBe(villageKey("g1", "Al-Jafr"));
  });

  it("names the governorate only when two governorates share a village name", () => {
    const labels = villageLabels([
      { key: villageKey("g1", "Al-Jafr"), typedName: "Al-Jafr", governorateName: "Al-Ahsa" },
      { key: villageKey("g2", "Al-Jafr"), typedName: "Al-Jafr", governorateName: "Qatif" },
      { key: villageKey("g1", "Al-Qarain"), typedName: "Al-Qarain", governorateName: "Al-Ahsa" },
    ]);
    expect([...labels.values()]).toEqual(["Al-Jafr — Al-Ahsa", "Al-Jafr — Qatif", "Al-Qarain"]);
  });
});
