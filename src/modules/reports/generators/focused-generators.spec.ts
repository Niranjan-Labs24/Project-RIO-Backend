import { describe, expect, it } from "vitest";
import { StubReportDataProvider } from "../providers/__fixtures__/report-content.fixtures";
import { dataQualityGenerator } from "./data-quality.generator";
import { topPriorityGenerator } from "./top-priority.generator";
import { individualSurveyGenerator } from "./individual-survey.generator";
import { buildReportDoc } from "../report-doc";
import { flattenReportContent } from "../report-content-flatten";
import type {
  DataQualityReportContent,
  TopPriorityReportContent,
} from "../report-content.types";
import type { IndividualSurveyReportContent } from "../report-content.types";

// RIO-RPT-001 — acceptance criteria as executable invariants for the two
// net-new report types (RPT03/RPT09 Top-Priority, RPT10 Data-Quality).
//
// The stub provider runs the REAL pure mappers (buildTopPriorityContent /
// buildDataQualityContent) over the REAL unified builder, so these assert the
// production projection logic rather than a hand-written fixture.

const ctx = (sourceNeedAffectedPopulation: number | null = null) => ({
  provider: new StubReportDataProvider(sourceNeedAffectedPopulation),
  orgId: "org-1",
  studyId: "study-1",
  studyTitle: "Village Community Needs Assessment",
  filters: {},
});

async function topPriority(
  sourceNeedAffectedPopulation: number | null = null,
): Promise<TopPriorityReportContent> {
  const r = await topPriorityGenerator(ctx(sourceNeedAffectedPopulation));
  return r.content as unknown as TopPriorityReportContent;
}

async function dataQuality(): Promise<DataQualityReportContent> {
  const r = await dataQualityGenerator(ctx());
  return r.content as unknown as DataQualityReportContent;
}

describe("RPT03/RPT09 Top-Priority Report", () => {
  it("titles itself from the study and stamps the methodology version (AC 1, AC 5)", async () => {
    const r = await topPriorityGenerator(ctx());
    expect(r.title).toBe("Top-Priority Report — Village Community Needs Assessment");
    const c = r.content as unknown as TopPriorityReportContent;
    // AC 5 — the version the report was scored against travels WITH the
    // content, so it survives into the export header and the archive.
    expect(c.header.methodologyVersion).toBe("v1.0");
    expect(c.header.reportGeneratedAt).toBeTruthy();
  });

  it("bands every measured need and counts none twice", async () => {
    const c = await topPriority();
    const banded = c.tierSummary.reduce((sum, t) => sum + t.count, 0);
    const measured = c.priorityNeeds.needs.length;
    expect(banded).toBe(measured);
    // Ranked + unmeasured accounts for every need record — nothing is dropped
    // between the ranking and the tier table.
    expect(measured + c.priorityNeeds.notMeasured.length).toBeGreaterThan(0);
  });

  it("never bands an unmeasured need (a null severity has no tier)", async () => {
    const c = await topPriority();
    for (const n of c.priorityNeeds.notMeasured) expect(n.severityScore).toBeNull();
    // Shares sum to 100 across measured needs, or to 0 when none were measured.
    const shares = c.tierSummary.reduce((s, t) => s + t.sharePct, 0);
    expect(shares === 0 || Math.abs(shares - 100) < 0.5).toBe(true);
  });

  it("ranks contiguously from 1 and is reproducible from the printed basis", async () => {
    const c = await topPriority();
    const ranks = c.priorityNeeds.needs.map((n) => n.rank);
    expect(ranks).toEqual(ranks.map((_, i) => i + 1));
    // The methodology's explainability requirement: a reader must be able to
    // recompute the order, so the formula is printed, not assumed.
    expect(c.priorityNeeds.rankingBasis).toBeTruthy();
    expect(c.calculationBasis.severityBandingRule).toBeTruthy();
    expect(c.calculationBasis.equityRule).toBeTruthy();
  });

  it("carries the no-masking columns on every domain row", async () => {
    const c = await topPriority();
    expect(c.domainRollup.length).toBeGreaterThan(0);
    for (const d of c.domainRollup) {
      // Max is mandatory alongside the average — that IS the no-masking rule.
      expect(d).toHaveProperty("maxKpiSeverity");
      expect(d).toHaveProperty("criticalKpiCount");
      // An unmeasured domain reports null, never a 0 standing in for "fine".
      if (d.maxKpiSeverity !== null) expect(d.maxKpiSeverity).toBeGreaterThanOrEqual(0);
    }
  });

  it("flags a domain whose average is milder than its worst KPI", async () => {
    const c = await topPriority();
    for (const d of c.domainRollup) {
      if (d.masksCriticalFinding) {
        expect(d.maxKpiSeverity).not.toBeNull();
        expect(d.averageSeverity).not.toBeNull();
        expect(d.maxKpiSeverity!).toBeGreaterThan(d.averageSeverity!);
      }
    }
  });
});

