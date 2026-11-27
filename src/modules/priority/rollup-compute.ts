import type { ConfidenceFlagSettings } from '../methodology-config/methodology-config.types';

// The scoring roll-up as a pure calculation: per-response severity scores in,
// one row per QUESTION / KPI / INDICATOR / SUB_DOMAIN / DOMAIN / OVERALL out.
//
// Split out of ScoreRollupService.calculateRollups (which still persists the
// rows exactly as before) so the same maths can run on a SUBSET of
// respondents without writing anything — UAT PRI-07: a Generate-summary
// filtered to one governorate or centre scores only the respondents who said
// they live there. One implementation, so a filtered summary and the stored
// rollups can never disagree on how a score is built.

/** A per-answer score, as stored on ResponseSeverityScore. */
export interface RollupScoreInput {
  questionId: string;
  scoreStatus: string;
  severityScore: { toString(): string } | number | null;
  exclusionReason: string | null;
}

/** The Question Bank fields the hierarchy is built from. */
export interface RollupQuestionDef {
  questionId: string;
  questionText: string;
  kpi: string | null;
  indicator: string | null;
  subDomain: string | null;
  domain: string | null;
}

export type RollupLevel = 'QUESTION' | 'KPI' | 'INDICATOR' | 'SUB_DOMAIN' | 'DOMAIN' | 'OVERALL';

export interface ComputedRollup {
  rollupLevel: RollupLevel;
  entityId: string;
  entityNameSnapshot: string;
  severityScore: number | null;
  validResponseCount: number;
  excludedResponseCount: number;
  dontKnowCount: number;
  dontKnowRate: number;
  notApplicableCount: number;
  confidenceLevel: 'LOW' | 'STANDARD';
}

interface RollupAggregate {
  severityScore: number | null;
  confidenceLevel: 'LOW' | 'STANDARD';
  validResponseCount: number;
  dontKnowRate: number;
}

/**
 * RIO-FR-024 dual confidence criterion (Sample Size Reference sheet): LOW if
 * below the configured absolute floor OR below the study's own required
 * sample, or when the don't-know rate is above the configured threshold.
 * `requiredSampleSize` is null for studies created before that field existed.
 */
export function isLowConfidence(
  validCount: number,
  dontKnowRate: number,
  requiredSampleSize: number | null,
  settings: ConfidenceFlagSettings,
): boolean {
  return (
    validCount < settings.minRespondentsForStandardConfidence ||
    (requiredSampleSize != null && validCount < requiredSampleSize) ||
    dontKnowRate > settings.dontKnowRatioThreshold
  );
}

/** Mean of the scored children; counts and don't-know rate averaged over all. */
function aggregateChildren(
  childRollups: RollupAggregate[],
  requiredSampleSize: number | null,
  settings: ConfidenceFlagSettings,
): RollupAggregate {
  const scoredChildren = childRollups.filter((r) => r.severityScore !== null);
  const severityScore =
    scoredChildren.length > 0
      ? scoredChildren.reduce((acc, curr) => acc + curr.severityScore!, 0) / scoredChildren.length
      : null;
  const validResponseCount = Math.round(
    childRollups.reduce((acc, curr) => acc + curr.validResponseCount, 0) / childRollups.length,
  );
  const dontKnowRate = childRollups.reduce((acc, curr) => acc + curr.dontKnowRate, 0) / childRollups.length;
  const confidenceLevel = isLowConfidence(validResponseCount, dontKnowRate, requiredSampleSize, settings)
    ? 'LOW'
    : 'STANDARD';
  return { severityScore, confidenceLevel, validResponseCount, dontKnowRate };
}

/** Group child names under each parent, first-seen order, no duplicates. */
function groupBy(
  questions: RollupQuestionDef[],
  parentOf: (q: RollupQuestionDef) => string | null,
  childOf: (q: RollupQuestionDef) => string | null,
  unique: boolean,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const q of questions) {
    const parent = parentOf(q);
    const child = childOf(q);
    if (!parent || !child) continue;
    if (!out.has(parent)) out.set(parent, []);
    const list = out.get(parent)!;
    if (!unique || !list.includes(child)) list.push(child);
  }
  return out;
}

/**
 * Every rollup row for one scope, in the order ScoreRollupService writes them:
 * questions, then KPIs, indicators, sub-domains, domains, and OVERALL last.
 */
