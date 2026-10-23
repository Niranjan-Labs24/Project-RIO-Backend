import { describe, expect, it } from "vitest";
import { buildCoreNeedsContent } from "./build-core-needs";
import { buildCoreView, type CoreAudit } from "./core-needs-view";
import { renderCoreNeedsPdf } from "./core-needs-pdf";
import { renderCoreNeedsExcel } from "./core-needs-excel";
import { resolveCoreView } from "./resolve-core-view";
import { mergeCoreInputs } from "./ncnp-needs";
import { villageKey, type CoreInputs, type GeoAnswer, type VillageGeo } from "./load-core-needs";
import type { QuestionMeta } from "./compute-unit-rollups";
import type { CoreOutput, ScopeLevel } from "./core-needs.types";
import { NO_ALIASES } from "../i18n/master-data-names";

// One small study, end to end: inputs → content → view → PDF and Excel, in
// English and Arabic, at every area level. The arithmetic itself is pinned
// in core-needs.spec.ts; this checks that every level and output renders.

const REGION = { id: "r1", code: "SA-04", name: "Eastern Province" };
const OTHER_REGION = { id: "r2", code: "SA-01", name: "Riyadh" };
const GOVS = [
  { id: "g1", code: "AHS", name: "Al-Ahsa", regionId: "r1", regionName: REGION.name, regionCode: REGION.code },
  { id: "g2", code: "QTF", name: "Qatif", regionId: "r1", regionName: REGION.name, regionCode: REGION.code },
];

const village = (gov: (typeof GOVS)[number], name: string, centre: string | null): VillageGeo => ({
  name,
  typedName: name,
  key: villageKey(gov.id, name),
  governorateId: gov.id,
  governorateName: gov.name,
  governorateCode: gov.code,
  centerId: centre,
  centerName: centre ? `Centre ${centre}` : null,
  centerCode: centre ? `C-${centre}` : null,
  regionId: gov.regionId,
  regionName: gov.regionName,
  regionCode: gov.regionCode,
});
// "Al-Jafr" exists in both governorates: two villages, labelled with their governorate.
const VILLAGES = [
  { ...village(GOVS[0]!, "Al-Jafr", "c1"), name: "Al-Jafr — Al-Ahsa" },
  { ...village(GOVS[1]!, "Al-Jafr", null), name: "Al-Jafr — Qatif" },
  village(GOVS[0]!, "Al-Qarain", "c1"),
];

const QUESTIONS: QuestionMeta[] = [
  { questionId: "q1", domain: "Health", subDomain: "Access", indicator: "Distance", kpi: "HLT-01 — Households far from a clinic", numeric: false, accessDimension: true, hasNo: true },
  { questionId: "q2", domain: "Health", subDomain: "Quality", indicator: "Waiting", kpi: "HLT-02 — Households waiting over an hour", numeric: false, hasNo: true },
  { questionId: "q3", domain: "Education", subDomain: "Enrolment", indicator: "Attendance", kpi: "EDU-01 — Children out of school", numeric: false, unit: "CHILDREN" },
  { questionId: "q4", domain: "Water", subDomain: "Supply", indicator: "Hours", kpi: "WAT-01 — Hours of supply per day", numeric: true },
];
// Health severe, Education medium with a gender gap, Water low.
const SEVERITY: Record<string, (i: number, female: boolean) => number> = {
  q1: (i) => (i % 5 === 0 ? 60 : 100),
  q2: (i) => (i % 2 ? 80 : 60),
  q3: (_i, female) => (female ? 90 : 20),
  q4: (i) => (i % 3 ? 10 : 30),
};

