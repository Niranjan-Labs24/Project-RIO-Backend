import { describe, expect, it } from "vitest";
import {
  combinedEvidenceGenerator,
  evidenceDocumentGenerator,
  type EvidenceReportTx,
} from "./evidence-reports.generator";

// RPT16 / RPT17 characterisation tests, added with the extraction of these two
// reports out of ReportsService.generateContent. Until now the pair had no
// generation-level coverage at all — report-doc.rpt16/17.spec.ts render
// hand-written content fixtures, so they would not have noticed the content
// itself changing shape.
//
// What these pin is the part of the "these reports carry no placeholder data"
// claim that is checkable in isolation: RPT17's scoring firewall, the fact
// that recommendations are only ever quoted from officer-facing summaries,
// and that an unscored study is reported as unscored rather than filled in.

const DOCS = [
  {
    id: "doc-1",
    title: "Water access field notes",
    documentType: "FIELD_NOTES",
    sourceReferenceId: "REF-1",
    collectedDate: new Date("2026-03-04T00:00:00.000Z"),
    description: "Notes from the March visit.",
    summaries: [
      {
        status: "CONFIRMED",
        officerEditedOutputJson: JSON.stringify({
          keyFindings: ["Two of four wells were non-functional."],
          recommendations: ["Repair the two non-functional wells"],
        }),
        aiOutputJson: null,
      },
    ],
  },
  {
    id: "doc-2",
    title: "Clinic staffing memo",
    documentType: "MEMO",
    sourceReferenceId: null,
    collectedDate: null,
    description: "",
    summaries: [],
  },
];

const COMBINED_SUMMARY = {
  officerEditedOutputJson: null,
  aiOutputJson: JSON.stringify({
    synthesis: "Water and health needs dominate the evidence base.",
    recommendations: ["Repair the two non-functional wells", "Add a second clinic shift"],
  }),
};

const SCORE_SUMMARY = {
  officerEditedOutputJson: null,
  aiOutputJson: JSON.stringify({
    scoreNarrative: "Severity concentrates in two domains.",
    // Deliberately overlaps the combined list, in different case and spacing —
    // the union must keep it once.
    draftNextSteps: ["  repair the two NON-FUNCTIONAL wells ", "Re-run scoring after repairs"],
  }),
};

function fakeTx(overrides: Partial<Record<string, unknown>> = {}): EvidenceReportTx {
  return {
    study: {
      findUnique: async () => ({
        id: "study-1",
        title: "Ad-Dilam Water & Health",
        cycleNumber: 2,
        methodologyVersionId: "mv-5",
      }),
    },
    organisation: { findUnique: async () => ({ id: "org-1", name: "Demo NGO" }) },
    studyCenter: {
      findMany: async () => [{ center: { name: "Central Centre" } }],
    },
    studyGovernorate: {
      findMany: async () => [{ governorate: { region: { code: 1 } } }],
    },
    evidenceDocument: { findMany: async () => DOCS },
    combinedReportSummary: { findFirst: async () => COMBINED_SUMMARY },
    aiPrioritySummary: { findFirst: async () => SCORE_SUMMARY },
    ...overrides,
  } as unknown as EvidenceReportTx;
}

const baseCtx = {
  studyId: "study-1",
  orgId: "org-1",
  generatedBy: "user-1",
  filters: {},
  // Unscored study — the common real case for an evidence-led report, and the
  // one where invented figures would be easiest to slip in unnoticed.
  loadFacts: async () => null,
};

describe("RPT17 evidence-document report", () => {
  it("carries no scoring keys at all", async () => {
    const { content } = await evidenceDocumentGenerator({ ...baseCtx, tx: fakeTx() });

    // The firewall: a document-derived report must not print survey-derived
    // scores, because a score sitting next to the documents reads as if the
    // documents produced it. Absent keys, not nulled ones — report-doc.ts
    // decides section-by-section on key presence.
    for (const key of [
      "severity",
      "priority",
      "topPriorities",
      "combinedSummarySection",
      "scoreSummarySection",
    ]) {
      expect(content, `RPT17 must not carry ${key}`).not.toHaveProperty(key);
    }
  });

  it("titles itself from the real study and reports the evidence it actually has", async () => {
    const { title, content } = await evidenceDocumentGenerator({ ...baseCtx, tx: fakeTx() });

    expect(title).toBe("Ad-Dilam Water & Health — Evidence Document Report");
    const evidence = content.evidenceSection as { totalDocuments: number; documents: unknown[] };
    expect(evidence.totalDocuments).toBe(2);
    expect(evidence.documents).toHaveLength(2);
    expect(content.reportKind).toBe("report");
  });

  it("marks a document with no summary rather than inventing one", async () => {
    const { content } = await evidenceDocumentGenerator({ ...baseCtx, tx: fakeTx() });
    const docs = (content.evidenceSection as { documents: Array<Record<string, unknown>> })
      .documents;

    expect(docs[1]!.summaryStatus).toBe("NO_SUMMARY");
    expect(docs[1]!.description).toBe("");
    // Pinning today's behaviour, which is subtly inconsistent and predates the
    // extraction: `parsedOutput` starts as null but is reassigned from an
    // absent summary, so it ends up `undefined` — and an undefined field is
    // dropped entirely when the content is written to JSONB. A document whose
    // summary exists but fails to parse gets an explicit null instead, so the
    // two "no usable summary" cases serialise differently. Harmless today
    // (`summaryStatus` is what both renderers read), but worth normalising to
    // null separately — not inside a move that is meant to change no output.
    expect(docs[1]!.aiSummary).toBeUndefined();
  });
});

