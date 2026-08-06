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
import { COMBINED_REPORT_SUMMARY_TASK } from "../ai/prompts/combined-report-summary.task";

export interface CombinedReportOutputJson {
  header: {
    studyName: string;
    entityName: string;
    methodologyVersion: string;
    cycleNumber: number;
    generatedAt: string;
  };
  geography: {
    region: string;
    governorate: string;
  };
  executiveSummary: string;
  scoreBasedFindings: {
    overallSeverityScore: number;
    priorityScore: number;
    priorityStatus: string;
    topDomainsOrKpis: { name: string; score: number }[];
    confidenceDataQualityNote: string;
  };
  documentBasedEvidence: {
    documentTitle: string;
    sourceReferenceId: string;
    documentType: string;
    linkedNeedOrDomain: string;
    keyEvidenceFinding: string;
    sourcePageOrSection?: string;
  }[];
  domainKpiResults: {
    domainName: string;
    severity: number;
    performance: number;
    weight: number;
    confidence: string;
    typeLabel: "SCORING_OUTPUT";
  }[];
  responseQuality: {
    validResponseCount: number;
    confidenceLevel: string;
    dontKnowRate: number;
    lowConfidenceReason?: string;
  };
  recommendations: {
    intervention: string;
    priority: string;
    statusLabel: "DRAFT_UNTIL_CONFIRMATION";
  }[];
  auditMetadata: {
    scoreSummaryId: string;
    includedDocumentSummaryIds: string[];
    aiModel: string;
    promptVersion: string;
    generatedTimestamp: string;
  };
}

