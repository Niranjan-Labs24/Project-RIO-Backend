import { toJson } from '../../common/prisma/json';
import { ROLE_KEYS } from '../../rbac/role-keys';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import crypto from "crypto";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { getOrgStore, requireActor, requireOrgId } from "../../tenancy/org-context";
import { AuditService } from "../audit/audit.service";
import { AiService } from "../ai/ai.service";
import { COMBINED_REPORT_SUMMARY_TASK } from "../ai/prompts/combined-report-summary.task";
import { withOutputLanguage } from "../ai/prompts/output-language";
import { requestLocale } from "../../common/locale/request-locale";
import { localizeSummaryOutput } from "../translation/summary-localization";
import { Prisma } from "../../generated/prisma";
import { ReportSummaryService, type ScopeFilters, type SummaryScopeType } from "./report-summary.service";
import { calculatedFigures, keepCalculatedFigures, withCalculatedFigures } from "./combined-report-figures";

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
  private readonly logger = new Logger(CombinedReportSummaryService.name);

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly ai: AiService,
    private readonly audit: AuditService,
    private readonly reportSummary: ReportSummaryService,
  ) {}

  async getCombinedReportContext(studyId: string, options: { localize?: boolean } = {}) {
    // RIO-RBAC-002 — System Admin/Reviewer/Center Supervisor reach this same
    // Combined Summary tab from a cross-org Study (Studies list, Priority
    // Dashboard, ...), same as StudiesService.list() already handles. A
    // plain org-scoped read here made every such view 404 with "Study with
    // id ... not found." even though the study genuinely exists — RLS was
    // silently filtering it out under the viewer's own (unrelated) org.
    // Read-only, so the SELECT-only supervisor client is safe.
    const store = getOrgStore();
    const isCrossOrgReader =
      store?.role === ROLE_KEYS.systemAdmin ||
      store?.role === ROLE_KEYS.systemReviewer ||
      store?.role === ROLE_KEYS.centerSupervisor;

    const include = {
      org: true,
      methodologyVersion: true,
      studyGovernorates: { include: { governorate: true } },
      evidenceDocuments: {
        where: { studyId },
        include: {
          // UAT PRI-03 — the latest CONFIRMED summary, never a draft: only a
          // confirmed document summary may feed the combined report.
          summaries: {
            where: { status: "OFFICER_CONFIRMED" as const },
            orderBy: { createdAt: "desc" as const },
            take: 1,
          },
        },
      },
      // All score summaries for the study, newest first. The combined
      // report lets the officer choose which one to combine, so the whole
      // list is returned rather than just the most recent.
      aiPrioritySummaries: {
        orderBy: { createdAt: "desc" as const },
      },
      combinedReportSummaries: {
        orderBy: { createdAt: "desc" as const },
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
    };

    const study = isCrossOrgReader
      ? await this.tenant.runAsSupervisor((tx) =>
          tx.study.findFirst({ where: { id: studyId }, include }),
        )
      : await this.tenant.runInOrgContext((tx) =>
          tx.study.findFirst({ where: { id: studyId, orgId: requireOrgId() }, include }),
        );

    if (!study) throw new NotFoundException(`Study with id ${studyId} not found.`);

    // The score summaries this study actually has, for the officer to pick from.
    // No placeholder is invented when the list is empty: a study with no
    // generated score summary must read as having none, not as having a
    // confident-looking baseline. Callers surface that as an empty state.
    const availableScoreSummaries = study.aiPrioritySummaries.map((summary) => ({
      id: summary.id,
      status: summary.status,
      surveyId: summary.surveyId,
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

    // Only documents the officer switched "Include in Combined Report" on for
    // (UAT PRI-03: the switch was saved but never read, so it did nothing).
    const confirmedDocumentSummaries = study.evidenceDocuments
      .filter((doc) => doc.isIncludedInCombinedReport && doc.summaries.length > 0)
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
    // Read-only display copy in the viewer's language (the row itself stays
    // as generated — its officerEditedOutputJson is what the review form edits).
    const latestCombinedLocalized =
      latestCombinedSummary && options.localize !== false
        ? await this.localizedCombinedOutput(latestCombinedSummary, !isCrossOrgReader)
        : null;

    const arabic = requestLocale() === "ar";
    return {
      study: {
        id: study.id,
        title: study.title,
        cycleNumber: study.cycleNumber,
        orgName: study.org.name,
        methodologyVersion: study.methodologyVersion?.version || "v5.0",
        // UAT GEN-04: governorates use their official Arabic name and the
        // fixed fallbacks are worded in the reader's language. The region is
        // the entity's own free-text value and stays as entered.
        region: study.org.region[0] || (arabic ? "على المستوى الوطني" : "National"),
        governorate:
          study.studyGovernorates
            .map((g) => (arabic ? (g.governorate.nameAr ?? g.governorate.name) : g.governorate.name))
            .join(arabic ? "، " : ", ") || (arabic ? "جميع المحافظات" : "All Governorates"),
        documentCount: study.evidenceDocuments.length,
      },
      availableScoreSummaries,
      confirmedScoreSummary,
      confirmedDocumentSummaries,
      latestCombinedSummary,
      latestCombinedLocalized,
    };
  }

  /**
   * A combined summary's output in the viewer's language, persisting the
   * translation on first use. `persist` is false for a cross-org reader, who
   * may read another organisation's summary but must never write to it.
   */
  private async localizedCombinedOutput(
    summary: {
      id: string;
      aiOutputJson: unknown;
      officerEditedOutputJson: unknown;
      outputLocale: string;
      localizedOutputs: unknown;
    },
    persist: boolean,
  ) {
    const result = await localizeSummaryOutput(this.ai, {
      source: (summary.officerEditedOutputJson ?? summary.aiOutputJson) as Record<string, unknown> | null,
      sourceLocale: summary.outputLocale === "ar" ? "ar" : "en",
      targetLocale: requestLocale(),
      stored: summary.localizedOutputs,
    });
    if (persist && result.toPersist) {
      const toPersist = result.toPersist;
      await this.tenant
        .runInOrgContext((tx) =>
          tx.combinedReportSummary.updateMany({
            where: { id: summary.id, orgId: requireOrgId() },
            data: { localizedOutputs: toPersist as Prisma.InputJsonValue },
          }),
        )
        .catch((error: unknown) =>
          this.logger.warn(`Could not cache localized summary output: ${String(error)}`),
        );
    }
    return { locale: result.locale, status: result.status, output: result.output };
  }

  async generateCombinedSummary(
    studyId: string,
    documentSummaryIds: string[],
    scoreSummaryId?: string,
  ) {
    const orgId = requireOrgId();
    const generatedBy = requireActor();

    // No display localization here: generation only reads the raw inputs.
    const context = await this.getCombinedReportContext(studyId, { localize: false });

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

    // UAT PRI-03 — the screen already requires a confirmed score summary; the
    // server now does too, so a draft one is never combined.
    if (scoreSummary.status !== "OFFICER_CONFIRMED") {
      throw new BadRequestException({
        error: {
          code: "SCORE_SUMMARY_NOT_CONFIRMED",
          message: "Confirm the Score-Based Summary before generating a Combined Summary.",
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

    // Only documents switched on for the combined report with a confirmed
    // summary are in this list, so anything else that was sent is ignored.
    const selectedDocSummaries = context.confirmedDocumentSummaries.filter(
      (d) => d.confirmedSummary && documentSummaryIds.includes(d.confirmedSummary.id),
    );
    if (selectedDocSummaries.length === 0) {
      throw new BadRequestException({
        error: {
          code: "NO_DOCUMENTS_SELECTED",
          message:
            "None of the selected documents is included in the combined report. Switch on \"Include in Combined Report\" for at least one document with a confirmed summary.",
        },
      });
    }

    const scoreSummaryOutput = (scoreSummary.officerEditedOutputJson ||
      scoreSummary.aiOutputJson) as Record<string, unknown>;

    // UAT PRI-03 — every figure in the report comes from the scoring engine's
    // own data for this score summary's scope, never from the AI.
    const { snapshot } = await this.reportSummary.buildReportDataSnapshot(
      studyId,
      scoreSummary.surveyId,
      scoreSummary.summaryScope as SummaryScopeType,
      (scoreSummary.scopeFilters ?? {}) as ScopeFilters,
    );
    const figures = calculatedFigures(snapshot);

    const inputDataToHash = JSON.stringify({
      scoreSummaryId: scoreSummary.id,
      figures,
      scoreOutput: scoreSummaryOutput,
      documentSummaries: selectedDocSummaries.map((d) => ({
        id: d.confirmedSummary!.id,
        json: d.confirmedSummary!.officerEditedOutputJson || d.confirmedSummary!.aiOutputJson,
      })),
    });

    const inputHash = crypto.createHash("sha256").update(inputDataToHash).digest("hex");
    // Prompt and schema come from the declared task, so the recorded
    // promptVersion always matches the prompt that ran. The MODEL does not:
    // every task literal names Gemini, while the OCI path is answered by
    // Cohere Command A, so it is resolved from the provider. This value is
    // also embedded in the generated summary's own `aiModel` field below.
    const { promptVersion, modelVersion } = COMBINED_REPORT_SUMMARY_TASK;
    const modelName = this.ai.resolveModelName(COMBINED_REPORT_SUMMARY_TASK);

    // Each document gets a fixed key the AI copies into sourceKey, so a finding
    // is traced to its document even when the AI translates the title or the
    // document has no reference number (UAT PRI-03 source attribution).
    const docSummariesFormatted = selectedDocSummaries.map((s, i) => ({
      sourceKey: `DOC-${i + 1}`,
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

Calculated Figures from the scoring engine (use these numbers exactly; do not change, round, average or add to them):
${JSON.stringify(figures, null, 2)}

Score-Based Summary Inputs (wording only — the numbers above are the authority):
${JSON.stringify(scoreSummaryOutput, null, 2)}

Selected Confirmed Document Summaries (${selectedDocSummaries.length}). Use only these documents as evidence. For every documentBasedEvidence entry, copy the document's sourceKey into "sourceKey" and its refId into "sourceReferenceId" exactly:
${JSON.stringify(docSummariesFormatted, null, 2)}

Generate JSON with these sections: header (studyName, entityName, methodologyVersion, cycleNumber, generatedAt), geography (region, governorate), executiveSummary, scoreBasedFindings (the calculated figures above plus confidenceDataQualityNote), documentBasedEvidence (one entry per finding: documentTitle, sourceReferenceId, documentType, linkedNeedOrDomain, keyEvidenceFinding, sourcePageOrSection), domainKpiResults (the calculated figures above), responseQuality (the calculated figures above), recommendations (intervention, priority as HIGH, MEDIUM or LOW, statusLabel "DRAFT_UNTIL_CONFIRMATION") and auditMetadata.`;

    // No fallback content. This used to catch every AI failure and substitute a
    // hand-written report — invented severity/priority figures, invented domain
    // results, invented recommendations — then store it as a DRAFT carrying a
    // real model name. A rate-limit produced a plausible-looking report built
    // from numbers nobody measured. Failures now propagate to the officer.
    // Written in the requester's language; see ReportSummaryService.generatePrioritySummary.
    const outputLocale = requestLocale();
    const task = {
      ...COMBINED_REPORT_SUMMARY_TASK,
      systemPrompt: withOutputLanguage(COMBINED_REPORT_SUMMARY_TASK.systemPrompt, outputLocale),
    };
    const { response: aiResponse } = await this.ai.run(task, prompt);
    const includedDocumentSummaryIds = selectedDocSummaries.map((d) => d.confirmedSummary!.id);
    const aiOutputJson = withCalculatedFigures(
      aiResponse,
      figures,
      selectedDocSummaries.map((d, i) => ({
        sourceKey: `DOC-${i + 1}`,
        documentTitle: d.documentTitle,
        sourceReferenceId: d.sourceReferenceId,
        documentType: d.documentType,
      })),
      {
        scoreSummaryId: scoreSummary.id,
        reportDataSnapshotId: snapshot.snapshotId,
        includedDocumentSummaryIds,
        aiModel: modelName,
        promptVersion,
        generatedTimestamp: new Date().toISOString(),
      },
    );

    const created = await this.tenant.runInOrgContext(async (tx) => {
      const summary = await tx.combinedReportSummary.create({
        data: {
          studyId,
          orgId,
          reportDataSnapshotId: snapshot.snapshotId,
          scoreSummaryId: scoreSummary.id,
          status: "DRAFT",
          promptVersion,
          modelName,
          modelVersion,
          inputHash,
          aiOutputJson: toJson(aiOutputJson),
          outputLocale,
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

    // UAT PRI-03 — an edit changes the wording, never the calculated figures.
    const edited = keepCalculatedFigures(editedOutputJson, summary.aiOutputJson);
    return this.tenant.runInOrgContext((tx) =>
      tx.combinedReportSummary.update({
        where: { id: summaryId },
        data: {
          officerEditedOutputJson: toJson(edited),
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