function inputsFor(level: ScopeLevel, unitId: string | null, unitName: string | null): CoreInputs {
  const responses = Array.from({ length: 36 }, (_, i) => ({
    id: `resp-${i}`,
    villages: [VILLAGES[i % 3]!.typedName],
    gender: i % 2 ? "FEMALE" : "MALE",
    ageBracket: i % 3 ? "25-44" : "18-24",
    duplicate: i === 35,
    lowConfidence: i === 34,
    incomplete: false,
  }));
  const answers: GeoAnswer[] = responses.flatMap((r, i) => {
    const v = VILLAGES[i % 3]!;
    return QUESTIONS.map((q) => {
      // Every seventh respondent answered "Don't know" on the waiting question.
      const dontKnow = q.questionId === "q2" && i % 7 === 0;
      return {
        responseId: r.id,
        questionId: q.questionId,
        status: dontKnow ? "EXCLUDED" : "SCORED",
        exclusionReason: dontKnow ? "DONT_KNOW" : null,
        severity: dontKnow ? null : SEVERITY[q.questionId]!(i, r.gender === "FEMALE"),
        numericValue: q.numeric ? 6 + (i % 5) : null,
        surveyId: "survey-1",
        village: v.typedName,
        governorateId: v.governorateId,
        centerId: v.centerId,
        regionId: v.regionId,
        governorateName: v.governorateName,
        centerName: v.centerName,
        centerCode: v.centerCode,
      };
    });
  });
  const inUnit = (v: VillageGeo) =>
    level === "KINGDOM" ||
    (level === "REGION" && v.regionId === unitId) ||
    (level === "GOVERNORATE" && v.governorateId === unitId) ||
    (level === "CENTRE" && v.centerId === unitId) ||
    (level === "VILLAGE" && v.name === unitName);
  const villages = VILLAGES.filter(inUnit);
  const keys = new Set(villages.map((v) => v.typedName + v.governorateId));
  return {
    study: {
      id: "study-1",
      title: "Community Needs Assessment",
      orgId: "org-1",
      organizationName: "Sample Charity",
      population: 4000,
      requiredSampleSize: 30,
      marginOfError: 0.1,
      minimumDetectableEffect: 12,
      methodologyVersionId: "mv-5",
      methodologyVersionLabel: "v5.0",
    },
    survey: { id: "survey-1", needId: "need-1", targetGroup: "Households in the study villages", selectionApproach: "Random" },
    surveyIds: ["survey-1"],
    unit: { level, id: unitId, name: unitName, parents: level === "KINGDOM" ? [] : [REGION.name], regionId: level === "KINGDOM" ? null : REGION.id },
    villages,
    governorates: GOVS.filter((g) => villages.some((v) => v.governorateId === g.id)),
    mapContext: GOVS.map((g) => ({ code: g.code, name: g.name })),
    governoratesInUnitTotal: level === "REGION" ? 10 : null,
    allRegions: level === "KINGDOM" ? [REGION, OTHER_REGION] : [],
    answers: answers.filter((a) => keys.has(a.village! + a.governorateId)),
    gapTypeBySurvey: new Map([["survey-1", "structural"]]),
    questions: new Map(QUESTIONS.map((q) => [q.questionId, q])),
    kpiSignature: new Map(),
    methodologySplit: [],
    responses,
    needSources: ["field_survey", "citizen_input"],
    collectedFrom: new Date("2026-09-30T00:00:00Z"),
    collectedTo: new Date("2026-10-21T00:00:00Z"),
    profiles: new Map([
      [`GOVERNORATE:g1`, { population: 1_200_000, growthRatePct: 2.1, densityPerKm2: 9, malePct: 51, femalePct: 49, saudiPct: 80, ruralPct: 20, source: "GASTAT", year: 2022 }],
    ]),
    domainConfigs: [
      { domainKey: "HEALTH", domainNameSnapshot: "Health", weight: 0.4, isCriticalDomain: true, criticalPerformanceThreshold: 40 },
      { domainKey: "EDUCATION", domainNameSnapshot: "Education", weight: 0.35, isCriticalDomain: false, criticalPerformanceThreshold: 40 },
      { domainKey: "WATER", domainNameSnapshot: "Water", weight: 0.25, isCriticalDomain: false, criticalPerformanceThreshold: 40 },
    ],
    allDomains: [
      { key: "HEALTH", name: "Health" },
      { key: "EDUCATION", name: "Education" },
      { key: "WATER", name: "Water" },
    ],
    otherOrganisations: ["Another Charity"],
    confidence: { minRespondents: 10, dontKnowRatio: 0.2 },
    tiers: { critical: 80, high: 70, equityHigh: 50, medium: 40 },
    equitySpreadThreshold: 20,
    concentratedFromPct: 50,
    coverageMinPct: 60,
    governorateMinCentresPct: 50,
    linkPairs: [["HLT-01 — Households far from a clinic", "WAT-01 — Hours of supply per day"]],
    targetGroupBySurvey: new Map([["survey-1", "Households in the study villages"]]),
    centresByGovernorate: new Map([
      ["g1", 4],
      ["g2", 3],
    ]),
    outsideGeography: 2,
  };
}

const AUDIT: CoreAudit = {
  generatedBy: "Data Analyst",
  generatedAt: "2026-10-23T09:00:00Z",
  confirmedBy: "Research Officer",
  confirmedAt: "2026-10-23T09:30:00Z",
  reviewedBy: "Reviewer",
  reviewedRole: "human_reviewer",
  reviewedAt: "2026-10-23T10:00:00Z",
  reviewerNotes: "Checked against the study data.",
  version: 1,
};

