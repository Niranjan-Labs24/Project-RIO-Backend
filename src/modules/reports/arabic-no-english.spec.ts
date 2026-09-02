import { describe, expect, it } from "vitest";
import { StubReportDataProvider } from "./providers/__fixtures__/report-content.fixtures";
import { buildReportDoc, type ReportDoc } from "./report-doc";
import { collectDocStrings, mapDocStrings } from "./doc-strings";
import { localiseReportDoc } from "./localise-doc";
import { ReportTranslationService, unexplainedLatin } from "./report-translation.service";
import type { GeneratorCtx } from "./generators";
import { collectiveGenerator } from "./generators/collective.generator";
import { combinedGenerator } from "./generators/combined.generator";
import { dataQualityGenerator } from "./generators/data-quality.generator";
import { executiveGenerator } from "./generators/executive.generator";
import { individualSurveyGenerator } from "./generators/individual-survey.generator";
import { regionGenerator } from "./generators/region.generator";
import { sectorGenerator } from "./generators/sector.generator";
import { sharingStatusGenerator } from "./generators/sharing-status.generator";
import { topPriorityGenerator } from "./generators/top-priority.generator";
import { villageGenerator } from "./generators/village.generator";

/**
 * The "no English anywhere" guarantee, asserted for EVERY report the platform
 * can generate.
 *
 * WHY EVERY TYPE, AND NOT ONE SAMPLE
 *
 * Because the leak is per-report-type in practice. An Arabic RPT06 came back
 * with four English strings; the same build of the same pipeline produced an
 * RPT10 with nine pages of it — RPT10 simply emits vocabulary and section kinds
 * the other reports do not. Testing one report type proves nothing about the
 * twelve that render different sections, and "we fixed the one you sent" is not
 * the requirement. The requirement is the language of the export.
 *
 * WHY DOCUMENT LEVEL, AND NOT THE RENDERED PDF
 *
 * A PDF's text sits behind a ToUnicode CMap, so extracting it tests the font
 * embedding — covered by `unicode-pdf-builder`'s own specs — and would say
 * nothing about whether a FIELD was ever offered for translation. The failure
 * this guards against is structural: a `DocSection` field that `doc-strings.ts`
 * does not walk is invisible to the pass, silently keeps its English, and no
 * amount of prompt work fixes it.
 *
 * The stub translator is the point, not a shortcut. What is under test is the
 * PIPELINE's coverage; a real model would make the assertion depend on the
 * model's mood, and a green run would stop meaning anything.
 */

const REVIEWER = "Reviewer - Demo User";
const AUTHOR = "Research Officer - Demo User";
/** Exactly what `protectedNamesOf` passes at export time. */
const PROTECTED = [AUTHOR, REVIEWER];

function ctx(over: Partial<GeneratorCtx> = {}): GeneratorCtx {
  return {
    provider: new StubReportDataProvider(),
    orgId: "org-1",
    studyId: "study-1",
    surveyId: "survey-1",
    studyTitle: "Village Community Needs Assessment",
    // villageGenerator requires it; the others ignore it.
    filters: { villageId: "VIL-001" },
    ...over,
  };
}

/** Every report type that has a generator, keyed by its catalogue code. */
const REPORTS: Array<[string, (c: GeneratorCtx) => Promise<{ title: string; content: Record<string, unknown> }>]> = [
  ["RPT01", individualSurveyGenerator],
  ["RPT02", collectiveGenerator],
  ["RPT03", topPriorityGenerator],
  ["RPT04", sectorGenerator],
  ["RPT06", regionGenerator],
  ["RPT10", dataQualityGenerator],
  ["RPT12", sharingStatusGenerator],
  ["RPT13", executiveGenerator],
  ["RPT14", villageGenerator],
  ["RPT16", combinedGenerator],
];

/** A model that answers in Arabic for anything it is handed.
 *
 *  It copies the source's digits through, because the service rejects any
 *  answer that changes them — a stub that dropped them would have every item
 *  rejected and make these tests pass for entirely the wrong reason. */
function arabisingAi() {
  return {
    run: async (_task: unknown, prompt: string) => {
      const payload = JSON.parse(prompt.slice(prompt.indexOf("{"))) as {
        items: Array<{ id: string; text: string }>;
      };
      return {
        response: {
          items: payload.items.map((i) => ({
            id: i.id,
            ar: `مترجم${(i.text.match(/\d/g) ?? []).join("")}`,
          })),
        },
        raw: null,
      };
    },
  };
}

