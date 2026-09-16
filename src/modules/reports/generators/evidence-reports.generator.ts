import { NotFoundException } from "@nestjs/common";
import type { Prisma } from "../../../generated/prisma";
import type { ReportDataSnapshot } from "../report-summary.service";
import { NOT_AVAILABLE_DATE, NOT_AVAILABLE_FOR_STUDY } from "../report-gap-markers";
import { REPORT_TYPE_META } from "../reports.types";
import type { GeneratedReport } from "./index";

// RPT16 Combined Evidence & Score · RPT17 Evidence Document-Based.
//
// Both are built from the study's uploaded evidence documents and their
// officer-confirmed AI summaries. RPT16 adds the quantitative severity /
// priority / response-quality half on top of the same evidence; RPT17 is
// qualitative ONLY and must not carry survey-derived scores anywhere, because
// a score printed in a document-derived report reads as if the documents had
// produced it.
//
// One builder, two entry points — the same arrangement RPT03/RPT09 use for
// their shared ranked list. The two reports differ by `isCombined` alone, so
// splitting them into two files would duplicate ~290 lines that would then
// have to be kept reconciled with each other by hand.
//
// Lifted out of ReportsService.generateContent, where this pair was the one
// report type assembled inline while every other type went through the
// generators/ seam. Nothing about the output changed in the move.

/** The transaction this generator reads through — the caller opens it, so the
 *  evidence documents, the study's geography and the quantitative snapshot are
 *  all read in one org-scoped transaction, as they were inline. */
export type EvidenceReportTx = Prisma.TransactionClient;

export interface EvidenceReportCtx {
  reportType: "RPT16" | "RPT17";
  studyId: string;
  orgId: string;
  generatedBy: string;
  filters: Record<string, unknown>;
  tx: EvidenceReportTx;
  /** Real scoring facts for the study, or null when it has not been scored
   *  yet — the quantitative sections then report themselves as unavailable
   *  rather than being filled with invented figures. Injected rather than
   *  loaded here because resolving it needs ReportSummaryService, a service
   *  dependency; the generators layer stays free of DI. */
  loadFacts: () => Promise<ReportDataSnapshot | null>;
}

