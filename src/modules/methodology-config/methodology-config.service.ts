import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { requireActor } from "../../tenancy/org-context";
import type {
  ConfidenceFlagSettings, MethodologyConfig, MethodologyConfigRow, MethodologyVersionOption,
  PriorityFactorWeight, PriorityThresholds, UpdateMethodologyConfigPayload,
} from "./methodology-config.types";

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

  // TEMPORARY — see the MethodologyVersionOption model comment in
  // schema.prisma. Backs the Survey workflow's "select a Methodology
  // Version before Submit for Approval" requirement until the real source
  // of versions is clarified.
  async listVersionOptions(): Promise<MethodologyVersionOption[]> {
    const rows = await this.prisma.methodologyVersionOption.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
      select: { id: true, version: true },
    });
    return rows;
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
    const priorityFactorWeights: PriorityFactorWeight[] = payload.priorityFactorWeights
      ? (existing.priorityFactorWeights as PriorityFactorWeight[]).map((factor) => {
          const override = payload.priorityFactorWeights?.find((w) => w.key === factor.key);
          return override ? { ...factor, weight: override.weight } : factor;
        })
      : (existing.priorityFactorWeights as PriorityFactorWeight[]);

    this.validateThresholds(priorityThresholds);

    const row = await this.prisma.methodologyConfig.update({
      where: { id: existing.id },
      data: {
        version: payload.version ?? existing.version,
        priorityThresholds: priorityThresholds as unknown as Prisma.InputJsonValue,
        priorityFactorWeights: priorityFactorWeights as unknown as Prisma.InputJsonValue,
        confidenceFlagSettings: confidenceFlagSettings as unknown as Prisma.InputJsonValue,
        updatedBy,
      },
    });
    return this.toConfig(row as unknown as MethodologyConfigRow);
  }

  async publish(): Promise<MethodologyConfig> {
    const existing = await this.findRowOrThrow();
    const publishedBy = requireActor();
    const row = await this.prisma.methodologyConfig.update({
      where: { id: existing.id },
      data: { status: "published", publishedBy, publishedAt: new Date(), updatedBy: publishedBy },
    });
    return this.toConfig(row as unknown as MethodologyConfigRow);
  }

  /** Internal accessor for other services (Priority/Response Quality) that
   * need the raw thresholds/weights without going through the controller/DTO shape. */
  async getRaw(): Promise<{
    priorityThresholds: PriorityThresholds;
    priorityFactorWeights: PriorityFactorWeight[];
    confidenceFlagSettings: ConfidenceFlagSettings;
  }> {
    const row = await this.findRowOrThrow();
    return {
      priorityThresholds: row.priorityThresholds as PriorityThresholds,
      priorityFactorWeights: row.priorityFactorWeights as PriorityFactorWeight[],
      confidenceFlagSettings: row.confidenceFlagSettings as ConfidenceFlagSettings,
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

  private async findRowOrThrow(): Promise<MethodologyConfigRow> {
    const row = await this.prisma.methodologyConfig.findFirst();
    if (!row) {
      throw new NotFoundException({ error: { code: "METHODOLOGY_CONFIG_NOT_FOUND", message: "Methodology configuration not found" } });
    }
    return row as unknown as MethodologyConfigRow;
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
      updatedAt: row.updatedAt.toISOString(),
      updatedByName,
    };
  }
}
