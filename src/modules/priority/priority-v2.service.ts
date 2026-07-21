import { Injectable, Logger } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { Prisma } from '../../generated/prisma';
import { requireOrgId } from '../../tenancy/org-context';

/**
 * Per-domain snapshot stored in VillagePriorityAssessment.domainComponents.
 */
export interface DomainPriorityComponent {
  domainKey: string;
  domainNameSnapshot: string;
  domainSeverityScore: number;         // 0–100, from ScoreRollup
  domainPerformanceScore: number;      // 100 – domainSeverityScore
  domainWeight: number;                // 0–1
  weightedContribution: number;        // domainPerformanceScore × domainWeight
  isCriticalDomain: boolean;
  criticalThreshold: number;           // threshold for override trigger
  triggeredOverride: boolean;          // performance < criticalThreshold
}

export interface VillagePriorityResult {
  priorityScore: number;               // weighted sum (0–100), unrounded
  priorityStatus: 'HIGH' | 'MEDIUM' | 'LOW';
  overrideApplied: boolean;
  overrideReason: string | null;
  domainComponents: DomainPriorityComponent[];
}

/**
 * Normalize a domain name to UPPER_SNAKE_CASE for key matching.
 * e.g. "Water & Sanitation" → "WATER_SANITATION", "Health" → "HEALTH"
 */
