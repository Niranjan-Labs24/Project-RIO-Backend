import type { ReportDataSnapshot } from './report-summary.service';

/**
 * UAT PRI-03 — the combined report's numbers must match the source data.
 *
 * The AI used to write every figure itself (priority score, level, severity,
 * domain results, response counts). Given the same inputs it returned a
 * different priority score each time, none of them the scoring engine's.
 * Every figure is now taken from the scoring engine's report data snapshot
 * and written over whatever the AI returned; the AI only writes the text.
 */

export interface CalculatedFigures {
  scoreBasedFindings: {
    overallSeverityScore: number | null;
    priorityScore: number | null;
    priorityStatus: string | null;
    topDomainsOrKpis: { name: string; score: number | null }[];
  };
  domainKpiResults: {
    domainName: string;
    severity: number;
    performance: number;
    weight: number;
    confidence: string;
    typeLabel: 'SCORING_OUTPUT';
  }[];
  responseQuality: {
    validResponseCount: number;
    confidenceLevel: string;
    dontKnowRate: number;
  };
}

export interface SelectedDocument {
  /** The fixed key ("DOC-1", ...) the AI was told to copy for this document. */
  sourceKey: string;
  documentTitle: string;
  sourceReferenceId: string;
  documentType: string;
}

const TOP_KPI_COUNT = 5;

export function calculatedFigures(snapshot: ReportDataSnapshot): CalculatedFigures {
  const confidenceByDomain = new Map(
    snapshot.severity.domainSeverityScores.map((d) => [d.domainKey, d.confidenceLevel]),
  );
  return {
    scoreBasedFindings: {
      overallSeverityScore: snapshot.severity.overallVillageNeedsIndex,
      priorityScore: snapshot.priority.villagePriorityScore,
      priorityStatus: snapshot.priority.priorityStatus,
      topDomainsOrKpis: snapshot.severity.topKpis
        .slice(0, TOP_KPI_COUNT)
        .map((k) => ({ name: k.kpiName, score: k.severityScore })),
    },
    domainKpiResults: snapshot.priority.domainPerformanceScores.map((d) => ({
      domainName: d.domainName,
      severity: d.severityScore,
      performance: d.performanceScore,
      weight: d.weight,
      confidence: confidenceByDomain.get(d.domainKey) ?? snapshot.responseQuality.confidenceLevel,
      typeLabel: 'SCORING_OUTPUT',
    })),
    responseQuality: {
      validResponseCount: snapshot.responseQuality.validResponseCount,
      confidenceLevel: snapshot.responseQuality.confidenceLevel,
      dontKnowRate: snapshot.responseQuality.dontKnowRate,
    },
  };
}

/** Priority words the AI writes in either language, mapped to the stored code. */
const PRIORITY_CODES: Record<string, 'HIGH' | 'MEDIUM' | 'LOW'> = {
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
  'عالية': 'HIGH',
  'عالي': 'HIGH',
  'مرتفعة': 'HIGH',
  'مرتفع': 'HIGH',
  'متوسطة': 'MEDIUM',
  'متوسط': 'MEDIUM',
  'منخفضة': 'LOW',
  'منخفض': 'LOW',
};

function priorityCode(value: unknown): string {
  const key = String(value ?? '').trim();
  return PRIORITY_CODES[key.toLowerCase()] ?? PRIORITY_CODES[key] ?? key;
}

const normalise = (s: unknown) => String(s ?? '').trim().toLowerCase();

/**
 * Keeps only evidence that comes from a document the officer included, and
 * takes each item's title, reference and type from that document rather than
 * from the AI. Evidence the AI attributes to any other document is dropped.
 */
function attributedEvidence(evidence: unknown, documents: SelectedDocument[]) {
  if (!Array.isArray(evidence)) return [];
  const out: Record<string, unknown>[] = [];
  for (const item of evidence) {
    if (!item || typeof item !== 'object') continue;
    const ev = item as Record<string, unknown>;
    const key = normalise(ev.sourceKey);
    const ref = normalise(ev.sourceReferenceId);
    const title = normalise(ev.documentTitle);
    const byKey = key ? documents.find((d) => normalise(d.sourceKey) === key) : undefined;
    const byRef = ref ? documents.find((d) => normalise(d.sourceReferenceId) === ref) : undefined;
    // A key or reference no included document has is an invented source: dropped.
    if ((key && !byKey) || (!byKey && ref && !byRef)) continue;
    // Otherwise match the title; with a single included document, the AI may
    // have translated its title, so that document is the source.
    const doc =
      byKey ||
      byRef ||
      documents.find((d) => normalise(d.documentTitle) === title) ||
      (documents.length === 1 ? documents[0] : undefined);
    if (!doc) continue;
    const { sourceKey: _sourceKey, ...rest } = ev;
    out.push({
      ...rest,
      documentTitle: doc.documentTitle,
      sourceReferenceId: doc.sourceReferenceId,
      documentType: doc.documentType,
    });
  }
  return out;
}

/**
 * The AI output with every calculated figure, every source and the audit
 * block replaced by the real values. Text fields (summary, findings,
 * recommendations, notes) stay as the AI wrote them.
 */
export function withCalculatedFigures(
  aiOutput: unknown,
  figures: CalculatedFigures,
  documents: SelectedDocument[],
  audit: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...((aiOutput ?? {}) as Record<string, unknown>) };
  const sb = (out.scoreBasedFindings ?? {}) as Record<string, unknown>;
  out.scoreBasedFindings = { ...sb, ...figures.scoreBasedFindings };
  out.domainKpiResults = figures.domainKpiResults;
  const rq = (out.responseQuality ?? {}) as Record<string, unknown>;
  out.responseQuality = { ...rq, ...figures.responseQuality };
  out.documentBasedEvidence = attributedEvidence(out.documentBasedEvidence, documents);
  if (Array.isArray(out.recommendations)) {
    out.recommendations = out.recommendations.map((r) =>
      r && typeof r === 'object'
        ? {
            ...(r as Record<string, unknown>),
            priority: priorityCode((r as Record<string, unknown>).priority),
            statusLabel: 'DRAFT_UNTIL_CONFIRMATION',
          }
        : r,
    );
  }
  out.auditMetadata = audit;
  return out;
}

/**
 * An officer's edit keeps their wording but never the numbers: the calculated
 * figures, sources and audit block are carried over from the generated output.
 */
export function keepCalculatedFigures(edited: unknown, generated: unknown): Record<string, unknown> {
  const out = { ...((edited ?? {}) as Record<string, unknown>) };
  const gen = (generated ?? {}) as Record<string, unknown>;
  const genSb = (gen.scoreBasedFindings ?? {}) as Record<string, unknown>;
  const sb = (out.scoreBasedFindings ?? {}) as Record<string, unknown>;
  out.scoreBasedFindings = {
    ...sb,
    overallSeverityScore: genSb.overallSeverityScore ?? null,
    priorityScore: genSb.priorityScore ?? null,
    priorityStatus: genSb.priorityStatus ?? null,
    topDomainsOrKpis: genSb.topDomainsOrKpis ?? [],
  };
  out.domainKpiResults = gen.domainKpiResults ?? [];
  const genRq = (gen.responseQuality ?? {}) as Record<string, unknown>;
  const rq = (out.responseQuality ?? {}) as Record<string, unknown>;
  out.responseQuality = {
    ...rq,
    validResponseCount: genRq.validResponseCount,
    confidenceLevel: genRq.confidenceLevel,
    dontKnowRate: genRq.dontKnowRate,
  };
  out.auditMetadata = gen.auditMetadata ?? out.auditMetadata;
  return out;
}