async function buildEvidenceReport(ctx: EvidenceReportCtx): Promise<GeneratedReport> {
  const { reportType, studyId, orgId, generatedBy, filters, tx } = ctx;
  const isCombined = reportType === "RPT16";

  const study = await tx.study.findUnique({ where: { id: studyId } });
  if (!study) throw new NotFoundException(`Study with id ${studyId} not found.`);

  const org = await tx.organisation.findUnique({ where: { id: orgId } });

  // The study's centers, for the Center rung of the geography hierarchy.
  // Read straight from study_centers rather than threaded through the
  // ReportData snapshot, whose `study` block carries region/governorate
  // but no center — this keeps the lookup local to these two reports.
  const studyCenters = await tx.studyCenter.findMany({
    where: { studyId, orgId },
    include: { center: true },
  });
  const centerNames = [...new Set(studyCenters.map((c) => c.center.name))];

  // The study's region(s), by their master-data `code`. The map marker
  // below is keyed on the code, never on the region NAME: names are
  // display values and every region now carries a populated `nameAr`,
  // so a name-keyed coordinate lookup misses the moment the report
  // renders in Arabic (see ncnp-report-pdf.ts's KSA_REGION_COORDS).
  // Region is reached through the study's governorates — a study links
  // governorates, not regions directly.
  const studyGovernorates = await tx.studyGovernorate.findMany({
    where: { studyId, orgId },
    include: { governorate: { include: { region: true } } },
  });
  const studyRegionCodes = [
    ...new Set(studyGovernorates.map((sg) => String(sg.governorate.region.code))),
  ];

  const docs = await tx.evidenceDocument.findMany({
    where: { studyId, orgId },
    include: { summaries: { orderBy: { createdAt: "desc" }, take: 1 } },
    orderBy: { createdAt: "desc" },
  });

  const latestCombined = reportType === "RPT16"
    ? await tx.combinedReportSummary.findFirst({
        where: { studyId, orgId },
        orderBy: { createdAt: "desc" },
      })
    : null;

  // The score-based AI narrative. RPT16 is the union of the score report
  // and the evidence report, so it carries this alongside the combined
  // narrative — the combined one is a synthesis and does not restate
  // everything the score summary said.
  const latestScore = isCombined
    ? await tx.aiPrioritySummary.findFirst({
        where: { studyId, orgId },
        orderBy: { createdAt: "desc" },
      })
    : null;

  const formattedDocs = docs.map((d) => {
    const latestSummary = d.summaries[0];
    const rawOutput = latestSummary?.officerEditedOutputJson || latestSummary?.aiOutputJson;
    let parsedOutput = null;
    if (typeof rawOutput === "string") {
      try { parsedOutput = JSON.parse(rawOutput); } catch { parsedOutput = null; }
    } else {
      parsedOutput = rawOutput;
    }
    return {
      id: d.id,
      title: d.title,
      documentType: d.documentType,
      sourceReferenceId: d.sourceReferenceId,
      collectedDate: d.collectedDate ? d.collectedDate.toISOString().substring(0, 10) : NOT_AVAILABLE_DATE,
      description: d.description || "",
      summaryStatus: latestSummary?.status || "NO_SUMMARY",
      aiSummary: parsedOutput,
    };
  });

  const parseOutput = (raw: unknown): unknown => {
    if (typeof raw === "string") {
      try { return JSON.parse(raw); } catch { return null; }
    }
    return raw ?? null;
  };

  const combinedParsed = latestCombined
    ? parseOutput(latestCombined.officerEditedOutputJson || latestCombined.aiOutputJson)
    : null;
  const scoreParsed = latestScore
    ? parseOutput(latestScore.officerEditedOutputJson || latestScore.aiOutputJson)
    : null;

  const reportTitle = reportType === "RPT17"
    ? `${study.title} — Evidence Document Report`
    : `${study.title} — Combined Quantitative & Evidence Report`;

  // Real scoring facts for this study. Null when the study has not been
  // scored yet, in which case the quantitative sections are reported as
  // unavailable rather than filled with placeholder figures.
  const facts: ReportDataSnapshot | null = await ctx.loadFacts();

  const NOT_AVAILABLE = NOT_AVAILABLE_FOR_STUDY;

  // Recommendations come from the officer-facing summaries — never
  // invented here. RPT16 unions the combined narrative's list with the
  // score summary's, since the report carries both halves; identical
  // interventions are kept once (case/whitespace-insensitive) so a
  // recommendation both summaries make is not printed twice.
  const asRecommendationText = (r: unknown) =>
    typeof r === "string"
      ? r
      : String((r as { intervention?: string })?.intervention ?? "");
  // The two summaries name this differently: the combined narrative uses
  // `recommendations`, the score narrative uses `draftNextSteps` (a
  // required string[] in its response schema). Both are the same domain —
  // interventions / next steps — so both feed the one list.
  const readRecommendations = (parsed: unknown): string[] => {
    const shape = (parsed ?? {}) as { recommendations?: unknown; draftNextSteps?: unknown };
    return [
      ...(Array.isArray(shape.recommendations) ? shape.recommendations : []),
      ...(Array.isArray(shape.draftNextSteps) ? shape.draftNextSteps : []),
    ]
      .map(asRecommendationText)
      .filter(Boolean);
  };

  const recommendations: string[] = [];
  const seenRecommendations = new Set<string>();
  for (const rec of [
    ...readRecommendations(combinedParsed),
    ...readRecommendations(scoreParsed),
  ]) {
    const key = rec.trim().toLowerCase();
    if (!key || seenRecommendations.has(key)) continue;
    seenRecommendations.add(key);
    recommendations.push(rec);
  }

  // The nested narratives keep everything except their own
  // `recommendations` array — that content is hoisted to the single
  // top-level list above, so it renders once rather than in three places.
  const stripRecommendations = (parsed: unknown): unknown => {
    if (!parsed || typeof parsed !== "object") return parsed;
    const { recommendations: _dropped, draftNextSteps: _alsoDropped, ...rest } = parsed as Record<string, unknown>;
    return rest;
  };

  return {
    title: reportTitle,
    content: {
      header: {
        studyName: study.title,
        entityName: org?.name || "Community Assessment Platform",
        methodologyVersion:
          facts?.study.methodologyVersionLabel ?? study.methodologyVersionId ?? NOT_AVAILABLE,
        cycleNumber: study.cycleNumber ?? 1,
        dateTime: new Date().toISOString(),
      },
      // Structured Region → Governorate → Center, from the study's own
      // selection.
      //
      // `regions` is the map payload: the same {id, name, count} shape
      // the NCNP report's RegionMap consumes, so both reports plot the
      // study on the Kingdom map with the existing component. `name`
      // must be the master Region name (e.g. "Northern Borders") — that
      // is the key RegionMap looks up coordinates by. Region level only:
      // the platform holds no governorate GPS data, and inventing it is
      // avoided here as everywhere else.
      //
      // The count is what the marker means for each report: documents
      // for the evidence report, documents plus scored domains for the
      // combined one.
      geography: {
        region: facts?.study.regionName ?? NOT_AVAILABLE,
        governorate: facts?.study.governorateName ?? NOT_AVAILABLE,
        center: centerNames.length ? centerNames.join(", ") : NOT_AVAILABLE,
        // One marker, for a single-region study only. A multi-region
        // study has no per-region split of this count to plot, so it
        // plots nothing rather than attributing the study's whole
        // figure to an arbitrary one of its regions — the same outcome
        // this produced before, when the joined "Riyadh, Aseer" name
        // matched no coordinate entry, but now by intent rather than by
        // a lookup that happened to miss.
        regions:
          facts?.study.regionName && studyRegionCodes.length === 1
            ? [
                {
                  id: facts.study.regionName,
                  code: studyRegionCodes[0]!,
                  name: facts.study.regionName,
                  count: isCombined
                    ? formattedDocs.length + (facts?.severity.domainSeverityScores.length ?? 0)
                    : formattedDocs.length,
                },
              ]
            : [],
        mapUnitLabel: isCombined
          ? ["data point", "data points"]
          : ["document", "documents"],
      },
      // Field names follow the canonical ResponseQuality contract, not
      // ad-hoc ones: ResponseQualityBlock and responseQualityRows both
      // read `overallConfidence` / `validResponseRatePct` / `dontKnowBand`,
      // and rendered "—" for three of six tiles while this block emitted
      // `confidence` and omitted the other two.
      responseQuality: facts
        ? {
            submittedResponses: facts.responseQuality.submittedResponseCount,
            validResponses: facts.responseQuality.validResponseCount,
            overallConfidence: facts.responseQuality.confidenceLevel,
            confidenceReason: facts.responseQuality.confidenceReason,
            validResponseRatePct:
              facts.responseQuality.submittedResponseCount > 0
                ? Math.round(
                    (facts.responseQuality.validResponseCount /
                      facts.responseQuality.submittedResponseCount) *
                      100,
                  )
                : 0,
            dontKnowRate: facts.responseQuality.dontKnowRate * 100,
            dontKnowBand: facts.responseQuality.dontKnowBand,
            population: facts.study.population,
            requiredSampleSize: facts.study.requiredSampleSize,
            minimumDetectableEffect: facts.study.minimumDetectableEffect,
          }
        : { note: NOT_AVAILABLE },
      // ── Scoring half: RPT16 only ──
      // Omitted entirely (not nulled) for RPT17 — report-doc.ts and the
      // frontend renderer both decide section-by-section on key presence,
      // so absent keys mean the scoring sections never render.
      ...(!isCombined
        ? {}
        : {
        severity: facts
          ? {
              label: facts.severity.severityBand,
              overallVillageNeedsIndex: facts.severity.overallVillageNeedsIndex,
              // Severity is joined to the priority rollup's performance and
              // weight per domain, so one table carries the full
              // Domain/KPI result set the report requires.
              domains: facts.severity.domainSeverityScores.map((d) => {
                const perf = facts.priority.domainPerformanceScores.find(
                  (p) => p.domainKey === d.domainKey,
                );
                const submitted = d.validResponseCount + d.excludedResponseCount;
                return {
                  name: d.domainName,
                  domainCode: d.domainKey,
                  severityScore: d.severityScore,
                  performanceScore: perf?.performanceScore ?? null,
                  weight: perf?.weight ?? null,
                  kpiCount: d.kpiCount,
                  confidence: d.confidenceLevel,
                  confidencePct:
                    submitted > 0 ? Math.round((d.validResponseCount / submitted) * 100) : null,
                  isCriticalDomain: perf?.isCriticalDomain ?? false,
                };
              }),
            }
          : { note: NOT_AVAILABLE },
        priority: facts
          ? {
              villagePriorityScore: facts.priority.villagePriorityScore,
              priorityStatus: facts.priority.priorityStatus,
              overrideApplied: facts.priority.overrideApplied,
              overrideReason: facts.priority.overrideReason,
            }
          : { note: NOT_AVAILABLE },
        topPriorities: (facts?.severity.topKpis ?? []).map((k) => ({
          rank: k.rank,
          needStatement: k.kpiName,
          score: k.severityScore,
          domain: k.domainName,
        })),
        combinedSummarySection: stripRecommendations(combinedParsed),
        scoreSummarySection: stripRecommendations(scoreParsed),
        }),
      evidenceSection: {
        totalDocuments: formattedDocs.length,
        documents: formattedDocs,
      },
      recommendations,
      approval: {
        generatedBy,
        generatedAt: new Date().toISOString(),
        status: "DRAFT",
      },
      filters,
      reportKind: REPORT_TYPE_META[reportType].kind,
    },
  };
}

/** RPT16 — evidence documents plus the study's quantitative half. */
export function combinedEvidenceGenerator(
  ctx: Omit<EvidenceReportCtx, "reportType">,
): Promise<GeneratedReport> {
  return buildEvidenceReport({ ...ctx, reportType: "RPT16" });
}

/** RPT17 — evidence documents only. Carries no severity, priority or
 *  top-priority figures by construction. */
export function evidenceDocumentGenerator(
  ctx: Omit<EvidenceReportCtx, "reportType">,
): Promise<GeneratedReport> {
  return buildEvidenceReport({ ...ctx, reportType: "RPT17" });
}