describe("RPT10 Data-Quality Report", () => {
  it("titles itself from the study and stamps the methodology version (AC 1, AC 5)", async () => {
    const r = await dataQualityGenerator(ctx());
    expect(r.title).toBe("Data-Quality Report — Village Community Needs Assessment");
    expect((r.content as unknown as DataQualityReportContent).header.methodologyVersion).toBe("v1.0");
  });

  it("FLAGS every incomplete record instead of excluding it (AC 6)", async () => {
    const c = await dataQuality();
    const dq = c.dataQualityNotes;
    const dc = c.dataCollection;
    // The count and the rows behind it must agree. A count without its rows is
    // precisely the silent exclusion acceptance criterion 6 prohibits — and
    // that applies to the two counts added on 24 Aug (abandoned sittings,
    // unanswered required questions) exactly as it did to the original two.
    expect(c.flaggedRecords.length).toBe(
      dq.notMeasuredCount +
        dq.domainsNotAssessed.length +
        (dc?.abandonment.abandoned ?? 0) +
        (dc?.unansweredRequired.byQuestion.length ?? 0),
    );
    for (const f of c.flaggedRecords) {
      expect(f.flag).toMatch(
        /^(NOT_MEASURABLE|DOMAIN_NOT_ASSESSED|ABANDONED_SESSION|REQUIRED_QUESTION_UNANSWERED)$/,
      );
      // Every flag carries its reason — a flag with no explanation is a
      // dead end for the analyst who has to act on it.
      expect(f.reason.length).toBeGreaterThan(0);
    }
  });

  // ── Data-collection completeness: client Q14 answer (a), settled 24 Aug ──

  it("counts abandoned sittings INTO the invalid-response count, not beside it", async () => {
    const c = await dataQuality();
    const dc = c.dataCollection;
    expect(dc).not.toBeNull();
    if (!dc) return;
    // "Abandoned/incomplete submissions are counted as invalid responses, not
    // reported as a separate category. They contribute to the invalid-response
    // count and the abandonment rate."
    expect(dc.invalidResponses.total).toBe(
      dc.invalidResponses.excludedSubmitted + dc.invalidResponses.abandonedSessions,
    );
    expect(dc.invalidResponses.abandonedSessions).toBe(dc.abandonment.abandoned);
    // The submission-level exclusion figure is left as the rollup reported it —
    // RPT01/RPT03 reconcile against that number, so it must not absorb a
    // session-level count.
    expect(dc.invalidResponses.excludedSubmitted).not.toBe(dc.invalidResponses.total);
  });

  it("prints the abandonment rate with the threshold that defines it", async () => {
    const c = await dataQuality();
    const rate = c.completeness.find((t) => t.label === "Abandonment Rate");
    expect(rate?.value).toMatch(/%.*abandoned after \d+m idle/);
  });

  it("states which surveys the completeness figures cover", async () => {
    const c = await dataQuality();
    const dc = c.dataCollection;
    if (!dc) throw new Error("dataCollection missing");
    // RPT10 was labelled study-scoped while reporting on one resolved survey.
    // The scope block is what makes a partial figure impossible to read as a
    // total: covered and not-covered surveys are both named.
    expect(dc.scope.coveredSurveys.length + dc.scope.excludedSurveys.length).toBe(dc.scope.surveysInStudy);
    expect(dc.scope.note.length).toBeGreaterThan(0);
  });

  it("RENDERS the completeness sections, not merely computes them", async () => {
    // The Calculation Basis blocks sat computed-but-unrendered for a sprint
    // because the tests asserted on the payload. These assert on the emitted
    // document: a figure a reader cannot see has not been delivered.
    const c = await dataQuality();
    const doc = buildReportDoc("Data-Quality", c as unknown as Record<string, unknown>, []);
    const headings = doc.sections.map((s) => ("heading" in s ? s.heading : "")).filter(Boolean);
    for (const heading of [
      "Data-Collection Scope",
      "Surveys Covered",
      "Survey Abandonment",
      "Where Respondents Stopped",
      "Invalid Responses",
      "Unanswered Required Questions",
      "Required Questions With Gaps",
    ]) {
      expect(headings).toContain(heading);
    }

    const invalid = doc.sections.find(
      (s) => s.kind === "keyvalue" && s.heading === "Invalid Responses",
    ) as { kind: "keyvalue"; rows: Array<{ label: string; value: string }> } | undefined;
    // Both components printed beside the total, so no reader has to guess
    // whether "invalid" includes the abandoned sittings. It does.
    expect(invalid?.rows.map((r) => r.label)).toEqual([
      "Excluded submitted responses",
      "Abandoned / incomplete sessions",
      "Invalid responses (total)",
      "How this is counted",
    ]);
  });

  it("renders the real demographic breakdown instead of the pending placeholder", async () => {
    // RPT10 aggregated demographics and then dropped them, so the chapter
    // printed "demographic capture is pending" over data that had in fact been
    // captured — a data-quality report understating the data it holds.
    const c = await dataQuality();
    expect(c.demographics?.gender.length).toBeGreaterThan(0);

    const doc = buildReportDoc("Data-Quality", c as unknown as Record<string, unknown>, []);
    const headings = doc.sections.map((s) => ("heading" in s ? s.heading : ""));
    expect(headings).toContain("Gender Breakdown");
    expect(headings).not.toContain("Demographic Breakdown");
  });

  it("shows every abandoned sitting and required-question gap as a flagged row", async () => {
    const c = await dataQuality();
    const doc = buildReportDoc("Data-Quality", c as unknown as Record<string, unknown>, []);
    const table = doc.sections.find(
      (s) => s.kind === "table" && s.heading === "Flagged Records Detail",
    ) as { kind: "table"; rows: string[][] } | undefined;
    expect(table).toBeDefined();
    const flags = table!.rows.map((r) => r[0]);
    expect(flags).toContain("ABANDONED_SESSION");
    expect(flags).toContain("REQUIRED_QUESTION_UNANSWERED");
  });

  it("stores no answer data anywhere in the abandonment block", async () => {
    const c = await dataQuality();
    const dc = c.dataCollection;
    if (!dc) throw new Error("dataCollection missing");
    // Client answer, point 1: a partially completed survey is not a data
    // record. The block carries counts, stages and timestamps — an answer
    // value has nowhere to live in it.
    for (const row of dc.abandonment.detail) {
      expect(Object.keys(row).sort()).toEqual(
        ["lastActivityAt", "progress", "remindersSent", "sessionRef", "stage", "stageLabel", "startedAt"],
      );
    }
  });

  it("reports excluded responses rather than netting them out of the total", async () => {
    const c = await dataQuality();
    const rq = c.dataQualityNotes.responseQuality;
    expect(rq.submitted).toBeGreaterThanOrEqual(rq.valid);
    expect(rq.excluded).toBe(rq.submitted - rq.valid);
    // The exclusion breakdown is itemised by status, never a single opaque number.
    for (const e of c.dataQualityNotes.exclusionBreakdown) {
      expect(e.status).toBeTruthy();
      expect(e.sharePct).toBeGreaterThanOrEqual(0);
    }
  });

  it("names the condition behind every confidence band", async () => {
    const c = await dataQuality();
    expect(c.domainConfidence.length).toBeGreaterThan(0);
    for (const d of c.domainConfidence) {
      expect(["LOW", "STANDARD"]).toContain(d.confidence);
      // A LOW band with no stated reason reads as arbitrary — the whole point
      // of composeConfidenceReason is that it names the trigger that fired.
      if (d.confidence === "LOW") expect(d.reason.length).toBeGreaterThan(0);
    }
  });

  it("states when a study has no signed-off sample-size target rather than printing 0", async () => {
    const c = await dataQuality();
    const row = c.completeness.find((r) => r.label === "Required Sample Size (study)");
    expect(row).toBeDefined();
    expect(row!.value).not.toBe("0");
  });
});