describe("RPT16 combined evidence & score report", () => {
  it("carries the scoring half", async () => {
    const { title, content } = await combinedEvidenceGenerator({ ...baseCtx, tx: fakeTx() });

    expect(title).toBe("Ad-Dilam Water & Health — Combined Quantitative & Evidence Report");
    expect(content).toHaveProperty("severity");
    expect(content).toHaveProperty("priority");
    expect(content).toHaveProperty("topPriorities");
  });

  it("reports an unscored study as unscored instead of filling in figures", async () => {
    const { content } = await combinedEvidenceGenerator({ ...baseCtx, tx: fakeTx() });

    const gap = { note: "Data not available for this study." };
    expect(content.severity).toEqual(gap);
    expect(content.priority).toEqual(gap);
    expect(content.responseQuality).toEqual(gap);
    // Not a zero, not a fabricated placeholder row — an empty ranking.
    expect(content.topPriorities).toEqual([]);
  });

  it("unions both summaries' recommendations and keeps a shared one once", async () => {
    const { content } = await combinedEvidenceGenerator({ ...baseCtx, tx: fakeTx() });

    // Quoted from the officer-facing summaries, never composed here. The well
    // repair appears in both lists (and in different case/whitespace).
    expect(content.recommendations).toEqual([
      "Repair the two non-functional wells",
      "Add a second clinic shift",
      "Re-run scoring after repairs",
    ]);
  });

  it("does not restate the hoisted recommendations inside the nested narratives", async () => {
    const { content } = await combinedEvidenceGenerator({ ...baseCtx, tx: fakeTx() });

    expect(content.combinedSummarySection).toEqual({
      synthesis: "Water and health needs dominate the evidence base.",
    });
    expect(content.scoreSummarySection).toEqual({
      scoreNarrative: "Severity concentrates in two domains.",
    });
  });

  it("emits no recommendations when the summaries carry none", async () => {
    const { content } = await combinedEvidenceGenerator({
      ...baseCtx,
      tx: fakeTx({
        combinedReportSummary: { findFirst: async () => null },
        aiPrioritySummary: { findFirst: async () => null },
      }),
    });

    expect(content.recommendations).toEqual([]);
  });
});

describe("geography, for both reports", () => {
  it("plots a single-region study by its region code, not its name", async () => {
    const { content } = await combinedEvidenceGenerator({ ...baseCtx, tx: fakeTx() });
    const geo = content.geography as { regions: Array<Record<string, unknown>> };

    // The coordinate lookup on both the PDF and the web map keys on `code`;
    // a name-keyed marker silently disappears once names render in Arabic.
    expect(geo.regions).toHaveLength(0); // no facts -> no regionName -> no marker
  });

  it("plots nothing for a multi-region study rather than picking one", async () => {
    const { content } = await evidenceDocumentGenerator({
      ...baseCtx,
      tx: fakeTx({
        studyGovernorate: {
          findMany: async () => [
            { governorate: { region: { code: 1 } } },
            { governorate: { region: { code: 6 } } },
          ],
        },
      }),
    });
    const geo = content.geography as { regions: unknown[] };

    expect(geo.regions).toEqual([]);
  });

  it("reports missing geography as unavailable, not as an empty string", async () => {
    const { content } = await evidenceDocumentGenerator({ ...baseCtx, tx: fakeTx() });
    const geo = content.geography as Record<string, unknown>;

    expect(geo.region).toBe("Data not available for this study.");
    expect(geo.governorate).toBe("Data not available for this study.");
    expect(geo.center).toBe("Central Centre");
  });
});