export function computeRollups(
  responseScores: RollupScoreInput[],
  questions: RollupQuestionDef[],
  requiredSampleSize: number | null,
  settings: ConfidenceFlagSettings,
): ComputedRollup[] {
  const rows: ComputedRollup[] = [];
  const questionMap = new Map<string, RollupQuestionDef>();
  for (const q of questions) questionMap.set(q.questionId, q);

  const scoresByQuestion = new Map<string, RollupScoreInput[]>();
  for (const score of responseScores) {
    if (!scoresByQuestion.has(score.questionId)) scoresByQuestion.set(score.questionId, []);
    scoresByQuestion.get(score.questionId)!.push(score);
  }

  // QUESTION level — the only level computed from the answers themselves.
  const questionRollups = new Map<string, RollupAggregate & Omit<ComputedRollup, 'rollupLevel' | 'entityId' | 'entityNameSnapshot'>>();
  for (const [qId, qScores] of scoresByQuestion.entries()) {
    const questionDef = questionMap.get(qId);
    if (!questionDef) continue;

    const scoredItems = qScores.filter((s) => s.scoreStatus === 'SCORED' && s.severityScore !== null);
    const validCount = scoredItems.length;
    const excludedCount = qScores.filter((s) => s.scoreStatus === 'EXCLUDED').length;
    const dontKnowCount = qScores.filter((s) => s.exclusionReason === 'DONT_KNOW').length;
    const notApplicableCount = qScores.filter((s) => s.scoreStatus === 'NOT_APPLICABLE').length;

    let avgScore: number | null = null;
    if (validCount > 0) {
      const sum = scoredItems.reduce((acc, curr) => acc + Number(curr.severityScore), 0);
      avgScore = sum / validCount;
    }

    const totalForDkRate = validCount + dontKnowCount;
    const dontKnowRate = totalForDkRate > 0 ? dontKnowCount / totalForDkRate : 0;
    const confidenceLevel = isLowConfidence(validCount, dontKnowRate, requiredSampleSize, settings) ? 'LOW' : 'STANDARD';

    const row = {
      severityScore: avgScore,
      validResponseCount: validCount,
      excludedResponseCount: excludedCount,
      dontKnowCount,
      dontKnowRate,
      notApplicableCount,
      confidenceLevel,
    } as const;
    questionRollups.set(qId, row);
    rows.push({ rollupLevel: 'QUESTION', entityId: qId, entityNameSnapshot: questionDef.questionText, ...row });
  }

  // KPI level — mean of its questions; counts averaged (rounded).
  const kpis = groupBy(questions, (q) => q.kpi, (q) => q.questionId, false);
  const kpiRollups = new Map<string, RollupAggregate>();
  for (const [kpiName, qIds] of kpis.entries()) {
    const childRollups = qIds.map((id) => questionRollups.get(id)).filter((r) => r !== undefined);
    if (childRollups.length === 0) continue;
    const agg = aggregateChildren(childRollups, requiredSampleSize, settings);
    kpiRollups.set(kpiName, agg);
    rows.push({
      rollupLevel: 'KPI',
      entityId: kpiName,
      entityNameSnapshot: kpiName,
      ...agg,
      excludedResponseCount: Math.round(
        childRollups.reduce((acc, curr) => acc + curr.excludedResponseCount, 0) / childRollups.length,
      ),
      dontKnowCount: Math.round(childRollups.reduce((acc, curr) => acc + curr.dontKnowCount, 0) / childRollups.length),
      notApplicableCount: Math.round(
        childRollups.reduce((acc, curr) => acc + curr.notApplicableCount, 0) / childRollups.length,
      ),
    });
  }

  // INDICATOR → SUB_DOMAIN → DOMAIN — each the mean of the level below.
  const levelUp = (
    level: 'INDICATOR' | 'SUB_DOMAIN' | 'DOMAIN',
    groups: Map<string, string[]>,
    children: Map<string, RollupAggregate>,
  ): Map<string, RollupAggregate> => {
    const out = new Map<string, RollupAggregate>();
    for (const [name, childNames] of groups.entries()) {
      const childRollups = childNames.map((n) => children.get(n)).filter((r) => r !== undefined);
      if (childRollups.length === 0) continue;
      const agg = aggregateChildren(childRollups, requiredSampleSize, settings);
      out.set(name, agg);
      rows.push({
        rollupLevel: level,
        entityId: name,
        entityNameSnapshot: name,
        ...agg,
        excludedResponseCount: 0,
        dontKnowCount: 0,
        notApplicableCount: 0,
      });
    }
    return out;
  };
  const indicatorRollups = levelUp(
    'INDICATOR',
    groupBy(questions, (q) => (q.kpi ? q.indicator : null), (q) => q.kpi, true),
    kpiRollups,
  );
  const subDomainRollups = levelUp(
    'SUB_DOMAIN',
    groupBy(questions, (q) => q.subDomain, (q) => q.indicator, true),
    indicatorRollups,
  );
  const domainRollups = levelUp(
    'DOMAIN',
    groupBy(questions, (q) => q.domain, (q) => q.subDomain, true),
    subDomainRollups,
  );

  // OVERALL — mean of the domains.
  const domainChildren = Array.from(domainRollups.values());
  if (domainChildren.length > 0) {
    rows.push({
      rollupLevel: 'OVERALL',
      entityId: 'OVERALL',
      entityNameSnapshot: 'Village Development Needs Index',
      ...aggregateChildren(domainChildren, requiredSampleSize, settings),
      excludedResponseCount: 0,
      dontKnowCount: 0,
      notApplicableCount: 0,
    });
  }

  return rows;
}