describe("reconciliation across the three reports sharing the unified pipeline (AC 3)", () => {
  it("Top-Priority, Data-Quality and RPT01 report identical response-quality figures", async () => {
    const survey = (await individualSurveyGenerator({ ...ctx(), surveyId: "survey-1" }))
      .content as unknown as IndividualSurveyReportContent;
    const tp = await topPriority();
    const dq = await dataQuality();

    // The reconciliation guarantee is structural: all three project ONE unified
    // half. If someone re-aggregates any of them independently, this fails.
    expect(tp.responseQuality.submittedResponses).toBe(survey.responseQuality.submittedResponses);
    expect(dq.responseQuality.submittedResponses).toBe(survey.responseQuality.submittedResponses);
    expect(dq.dataQualityNotes.responseQuality.valid).toBe(survey.dataQualityNotes.responseQuality.valid);
    expect(tp.priorityNeeds.needs.length).toBe(survey.priorityNeeds.needs.length);
  });

  it("the same methodology version stamps all three", async () => {
    const survey = (await individualSurveyGenerator({ ...ctx(), surveyId: "survey-1" }))
      .content as unknown as IndividualSurveyReportContent;
    const tp = await topPriority();
    const dq = await dataQuality();
    expect(tp.header.methodologyVersion).toBe(survey.header.methodologyVersion);
    expect(dq.header.methodologyVersion).toBe(survey.header.methodologyVersion);
  });
});

