import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { Prisma } from "../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { requireActor } from "../../tenancy/org-context";
import { requireNonBlank } from "../../common/validation/require-non-blank";
import type {
  AiClassificationSettings,
  PriorityFactorScales, AiSummarySettings, ConfidenceFlagSettings, MethodologyConfig,
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

/** RIO-AI-003's threshold, client-decided (25 Aug 2026): 1,500 characters for
 * every language. Mirrors the migration's column DEFAULT and backs the read
 * path for rows written before that column existed. */
export const DEFAULT_AI_SUMMARY_SETTINGS: AiSummarySettings = {
  statementLengthThreshold: 1500,
  maxSummaryChars: 600,
};

/** Mirrors the migration's seeded value, and backs the read path for a row
 *  written before the column existed. The derivation of the strategic values
 *  from the workbook's multipliers is documented in the migration. */
export const DEFAULT_PRIORITY_FACTOR_SCALES: PriorityFactorScales = {
  urgency: { immediate: 100, this_cycle: 70, next_cycle: 40, no_fixed_timeline: 10 },
  affectedPopulation: { floor: 0, ceiling: 1000 },
  geographicCoverage: { floor: 1, ceiling: 10 },
  frequency: { floor: 1, ceiling: 20 },
  equitySpreadThreshold: 50,
  strategicAxes: [
    { key: "non_profit_empowerment", label: "Non-profit sector empowerment", value: 100,
      domains: ["Governance & Services"],
      questionIds: ["GOV-11", "GOV-12", "SOC-07", "SOC-11", "GOV-05", "GOV-06"] },
    { key: "diversified_economy", label: "Diversified local economy", value: 67,
      domains: ["Livelihood", "Culture"], questionIds: ["INF-10", "INF-06"] },
    { key: "human_capability", label: "Human capability and empowerment", value: 50,
      domains: ["Education", "Social Development"],
      questionIds: ["LIV-13", "LIV-14", "LIV-15", "LIV-16", "LIV-17", "LIV-20"] },
    { key: "essential_services", label: "Essential services", value: 33,
      domains: ["Health", "Water & Sanitation", "Energy & Environment", "Infrastructure"],
      questionIds: [] },
  ],
};

/** The methodology baseline's starting thresholds/weights/confidence rule —
 * used both to self-heal a missing MethodologyConfig row and as getRaw()'s
 * safe fallback for a genuinely fresh environment that has never published
 * anything yet (see getRaw()'s own comment for why it must never fall back
 * to the live, possibly-pending-approval row instead). */
export const DEFAULT_PRIORITY_THRESHOLDS: PriorityThresholds = {
  criticalSeverity: 80,
  highSeverity: 70,
  mediumSeverity: 40,
  equityHighSeverity: 50,
};
export const DEFAULT_PRIORITY_FACTOR_WEIGHTS: PriorityFactorWeight[] = [
  { key: "severity", label: "Severity", weight: 0.2 },
  { key: "affected_population", label: "Affected population", weight: 0.15 },
  { key: "service_availability_gap", label: "Service availability gap", weight: 0.12 },
  { key: "urgency", label: "Urgency", weight: 0.12 },
  { key: "data_confidence", label: "Data confidence", weight: 0.1 },
  { key: "frequency", label: "Frequency of similar needs", weight: 0.1 },
  { key: "geographic_coverage", label: "Geographic coverage", weight: 0.08 },
  { key: "vulnerable_groups", label: "Vulnerable groups (equity)", weight: 0.08 },
  { key: "strategic_alignment", label: "Strategic alignment", weight: 0.05 },
];
export const DEFAULT_CONFIDENCE_FLAG_SETTINGS: ConfidenceFlagSettings = {
  dontKnowRatioThreshold: 0.2,
  minRespondentsForStandardConfidence: 10,
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
    const aiSummarySettings: AiSummarySettings = {
      ...this.readAiSummarySettings(existing),
      ...(payload.aiSummarySettings ?? {}),
    };
    const priorityFactorWeights: PriorityFactorWeight[] = payload.priorityFactorWeights
      ? (existing.priorityFactorWeights as PriorityFactorWeight[]).map((factor) => {
          const override = payload.priorityFactorWeights?.find((w) => w.key === factor.key);
          return override ? { ...factor, weight: override.weight } : factor;
        })
      : (existing.priorityFactorWeights as PriorityFactorWeight[]);

    const priorityFactorScales: PriorityFactorScales = {
      ...this.readPriorityFactorScales(existing),
      ...(payload.priorityFactorScales ?? {}),
    };

    this.validateThresholds(priorityThresholds);
    this.validateAiClassificationSettings(aiClassificationSettings);
    this.validateAiSummarySettings(aiSummarySettings);
    this.validatePriorityFactorScales(priorityFactorScales);

    // Any edit invalidates a prior approval and needs its own review —
    // client requirement: methodology weight/threshold changes go through
    // the same System Reviewer approval gate as Question Bank changes.
    const row = await this.prisma.methodologyConfig.update({
      where: { id: existing.id },
      data: {
        version: payload.version ?? existing.version,
        status: "pending_approval",
        reviewedBy: null,
        reviewedAt: null,
        reviewNotes: null,
        priorityThresholds: priorityThresholds as unknown as Prisma.InputJsonValue,
        priorityFactorWeights: priorityFactorWeights as unknown as Prisma.InputJsonValue,
        confidenceFlagSettings: confidenceFlagSettings as unknown as Prisma.InputJsonValue,
        aiClassificationSettings: aiClassificationSettings as unknown as Prisma.InputJsonValue,
        aiSummarySettings: aiSummarySettings as unknown as Prisma.InputJsonValue,
        priorityFactorScales: priorityFactorScales as unknown as Prisma.InputJsonValue,
        updatedBy,
      },
    });
    await this.recordHistory(row as unknown as MethodologyConfigRow, "edit", updatedBy);
    return this.toConfig(row as unknown as MethodologyConfigRow);
  }

  // System Reviewer only (methodologyQuestionBank:approve) — required
  // before System Admin can publish. Mandatory notes, same pattern as
  // NcnpReportReviewService.approve/reject and SurveysService's
  // approveSurvey/rejectSurvey.
  async approve(notes: string): Promise<MethodologyConfig> {
    requireNonBlank(notes, "REVIEWER_NOTES_REQUIRED", "Reviewer notes are required.");
    const existing = await this.findRowOrThrow();
    if (existing.status !== "pending_approval") {
      throw new ConflictException({
        error: { code: "METHODOLOGY_NOT_PENDING_APPROVAL", message: "This configuration is not currently awaiting approval." },
      });
    }
    const reviewedBy = requireActor();
    const row = await this.prisma.methodologyConfig.update({
      where: { id: existing.id },
      data: { status: "approved", reviewedBy, reviewedAt: new Date(), reviewNotes: notes },
    });
    await this.recordHistory(row as unknown as MethodologyConfigRow, "approve", reviewedBy);
    return this.toConfig(row as unknown as MethodologyConfigRow);
  }

  // Kicks the config back to draft — System Admin must revise and
  // resubmit (the next update() call moves it to pending_approval again).
  async reject(notes: string): Promise<MethodologyConfig> {
    requireNonBlank(notes, "REVIEWER_NOTES_REQUIRED", "Reviewer notes are required.");
    const existing = await this.findRowOrThrow();
    if (existing.status !== "pending_approval") {
      throw new ConflictException({
        error: { code: "METHODOLOGY_NOT_PENDING_APPROVAL", message: "This configuration is not currently awaiting approval." },
      });
    }
    const reviewedBy = requireActor();
    const row = await this.prisma.methodologyConfig.update({
      where: { id: existing.id },
      data: { status: "draft", reviewedBy, reviewedAt: new Date(), reviewNotes: notes },
    });
    await this.recordHistory(row as unknown as MethodologyConfigRow, "reject", reviewedBy);
    return this.toConfig(row as unknown as MethodologyConfigRow);
  }

  async publish(): Promise<MethodologyConfig> {
    const existing = await this.findRowOrThrow();
    if (existing.status !== "approved") {
      throw new ConflictException({
        error: {
          code: "METHODOLOGY_NOT_APPROVED",
          message: "This configuration must be approved by a System Reviewer before it can be published.",
        },
      });
    }
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
      changeType: r.changeType as "edit" | "approve" | "reject" | "publish",
      priorityThresholds: r.priorityThresholds as unknown as PriorityThresholds,
      priorityFactorWeights: r.priorityFactorWeights as unknown as PriorityFactorWeight[],
      confidenceFlagSettings: r.confidenceFlagSettings as unknown as ConfidenceFlagSettings,
      // Same fallback as the live config read: history rows written before
      // this column existed carry the documented defaults, not undefined.
      aiClassificationSettings: this.readAiClassificationSettings(
        r as unknown as MethodologyConfigRow,
      ),
      aiSummarySettings: this.readAiSummarySettings(r as unknown as MethodologyConfigRow),
      priorityFactorScales: this.readPriorityFactorScales(r as unknown as MethodologyConfigRow),
      changedByName: names[i] ?? null,
      changedAt: r.changedAt.toISOString(),
    }));
  }

  private async recordHistory(
    row: MethodologyConfigRow,
    changeType: "edit" | "approve" | "reject" | "publish",
    changedBy: string | null,
  ): Promise<void> {
    await this.prisma.methodologyConfigHistory.create({
      data: {
        configId: row.id,
        version: row.version,
        status: row.status,
        changeType,
        priorityFactorScales: row.priorityFactorScales as unknown as Prisma.InputJsonValue,
        priorityThresholds: row.priorityThresholds as unknown as Prisma.InputJsonValue,
        priorityFactorWeights: row.priorityFactorWeights as unknown as Prisma.InputJsonValue,
        confidenceFlagSettings: row.confidenceFlagSettings as unknown as Prisma.InputJsonValue,
        // Read through the same fallback the live config uses, so a row
        // written before this column existed snapshots the documented
        // defaults rather than a null the history reader would choke on.
        aiClassificationSettings:
          this.readAiClassificationSettings(row) as unknown as Prisma.InputJsonValue,
        aiSummarySettings:
          this.readAiSummarySettings(row) as unknown as Prisma.InputJsonValue,
        changedBy,
      },
    });
  }

  /** Internal accessor for other services (Priority/Response Quality/AI
   * Classification/Need Summary) that need the raw thresholds/weights
   * without going through the controller/DTO shape.
   *
   * Bug fix (found during a methodology-governance audit): this used to read
   * `findRowOrThrow()` directly — the live, editable row `update()` writes
   * to. Since that row's `status` was never filtered on, a System Admin
   * edit sitting in `pending_approval` (or freshly `rejected`) was already
   * live for every real score calculation the instant it was saved, with
   * zero System Reviewer involvement — the approval gate only blocked the
   * `publish()` call and hid the Publish button, it never protected the
   * actual computation. Verified live: edited a threshold, left it
   * unapproved, and `getRaw()` returned the edited value immediately.
   *
   * Fixed by always preferring the last successfully **published**
   * snapshot (`MethodologyConfigHistory` where `changeType: 'publish'`,
   * newest first) over the live row. The live row is still what
   * `get()`/`update()`/`approve()`/`reject()`/`publish()` read and write —
   * System Admin/Reviewer need to see and act on the pending edit — only
   * this read-only accessor, the one every scoring/classification/
   * summarization consumer calls, is isolated from unpublished changes.
   * Falls back to the safe seed defaults — never the live row — when
   * nothing has ever been published yet (a fresh environment before its
   * first publish action). This deliberately does NOT fall back to the
   * live row's current values: that row could itself be sitting in
   * `pending_approval` with no prior publish to fall back to, which would
   * silently reopen the exact leak this fix closes.
   */
  async getRaw(): Promise<{
    priorityThresholds: PriorityThresholds;
    priorityFactorWeights: PriorityFactorWeight[];
    confidenceFlagSettings: ConfidenceFlagSettings;
    aiClassificationSettings: AiClassificationSettings;
    aiSummarySettings: AiSummarySettings;
    priorityFactorScales: PriorityFactorScales;
  }> {
    // Ensures the row exists (self-heals a missing one) — its VALUES are
    // deliberately never read below; see the comment above.
    await this.findRowOrThrow();
    const published = await this.prisma.methodologyConfigHistory.findFirst({
      where: { changeType: "publish" },
      orderBy: { changedAt: "desc" },
    });
    if (!published) {
      return {
        priorityThresholds: DEFAULT_PRIORITY_THRESHOLDS,
        priorityFactorWeights: DEFAULT_PRIORITY_FACTOR_WEIGHTS,
        confidenceFlagSettings: DEFAULT_CONFIDENCE_FLAG_SETTINGS,
        aiClassificationSettings: DEFAULT_AI_CLASSIFICATION_SETTINGS,
        aiSummarySettings: DEFAULT_AI_SUMMARY_SETTINGS,
        priorityFactorScales: DEFAULT_PRIORITY_FACTOR_SCALES,
      };
    }
    const source = published as unknown as MethodologyConfigRow;
    return {
      priorityThresholds: source.priorityThresholds as PriorityThresholds,
      priorityFactorWeights: source.priorityFactorWeights as PriorityFactorWeight[],
      confidenceFlagSettings: source.confidenceFlagSettings as ConfidenceFlagSettings,
      aiClassificationSettings: this.readAiClassificationSettings(source),
      aiSummarySettings: this.readAiSummarySettings(source),
      priorityFactorScales: this.readPriorityFactorScales(source),
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

  // A maxSummaryChars at or above the trigger threshold makes the feature a
  // no-op that still looks configured: every statement long enough to be
  // summarised would be allowed to come back at its original length. Rejected
  // before it can be saved, for the same reason as the confidence bands above.
  /** Per-field fallback, same shape as readAiSummarySettings: a row written
   *  before the column existed reads back as {}, and a partially-populated one
   *  must not produce undefined ranges that would make every factor NaN. */
  private readPriorityFactorScales(row: MethodologyConfigRow): PriorityFactorScales {
    const raw = row.priorityFactorScales as Partial<PriorityFactorScales> | null | undefined;
    const d = DEFAULT_PRIORITY_FACTOR_SCALES;
    const range = (v: unknown, fallback: { floor: number; ceiling: number }) => {
      const r = v as Partial<{ floor: number; ceiling: number }> | undefined;
      return {
        floor: typeof r?.floor === "number" && Number.isFinite(r.floor) ? r.floor : fallback.floor,
        ceiling:
          typeof r?.ceiling === "number" && Number.isFinite(r.ceiling) ? r.ceiling : fallback.ceiling,
      };
    };
    return {
      urgency:
        raw?.urgency && Object.keys(raw.urgency).length > 0 ? raw.urgency : d.urgency,
      affectedPopulation: range(raw?.affectedPopulation, d.affectedPopulation),
      geographicCoverage: range(raw?.geographicCoverage, d.geographicCoverage),
      frequency: range(raw?.frequency, d.frequency),
      strategicAxes:
        Array.isArray(raw?.strategicAxes) && raw.strategicAxes.length > 0
          ? raw.strategicAxes
          : d.strategicAxes,
      equitySpreadThreshold:
        typeof raw?.equitySpreadThreshold === 'number' && Number.isFinite(raw.equitySpreadThreshold)
          ? raw.equitySpreadThreshold
          : d.equitySpreadThreshold,
    };
  }

  /** A range whose ceiling is at or below its floor cannot produce a 0-100
   *  value at all — every input would land outside it — so the factor would
   *  silently contribute nothing while still looking configured. Same class of
   *  dead-setting bug validateAiClassificationSettings guards against. */
  private validatePriorityFactorScales(scales: PriorityFactorScales): void {
    const ranges: Array<[string, { floor: number; ceiling: number }]> = [
      ["affectedPopulation", scales.affectedPopulation],
      ["geographicCoverage", scales.geographicCoverage],
      ["frequency", scales.frequency],
    ];
    for (const [name, r] of ranges) {
      if (!(r.ceiling > r.floor)) {
        throw new BadRequestException({
          error: {
            code: "INVALID_FACTOR_SCALE",
            message: `${name}: ceiling must be greater than floor.`,
          },
        });
      }
    }
    if (scales.equitySpreadThreshold < 0 || scales.equitySpreadThreshold > 100) {
      throw new BadRequestException({
        error: {
          code: 'INVALID_FACTOR_SCALE',
          message: 'equitySpreadThreshold: must be between 0 and 100.',
        },
      });
    }
    for (const [level, value] of Object.entries(scales.urgency)) {
      if (typeof value !== "number" || value < 0 || value > 100) {
        throw new BadRequestException({
          error: {
            code: "INVALID_FACTOR_SCALE",
            message: `urgency.${level}: value must be between 0 and 100.`,
          },
        });
      }
    }
  }

  private validateAiSummarySettings(settings: AiSummarySettings): void {
    const { statementLengthThreshold, maxSummaryChars } = settings;
    if (!(maxSummaryChars < statementLengthThreshold)) {
      throw new BadRequestException({
        error: {
          code: "INVALID_SUMMARY_LENGTH_ORDER",
          message:
            "The maximum summary length must be below the statement length threshold that triggers summarisation.",
        },
      });
    }
  }

  // Same fallback contract as readAiClassificationSettings below: a row
  // written before the ai_summary_settings column existed reads back as the
  // documented defaults, never as NaN — a NaN threshold would compare false
  // against every length and silently disable summarisation everywhere.
  private readAiSummarySettings(row: MethodologyConfigRow): AiSummarySettings {
    const raw = row.aiSummarySettings as Partial<AiSummarySettings> | null | undefined;
    const threshold = raw?.statementLengthThreshold;
    const maxChars = raw?.maxSummaryChars;
    return {
      statementLengthThreshold:
        typeof threshold === "number" && Number.isFinite(threshold)
          ? threshold
          : DEFAULT_AI_SUMMARY_SETTINGS.statementLengthThreshold,
      maxSummaryChars:
        typeof maxChars === "number" && Number.isFinite(maxChars)
          ? maxChars
          : DEFAULT_AI_SUMMARY_SETTINGS.maxSummaryChars,
    };
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
        priorityThresholds: DEFAULT_PRIORITY_THRESHOLDS as unknown as Prisma.InputJsonValue,
        priorityFactorWeights: DEFAULT_PRIORITY_FACTOR_WEIGHTS as unknown as Prisma.InputJsonValue,
        confidenceFlagSettings: DEFAULT_CONFIDENCE_FLAG_SETTINGS as unknown as Prisma.InputJsonValue,
        aiClassificationSettings:
          DEFAULT_AI_CLASSIFICATION_SETTINGS as unknown as Prisma.InputJsonValue,
        aiSummarySettings: DEFAULT_AI_SUMMARY_SETTINGS as unknown as Prisma.InputJsonValue,
        priorityFactorScales: DEFAULT_PRIORITY_FACTOR_SCALES as unknown as Prisma.InputJsonValue,
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
    const [publishedByName, updatedByName, reviewedByName] = await Promise.all([
      this.resolveActorName(row.publishedBy),
      this.resolveActorName(row.updatedBy),
      this.resolveActorName(row.reviewedBy),
    ]);
    return {
      id: row.id,
      version: row.version,
      status: row.status,
      publishedByName,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      reviewedByName,
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
      reviewNotes: row.reviewNotes,
      priorityThresholds: row.priorityThresholds as PriorityThresholds,
      priorityFactorWeights: row.priorityFactorWeights as PriorityFactorWeight[],
      confidenceFlagSettings: row.confidenceFlagSettings as ConfidenceFlagSettings,
      aiClassificationSettings: this.readAiClassificationSettings(row),
      aiSummarySettings: this.readAiSummarySettings(row),
      priorityFactorScales: this.readPriorityFactorScales(row),
      updatedAt: row.updatedAt.toISOString(),
      updatedByName,
    };
  }
}