const SCOPES: Array<[ScopeLevel, string | null, string | null]> = [
  ["KINGDOM", null, null],
  ["REGION", "r1", REGION.name],
  ["GOVERNORATE", "g1", "Al-Ahsa"],
  ["CENTRE", "c1", "Centre c1"],
  ["VILLAGE", null, "Al-Qarain"],
];

const build = (level: ScopeLevel, id: string | null, name: string | null, output: CoreOutput = "FULL", domainKeys: string[] | null = null) =>
  buildCoreNeedsContent({
    inputs: inputsFor(level, id, name),
    output,
    domainKeys,
    filters: { scopeLevel: level, unitId: id },
    generatedAt: AUDIT.generatedAt,
  });

describe("Core Needs Report, end to end", () => {
  it.each(SCOPES)("builds, draws and exports a %s report in English and Arabic", async (level, id, name) => {
    const content = build(level, id, name);
    expect(content.kind).toBe("CORE_NEEDS");
    expect(content.rankedNeeds.length).toBeGreaterThan(0);
    // Ranked from the most severe need down.
    const sev = content.rankedNeeds.map((n) => n.severity);
    expect([...sev].sort((a, b) => b - a)).toEqual(sev);

    for (const locale of ["en", "ar"] as const) {
      const view = buildCoreView({ content, locale, aliases: NO_ALIASES, audit: AUDIT });
      expect(view.dir).toBe(locale === "ar" ? "rtl" : "ltr");
      const pdf = renderCoreNeedsPdf(view);
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      const xlsx = await renderCoreNeedsExcel(view);
      expect(xlsx.subarray(0, 2).toString()).toBe("PK");
    }
  });

  it("keeps only the chosen domains", () => {
    const content = build("KINGDOM", null, null, "FULL", ["HEALTH"]);
    expect(content.domains.map((d) => d.key)).toEqual(["HEALTH"]);
    expect(content.rankedNeeds.every((n) => n.domain === "Health")).toBe(true);
  });

  it("the summary output is shorter than the full report", () => {
    const full = buildCoreView({ content: build("GOVERNORATE", "g1", "Al-Ahsa", "FULL"), locale: "en", aliases: NO_ALIASES, audit: AUDIT });
    const summary = buildCoreView({ content: build("GOVERNORATE", "g1", "Al-Ahsa", "SUMMARY"), locale: "en", aliases: NO_ALIASES, audit: AUDIT });
    expect(summary.output).toBe("SUMMARY");
    expect(renderCoreNeedsPdf(summary).length).toBeLessThan(renderCoreNeedsPdf(full).length);
  });

  it("a low-confidence report carries the watermark; one that meets the standard does not", () => {
    const meets = buildCoreView({ content: build("REGION", "r1", REGION.name), locale: "en", aliases: NO_ALIASES, audit: AUDIT });
    const inputs = inputsFor("REGION", "r1", REGION.name);
    // Fewer valid responses than the methodology minimum.
    const low = buildCoreView({
      content: buildCoreNeedsContent({
        inputs: { ...inputs, confidence: { ...inputs.confidence, minRespondents: 500 } },
        output: "FULL",
        domainKeys: null,
        filters: {},
        generatedAt: AUDIT.generatedAt,
      }),
      locale: "ar",
      aliases: NO_ALIASES,
      audit: AUDIT,
    });
    expect(meets.overall).toBe("MEETS");
    expect(meets.watermark).toBeNull();
    expect(low.overall).toBe("LOW");
    expect(low.watermark).toBeTruthy();
    expect(renderCoreNeedsPdf(low).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("draws the NCNP report from two studies combined", async () => {
    const other = inputsFor("KINGDOM", null, null);
    const merged = mergeCoreInputs([
      inputsFor("KINGDOM", null, null),
      { ...other, study: { ...other.study, id: "study-2", orgId: "org-2", organizationName: "Another Charity" } },
    ]);
    const content = buildCoreNeedsContent({ inputs: merged, output: "FULL", domainKeys: null, filters: {}, generatedAt: AUDIT.generatedAt });
    const view = buildCoreView({ content, locale: "ar", aliases: NO_ALIASES, audit: AUDIT });
    expect(renderCoreNeedsPdf(view).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await renderCoreNeedsExcel(view)).subarray(0, 2).toString()).toBe("PK");
  });
});

describe("resolveCoreView", () => {
  it("translates the free text once and draws the view in that language", async () => {
    const content = build("GOVERNORATE", "g1", "Al-Ahsa");
    const asked: string[] = [];
    const view = await resolveCoreView({
      content,
      locale: "ar",
      aliases: NO_ALIASES,
      audit: AUDIT,
      translateMany: async (texts) => {
        asked.push(...texts);
        return texts.map((t) => ({ translatedText: `ع ${t}` }));
      },
    });
    expect(asked).toContain("Community Needs Assessment");
    expect(new Set(asked).size).toBe(asked.length);
    expect(view.header.study).toContain("ع Community Needs Assessment");
  });

  it("asks for content stored under the earlier rules to be generated again", async () => {
    const old = { ...build("KINGDOM", null, null), version: 1 } as unknown as ReturnType<typeof build>;
    await expect(
      resolveCoreView({ content: old, locale: "en", aliases: NO_ALIASES, audit: AUDIT, translateMany: async (t) => t.map((x) => ({ translatedText: x })) }),
    ).rejects.toThrow();
  });
});

describe("Core Needs Report, when data is missing or uneven", () => {
  const base = () => inputsFor("GOVERNORATE", "g1", "Al-Ahsa");
  const variants: Array<[string, (i: CoreInputs) => CoreInputs]> = [
    ["no required sample or population", (i) => ({ ...i, study: { ...i.study, requiredSampleSize: null, population: null, marginOfError: null, minimumDetectableEffect: null } })],
    ["no area figures, centres or map", (i) => ({ ...i, profiles: new Map(), centresByGovernorate: new Map(), mapContext: [] })],
    ["no domain weights", (i) => ({ ...i, domainConfigs: [] })],
    ["settings not yet approved", (i) => ({ ...i, concentratedFromPct: null, coverageMinPct: null, governorateMinCentresPct: null, linkPairs: [] })],
    ["every answer in one village", (i) => ({ ...i, answers: i.answers.map((a) => ({ ...a, village: "Al-Qarain" })) })],
    [
      "mostly don't-know answers",
      (i) => ({ ...i, answers: i.answers.map((a, n) => (n % 3 ? { ...a, status: "EXCLUDED", exclusionReason: "DONT_KNOW", severity: null } : a)) }),
    ],
    ["no gender or age recorded", (i) => ({ ...i, responses: i.responses.map((r) => ({ ...r, gender: null, ageBracket: null })) })],
    [
      "nothing else known about the study",
      (i) => ({ ...i, otherOrganisations: [], needSources: [], collectedFrom: null, collectedTo: null, outsideGeography: 0, survey: { ...i.survey, targetGroup: null, selectionApproach: null }, targetGroupBySurvey: new Map() }),
    ],
    ["no scored answers at all", (i) => ({ ...i, answers: [] })],
  ];

  it.each(variants)("still builds, draws and exports: %s", async (_name, change) => {
    const content = buildCoreNeedsContent({ inputs: change(base()), output: "FULL", domainKeys: null, filters: {}, generatedAt: AUDIT.generatedAt });
    for (const locale of ["en", "ar"] as const) {
      const view = buildCoreView({ content, locale, aliases: NO_ALIASES, audit: AUDIT });
      expect(renderCoreNeedsPdf(view).subarray(0, 5).toString()).toBe("%PDF-");
    }
    const xlsx = await renderCoreNeedsExcel(buildCoreView({ content, locale: "ar", aliases: NO_ALIASES, audit: AUDIT }));
    expect(xlsx.subarray(0, 2).toString()).toBe("PK");
  });

  it("names master data in Arabic, and shows a KPI per methodology version when the versions differ", () => {
    const a = inputsFor("KINGDOM", null, null);
    const withSig = (i: CoreInputs, label: string, sig: string): CoreInputs => ({
      ...i,
      study: { ...i.study, methodologyVersionLabel: label, methodologyVersionId: label },
      kpiSignature: new Map([["HLT-01 — Households far from a clinic", sig]]),
    });
    const merged = mergeCoreInputs([withSig(a, "v5.0", "x"), withSig({ ...a, study: { ...a.study, id: "study-2", organizationName: "Another Charity" } }, "v5.1", "y")]);
    const content = buildCoreNeedsContent({ inputs: merged, output: "FULL", domainKeys: null, filters: {}, generatedAt: AUDIT.generatedAt });
    expect(content.methodologySplit?.[0]?.versions).toEqual(["v5.0", "v5.1"]);
    const aliases = new Map([
      ["health", "الصحة"],
      ["al-ahsa", "الأحساء"],
      ["eastern province", "المنطقة الشرقية"],
    ]);
    const view = buildCoreView({ content, locale: "ar", aliases, audit: AUDIT });
    expect(JSON.stringify(view)).toContain("الصحة");
    expect(renderCoreNeedsPdf(view).subarray(0, 5).toString()).toBe("%PDF-");
  });
});
