import { describe, expect, it, beforeEach, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { orgContext } from "../../tenancy/org-context";
import { CombinedReportSummaryService } from "./combined-report-summary.service";

describe("CombinedReportSummaryService", () => {
  let service: CombinedReportSummaryService;
  let mockTenant: any;
  let mockAi: any;
  let mockAudit: any;
  let mockReportSummary: any;

  beforeEach(() => {
    mockTenant = {
      runInOrgContext: vi.fn((fn) => fn(mockTenant)),
      study: {
        findFirst: vi.fn(),
      },
      combinedReportSummary: {
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        findFirst: vi.fn(),
      },
      combinedReportEvidenceSource: {
        createMany: vi.fn(),
      },
    };

    mockAi = {
      resolveModelName: vi.fn(() => "cohere.command-a-03-2025"),
      run: vi.fn().mockResolvedValue({
        response: {
          header: { studyName: "Test Study", entityName: "Org", methodologyVersion: "v1.0", cycleNumber: 1, generatedAt: new Date().toISOString() },
          geography: { region: "Region A", governorate: "Gov A" },
          executiveSummary: "Combined executive summary.",
          scoreBasedFindings: { overallSeverityScore: 4.2, priorityScore: 78.5, priorityStatus: "HIGH", topDomainsOrKpis: [], confidenceDataQualityNote: "High" },
          documentBasedEvidence: [{ documentTitle: "Doc 1", sourceReferenceId: "REF-1", documentType: "Report", linkedNeedOrDomain: "Health", keyEvidenceFinding: "Finding" }],
          domainKpiResults: [{ domainName: "Health", severity: 4.2, performance: 35, weight: 0.35, confidence: "HIGH", typeLabel: "SCORING_OUTPUT" }],
          responseQuality: { validResponseCount: 100, confidenceLevel: "HIGH", dontKnowRate: 0.02 },
          recommendations: [{ intervention: "Intervention", priority: "HIGH", statusLabel: "DRAFT_UNTIL_CONFIRMATION" }],
          auditMetadata: { scoreSummaryId: "score-1", includedDocumentSummaryIds: ["doc-sum-1"], aiModel: "gemini-2.5-flash", promptVersion: "v1", generatedTimestamp: new Date().toISOString() },
        },
      }),
    };

    mockAudit = {
      record: vi.fn().mockResolvedValue(undefined),
    };

    // The scoring engine's figures for the score summary's scope.
    mockReportSummary = {
      buildReportDataSnapshot: vi.fn().mockResolvedValue({
        snapshot: {
          snapshotId: "snap-now",
          responseQuality: { validResponseCount: 6, confidenceLevel: "LOW", dontKnowRate: 4.76 },
          severity: {
            overallVillageNeedsIndex: 35.24,
            domainSeverityScores: [{ domainKey: "health", confidenceLevel: "LOW" }],
            topKpis: [{ kpiName: "HLT-03", severityScore: 76.14 }],
          },
          priority: {
            villagePriorityScore: 22,
            priorityStatus: "LOW",
            domainPerformanceScores: [
              { domainKey: "health", domainName: "Health", severityScore: 35.24, performanceScore: 64.76, weight: 1 },
            ],
          },
        },
      }),
    };

    service = new CombinedReportSummaryService(mockTenant, mockAi, mockAudit, mockReportSummary);
  });

  function withContext<T>(fn: () => Promise<T>): Promise<T> {
    return orgContext.run(
      { requestId: "test-req", orgId: "org-1", actorId: "actor-1", role: "ngo_research_officer" },
      fn,
    );
  }

  it("offers only documents switched into the combined report (UAT PRI-03)", async () => {
    const doc = (id: string, included: boolean) => ({
      id,
      title: id,
      sourceReferenceId: null,
      documentType: "report",
      linkedDomainId: null,
      linkedNeedId: null,
      isIncludedInCombinedReport: included,
      summaries: [{ id: `sum-${id}` }],
    });
    mockTenant.study.findFirst.mockResolvedValue({
      id: "s1",
      title: "Study",
      cycleNumber: 1,
      org: { name: "Org", region: [] },
      methodologyVersion: null,
      studyGovernorates: [],
      evidenceDocuments: [doc("kept", true), doc("excluded", false)],
      aiPrioritySummaries: [],
      combinedReportSummaries: [],
    });
    const ctx = await withContext(() => service.getCombinedReportContext("s1", { localize: false }));
    expect(ctx.confirmedDocumentSummaries.map((d) => d.documentId)).toEqual(["kept"]);
  });

  describe("generateCombinedSummary prerequisites", () => {
    const scoreSummary = {
      id: "score-1",
      status: "OFFICER_CONFIRMED",
      surveyId: "survey-1",
      summaryScope: "VILLAGE",
      reportDataSnapshotId: "snap-1",
      aiOutputJson: {},
      generatedAt: new Date(),
    } as any;

    it("should throw if Score-Based Summary is not confirmed", async () => {
      vi.spyOn(service, "getCombinedReportContext").mockResolvedValueOnce({
        study: { id: "s1", title: "Study", cycleNumber: 1, orgName: "Org", methodologyVersion: "v1.0", region: "R", governorate: "G", documentCount: 1 },
        availableScoreSummaries: [],
        confirmedScoreSummary: null,
        confirmedDocumentSummaries: [],
        latestCombinedSummary: null,
      } as any);

      await expect(
        withContext(() => service.generateCombinedSummary("s1", ["doc-sum-1"])),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw if no Document Summaries are selected", async () => {
      vi.spyOn(service, "getCombinedReportContext").mockResolvedValueOnce({
        study: { id: "s1", title: "Study", cycleNumber: 1, orgName: "Org", methodologyVersion: "v1.0", region: "R", governorate: "G", documentCount: 1 },
        availableScoreSummaries: [scoreSummary],
        confirmedScoreSummary: scoreSummary,
        confirmedDocumentSummaries: [],
        latestCombinedSummary: null,
      } as any);

      await expect(
        withContext(() => service.generateCombinedSummary("s1", [])),
      ).rejects.toThrow(BadRequestException);
    });

    // This used to catch every AI failure and store a hand-written report with
    // invented severity/priority figures, indistinguishable from a real one.
    it("should surface an AI failure instead of storing fabricated content", async () => {
      vi.spyOn(service, "getCombinedReportContext").mockResolvedValueOnce({
        study: { id: "s1", title: "Study", cycleNumber: 1, orgName: "Org", methodologyVersion: "v1.0", region: "R", governorate: "G", documentCount: 1 },
        availableScoreSummaries: [scoreSummary],
        confirmedScoreSummary: scoreSummary,
        confirmedDocumentSummaries: [
          {
            documentId: "doc-1",
            documentTitle: "Field Report",
            sourceReferenceId: "REF-1",
            documentType: "Report",
            linkedDomainId: "health",
            linkedNeedId: "need-1",
            confirmedSummary: { id: "doc-sum-1", status: "OFFICER_CONFIRMED", aiOutputJson: {} },
          },
        ],
        latestCombinedSummary: null,
      } as any);

      mockAi.run.mockRejectedValueOnce(new Error("simulated AI outage"));

      await expect(
        withContext(() => service.generateCombinedSummary("s1", ["doc-sum-1"], "score-1")),
      ).rejects.toThrow("simulated AI outage");

      // Nothing may be persisted from a failed generation.
      expect(mockTenant.combinedReportSummary.create).not.toHaveBeenCalled();
    });

    // UAT PRI-03 — the AI returned a different priority score on every run.
    it("takes every figure from the scoring engine and keeps only included documents as sources", async () => {
      vi.spyOn(service, "getCombinedReportContext").mockResolvedValueOnce({
        study: { id: "s1", title: "Study", cycleNumber: 1, orgName: "Org", methodologyVersion: "v1.0", region: "R", governorate: "G", documentCount: 1 },
        availableScoreSummaries: [scoreSummary],
        confirmedScoreSummary: scoreSummary,
        confirmedDocumentSummaries: [
          { documentId: "doc-1", documentTitle: "Field Report", sourceReferenceId: "REF-1", documentType: "FIELD_REPORT", confirmedSummary: { id: "doc-sum-1", aiOutputJson: {} } },
        ],
        latestCombinedSummary: null,
      } as any);
      mockTenant.combinedReportSummary.create.mockImplementation(({ data }: any) => data);
      mockAi.run.mockResolvedValueOnce({
        response: {
          scoreBasedFindings: { priorityScore: 76.14, priorityStatus: "HIGH", overallSeverityScore: 4.2 },
          documentBasedEvidence: [
            { documentTitle: "تقرير ميداني", sourceKey: "DOC-1", sourceReferenceId: "", keyEvidenceFinding: "Kept" },
            { documentTitle: "Some other report", sourceReferenceId: "REF-001", keyEvidenceFinding: "Dropped" },
          ],
          recommendations: [{ intervention: "Do it", priority: "عالية" }],
          auditMetadata: { includedDocumentSummaryIds: ["doc-summary-id-1", "doc-summary-id-2"] },
        },
      });

      const created: any = await withContext(() => service.generateCombinedSummary("s1", ["doc-sum-1", "excluded-sum"]));
      const out = created.aiOutputJson;
      expect(out.scoreBasedFindings).toMatchObject({ priorityScore: 22, priorityStatus: "LOW", overallSeverityScore: 35.24 });
      expect(out.responseQuality).toMatchObject({ validResponseCount: 6, dontKnowRate: 4.76 });
      expect(out.documentBasedEvidence).toEqual([
        expect.objectContaining({ documentTitle: "Field Report", sourceReferenceId: "REF-1", keyEvidenceFinding: "Kept" }),
      ]);
      expect(out.recommendations[0].priority).toBe("HIGH");
      expect(out.auditMetadata.includedDocumentSummaryIds).toEqual(["doc-sum-1"]);
    });

    it("refuses a draft score summary and a selection with no included document", async () => {
      const ctx = (summary: any, docs: any[]) =>
        ({
          study: { id: "s1", title: "Study", cycleNumber: 1, orgName: "Org", methodologyVersion: "v1.0", region: "R", governorate: "G", documentCount: 1 },
          availableScoreSummaries: [summary],
          confirmedScoreSummary: summary,
          confirmedDocumentSummaries: docs,
          latestCombinedSummary: null,
        }) as any;
      vi.spyOn(service, "getCombinedReportContext").mockResolvedValueOnce(ctx({ ...scoreSummary, status: "DRAFT" }, []));
      await expect(withContext(() => service.generateCombinedSummary("s1", ["doc-sum-1"]))).rejects.toMatchObject({
        response: { error: { code: "SCORE_SUMMARY_NOT_CONFIRMED" } },
      });
      vi.spyOn(service, "getCombinedReportContext").mockResolvedValueOnce(ctx(scoreSummary, []));
      await expect(withContext(() => service.generateCombinedSummary("s1", ["switched-off-sum"]))).rejects.toMatchObject({
        response: { error: { code: "NO_DOCUMENTS_SELECTED" } },
      });
      expect(mockAi.run).not.toHaveBeenCalled();
    });

    it("should throw if the chosen score summary does not belong to the study", async () => {
      vi.spyOn(service, "getCombinedReportContext").mockResolvedValueOnce({
        study: { id: "s1", title: "Study", cycleNumber: 1, orgName: "Org", methodologyVersion: "v1.0", region: "R", governorate: "G", documentCount: 1 },
        availableScoreSummaries: [scoreSummary],
        confirmedScoreSummary: scoreSummary,
        confirmedDocumentSummaries: [],
        latestCombinedSummary: null,
      } as any);

      await expect(
        withContext(() =>
          service.generateCombinedSummary("s1", ["doc-sum-1"], "score-from-another-study"),
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