export function normalizeDomainKey(name: string): string {
  return name
    .toUpperCase()
    .trim()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Pure calculation — no DB access. Accepts config rows and rollup severity
 * scores and returns the full priority result. Exported for unit testing.
 *
 * @param configs      DomainPriorityConfig rows for a methodology version
 * @param domainScores Map of normalized domainKey → severityScore (0–100)
 */
export function computeVillagePriority(
  configs: Array<{
    domainKey: string;
    domainNameSnapshot: string;
    weight: number;
    isCriticalDomain: boolean;
    criticalPerformanceThreshold: number;
  }>,
  domainScores: Map<string, number>,
): VillagePriorityResult {
  const components: DomainPriorityComponent[] = [];
  let weightedSum = 0;
  let weightSum = 0;

  for (const cfg of configs) {
    const severityScore = domainScores.get(cfg.domainKey) ?? null;

    // Skip domains for which no rollup data exists yet
    if (severityScore === null) continue;

    const performanceScore = 100 - severityScore;
    const weight = Number(cfg.weight);
    const weightedContribution = performanceScore * weight;
    const triggeredOverride =
      cfg.isCriticalDomain && performanceScore < cfg.criticalPerformanceThreshold;

    components.push({
      domainKey: cfg.domainKey,
      domainNameSnapshot: cfg.domainNameSnapshot,
      domainSeverityScore: severityScore,
      domainPerformanceScore: performanceScore,
      domainWeight: weight,
      weightedContribution,
      isCriticalDomain: cfg.isCriticalDomain,
      criticalThreshold: cfg.criticalPerformanceThreshold,
      triggeredOverride,
    });

    weightedSum += weightedContribution;
    weightSum += weight;
  }

  // Normalise in case weights don't exactly sum to 1 (future-proofing)
  const priorityScore = weightSum > 0 ? weightedSum / weightSum : 0;

  // ── Critical domain override (strictly < threshold) ──────────────────
  const overriddenDomain = components.find(c => c.triggeredOverride);
  if (overriddenDomain) {
    return {
      priorityScore,
      priorityStatus: 'HIGH',
      overrideApplied: true,
      overrideReason:
        `Critical domain override: ${overriddenDomain.domainNameSnapshot} ` +
        `performance score ${overriddenDomain.domainPerformanceScore.toFixed(1)} ` +
        `is below ${overriddenDomain.criticalThreshold}.`,
      domainComponents: components,
    };
  }

  // ── Standard classification (on unrounded score) ──────────────────────
  // ≤ 40 → HIGH  |  41–70 → MEDIUM  |  ≥ 71 → LOW
  let priorityStatus: 'HIGH' | 'MEDIUM' | 'LOW';
  if (priorityScore <= 40) {
    priorityStatus = 'HIGH';
  } else if (priorityScore <= 70) {
    priorityStatus = 'MEDIUM';
  } else {
    priorityStatus = 'LOW';
  }

  return {
    priorityScore,
    priorityStatus,
    overrideApplied: false,
    overrideReason: null,
    domainComponents: components,
  };
}

@Injectable()
export class PriorityV2Service {
  private readonly logger = new Logger(PriorityV2Service.name);

  constructor(private readonly tenant: TenantPrismaService) {}

  /**
   * Calculate and upsert a VillagePriorityAssessment for the given scope.
   * villageId = '' means consolidated (all villages).
   */
  async calculateVillagePriority(
    studyId: string,
    surveyId: string,
    villageId: string,
  ): Promise<void> {
    await this.tenant.runInOrgContext(async (tx) => {
      const orgId = requireOrgId();

      // Resolve methodology version from survey
      const survey = await tx.survey.findUnique({ where: { id: surveyId } });
      if (!survey) return;

      const mv = await tx.methodologyVersion.findFirst({
        where: survey.methodologyVersion
          ? { version: survey.methodologyVersion }
          : { status: 'PUBLISHED' },
        orderBy: { createdAt: 'desc' },
      });
      if (!mv) return;

      // Load domain priority config for this version
      const configs = await tx.domainPriorityConfig.findMany({
        where: { methodologyVersionId: mv.id },
      });
      if (configs.length === 0) {
        this.logger.warn(
          `No DomainPriorityConfig found for version ${mv.version} — skipping village priority calculation.`
        );
        return;
      }

      // Load DOMAIN-level rollups for this scope
      const domainRollups = await tx.scoreRollup.findMany({
        where: {
          studyId,
          surveyId,
          villageId: villageId || '',
          methodologyVersionId: mv.id,
          rollupLevel: 'DOMAIN',
        },
      });

      // Build a normalized key → severity map from rollups
      const domainScores = new Map<string, number>();
      for (const rollup of domainRollups) {
        if (rollup.severityScore !== null) {
          const key = normalizeDomainKey(rollup.entityId);
          domainScores.set(key, Number(rollup.severityScore));
        }
      }

      // Normalize config keys (they come from CSV already normalized, but be safe)
      const normalizedConfigs = configs.map(c => ({
        domainKey: normalizeDomainKey(c.domainKey),
        domainNameSnapshot: c.domainNameSnapshot,
        weight: Number(c.weight),
        isCriticalDomain: c.isCriticalDomain,
        criticalPerformanceThreshold: c.criticalPerformanceThreshold,
      }));

      const result = computeVillagePriority(normalizedConfigs, domainScores);

      if (result.domainComponents.length === 0) {
        this.logger.warn(
          `No matching domain rollups found for ${studyId}/${surveyId}/${villageId || 'consolidated'} — skipping.`
        );
        return;
      }

      // Upsert VillagePriorityAssessment
      const uniqueWhere = {
        studyId_surveyId_villageId_methodologyVersionId: {
          studyId,
          surveyId,
          villageId: villageId || '',
          methodologyVersionId: mv.id,
        },
      };

      const existing = await tx.villagePriorityAssessment.findUnique({
        where: uniqueWhere,
      });

      const data = {
        orgId,
        studyId,
        surveyId,
        villageId: villageId || '',
        methodologyVersionId: mv.id,
        priorityScore: new Prisma.Decimal(result.priorityScore),
        priorityStatus: result.priorityStatus,
        overrideApplied: result.overrideApplied,
        overrideReason: result.overrideReason,
        domainComponents: result.domainComponents as unknown as Prisma.InputJsonValue,
        calculatedAt: new Date(),
        calculationVersion: 'v2',
      };

      if (existing) {
        await tx.villagePriorityAssessment.update({
          where: { id: existing.id },
          data: {
            priorityScore: data.priorityScore,
            priorityStatus: data.priorityStatus,
            overrideApplied: data.overrideApplied,
            overrideReason: data.overrideReason,
            domainComponents: data.domainComponents,
            calculatedAt: data.calculatedAt,
            calculationVersion: data.calculationVersion,
          },
        });
        this.logger.log(
          `Updated VillagePriorityAssessment: ${studyId}/${villageId || 'consolidated'} → ${result.priorityStatus} (${result.priorityScore.toFixed(2)})`
        );
      } else {
        await tx.villagePriorityAssessment.create({ data });
        this.logger.log(
          `Created VillagePriorityAssessment: ${studyId}/${villageId || 'consolidated'} → ${result.priorityStatus} (${result.priorityScore.toFixed(2)})`
        );
      }
    });
  }

  /**
   * Recalculate village priority for all village scopes + consolidated.
   * Called at the end of ScoreRollupService.recalculateStudyScores().
   */
  async recalculateAll(studyId: string, surveyId: string): Promise<void> {
    // Discover distinct villages from existing domain rollups
    const rollups = await this.tenant.runInOrgContext((tx) =>
      tx.scoreRollup.findMany({
        where: { studyId, surveyId, rollupLevel: 'DOMAIN' },
        select: { villageId: true },
        distinct: ['villageId'],
      })
    );

    const villageIds = (rollups.map(r => r.villageId).filter(Boolean)) as string[];

    for (const vid of villageIds) {
      if (vid !== '') {
        await this.calculateVillagePriority(studyId, surveyId, vid);
      }
    }
    // Consolidated (all villages)
    await this.calculateVillagePriority(studyId, surveyId, '');
  }

  /**
   * Read the latest VillagePriorityAssessment for a given scope.
   * Returns null if not yet calculated.
   */
  async getVillagePriority(
    studyId: string,
    surveyId: string,
    villageId: string | null,
  ): Promise<any> {
    const vId = villageId || '';
    return this.tenant.runInOrgContext(async (tx) => {
      const survey = await tx.survey.findUnique({ where: { id: surveyId } });
      const mv = survey?.methodologyVersion
        ? await tx.methodologyVersion.findFirst({ where: { version: survey.methodologyVersion } })
        : await tx.methodologyVersion.findFirst({ where: { status: 'PUBLISHED' }, orderBy: { createdAt: 'desc' } });
      if (!mv) return null;

      const assessment = await tx.villagePriorityAssessment.findUnique({
        where: {
          studyId_surveyId_villageId_methodologyVersionId: {
            studyId,
            surveyId,
            villageId: vId,
            methodologyVersionId: mv.id,
          },
        },
      });
      if (!assessment) return null;

      return {
        priorityScore: Number(assessment.priorityScore),
        priorityStatus: assessment.priorityStatus,
        overrideApplied: assessment.overrideApplied,
        overrideReason: assessment.overrideReason,
        domainComponents: assessment.domainComponents,
        calculatedAt: assessment.calculatedAt.toISOString(),
        calculationVersion: assessment.calculationVersion,
        methodologyVersion: mv.version,
      };
    });
  }
}
