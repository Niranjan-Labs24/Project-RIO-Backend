import { describe, expect, it, beforeEach, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { orgContext } from "../../tenancy/org-context";
import { CombinedReportSummaryService } from "./combined-report-summary.service";

describe("CombinedReportSummaryService", () => {
  let service: CombinedReportSummaryService;
  let mockTenant: any;
  let mockAi: any;
  let mockAudit: any;

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

    service = new CombinedReportSummaryService(mockTenant, mockAi, mockAudit);
  });

  function withContext<T>(fn: () => Promise<T>): Promise<T> {
    return orgContext.run(
      { requestId: "test-req", orgId: "org-1", actorId: "actor-1", role: "ngo_research_officer" },
      fn,
    );
  }

  describe("generateCombinedSummary prerequisites", () => {
    const scoreSummary = {
      id: "score-1",
      status: "OFFICER_CONFIRMED",
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