function emptyCache() {
  const tx = {
    reportTranslation: {
      findMany: async () => [],
      createMany: async () => undefined,
      updateMany: async () => ({ count: 0 }),
    },
  };
  return {
    runAsSupervisor: <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
    runAsSupervisorWrite: <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
  };
}

/** A cache whose every query throws, standing in for the migration not having
 *  been deployed. */
function brokenCache() {
  const boom = async () => {
    throw new Error('relation "report_translations" does not exist');
  };
  const tx = { reportTranslation: { findMany: boom, createMany: boom, updateMany: boom } };
  return {
    runAsSupervisor: <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
    runAsSupervisorWrite: <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
  };
}

/** The real export pipeline: generate → build → dictionaries → model. */
async function arabicEditionOf(
  generator: (c: GeneratorCtx) => Promise<{ title: string; content: Record<string, unknown> }>,
  cache: unknown = emptyCache(),
): Promise<ReportDoc> {
  const { title, content } = await generator(ctx());
  const auditRows = [
    { label: "Generated By", value: AUTHOR },
    { label: "Reviewed By", value: REVIEWER },
    { label: "Reviewer Role", value: "Human Reviewer" },
  ];
  const built = buildReportDoc(title, content, auditRows, "ar");
  const localised = localiseReportDoc({ ...built, locale: "ar", rtl: true }, "ar", {});
  const service = new ReportTranslationService(arabisingAi() as never, cache as never);
  return service.translateDoc(localised, "ar", PROTECTED);
}

describe("every Arabic report, end to end", () => {
  it.each(REPORTS)("%s has no English left in any field", async (_code, generator) => {
    const doc = await arabicEditionOf(generator);
    // Asserted as the offending strings rather than a count, so a failure names
    // the exact field the walker cannot see. That is the difference between an
    // actionable failure and a puzzle.
    expect(unexplainedLatin(doc, new Set(PROTECTED))).toEqual([]);
  });

  it("still carries the reviewer's real name, unaltered", async () => {
    const doc = await arabicEditionOf(villageGenerator);
    expect(collectDocStrings(doc)).toContain(REVIEWER);
  });

  it("translates an all-caps English word rather than mistaking it for a code", async () => {
    // "DOMAIN", "SUB-DOMAIN", "SCORED" and friends are rendered in capitals as
    // a table's type column. Treating capitalisation as evidence of machine
    // vocabulary is what left them English across an entire Arabic RPT10.
    const doc = await arabicEditionOf(villageGenerator);
    const all = collectDocStrings(doc);
    for (const badge of ["DOMAIN", "SUB-DOMAIN", "SURVEY", "INDICATOR"]) {
      expect(all).not.toContain(badge);
    }
  });

  it("still translates when the cache is unreachable", async () => {
    // The `report_translations` migration not being deployed must cost speed,
    // not the language of the report.
    const doc = await arabicEditionOf(dataQualityGenerator, brokenCache());
    expect(unexplainedLatin(doc, new Set(PROTECTED))).toEqual([]);
  });
});

describe("doc-strings", () => {
  it("never visits an anchor id or link target, which would break navigation", async () => {
    const { title, content } = await villageGenerator(ctx());
    const built = buildReportDoc(title, content, [], "en");
    const rewritten = mapDocStrings(built, () => "REWRITTEN");

    // Anchors, page-break targets and tile destinations are machine
    // identifiers. A rewritten one gives a PDF whose links look clickable and
    // go nowhere, which is worse than an untranslated label.
    const targets = (doc: ReportDoc): string[] =>
      doc.sections.flatMap((s) => {
        if (s.kind === "anchor") return [s.id];
        if (s.kind === "pageBreak") return [s.anchorId];
        if (s.kind === "navGrid") return s.tiles.map((t) => t.to);
        return [];
      });
    expect(targets(rewritten)).toEqual(targets(built));
    expect(rewritten.title).toBe("REWRITTEN");
  });

  it("returns each distinct string once", async () => {
    const { title, content } = await villageGenerator(ctx());
    const all = collectDocStrings(buildReportDoc(title, content, [], "en"));
    expect(new Set(all).size).toBe(all.length);
  });
});
