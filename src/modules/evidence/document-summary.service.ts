import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import crypto from "crypto";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { requireActor, requireOrgId } from "../../tenancy/org-context";
import { AuditService } from "../audit/audit.service";
import { AiService } from "../ai/ai.service";
import { EVIDENCE_DOCUMENT_SUMMARY_TASK } from "../ai/prompts/evidence-document-summary.task";
import { Prisma } from "../../generated/prisma";

export interface DocumentSummaryOutputJson {
  documentTitle: string;
  documentType: string;
  sourceReferenceId: string;
  collectionDate: string;
  linkedNeed: string;
  linkedDomain: string;
  linkedKpi: string;

  summary: string;

  keyFindings: {
    finding: string;
    sourceReferenceId: string;
    pageOrSection: string;
  }[];

  themes: {
    theme: string;
    description: string;
    sourceReferenceId: string;
    pageOrSection: string;
  }[];

  supportingStatements: {
    statement: string;
    sourceReferenceId: string;
    pageOrSection: string;
  }[];

  risksOrConcerns: {
    concern: string;
    sourceReferenceId: string;
    pageOrSection: string;
  }[];

  documentLimitations: string[];

  evidenceNote: string;
}

@Injectable()
export class DocumentSummaryService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly ai: AiService,
    private readonly audit: AuditService,
  ) {}

  async generateDocumentSummary(documentId: string) {
    const orgId = requireOrgId();
    const generatedBy = requireActor();

    const doc = await this.tenant.runInOrgContext((tx) =>
      tx.evidenceDocument.findFirst({
        where: { id: documentId, orgId },
        include: {
          chunks: { orderBy: { chunkIndex: "asc" } },
          need: true,
          study: true,
        },
      }),
    );

    if (!doc) {
      throw new NotFoundException(`Evidence document with id ${documentId} not found.`);
    }

    if (doc.parsingStatus !== "PARSED" || (!doc.extractedText && doc.chunks.length === 0)) {
      throw new BadRequestException(
        "Document parsing must be PARSED before generating an AI summary.",
      );
    }

    const textToSummarize =
      doc.extractedText || doc.chunks.map((c) => c.chunkText).join("\n\n");
    const inputTextHash = crypto
      .createHash("sha256")
      .update(textToSummarize)
      .digest("hex");

    // Prompt text, model settings and version all come from the declared task,
    // so the recorded promptVersion can never name a prompt other than the one
    // that ran. promptHash pins the exact text.
    const { promptVersion, model: modelName, modelVersion } = EVIDENCE_DOCUMENT_SUMMARY_TASK;

    const chunkSummariesFormatted = doc.chunks
      .map((c) => `- [${c.sectionReference || `Chunk #${c.chunkIndex + 1}`}]: ${c.chunkText.substring(0, 500)}`)
      .join("\n");

    const prompt = `INPUT DOCUMENT DATA:

- Document title: ${doc.title}
- Document type: ${doc.documentType}
- Source/reference ID: ${doc.sourceReferenceId}
- Collection date: ${doc.collectedDate ? new Date(doc.collectedDate).toISOString().substring(0, 10) : "Data not available in this document."}
- Linked Need: ${doc.need?.title || "Data not available in this document."}
- Linked Domain: ${doc.linkedDomainId || "Data not available in this document."}
- Linked KPI: ${doc.linkedKpiId || "Data not available in this document."}

EXTRACTED DOCUMENT TEXT:
${textToSummarize.substring(0, 30000)}

CHUNK SUMMARIES & SECTION REFERENCES:
${chunkSummariesFormatted || "Data not available in this document."}

Output strictly valid JSON matching this schema:
{
  "documentTitle": "${doc.title}",
  "documentType": "${doc.documentType}",
  "sourceReferenceId": "${doc.sourceReferenceId}",
  "collectionDate": "${doc.collectedDate ? new Date(doc.collectedDate).toISOString().substring(0, 10) : "Data not available in this document."}",
  "linkedNeed": "${doc.need?.title || "Data not available in this document."}",
  "linkedDomain": "${doc.linkedDomainId || "Data not available in this document."}",
  "linkedKpi": "${doc.linkedKpiId || "Data not available in this document."}",

  "summary": "Concise executive qualitative summary",

  "keyFindings": [
    {
      "finding": "Clear non-repetitive finding",
      "sourceReferenceId": "${doc.sourceReferenceId}",
      "pageOrSection": "Section 1"
    }
  ],

  "themes": [
    {
      "theme": "Theme name",
      "description": "Description",
      "sourceReferenceId": "${doc.sourceReferenceId}",
      "pageOrSection": "Section 1"
    }
  ],

  "supportingStatements": [
    {
      "statement": "The document indicates...",
      "sourceReferenceId": "${doc.sourceReferenceId}",
      "pageOrSection": "Section 1"
    }
  ],

  "risksOrConcerns": [
    {
      "concern": "Concern noted in document",
      "sourceReferenceId": "${doc.sourceReferenceId}",
      "pageOrSection": "Section 1"
    }
  ],

  "documentLimitations": [
    "Not statistically representative"
  ],

  "evidenceNote": "This is qualitative document-based evidence. It supports report interpretation but does not calculate, change, or replace survey-based Severity or Priority Scores."
}`;

    // No fallback content. A failed AI call used to be swallowed here and
    // replaced with a hand-written "compliant" summary, which was then stored
    // with a real model name and prompt version — indistinguishable from a
    // genuine summary while containing invented findings. A failure now
    // propagates so the officer sees it and can retry.
    const { response: aiOutputJson } = await this.ai.run(
      EVIDENCE_DOCUMENT_SUMMARY_TASK,
      prompt,
    );

    const summaryRecord = await this.tenant.runInOrgContext((tx) =>
      tx.evidenceDocumentSummary.create({
        data: {
          documentId,
          studyId: doc.studyId,
          status: "DRAFT",
          promptVersion,
          modelName,
          modelVersion,
          inputTextHash,
          aiOutputJson: aiOutputJson as unknown as Prisma.InputJsonValue,
          generatedBy,
        },
      }),
    );

    await this.audit.record({
      action: "generate_document_summary",
      entityType: "evidence_document_summary",
      entityId: summaryRecord.id,
      entityLabel: doc.title,
    });

    return summaryRecord;
  }

  async updateDraftSummary(summaryId: string, editedOutputJson: DocumentSummaryOutputJson) {
    const orgId = requireOrgId();
    const summary = await this.tenant.runInOrgContext((tx) =>
      tx.evidenceDocumentSummary.findFirst({
        where: { id: summaryId, document: { orgId } },
      }),
    );
    if (!summary) throw new NotFoundException(`Document summary ${summaryId} not found.`);

    return this.tenant.runInOrgContext((tx) =>
      tx.evidenceDocumentSummary.update({
        where: { id: summaryId },
        data: {
          officerEditedOutputJson: editedOutputJson as unknown as Prisma.InputJsonValue,
          status: "DRAFT",
        },
      }),
    );
  }

  async confirmSummary(summaryId: string) {
    const orgId = requireOrgId();
    const confirmedBy = requireActor();

    const summary = await this.tenant.runInOrgContext((tx) =>
      tx.evidenceDocumentSummary.findFirst({
        where: { id: summaryId, document: { orgId } },
      }),
    );
    if (!summary) throw new NotFoundException(`Document summary ${summaryId} not found.`);

    // Supersede old confirmed summaries for this document
    await this.tenant.runInOrgContext((tx) =>
      tx.evidenceDocumentSummary.updateMany({
        where: {
          documentId: summary.documentId,
          id: { not: summaryId },
          status: "OFFICER_CONFIRMED",
        },
        data: { status: "SUPERSEDED" },
      }),
    );

    const updated = await this.tenant.runInOrgContext((tx) =>
      tx.evidenceDocumentSummary.update({
        where: { id: summaryId },
        data: {
          status: "OFFICER_CONFIRMED",
          confirmedBy,
          confirmedAt: new Date(),
        },
      }),
    );

    await this.audit.record({
      action: "confirm_document_summary",
      entityType: "evidence_document_summary",
      entityId: summaryId,
      entityLabel: `Confirmed Summary for Document ${summary.documentId}`,
    });

    return updated;
  }

  async markStaleForDocument(documentId: string) {
    return this.tenant.runInOrgContext((tx) =>
      tx.evidenceDocumentSummary.updateMany({
        where: { documentId, status: "OFFICER_CONFIRMED" },
        data: { status: "STALE" },
      }),
    );
  }
}