describe("export rendering (AC 2, AC 7)", () => {
  // Both new types must render as STRUCTURED documents, not the flat key-value
  // fallback. That fallback is what silently dropped whole sections from RPT17's
  // export, and it fails AC 7 without failing loudly.
  it("Top-Priority renders its own sections, not the generic flatten", async () => {
    const c = await topPriority();
    const doc = buildReportDoc("Top-Priority", c as unknown as Record<string, unknown>, []);
    const headings = doc.sections.map((s) => ("heading" in s ? s.heading : "")).filter(Boolean);
    expect(headings).toContain("Priority Tier Summary");
    expect(headings).toContain("Domain Rollup");
    // "Summary" is the flatten fallback's heading — its presence means the
    // isCore predicate rejected this shape.
    expect(headings).not.toContain("Summary");
  });

  // The client's Top-Priority specification, asserted against the RENDERED
  // table rather than the payload: "the highest-priority needs ... with domain,
  // sub-domain, location, priority score, severity, affected population, and
  // ranking". Every one of those is a column a reader can point at.
  //
  // Payload-level assertions are what let the calculation basis sit unrendered
  // for a whole sprint — the field was truthy and nobody ever saw it. These read
  // the doc.
  it("carries every column the client specified, by the client's name for it", async () => {
    const c = await topPriority();
    const doc = buildReportDoc("Top-Priority", c as unknown as Record<string, unknown>, []);
    const table = doc.sections.find(
      (s) => s.kind === "table" && s.heading === "Priority Needs",
    ) as { kind: "table"; columns: string[]; rows: string[][] } | undefined;
    expect(table).toBeDefined();

    for (const col of ["#", "Domain", "Sub-domain", "Location", "Priority Score", "Severity", "Affected Pop."]) {
      expect(table!.columns).toContain(col);
    }
    // "Relevance" was the old heading for the priority score. The report must
    // not use a word the specification does not, especially while a DIFFERENT
    // figure on the same page is labelled "Priority Score".
    expect(table!.columns).not.toContain("Relevance");
    expect(table!.rows.length).toBe(c.priorityNeeds.needs.length);
  });

  it("prints the ranking formula beneath the ranking", async () => {
    const c = await topPriority();
    const doc = buildReportDoc("Top-Priority", c as unknown as Record<string, unknown>, []);
    const note = doc.sections.find(
      (s) => "heading" in s && s.heading === "Priority Needs — How this ranking was produced",
    ) as { kind: "note"; text: string } | undefined;
    expect(note).toBeDefined();
    // Not a paraphrase — the basis the ranker actually used.
    expect(note!.text).toContain(c.priorityNeeds.rankingBasis);
  });

  it("says why Affected Pop. is empty instead of leaving a silent blank column", async () => {
    // A Need recorded before the need-entry question existed: the estimate can
    // never be reconstructed for it, so the column stays empty forever.
    const c = await topPriority(null);
    const doc = buildReportDoc("Top-Priority", c as unknown as Record<string, unknown>, []);
    const table = doc.sections.find(
      (s) => s.kind === "table" && s.heading === "Priority Needs",
    ) as { kind: "table"; columns: string[]; rows: string[][] };
    const col = table.columns.indexOf("Affected Pop.");
    // Every cell is a dash — and NEVER the study-area population, which would
    // read as "this need affects all of them".
    expect(table.rows.every((r) => r[col] === "—")).toBe(true);

    const note = doc.sections.find(
      (s) => "heading" in s && s.heading === "Priority Needs — Reading these columns",
    ) as { kind: "note"; text: string } | undefined;
    expect(note).toBeDefined();
    expect(note!.text).toContain("was not recorded");
    // And it must say what the population figure elsewhere on the page IS, or a
    // reader will assume the report simply forgot to use it.
    expect(note!.text).toContain("study AREA's population");
  });

  // Option A, client-confirmed 24 Aug 2026: the need-entry form now asks
  // "roughly how many people does this need affect?", and THAT answer — not the
  // study-area population — is what the column prints.
  it("prints the recorded estimate once the need carries one", async () => {
    const c = await topPriority(12_000);
    const doc = buildReportDoc("Top-Priority", c as unknown as Record<string, unknown>, []);
    const table = doc.sections.find(
      (s) => s.kind === "table" && s.heading === "Priority Needs",
    ) as { kind: "table"; columns: string[]; rows: string[][] };
    const col = table.columns.indexOf("Affected Pop.");
    expect(table.rows.length).toBeGreaterThan(0);
    expect(table.rows.every((r) => r[col] === "12,000")).toBe(true);
  });

  // The figure describes the source need, so it necessarily repeats down the
  // indicator rows. Saying so is the whole reason the column is safe to print:
  // a repeated number with no explanation is exactly the failure we refused to
  // ship when the only candidate was the study-area population.
  it("states that the estimate is the need's reach, not each indicator's", async () => {
    const c = await topPriority(12_000);
    const doc = buildReportDoc("Top-Priority", c as unknown as Record<string, unknown>, []);
    const note = doc.sections.find(
      (s) => "heading" in s && s.heading === "Priority Needs — Reading these columns",
    ) as { kind: "note"; text: string } | undefined;
    expect(note).toBeDefined();
    expect(note!.text).toContain("describes the need as a whole");
    expect(note!.text).toContain("A dash means no estimate was given, not zero people.");
    // The "nothing was recorded" wording must NOT also fire — the two notes
    // contradict each other, and shipping both is how a reader stops believing
    // either.
    expect(note!.text).not.toContain("was not recorded");
  });

  // Two different numbers running in OPPOSITE directions must not share a name
  // on one page: the per-need Priority Score (severity × weight, higher = more
  // urgent) and the village-level score (performance-based, lower = more
  // urgent). Adopting the client's vocabulary for the column is only an
  // improvement if the other figure stops answering to the same name.
  it("never labels two different scores 'Priority Score' on the same page", async () => {
    const c = await topPriority();
    const doc = buildReportDoc("Top-Priority", c as unknown as Record<string, unknown>, []);

    const vp = doc.sections.find(
      (s) => s.kind === "keyvalue" && s.heading === "Village Priority",
    ) as { kind: "keyvalue"; rows: Array<{ label: string; value: string }> };
    expect(vp.rows.map((r) => r.label)).toContain("Village Priority Score");
    expect(vp.rows.map((r) => r.label)).not.toContain("Priority Score");

    const basis = doc.sections.find(
      (s) => s.kind === "keyvalue" && s.heading === "Calculation Basis",
    ) as { kind: "keyvalue"; rows: Array<{ label: string; value: string }> };
    expect(basis.rows.map((r) => r.label)).toContain("Village Priority Score");
    expect(basis.rows.map((r) => r.label)).not.toContain("Priority Score");

    // …and no value re-states its own label as a heading ("Needs Index = Needs
    // Index = mean of …"), which is what printing a self-naming formula beside a
    // label of the same name produced. Prose that merely begins with the same
    // word ("Confidence is LOW when …") is fine — it is the `label =` / `label:`
    // restatement that is the defect.
    for (const row of basis.rows) {
      expect(row.value).not.toMatch(/^[A-Za-z ()]{3,40}\s*[=:]\s/);
    }
  });

  it("prints the village score at the same precision as its own working line", async () => {
    const c = await topPriority();
    const doc = buildReportDoc("Top-Priority", c as unknown as Record<string, unknown>, []);
    const vp = doc.sections.find(
      (s) => s.kind === "keyvalue" && s.heading === "Village Priority",
    ) as { kind: "keyvalue"; rows: Array<{ label: string; value: string }> };
    const shown = vp.rows.find((r) => r.label === "Village Priority Score")!.value;
    const score = c.priorityNeeds.villagePriority.priorityScore;
    if (typeof score === "number") {
      expect(shown).toBe(score.toFixed(2));
      // The working line ends with the same figure; a reader comparing the two
      // must not find 37 in one place and 37.45 in the other.
      const working = c.calculationBasis.priorityScoreWorking.at(-1) ?? "";
      expect(working).toContain(score.toFixed(2));
    }
  });

  it("renders the calculation basis on the page, not just in the payload", async () => {
    const c = await topPriority();
    const doc = buildReportDoc("Top-Priority", c as unknown as Record<string, unknown>, []);
    const headings = doc.sections.map((s) => ("heading" in s ? s.heading : "")).filter(Boolean);
    expect(headings).toContain("Calculation Basis");
    expect(headings).toContain("Calculation Basis — Thresholds Applied");

    // The working lines are the part a reader recomputes against, so they must
    // reach the page verbatim.
    const working = doc.sections.find(
      (s) => "heading" in s && s.heading === "Calculation Basis — Village Priority Score working",
    ) as { kind: "list"; items: string[] } | undefined;
    expect(working).toBeDefined();
    expect(working!.items).toEqual(c.calculationBasis.priorityScoreWorking);
  });

  it("Data-Quality renders its own sections, not the generic flatten", async () => {
    const c = await dataQuality();
    const doc = buildReportDoc("Data-Quality", c as unknown as Record<string, unknown>, []);
    const headings = doc.sections.map((s) => ("heading" in s ? s.heading : "")).filter(Boolean);
    expect(headings).toContain("Completeness & Confidence");
    expect(headings).toContain("Confidence by Domain");
    expect(headings).toContain("Flagged Records");
    expect(headings).not.toContain("Summary");
  });

  it("every flagged record survives the flatten into the Excel path (AC 2)", async () => {
    const c = await dataQuality();
    const flat = flattenReportContent(c as unknown as Record<string, unknown>);
    const table = flat.tables.find((t) => t.name === "flaggedRecords");
    if (c.flaggedRecords.length > 0) {
      expect(table).toBeDefined();
      // Row-count parity between the content and what the spreadsheet receives —
      // a truncated table is an AC 7 failure that reads as a clean export.
      expect(table!.rows.length).toBe(c.flaggedRecords.length);
    }
  });
});
