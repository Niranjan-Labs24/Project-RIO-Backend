import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { requireActor } from "../../tenancy/org-context";
import type {
  AiClassificationSettings, ConfidenceFlagSettings, MethodologyConfig,
  MethodologyConfigHistoryEntry, MethodologyConfigRow,
  MethodologyVersionOption, PriorityFactorWeight, PriorityThresholds, UpdateMethodologyConfigPayload,
} from "./methodology-config.types";

/** The values the frontend hardcoded before RIO-AI-001 made them
 * configurable — kept as the default so enabling configurability changed no
 * observable behaviour. Mirrors the migration's column DEFAULT, and backs the
 * read path for any row written before that column existed. */
export const DEFAULT_AI_CLASSIFICATION_SETTINGS: AiClassificationSettings = {
  lowConfidenceThreshold: 0.7,
  veryLowConfidenceThreshold: 0.4,
};

// Global reference/master data (no orgId, no RLS — same pattern as
// Domain/SubDomain) — single row, seeded by migration. Read via the bare
// PrismaService like the rest of this family of tables.
@Injectable()
export class MethodologyConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantPrismaService,
  ) {}

  async get(): Promise<MethodologyConfig> {
    const row = await this.findRowOrThrow();
    return this.toConfig(row);
  }

  // Backs the Survey workflow's "select a Methodology Version before Submit
  // for Approval" requirement. Sourced directly from the single
  // MethodologyConfig row now — the currently PUBLISHED version is the only
  // one ever offered (an empty list while it's still `draft`, which the
  // Survey Builder page's placeholder correctly reflects as "nothing to
  // pick yet"). MethodologyVersionOption (a separate, hardcoded 2-row
  // placeholder table from before real versioning existed) is no longer
  // read here — publishing a version in Settings never wrote to that table,
  // so the dropdown could show stale options with no way to know which one
  // was actually published; this makes the dropdown reflect the one real
  // published version instead.
  async listVersionOptions(): Promise<MethodologyVersionOption[]> {
    const versions = await this.tenant.runAsSupervisor((tx) =>
      tx.methodologyVersion.findMany({
        where: { status: "PUBLISHED" },
        orderBy: { createdAt: "desc" },
      }),
    );
    if (versions.length > 0) {
      return versions.map((v) => ({ id: v.id, version: v.version }));
    }
    const row = await this.findRowOrThrow();
    if (row.status !== "published") return [];
    return [{ id: row.id, version: row.version }];
  }

  async update(payload: UpdateMethodologyConfigPayload): Promise<MethodologyConfig> {
    const existing = await this.findRowOrThrow();
    const updatedBy = requireActor();

    const priorityThresholds: PriorityThresholds = {
      ...(existing.priorityThresholds as PriorityThresholds),
      ...(payload.priorityThresholds ?? {}),
    };
    const confidenceFlagSettings: ConfidenceFlagSettings = {
      ...(existing.confidenceFlagSettings as ConfidenceFlagSettings),
      ...(payload.confidenceFlagSettings ?? {}),
    };
    const aiClassificationSettings: AiClassificationSettings = {
      ...this.readAiClassificationSettings(existing),
      ...(payload.aiClassificationSettings ?? {}),
    };
    const priorityFactorWeights: PriorityFactorWeight[] = payload.priorityFactorWeights
      ? (existing.priorityFactorWeights as PriorityFactorWeight[]).map((factor) => {
          const override = payload.priorityFactorWeights?.find((w) => w.key === factor.key);
          return override ? { ...factor, weight: override.weight } : factor;
        })
      : (existing.priorityFactorWeights as PriorityFactorWeight[]);

    this.validateThresholds(priorityThresholds);
    this.validateAiClassificationSettings(aiClassificationSettings);

    const row = await this.prisma.methodologyConfig.update({
      where: { id: existing.id },
      data: {
        version: payload.version ?? existing.version,
        priorityThresholds: priorityThresholds as unknown as Prisma.InputJsonValue,
        priorityFactorWeights: priorityFactorWeights as unknown as Prisma.InputJsonValue,
        confidenceFlagSettings: confidenceFlagSettings as unknown as Prisma.InputJsonValue,
        aiClassificationSettings: aiClassificationSettings as unknown as Prisma.InputJsonValue,
        updatedBy,
      },
    });
    await this.recordHistory(row as unknown as MethodologyConfigRow, "edit", updatedBy);
    return this.toConfig(row as unknown as MethodologyConfigRow);
  }

  async publish(): Promise<MethodologyConfig> {
    const existing = await this.findRowOrThrow();
    const publishedBy = requireActor();
    const row = await this.prisma.methodologyConfig.update({
      where: { id: existing.id },
      data: { status: "published", publishedBy, publishedAt: new Date(), updatedBy: publishedBy },
    });
    await this.recordHistory(row as unknown as MethodologyConfigRow, "publish", publishedBy);
    return this.toConfig(row as unknown as MethodologyConfigRow);
  }

  // RIO-NFR-017 (client-confirmed) — "retain full version history of every
  // methodology configuration change — never overwrite." One immutable
  // snapshot per update()/publish() call; see MethodologyConfigHistory's
  // own schema comment for why this lives in a separate append-only table
  // rather than versioning the MethodologyConfig row itself.
  async getHistory(): Promise<MethodologyConfigHistoryEntry[]> {
    const rows = await this.prisma.methodologyConfigHistory.findMany({
      orderBy: { changedAt: "desc" },
    });
    const names = await Promise.all(rows.map((r) => this.resolveActorName(r.changedBy)));
    return rows.map((r, i) => ({
      id: r.id,
      version: r.version,
      status: r.status,
      changeType: r.changeType as "edit" | "publish",
      priorityThresholds: r.priorityThresholds as unknown as PriorityThresholds,
      priorityFactorWeights: r.priorityFactorWeights as unknown as PriorityFactorWeight[],
      confidenceFlagSettings: r.confidenceFlagSettings as unknown as ConfidenceFlagSettings,
      // Same fallback as the live config read: history rows written before
      // this column existed carry the documented defaults, not undefined.
      aiClassificationSettings: this.readAiClassificationSettings(
        r as unknown as MethodologyConfigRow,
      ),
      changedByName: names[i] ?? null,
      changedAt: r.changedAt.toISOString(),
    }));
  }

  private async recordHistory(
    row: MethodologyConfigRow,
    changeType: "edit" | "publish",
    changedBy: string | null,
  ): Promise<void> {
    await this.prisma.methodologyConfigHistory.create({
      data: {
        configId: row.id,
        version: row.version,
        status: row.status,
        changeType,
        priorityThresholds: row.priorityThresholds as unknown as Prisma.InputJsonValue,
        priorityFactorWeights: row.priorityFactorWeights as unknown as Prisma.InputJsonValue,
        confidenceFlagSettings: row.confidenceFlagSettings as unknown as Prisma.InputJsonValue,
        // Read through the same fallback the live config uses, so a row
        // written before this column existed snapshots the documented
        // defaults rather than a null the history reader would choke on.
        aiClassificationSettings:
          this.readAiClassificationSettings(row) as unknown as Prisma.InputJsonValue,
        changedBy,
      },
    });
  }

  /** Internal accessor for other services (Priority/Response Quality) that
   * need the raw thresholds/weights without going through the controller/DTO shape. */
  async getRaw(): Promise<{
    priorityThresholds: PriorityThresholds;
    priorityFactorWeights: PriorityFactorWeight[];
    confidenceFlagSettings: ConfidenceFlagSettings;
    aiClassificationSettings: AiClassificationSettings;
  }> {
    const row = await this.findRowOrThrow();
    return {
      priorityThresholds: row.priorityThresholds as PriorityThresholds,
      priorityFactorWeights: row.priorityFactorWeights as PriorityFactorWeight[],
      confidenceFlagSettings: row.confidenceFlagSettings as ConfidenceFlagSettings,
      aiClassificationSettings: this.readAiClassificationSettings(row),
    };
  }

  // Same reasoning as validateThresholds below: a `veryLow` band above `low` would
  // make the reviewer UI's "worse than low" tier unreachable while still
  // looking configured, so it is rejected before it can be saved rather than
  // silently producing a band no suggestion can ever fall into.
  private validateAiClassificationSettings(settings: AiClassificationSettings): void {
    const { lowConfidenceThreshold, veryLowConfidenceThreshold } = settings;
    if (!(veryLowConfidenceThreshold < lowConfidenceThreshold)) {
      throw new BadRequestException({
        error: {
          code: "INVALID_CONFIDENCE_THRESHOLD_ORDER",
          message:
            "The very-low AI confidence threshold must be below the low AI confidence threshold.",
        },
      });
    }
  }

  // Rows written before the ai_classification_settings column existed (and
  // any row whose JSON was hand-edited to something unusable) read back as
  // the documented defaults rather than as NaN thresholds that would classify
  // every suggestion as low-confidence.
  private readAiClassificationSettings(row: MethodologyConfigRow): AiClassificationSettings {
    const raw = row.aiClassificationSettings as Partial<AiClassificationSettings> | null | undefined;
    const low = raw?.lowConfidenceThreshold;
    const veryLow = raw?.veryLowConfidenceThreshold;
    return {
      lowConfidenceThreshold:
        typeof low === "number" && Number.isFinite(low)
          ? low
          : DEFAULT_AI_CLASSIFICATION_SETTINGS.lowConfidenceThreshold,
      veryLowConfidenceThreshold:
        typeof veryLow === "number" && Number.isFinite(veryLow)
          ? veryLow
          : DEFAULT_AI_CLASSIFICATION_SETTINGS.veryLowConfidenceThreshold,
    };
  }

  // Critical > High > Medium is the methodology's own ordering (scope.md
  // §8's Priority Level Classification) — an inverted set of thresholds
  // would make mapPriorityLevel() in priority/scoring.ts produce nonsensical
  // rankings, so this is rejected before it's ever saved.
  private validateThresholds(thresholds: PriorityThresholds): void {
    const { criticalSeverity, highSeverity, mediumSeverity, equityHighSeverity } = thresholds;
    if (!(criticalSeverity > highSeverity && highSeverity > mediumSeverity)) {
      throw new BadRequestException({
        error: {
          code: "INVALID_THRESHOLD_ORDER",
          message: "Priority thresholds must satisfy Critical > High > Medium severity.",
        },
      });
    }
    if (equityHighSeverity > highSeverity) {
      throw new BadRequestException({
        error: {
          code: "INVALID_THRESHOLD_ORDER",
          message: "The equity-flag high-severity threshold can't exceed the plain high-severity threshold.",
        },
      });
    }
  }

  // Single global row, meant to always exist (seeded by migration — see
  // schema.prisma's comment on MethodologyConfig) — but nothing ever
  // enforced that after the fact. If it's ever missing (deleted directly,
  // or a fresh DB that skipped that migration's seed insert), this used to
  // 404 the entire Methodology Configuration page with no way to recover
  // short of a manual DB insert. Self-heals instead: recreate it with the
  // same defaults the original migration seeded, so the feature never goes
  // permanently dark just because the one row it depends on got deleted.
  private async findRowOrThrow(): Promise<MethodologyConfigRow> {
    const row = await this.prisma.methodologyConfig.findFirst();
    if (row) return row as unknown as MethodologyConfigRow;

    const created = await this.prisma.methodologyConfig.create({
      data: {
        version: "v5.0 - Approved methodology baseline",
        priorityThresholds: {
          criticalSeverity: 80,
          highSeverity: 70,
          mediumSeverity: 40,
          equityHighSeverity: 50,
        } satisfies PriorityThresholds as unknown as Prisma.InputJsonValue,
        priorityFactorWeights: [
          { key: "severity", label: "Severity", weight: 0.2 },
          { key: "affected_population", label: "Affected population", weight: 0.15 },
          { key: "service_availability_gap", label: "Service availability gap", weight: 0.12 },
          { key: "urgency", label: "Urgency", weight: 0.12 },
          { key: "data_confidence", label: "Data confidence", weight: 0.1 },
          { key: "frequency", label: "Frequency of similar needs", weight: 0.1 },
          { key: "geographic_coverage", label: "Geographic coverage", weight: 0.08 },
          { key: "vulnerable_groups", label: "Vulnerable groups (equity)", weight: 0.08 },
          { key: "strategic_alignment", label: "Strategic alignment", weight: 0.05 },
        ] satisfies PriorityFactorWeight[] as unknown as Prisma.InputJsonValue,
        confidenceFlagSettings: {
          dontKnowRatioThreshold: 0.2,
          minRespondentsForStandardConfidence: 10,
        } satisfies ConfidenceFlagSettings as unknown as Prisma.InputJsonValue,
        aiClassificationSettings:
          DEFAULT_AI_CLASSIFICATION_SETTINGS as unknown as Prisma.InputJsonValue,
      },
    });
    return created as unknown as MethodologyConfigRow;
  }

  // `users` is RLS-scoped per org; this global reference table has no
  // ambient org context to resolve it under, so the lookup goes through the
  // same SELECT-only cross-org supervisor path AuditService uses to resolve
  // actor names.
  private async resolveActorName(userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const user = await this.tenant.runAsSupervisor((tx) => tx.user.findUnique({ where: { id: userId }, select: { name: true } }));
    return user?.name ?? null;
  }

  private async toConfig(row: MethodologyConfigRow): Promise<MethodologyConfig> {
    const [publishedByName, updatedByName] = await Promise.all([
      this.resolveActorName(row.publishedBy),
      this.resolveActorName(row.updatedBy),
    ]);
    return {
      id: row.id,
      version: row.version,
      status: row.status,
      publishedByName,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      priorityThresholds: row.priorityThresholds as PriorityThresholds,
      priorityFactorWeights: row.priorityFactorWeights as PriorityFactorWeight[],
      confidenceFlagSettings: row.confidenceFlagSettings as ConfidenceFlagSettings,
      aiClassificationSettings: this.readAiClassificationSettings(row),
      updatedAt: row.updatedAt.toISOString(),
      updatedByName,
    };
  }
}
