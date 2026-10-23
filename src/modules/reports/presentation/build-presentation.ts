// Builds the report presentation block from a report's existing content.
//
// Pure: no DB, no AI, no prose. It returns codes and numbers; the renderers
// turn them into sentences from the label catalogue, so every word is in both
// languages and a wording change never touches this file. Reports of every
// type go through here; a block whose data a report lacks is left out rather
// than shown empty. Rules come from presentation.config.ts.

import {
  CONFIDENCE_BANDS,
  COLLAPSED_SECTIONS,
  DESIGN_STYLE_REPORT_TYPES,
  SECTION_HOME,
  type SharedSection,
  FIT_TO_PUBLISH_MIN_BAND,
  PARTICIPATION_STATUS,
  blocksFor,
  decisionFor,
  type ConfidenceBand,
  type DecisionKey,
  type ParticipationStatus,
  type PresentationBlock,
} from './presentation.config';
import { severityBandOf } from '../providers/severity-bands';

export interface ParticipationGroup {
  governorate: string;
  total: number;
  rows: Array<{
    village: string;
    responses: number;
    sharePct: number;
    status: ParticipationStatus | null;
  }>;
}

export interface ReportPresentation {
  version: 1;
  blocks: PresentationBlock[];
  /** Restyle the report's existing sections too (DESIGN_STYLE_REPORT_TYPES). */
  design: boolean;
  confidence: {
    band: ConfidenceBand;
    validResponses: number;
    requiredSampleSize: number | null;
    population: number | null;
    mediumFrom: number;
  } | null;
  summary: {
    /** 0–100 overall needs index, and its severity band code. */
    index: number | null;
    indexBand: string | null;
    topDomain: { name: string; score: number } | null;
    /** For reports scoped by geography rather than domain (regional): the
     *  area with the highest needs. */
    topArea: { name: string; score: number } | null;
    topKpis: Array<{ name: string; score: number }>;
    /** Data-Quality report: no findings to rank, so the summary reports the
     *  sample itself. */
    quality?: { submitted: number; valid: number; excluded: number } | null;
    decision: DecisionKey;
  } | null;
  participation: ParticipationGroup[] | null;
  kpis: Array<{
    kpi: string;
    severity: number | null;
    gapType: string | null;
    band: ConfidenceBand;
    fitToPublish: boolean;
  }> | null;
  excluded: {
    total: number;
    duplicate: number;
    lowConfidence: number;
    other: number;
  } | null;
  signOff: {
    reviewerName: string | null;
    reviewerRole: string | null;
    organization: string | null;
    reviewedAt: string | null;
  } | null;
  /** Content fields shown collapsed rather than printed in full. */
  collapsed: string[];
  /** Repeated sections this report shows as a one-line reference, each with
   *  the report type that holds it in full (SECTION_HOME). */
  referenced: Array<{ key: SharedSection; home: string }>;
  /** Respondents per age band (the report that holds the demographics). */
  ageBands: Array<{ band: string; count: number }> | null;
}

export interface PresentationExtras {
  participation?: ParticipationGroup[];
  /** Used when the report's own content has no responseQuality block (the
   *  domain-wise and regional reports): the study's figures instead. */
  responseQuality?: {
    validResponses: number;
    submittedResponses: number;
    requiredSampleSize: number | null;
    population: number | null;
  } | null;
  reviewerName?: string | null;
  reviewerRole?: string | null;
  organization?: string | null;
  reviewedAt?: string | null;
  ageBands?: Array<{ band: string; count: number }> | null;
}

const BAND_RANK: Record<ConfidenceBand, number> = { VERY_LOW: 0, MEDIUM: 1, STRONG: 2 };

export function confidenceBandOf(valid: number, requiredSampleSize: number | null): ConfidenceBand {
  if (valid < CONFIDENCE_BANDS.mediumFrom) return 'VERY_LOW';
  if (
    CONFIDENCE_BANDS.strongFromRequiredSampleSize &&
    requiredSampleSize != null &&
    valid >= requiredSampleSize
  ) {
    return 'STRONG';
  }
  return 'MEDIUM';
}