@Injectable()
export class CombinedReportSummaryService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly ai: AiService,
    private readonly audit: AuditService,
  ) {}

  async getCombinedReportContext(studyId: string) {
    const orgId = requireOrgId();

    const study = await this.tenant.runInOrgContext((tx) =>
      tx.study.findFirst({
        where: { id: studyId, orgId },
        include: {
          org: true,
          methodologyVersion: true,
          studyGovernorates: { include: { governorate: true } },
          evidenceDocuments: {
            where: { studyId },
            include: {
              summaries: {
                orderBy: { createdAt: "desc" },
                take: 1,
              },
            },
          },
          // All score summaries for the study, newest first. The combined
          // report lets the officer choose which one to combine, so the whole
          // list is returned rather than just the most recent.
          aiPrioritySummaries: {
            orderBy: { createdAt: "desc" },
          },
          combinedReportSummaries: {
            orderBy: { createdAt: "desc" },
            take: 1,
            include: {
              sources: {
                include: {
                  document: true,
                  documentSummary: true,
                },
              },
            },
          },
        },
      }),
    );

    if (!study) throw new NotFoundException(`Study with id ${studyId} not found.`);

    // The score summaries this study actually has, for the officer to pick from.
    // No placeholder is invented when the list is empty: a study with no
    // generated score summary must read as having none, not as having a
    // confident-looking baseline. Callers surface that as an empty state.
    const availableScoreSummaries = study.aiPrioritySummaries.map((summary) => ({
      id: summary.id,
      status: summary.status,
      summaryScope: summary.summaryScope,
      scopeFilters: summary.scopeFilters,
      reportDataSnapshotId: summary.reportDataSnapshotId,
      promptVersion: summary.promptVersion,
      modelName: summary.modelName,
      aiOutputJson: summary.aiOutputJson,
      officerEditedOutputJson: summary.officerEditedOutputJson,
      generatedAt: summary.generatedAt,
      officerConfirmedAt: summary.officerConfirmedAt,
    }));

    // Retained for callers that just want the most recent one; null when the
    // study has none.
    const confirmedScoreSummary = availableScoreSummaries[0] ?? null;

    const confirmedDocumentSummaries = study.evidenceDocuments
      .filter((doc) => doc.summaries.length > 0)
      .map((doc) => ({
        documentId: doc.id,
        documentTitle: doc.title,
        sourceReferenceId: doc.sourceReferenceId,
        documentType: doc.documentType,
        linkedDomainId: doc.linkedDomainId || "N/A",
        linkedNeedId: doc.linkedNeedId || "N/A",
        confirmedSummary: doc.summaries[0],
      }));

    const latestCombinedSummary = study.combinedReportSummaries[0] || null;

    return {
      study: {
        id: study.id,
        title: study.title,
        cycleNumber: study.cycleNumber,
        orgName: study.org.name,
        methodologyVersion: study.methodologyVersion?.version || "v1.0",
        region: study.org.region[0] || "National",
        governorate: study.studyGovernorates.map((g) => g.governorate.name).join(", ") || "All Governorates",
        documentCount: study.evidenceDocuments.length,
      },
      availableScoreSummaries,
      confirmedScoreSummary,
      confirmedDocumentSummaries,
      latestCombinedSummary,
    };
  }

  async generateCombinedSummary(
    studyId: string,
    documentSummaryIds: string[],
    scoreSummaryId?: string,
  ) {
    const orgId = requireOrgId();
    const generatedBy = requireActor();

    const context = await this.getCombinedReportContext(studyId);

    // The officer picks which score summary to combine. When no id is supplied
    // fall back to the most recent one, so existing callers keep working.
    const scoreSummary = scoreSummaryId
      ? (context.availableScoreSummaries ?? []).find((s) => s.id === scoreSummaryId)
      : context.confirmedScoreSummary;

    if (!scoreSummary) {
      throw new BadRequestException({
        error: {
          code: "SCORE_SUMMARY_NOT_FOUND",
          message: scoreSummaryId
            ? "The selected score summary does not belong to this study."
            : "Score summary not available for this study. Generate a score-based AI summary first.",
        },
      });
    }

    if (!documentSummaryIds || documentSummaryIds.length === 0) {
      throw new BadRequestException({
        error: {
          code: "NO_DOCUMENTS_SELECTED",
          message: "Select at least one Document Summary to generate a Combined Summary.",
        },
      });
    }

    const selectedDocSummaries = context.confirmedDocumentSummaries.filter(
      (d) => d.confirmedSummary && documentSummaryIds.includes(d.confirmedSummary.id),
    );

    const scoreSummaryOutput = (scoreSummary?.officerEditedOutputJson ||
      scoreSummary?.aiOutputJson) as any;

    const inputDataToHash = JSON.stringify({
      scoreSummaryId: scoreSummary.id,
      scoreOutput: scoreSummaryOutput,
      documentSummaries: selectedDocSummaries.map((d) => ({
        id: d.confirmedSummary!.id,
        json: d.confirmedSummary!.officerEditedOutputJson || d.confirmedSummary!.aiOutputJson,
      })),
    });

    const inputHash = crypto.createHash("sha256").update(inputDataToHash).digest("hex");
    // Prompt, schema and model settings all come from the declared task, so the
    // recorded promptVersion always matches the prompt that ran.
    const { promptVersion, model: modelName, modelVersion } = COMBINED_REPORT_SUMMARY_TASK;

    const docSummariesFormatted = selectedDocSummaries.map((s) => ({
      title: s.documentTitle,
      type: s.documentType,
      refId: s.sourceReferenceId,
      summary: s.confirmedSummary!.officerEditedOutputJson || s.confirmedSummary!.aiOutputJson,
    }));

    const prompt = `Study Context:
- Name: ${context.study.title}
- Organization: ${context.study.orgName}
- Methodology: ${context.study.methodologyVersion}
- Cycle: ${context.study.cycleNumber}
- Region: ${context.study.region}
- Governorate: ${context.study.governorate}

Score-Based Summary Inputs:
${JSON.stringify(scoreSummaryOutput, null, 2)}

Selected Confirmed Document Summaries (${selectedDocSummaries.length}):
${JSON.stringify(docSummariesFormatted, null, 2)}

Generate JSON conforming to:
{
  "header": {
    "studyName": "${context.study.title}",
    "entityName": "${context.study.orgName}",
    "methodologyVersion": "${context.study.methodologyVersion}",
    "cycleNumber": ${context.study.cycleNumber},
    "generatedAt": "${new Date().toISOString()}"
  },
  "geography": {
    "region": "${context.study.region}",
    "governorate": "${context.study.governorate}"
  },
  "executiveSummary": "Unified executive overview",
  "scoreBasedFindings": {
    "overallSeverityScore": ${scoreSummaryOutput?.overallSeverityScore || 4.2},
    "priorityScore": ${scoreSummaryOutput?.priorityScore || 78.5},
    "priorityStatus": "${scoreSummaryOutput?.priorityStatus || "HIGH"}",
    "topDomainsOrKpis": [{"name": "Health", "score": 85}],
    "confidenceDataQualityNote": "High statistical confidence."
  },
  "documentBasedEvidence": [
    {
      "documentTitle": "${selectedDocSummaries[0]?.documentTitle || "Field Report"}",
      "sourceReferenceId": "${selectedDocSummaries[0]?.sourceReferenceId || "REF-001"}",
      "documentType": "${selectedDocSummaries[0]?.documentType || "Field Study"}",
      "linkedNeedOrDomain": "${selectedDocSummaries[0]?.linkedDomainId || "Health"}",
      "keyEvidenceFinding": "Field evidence confirms health facility shortages.",
      "sourcePageOrSection": "Section 1"
    }
  ],
  "domainKpiResults": [
    {
      "domainName": "Health",
      "severity": 4.2,
      "performance": 35.0,
      "weight": 0.35,
      "confidence": "HIGH",
      "typeLabel": "SCORING_OUTPUT"
    }
  ],
  "responseQuality": {
    "validResponseCount": 120,
    "confidenceLevel": "HIGH",
    "dontKnowRate": 0.04
  },
  "recommendations": [
    {
      "intervention": "Deploy urgent medical supplies.",
      "priority": "HIGH",
      "statusLabel": "DRAFT_UNTIL_CONFIRMATION"
    }
  ],
  "auditMetadata": {
    "scoreSummaryId": "${scoreSummary.id}",
    "includedDocumentSummaryIds": ${JSON.stringify(documentSummaryIds)},
    "aiModel": "${modelName}",
    "promptVersion": "${promptVersion}",
    "generatedTimestamp": "${new Date().toISOString()}"
  }
}`;

    // No fallback content. This used to catch every AI failure and substitute a
    // hand-written report — invented severity/priority figures, invented domain
    // results, invented recommendations — then store it as a DRAFT carrying a
    // real model name. A rate-limit produced a plausible-looking report built
    // from numbers nobody measured. Failures now propagate to the officer.
    const { response: aiOutputJson } = await this.ai.run(COMBINED_REPORT_SUMMARY_TASK, prompt);

    const created = await this.tenant.runInOrgContext(async (tx) => {
      const summary = await tx.combinedReportSummary.create({
        data: {
          studyId,
          orgId,
          reportDataSnapshotId: scoreSummary.reportDataSnapshotId,
          scoreSummaryId: scoreSummary.id,
          status: "DRAFT",
          promptVersion,
          modelName,
          modelVersion,
          inputHash,
          aiOutputJson: aiOutputJson as any,
          generatedBy,
        },
      });

      await tx.combinedReportEvidenceSource.createMany({
        data: selectedDocSummaries.map((s) => ({
          combinedReportSummaryId: summary.id,
          documentId: s.documentId,
          documentSummaryId: s.confirmedSummary!.id,
          includedBy: generatedBy,
        })),
      });

      return summary;
    });

    await this.audit.record({
      action: "generate_combined_summary",
      entityType: "combined_report_summary",
      entityId: created.id,
      entityLabel: `Combined Summary for ${context.study.title}`,
    });

    return created;
  }

  async updateDraftCombinedSummary(summaryId: string, editedOutputJson: CombinedReportOutputJson) {
    const orgId = requireOrgId();
    const summary = await this.tenant.runInOrgContext((tx) =>
      tx.combinedReportSummary.findFirst({ where: { id: summaryId, orgId } }),
    );
    if (!summary) throw new NotFoundException(`Combined summary ${summaryId} not found.`);

    return this.tenant.runInOrgContext((tx) =>
      tx.combinedReportSummary.update({
        where: { id: summaryId },
        data: {
          officerEditedOutputJson: editedOutputJson as any,
          status: "DRAFT",
        },
      }),
    );
  }

  async confirmCombinedSummary(summaryId: string) {
    const orgId = requireOrgId();
    const confirmedBy = requireActor();

    const summary = await this.tenant.runInOrgContext((tx) =>
      tx.combinedReportSummary.findFirst({ where: { id: summaryId, orgId } }),
    );
    if (!summary) throw new NotFoundException(`Combined summary ${summaryId} not found.`);

    // Supersede older confirmed combined summaries
    await this.tenant.runInOrgContext((tx) =>
      tx.combinedReportSummary.updateMany({
        where: {
          studyId: summary.studyId,
          id: { not: summaryId },
          status: "OFFICER_CONFIRMED",
        },
        data: { status: "SUPERSEDED" },
      }),
    );

    const updated = await this.tenant.runInOrgContext((tx) =>
      tx.combinedReportSummary.update({
        where: { id: summaryId },
        data: {
          status: "OFFICER_CONFIRMED",
          confirmedBy,
          confirmedAt: new Date(),
        },
      }),
    );

    await this.audit.record({
      action: "confirm_combined_summary",
      entityType: "combined_report_summary",
      entityId: summaryId,
      entityLabel: `Confirmed Combined Summary ${summaryId}`,
    });

    return updated;
  }
}
