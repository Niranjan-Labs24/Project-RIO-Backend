import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { requireActor, requireOrgId } from "../../tenancy/org-context";
import { AuditService } from "../audit/audit.service";
import { CleaningContextService } from "./cleaning-context.service";
import { isCrossOrgReader } from "./cross-org-reader";
import { DEFAULT_SETTINGS, type DataCleaningSettings } from "./data-cleaning.types";

/**
 * RIO-FR-002 / Q23 — tuning the rule set.
 *
 * The client's ruling: thresholds "start conservative and tune once real field
 * data exists", and tuning is owned by System Admin / Data Analyst — "the same
 * role that already receives low-confidence and override flags".
 *
 * ─── Why this is not on the Methodology Configuration screen ───────────────
 * The values live on `methodology_configs` alongside the priority weights, and
 * that screen already edits them — but it is gated on
 * `methodologyQuestionBank` and sits behind a System Reviewer approval gate.
 * Data Analyst holds neither. Putting cleaning thresholds there would hand
 * tuning to a role the client did not name and withhold it from one they did.
 *
 * So the values keep their home (one source of truth, one history table) and
 * get their own endpoint gated on `dataQuality:write`. What they do NOT get is
 * the approval gate: a detection threshold is an operational dial, not a
 * methodology change — retuning it alters what is PROPOSED next, never a
 * decision already taken, because every flag and candidate stores the
 * threshold it was raised under.
 *
 * RIO-NFR-017 still applies: every write snapshots history.
 */

/** Bounds that stop a typo silently disabling detection. */
const RANGE: Record<string, [number, number]> = {
  villageMatchAcceptThreshold: [0.5, 1],
  villageMatchProposeThreshold: [0.3, 1],
  literalDuplicateThreshold: [0.5, 1],
  classificationNearMatchThreshold: [0.3, 1],
  // Below 0.7 an embedding match is a topic, not a duplicate.
  semanticDuplicateThreshold: [0.7, 1],
  villageMatchMaxCandidates: [1, 20],
};

export interface CleaningSettingsView extends DataCleaningSettings {
  /** Where these came from, so the screen can say "defaults" honestly. */
  methodologyVersion: string;
}

@Injectable()
export class CleaningSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly context: CleaningContextService,
  ) {}

  async get(): Promise<CleaningSettingsView> {
    const config = await this.prisma.methodologyConfig.findFirst({
      select: { version: true, dataCleaningSettings: true },
    });
    if (!config) {
      throw new NotFoundException({
        error: {
          code: "NO_METHODOLOGY_CONFIG",
          message: "No methodology configuration exists to read cleaning settings from.",
        },
      });
    }
    const stored = (config.dataCleaningSettings ?? {}) as DataCleaningSettings;
    return { ...DEFAULT_SETTINGS, ...stored, methodologyVersion: config.version };
  }

  /**
   * Patch the rule set. Only the keys sent are changed — a screen that edits
   * one threshold must not silently reset the others to whatever it happened
   * to have loaded.
   */
  async update(patch: DataCleaningSettings): Promise<CleaningSettingsView> {
    const orgId = requireOrgId();
    const actor = requireActor();

    const config = await this.prisma.methodologyConfig.findFirst();
    if (!config) {
      throw new NotFoundException({
        error: {
          code: "NO_METHODOLOGY_CONFIG",
          message: "No methodology configuration exists to write cleaning settings to.",
        },
      });
    }

    const before = { ...DEFAULT_SETTINGS, ...((config.dataCleaningSettings ?? {}) as DataCleaningSettings) };
    const after = { ...before, ...patch };

    // Q9 — turning cross-entity matching ON is not a threshold tweak. It
    // decides whether one entity's need text may be shown to a reviewer at
    // another entity, so it belongs to the same roles that can read across the
    // boundary, not to everyone holding dataQuality:write.
    if (
      patch.duplicateScopes?.crossOrg === true &&
      before.duplicateScopes?.crossOrg !== true &&
      !isCrossOrgReader()
    ) {
      throw new ForbiddenException({
        error: {
          code: "CROSS_ORG_SCOPE_FORBIDDEN",
          message:
            "Only Center or NCNP oversight can enable cross-entity duplicate matching.",
        },
      });
    }

    for (const [key, [min, max]] of Object.entries(RANGE)) {
      const value = (after as Record<string, unknown>)[key];
      if (typeof value === "number" && (value < min || value > max)) {
        throw new NotFoundException({
          error: {
            code: "THRESHOLD_OUT_OF_RANGE",
            message: `${key} must be between ${min} and ${max}.`,
          },
        });
      }
    }
    // A propose threshold above the accept threshold means the shortlist band
    // is empty and every near match is either auto-proposed or invisible —
    // almost certainly a typo rather than an intent.
    if (
      typeof after.villageMatchProposeThreshold === "number" &&
      typeof after.villageMatchAcceptThreshold === "number" &&
      after.villageMatchProposeThreshold > after.villageMatchAcceptThreshold
    ) {
      throw new NotFoundException({
        error: {
          code: "THRESHOLD_ORDER",
          message:
            "The propose threshold cannot be higher than the accept threshold — nothing would ever be shortlisted.",
        },
      });
    }

    const updated = await this.prisma.methodologyConfig.update({
      where: { id: config.id },
      data: {
        dataCleaningSettings: after as unknown as Prisma.InputJsonValue,
        updatedBy: actor,
      },
      select: { id: true, version: true, status: true, dataCleaningSettings: true },
    });

    // RIO-NFR-017 — never overwrite without a history row.
    await this.prisma.methodologyConfigHistory.create({
      data: {
        configId: config.id,
        version: updated.version,
        status: updated.status,
        changeType: "edit",
        priorityThresholds: config.priorityThresholds as unknown as Prisma.InputJsonValue,
        priorityFactorWeights: config.priorityFactorWeights as unknown as Prisma.InputJsonValue,
        priorityFactorScales: config.priorityFactorScales as unknown as Prisma.InputJsonValue,
        confidenceFlagSettings: config.confidenceFlagSettings as unknown as Prisma.InputJsonValue,
        aiClassificationSettings: config.aiClassificationSettings as unknown as Prisma.InputJsonValue,
        aiSummarySettings: config.aiSummarySettings as unknown as Prisma.InputJsonValue,
        dataCleaningSettings: after as unknown as Prisma.InputJsonValue,
        changedBy: actor,
      },
    });

    // The context caches these for five minutes. Without this, a reviewer
    // retunes a threshold and sees no change until the cache expires.
    this.context.invalidate();

    const changes = Object.keys(patch)
      .filter((key) => JSON.stringify((before as Record<string, unknown>)[key]) !== JSON.stringify((after as Record<string, unknown>)[key]))
      .map((key) => ({
        field: key,
        before: JSON.stringify((before as Record<string, unknown>)[key]) ?? null,
        after: JSON.stringify((after as Record<string, unknown>)[key]),
      }));

    if (changes.length > 0) {
      await this.audit.record({
        action: "edit",
        entityType: "question",
        entityId: config.id,
        entityLabel: "Data quality rule set",
        organizationId: orgId,
        changes,
      });
    }

    return { ...after, methodologyVersion: updated.version };
  }
}