export function isFitToPublish(band: ConfidenceBand): boolean {
  return BAND_RANK[band] >= BAND_RANK[FIT_TO_PUBLISH_MIN_BAND];
}

/** Concentration status of each village within one governorate's responses. */
export function participationStatus(
  sharePct: number,
  villagesWithResponses: number,
  /** The System Admin's setting when there is one; the config default otherwise. */
  concentratedFromPct: number = PARTICIPATION_STATUS.concentratedFromPct,
): ParticipationStatus | null {
  if (sharePct >= 100 && villagesWithResponses === 1) return 'FULLY_CONCENTRATED';
  if (sharePct >= concentratedFromPct) return 'CONCENTRATED';
  return null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** The KPI rows a report carries, whichever shape its type uses. */
function kpiSource(content: Record<string, unknown>): Array<Record<string, unknown>> {
  const priorityNeeds = isObj(content.priorityNeeds) ? content.priorityNeeds.needs : null;
  for (const candidate of [priorityNeeds, content.topKpis, content.topPriorities]) {
    if (Array.isArray(candidate) && candidate.length) return candidate.filter(isObj);
  }
  // Domain-wise report: no KPI list, but each domain names its worst KPI.
  const severity = isObj(content.severity) ? content.severity : null;
  if (Array.isArray(severity?.domains)) {
    return severity.domains
      .filter(isObj)
      .filter((d) => typeof d.maxKpiName === 'string' && d.maxKpiName)
      .map((d) => ({
        kpiName: d.maxKpiName,
        severityScore: d.maxKpiSeverity,
        gapType: d.gapType,
        validResponseCount: d.validResponseCount,
      }));
  }
  return [];
}

export function buildPresentation(
  reportType: string,
  content: Record<string, unknown>,
  extras: PresentationExtras = {},
): ReportPresentation {
  const wanted = blocksFor(reportType);
  const rq: Record<string, unknown> | null = isObj(content.responseQuality)
    ? content.responseQuality
    : (extras.responseQuality ?? null);
  const valid = num(rq?.validResponses);
  const required = num(rq?.requiredSampleSize);

  const confidence =
    valid != null
      ? {
          band: confidenceBandOf(valid, required),
          validResponses: valid,
          requiredSampleSize: required,
          population: num(rq?.population),
          mediumFrom: CONFIDENCE_BANDS.mediumFrom,
        }
      : null;

  // Findings: the overall index, the most severe domain and its worst KPIs.
  const severity = isObj(content.severity) ? content.severity : null;
  const domains = Array.isArray(severity?.domains) ? severity.domains.filter(isObj) : [];
  const scoredDomains = domains
    .map((d) => ({
      name: str(d.name) ?? str(d.domain) ?? '',
      score: num(d.severityScore) ?? num(d.score),
    }))
    .filter((d): d is { name: string; score: number } => !!d.name && d.score != null)
    .sort((a, b) => b.score - a.score);
  const kpiRows = kpiSource(content);
  const topKpis = kpiRows
    .map((k) => ({
      name: str(k.kpiName) ?? str(k.kpi) ?? str(k.indicatorName) ?? '',
      score: num(k.severityScore),
    }))
    .filter((k): k is { name: string; score: number } => !!k.name && k.score != null)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
  // Geography-scoped reports (regional) rank areas instead of domains.
  const areas = [
    ...(Array.isArray(content.villages) ? content.villages : []),
    ...(Array.isArray(content.regions) ? content.regions : []),
  ]
    .filter(isObj)
    .map((a) => ({
      name: str(a.village) ?? str(a.name) ?? str(a.governorate) ?? str(a.regionName) ?? '',
      score: num(a.severityScore),
    }))
    .filter((a): a is { name: string; score: number } => !!a.name && a.score != null)
    .sort((a, b) => b.score - a.score);
  const topArea = scoredDomains.length ? null : (areas[0] ?? null);
  const index = num(severity?.overallVillageNeedsIndex) ?? (topArea ? topArea.score : null);
  const indexBand = str(severity?.label) ?? (index != null ? severityBandOf(index) : null);

  const submittedCount = num(rq?.submittedResponses);
  const hasFindings = index != null || scoredDomains.length > 0 || topKpis.length > 0;
  const quality =
    !hasFindings && confidence && submittedCount != null
      ? {
          submitted: submittedCount,
          valid: confidence.validResponses,
          excluded: Math.max(0, submittedCount - confidence.validResponses),
        }
      : null;
  const summary =
    confidence && (hasFindings || quality)
      ? {
          index,
          indexBand,
          topDomain: scoredDomains[0] ?? null,
          topArea,
          topKpis,
          quality,
          decision: decisionFor(confidence.band, indexBand),
        }
      : null;

  const kpis = kpiRows.length
    ? kpiRows.slice(0, 10).map((k) => {
        const kpiValid = num(k.validResponseCount) ?? valid ?? 0;
        const band = confidenceBandOf(kpiValid, required);
        return {
          kpi: str(k.kpiName) ?? str(k.kpi) ?? str(k.indicatorName) ?? '—',
          severity: num(k.severityScore),
          gapType: str(k.gapType),
          band,
          fitToPublish: isFitToPublish(band),
        };
      })
    : null;

  // Data-Quality report keeps its counts under dataQualityNotes.responseQuality.
  const dqn =
    isObj(content.dataQualityNotes) && isObj(content.dataQualityNotes.responseQuality)
      ? content.dataQualityNotes.responseQuality
      : null;
  const coverage = isObj(content.coverage)
    ? content.coverage
    : dqn
      ? {
          responsesExcluded: dqn.excluded,
          duplicateResponses: dqn.duplicatesFlagged,
          lowConfidenceResponses: dqn.lowConfidenceFlagged,
        }
      : null;
  const submitted = num(rq?.submittedResponses);
  const total =
    num(coverage?.responsesExcluded) ??
    (submitted != null && valid != null ? Math.max(0, submitted - valid) : null);
  const duplicate = num(coverage?.duplicateResponses) ?? 0;
  const lowConfidence = num(coverage?.lowConfidenceResponses) ?? 0;
  const excluded =
    total != null
      ? { total, duplicate, lowConfidence, other: Math.max(0, total - duplicate - lowConfidence) }
      : null;

  const signOff =
    extras.reviewerName || extras.organization
      ? {
          reviewerName: extras.reviewerName ?? null,
          reviewerRole: extras.reviewerRole ?? null,
          organization: extras.organization ?? null,
          reviewedAt: extras.reviewedAt ?? null,
        }
      : null;

  const participation = extras.participation?.length ? extras.participation : null;

  const available: Record<PresentationBlock, boolean> = {
    summary: !!summary,
    confidence: !!confidence,
    participation: !!participation,
    kpis: !!kpis,
    adaptiveWording: !!summary && !!confidence,
    excluded: !!excluded,
    signOff: !!signOff,
  };

  return {
    version: 1,
    blocks: wanted.filter((b) => available[b]),
    design: DESIGN_STYLE_REPORT_TYPES.includes(reportType),
    confidence,
    summary,
    participation,
    kpis,
    excluded,
    signOff,
    collapsed: COLLAPSED_SECTIONS.filter((key) => content[key] != null),
    referenced: DESIGN_STYLE_REPORT_TYPES.includes(reportType)
      ? (Object.keys(SECTION_HOME) as SharedSection[])
          .filter((key) => SECTION_HOME[key] !== reportType)
          .map((key) => ({ key, home: SECTION_HOME[key] }))
      : [],
    ageBands: extras.ageBands?.some((b) => b.count > 0) ? extras.ageBands : null,
  };
}
