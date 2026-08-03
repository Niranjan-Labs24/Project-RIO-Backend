import { describe, expect, it, beforeEach, vi } from "vitest";
import { orgContext } from "../../tenancy/org-context";
import { DocumentSummaryService } from "./document-summary.service";
import { EVIDENCE_DOCUMENT_SUMMARY_TASK } from "../ai/prompts/evidence-document-summary.task";

describe("DocumentSummaryService", () => {
  let service: DocumentSummaryService;
  let mockTenant: any;
  let mockAi: any;
  let mockAudit: any;

  const parsedDoc = {
    id: "doc-1",
    title: "Field Visit Report",
    documentType: "FIELD_REPORT",
    sourceReferenceId: "REF-1",
    collectedDate: new Date("2026-07-01"),
    parsingStatus: "PARSED",
    extractedText: "Borehole yield declined during the dry season.",
    chunks: [],
    need: { title: "Water access" },
    study: { id: "study-1" },
    linkedDomainId: "water",
    linkedKpiId: null,
  };

  beforeEach(() => {
    mockTenant = {
      runInOrgContext: vi.fn((fn) => fn(mockTenant)),
      evidenceDocument: { findFirst: vi.fn().mockResolvedValue(parsedDoc) },
      evidenceDocumentSummary: {
        create: vi.fn().mockResolvedValue({ id: "sum-1" }),
        findFirst: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      combinedReportSummary: { updateMany: vi.fn() },
    };
    mockAi = { run: vi.fn() };
    mockAudit = { record: vi.fn().mockResolvedValue(undefined) };
    service = new DocumentSummaryService(mockTenant, mockAi, mockAudit);
  });

  function withContext<T>(fn: () => Promise<T>): Promise<T> {
    return orgContext.run(
      { requestId: "test-req", orgId: "org-1", actorId: "actor-1", role: "ngo_research_officer" },
      fn,
    );
  }

  // The old implementation caught every AI failure and substituted a
  // hand-written summary ("The field note states operational observations
  // relevant to ..."), stored with a real model name and prompt version. A
  // rate-limit therefore produced invented evidence findings that looked
  // genuine to a reviewer.
  it("surfaces an AI failure instead of storing a fabricated summary", async () => {
    mockAi.run.mockRejectedValueOnce(new Error("simulated AI outage"));

    await expect(withContext(() => service.generateDocumentSummary("doc-1"))).rejects.toThrow(
      "simulated AI outage",
    );

    expect(mockTenant.evidenceDocumentSummary.create).not.toHaveBeenCalled();
  });

  it("records the model and prompt version actually used", async () => {
    mockAi.run.mockResolvedValueOnce({
      response: { summary: "Yield declined.", keyFindings: [] },
      raw: {},
    });

    await withContext(() => service.generateDocumentSummary("doc-1"));

    // The task passed to the AI layer must be the declared evidence task, not
    // an ad-hoc prompt assembled at the call site.
    expect(mockAi.run).toHaveBeenCalledWith(
      EVIDENCE_DOCUMENT_SUMMARY_TASK,
      expect.any(String),
    );

    const stored = mockTenant.evidenceDocumentSummary.create.mock.calls[0][0].data;
    expect(stored.promptVersion).toBe(EVIDENCE_DOCUMENT_SUMMARY_TASK.promptVersion);
    expect(stored.modelName).toBe(EVIDENCE_DOCUMENT_SUMMARY_TASK.model);
  });
});
