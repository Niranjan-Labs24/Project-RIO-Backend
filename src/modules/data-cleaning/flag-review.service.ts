import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "../../generated/prisma";
import { requireActor, requireOrgId } from "../../tenancy/org-context";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { AuditService } from "../audit/audit.service";
import { CleaningContextService } from "./cleaning-context.service";
import type { ListFlagsQueryDto } from "./data-cleaning.contract";
import { normalizePhone } from "./normalizers";

/**
 * RIO-FR-002 — the reviewer queue: reading flags, and deciding on them.
 *
 * Kept apart from DataCleaningService deliberately. That class PRODUCES flags
 * and is forbidden from touching a record; this one is the only place in
 * FR-002 that ever writes to a Need or a SurveyResponse, and it does so only
 * on an explicit human decision (Q11). Two classes means the "never mutates"
 * rule on the producing side is a property you can read off the file, not a
 * convention you have to audit call by call.
 */

const DEFAULT_PAGE_SIZE = 25;

/** Need columns a standardization may be written to. */
const WRITABLE_NEED_FIELDS = new Set(["title", "statement", "domain", "subDomain"]);

/** village[0], village[12] — the index matters, the flag is per value. */
const VILLAGE_FIELD = /^village\[(\d+)\]$/;

/** answers[HLT-02] — one numeric answer inside the response's answers JSON. */
const ANSWER_FIELD = /^answers\[([^\]]+)\]$/;

export interface FlagListItem {
  id: string;
  source: string;
  entityType: string;
  entityId: string | null;
  entityLabel: string | null;
  rowNumber: number | null;
  field: string;
  ruleCode: string;
  severity: string;
  originalValue: string | null;
  proposedValue: string | null;
  confidence: number | null;
  detail: unknown;
  status: string;
  note: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  /** False when accepting is impossible — nothing to write. */
  acceptable: boolean;
}

@Injectable()
export class FlagReviewService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly context: CleaningContextService,
  ) {}

  async list(
    query: Omit<ListFlagsQueryDto, 'page' | 'pageSize'> & { page?: number; pageSize?: number },
  ): Promise<{ items: FlagListItem[]; total: number }> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.CleaningFlagWhereInput = {
      // Default to the QUEUE, not the archive: a reviewer opening this screen
      // wants what still needs deciding.
      status: query.status ?? "pending",
      ...(query.source ? { source: query.source } : {}),
      ...(query.severity ? { severity: query.severity } : {}),
      ...(query.ruleCode ? { ruleCode: query.ruleCode } : {}),
      ...(query.studyId ? { studyId: query.studyId } : {}),
    };

    return this.tenant.runInOrgContext(async (tx) => {
      const [rows, total] = await Promise.all([
        tx.cleaningFlag.findMany({
          where,
          orderBy: [{ severity: "asc" }, { createdAt: "asc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        tx.cleaningFlag.count({ where }),
      ]);

      // Label the records so the queue reads as "NEED-000042, village" rather
      // than as a list of uuids. One extra query for the page, not one per row.
      const needIds = rows
        .filter((r) => r.entityType === "need" && r.entityId)
        .map((r) => r.entityId as string);
      const needs = needIds.length
        ? await tx.need.findMany({
            where: { id: { in: needIds } },
            select: { id: true, internalRefSeq: true, title: true },
          })
        : [];
      const labelById = new Map(
        needs.map((n) => [n.id, `NEED-${String(n.internalRefSeq).padStart(6, "0")} · ${n.title}`]),
      );

      return {
        total,
        items: rows.map((row) => ({
          id: row.id,
          source: row.source,
          entityType: row.entityType,
          entityId: row.entityId,
          entityLabel:
            row.entityType === "import_row"
              ? `Row ${row.rowNumber ?? "?"}`
              : (labelById.get(row.entityId ?? "") ?? null),
          rowNumber: row.rowNumber,
          field: row.field,
          ruleCode: row.ruleCode,
          severity: row.severity,
          originalValue: row.originalValue,
          proposedValue: row.proposedValue,
          confidence: row.confidence === null ? null : Number(row.confidence),
          detail: row.detail,
          status: row.status,
          note: row.note,
          reviewedAt: row.reviewedAt,
          createdAt: row.createdAt,
          acceptable: this.isAcceptable(row.entityType, row.field, row.proposedValue, row.detail),
        })),
      };
    });
  }

  /** Q14's per-source report: what was flagged, by source and by rule. */
  async summary(): Promise<{
    bySource: { source: string; status: string; count: number }[];
    byRule: { ruleCode: string; severity: string; source: string; count: number }[];
    lastRunAt: Date | null;
  }> {
    return this.tenant.runInOrgContext(async (tx) => {
      const [bySource, byRule, lastRun] = await Promise.all([
        tx.cleaningFlag.groupBy({ by: ["source", "status"], _count: { _all: true } }),
        tx.cleaningFlag.groupBy({
          by: ["ruleCode", "severity", "source"],
          where: { status: "pending" },
          _count: { _all: true },
        }),
        tx.cleaningRun.findFirst({ orderBy: { startedAt: "desc" }, select: { startedAt: true } }),
      ]);
      return {
        bySource: bySource.map((r) => ({
          source: r.source,
          status: r.status,
          count: r._count._all,
        })),
        byRule: byRule
          .map((r) => ({
            ruleCode: r.ruleCode,
            severity: r.severity,
            source: r.source,
            count: r._count._all,
          }))
          .sort((a, b) => b.count - a.count),
        lastRunAt: lastRun?.startedAt ?? null,
      };
    });
  }

  /**
   * One reviewer decision (AC 4).
   *
   * accept — write the proposal onto the record, then mark the flag accepted.
   * reject — the stored value is correct as it stands; the record is untouched.
   *
   * A rejection REQUIRES a note. Accepting a proposal needs no explanation
   * (the proposal is the explanation), but overruling the rule set is exactly
   * the decision a later reader will want a reason for — and it is the one the
   * client's own "mandatory note" pattern covers everywhere else (score
   * overrides, merge undo).
   */
  async review(
    flagId: string,
    decision: "accept" | "reject",
    note: string | undefined,
  ): Promise<FlagListItem> {
    const orgId = requireOrgId();
    const actor = requireActor();

    if (decision === "reject" && !note?.trim()) {
      throw new BadRequestException({
        error: {
          code: "NOTE_REQUIRED",
          message: "A note is required when rejecting a proposed correction.",
        },
      });
    }

    const context = await this.context.load();

    const { flag, applied } = await this.tenant.runInOrgContext(async (tx) => {
      const existing = await tx.cleaningFlag.findUnique({ where: { id: flagId } });
      if (!existing) {
        throw new NotFoundException({
          error: { code: "FLAG_NOT_FOUND", message: "Data quality flag not found." },
        });
      }
      if (existing.status !== "pending") {
        // Two reviewers on the same queue is the normal case, not an edge one.
        throw new BadRequestException({
          error: {
            code: "FLAG_ALREADY_DECIDED",
            message: `This flag was already ${existing.status}.`,
          },
        });
      }

      let applied: { field: string; before: string | null; after: string } | null = null;
      if (decision === "accept") {
        applied = await this.applyProposal(tx, existing, context.settings.phoneDefaultRegion);
      }

      const updated = await tx.cleaningFlag.update({
        where: { id: flagId },
        data: {
          status: decision === "accept" ? "accepted" : "rejected",
          reviewedBy: actor,
          reviewedAt: new Date(),
          note: note?.trim() || null,
        },
      });
      return { flag: updated, applied };
    });

    // AC 4. Recorded against the FLAG, so an auditor can see every decision
    // made on the queue in one filter.
    await this.audit.record({
      action: "review_cleaning_flag",
      entityType: "cleaning_flag",
      entityId: flag.id,
      entityLabel: `${flag.ruleCode} on ${flag.field}`,
      organizationId: orgId,
      changes: [
        { field: "Decision", before: "pending", after: decision === "accept" ? "accepted" : "rejected" },
        { field: "Rule", before: null, after: flag.ruleCode },
        { field: "Note", before: null, after: note?.trim() ?? null },
      ],
    });

    // And separately against the record, when a value actually moved. An
    // auditor asking "what changed this need's data" filters on this action;
    // a rejection never produces one.
    if (applied) {
      // Correcting a numeric ANSWER leaves the response's severity score
      // stale — see applyToAnswer for why re-scoring cannot run here. Recorded
      // on the audit entry so nobody reads an accepted correction as
      // "the score now includes this".
      const answerCorrected = ANSWER_FIELD.test(applied.field);
      await this.audit.record({
        action: "apply_standardization",
        entityType: flag.entityType === "need" ? "need" : "survey_response",
        entityId: flag.entityId ?? flag.id,
        entityLabel: `${flag.ruleCode} applied to ${applied.field}`,
        organizationId: orgId,
        changes: [
          { field: applied.field, before: applied.before, after: applied.after },
          ...(answerCorrected
            ? [
                {
                  field: "Severity score",
                  before: null,
                  after: "stale — this response needs re-scoring",
                },
              ]
            : []),
        ],
      });
    }

    return {
      id: flag.id,
      source: flag.source,
      entityType: flag.entityType,
      entityId: flag.entityId,
      entityLabel: null,
      rowNumber: flag.rowNumber,
      field: flag.field,
      ruleCode: flag.ruleCode,
      severity: flag.severity,
      originalValue: flag.originalValue,
      proposedValue: flag.proposedValue,
      confidence: flag.confidence === null ? null : Number(flag.confidence),
      detail: flag.detail,
      status: flag.status,
      note: flag.note,
      reviewedAt: flag.reviewedAt,
      createdAt: flag.createdAt,
      // A decided flag is never acceptable again.
      acceptable: false,
    };
  }

  /**
   * Accept every pending flag of one rule code.
   *
   * Scoped to a single rule on purpose. A date reformat is the same
   * deterministic change on every row it touches, and asking a reviewer to
   * click it three hundred times is how a queue gets abandoned. A village
   * near-match is a judgement about a specific place, and no bulk action
   * should ever cover it — the controller rejects any rule whose proposals
   * carry a confidence score, because carrying one is exactly what makes a
   * proposal a judgement rather than a reformat.
   */
  async bulkAccept(
    ruleCode: string,
    source: string | undefined,
    note: string | undefined,
  ): Promise<{ accepted: number; skipped: number }> {
    const context = await this.context.load();
    const orgId = requireOrgId();
    const actor = requireActor();

    const { accepted, skipped } = await this.tenant.runInOrgContext(async (tx) => {
      const pending = await tx.cleaningFlag.findMany({
        where: {
          status: "pending",
          ruleCode,
          ...(source ? { source } : {}),
          // A judgement never bulk-applies. Belt and braces with the
          // controller's own check.
          confidence: null,
          proposedValue: { not: null },
        },
      });

      let accepted = 0;
      let skipped = 0;
      for (const flag of pending) {
        try {
          await this.applyProposal(tx, flag, context.settings.phoneDefaultRegion);
          await tx.cleaningFlag.update({
            where: { id: flag.id },
            data: {
              status: "accepted",
              reviewedBy: actor,
              reviewedAt: new Date(),
              note: note?.trim() || null,
            },
          });
          accepted++;
        } catch {
          // One unapplicable row must not abandon the other 299. It stays
          // pending and the reviewer sees it individually.
          skipped++;
        }
      }
      return { accepted, skipped };
    });

    if (accepted > 0) {
      await this.audit.record({
        action: "review_cleaning_flag",
        entityType: "cleaning_flag",
        entityId: orgId,
        entityLabel: `Bulk-accepted ${accepted} ${ruleCode} correction(s)`,
        organizationId: orgId,
        changes: [
          { field: "Rule", before: null, after: ruleCode },
          { field: "Accepted", before: null, after: accepted },
          { field: "Skipped", before: null, after: skipped },
          { field: "Note", before: null, after: note?.trim() ?? null },
        ],
      });
    }

    return { accepted, skipped };
  }

  // ── applying a proposal ──────────────────────────────────────────────────

  /**
   * Whether a flag can be accepted at all.
   *
   * A MISSING_REQUIRED flag never can: there is nothing to write, and the fix
   * is for someone to edit the record — which supersedes the flag on the next
   * run. The queue shows those as findings to act on elsewhere, not as
   * one-click corrections. An import_row flag never can either: the row is in
   * the uploader's file, not in the database.
   */
  private isAcceptable(
    entityType: string,
    field: string,
    proposedValue: string | null,
    detail: unknown,
  ): boolean {
    if (entityType === "import_row") return false;
    if (proposedValue !== null) return true;
    // A redacted PII flag carries no proposal by design — the value is
    // recomputed at accept time instead. See survey-response.rules.ts.
    return this.isRedacted(detail) && entityType === "survey_response" && field === "mobile";
  }

  private isRedacted(detail: unknown): boolean {
    return (
      typeof detail === "object" &&
      detail !== null &&
      (detail as Record<string, unknown>).redacted === true
    );
  }

  private async applyProposal(
    tx: Prisma.TransactionClient,
    flag: {
      id: string;
      entityType: string;
      entityId: string | null;
      field: string;
      proposedValue: string | null;
      detail: unknown;
    },
    phoneRegion: string,
  ): Promise<{ field: string; before: string | null; after: string }> {
    if (!this.isAcceptable(flag.entityType, flag.field, flag.proposedValue, flag.detail)) {
      throw new BadRequestException({
        error: {
          code: "NOTHING_TO_APPLY",
          message:
            "This finding has no correction to apply — it reports something that has to be fixed on the record itself.",
        },
      });
    }
    if (!flag.entityId) {
      throw new BadRequestException({
        error: { code: "NOTHING_TO_APPLY", message: "This finding has no record to correct." },
      });
    }

    if (flag.entityType === "need") return this.applyToNeed(tx, flag.entityId, flag);
    if (flag.entityType === "survey_response") {
      return this.applyToSurveyResponse(tx, flag.entityId, flag, phoneRegion);
    }
    throw new BadRequestException({
      error: { code: "NOTHING_TO_APPLY", message: "Unsupported record type." },
    });
  }

  private async applyToNeed(
    tx: Prisma.TransactionClient,
    needId: string,
    flag: { field: string; proposedValue: string | null },
  ): Promise<{ field: string; before: string | null; after: string }> {
    const need = await tx.need.findUnique({
      where: { id: needId },
      select: { id: true, title: true, statement: true, domain: true, subDomain: true, village: true },
    });
    if (!need) {
      throw new NotFoundException({
        error: { code: "NEED_NOT_FOUND", message: "The need this finding refers to no longer exists." },
      });
    }
    const value = flag.proposedValue!;

    const villageMatch = VILLAGE_FIELD.exec(flag.field);
    if (villageMatch) {
      const index = Number(villageMatch[1]);
      const before = need.village[index] ?? null;
      // The proposal is a CENTER CODE — resolve it back to the canonical name,
      // because what is being standardized is the free-text village string.
      //
      // Deliberately does NOT add the Center to the Need's geography links.
      // NeedCenter rows must stay within the owning Study's selected scope
      // (NeedsService enforces that, the FK cannot), so writing one here could
      // put a Need outside its own Study's area — a change to what the Need
      // covers, which is a research decision and not a spelling correction.
      const center = await tx.center.findUnique({
        where: { code: value },
        select: { name: true },
      });
      if (!center) {
        throw new BadRequestException({
          error: {
            code: "REFERENCE_NOT_FOUND",
            message: "The matched place is no longer in the geographic reference.",
          },
        });
      }
      const village = [...need.village];
      village[index] = center.name;
      await tx.need.update({ where: { id: needId }, data: { village } });
      return { field: flag.field, before, after: center.name };
    }

    if (!WRITABLE_NEED_FIELDS.has(flag.field)) {
      throw new BadRequestException({
        error: { code: "NOTHING_TO_APPLY", message: `Cannot correct "${flag.field}" automatically.` },
      });
    }

    const before = (need as unknown as Record<string, string | null>)[flag.field] ?? null;
    await tx.need.update({ where: { id: needId }, data: { [flag.field]: value } });

    // Need.domain/subDomain MIRROR the first needDomains row — schema.prisma
    // is explicit that the pair must never be written without the matching
    // rows. Correcting the spelling of a domain and leaving needDomains on the
    // old spelling would put the authoritative field and its source of truth
    // out of step, which is the exact bug that comment exists to prevent.
    if (flag.field === "domain" || flag.field === "subDomain") {
      const first = await tx.needDomain.findFirst({
        where: { needId },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (first) {
        await tx.needDomain.update({ where: { id: first.id }, data: { [flag.field]: value } });
      }
    }

    return { field: flag.field, before, after: value };
  }

  private async applyToSurveyResponse(
    tx: Prisma.TransactionClient,
    responseId: string,
    flag: { field: string; proposedValue: string | null; detail: unknown },
    phoneRegion: string,
  ): Promise<{ field: string; before: string | null; after: string }> {
    const response = await tx.surveyResponse.findUnique({
      where: { id: responseId },
      select: { id: true, mobile: true, answers: true },
    });
    if (!response) {
      throw new NotFoundException({
        error: {
          code: "RESPONSE_NOT_FOUND",
          message: "The response this finding refers to no longer exists.",
        },
      });
    }
    // A numeric answer correction rewrites one entry in the response's own
    // answers JSON.
    const answerMatch = ANSWER_FIELD.exec(flag.field);
    if (answerMatch) {
      return this.applyToAnswer(tx, responseId, flag);
    }

    if (flag.field !== "mobile") {
      throw new BadRequestException({
        error: { code: "NOTHING_TO_APPLY", message: `Cannot correct "${flag.field}" automatically.` },
      });
    }

    // The flag carries no proposed value for a PII field — RECOMPUTE it from
    // the live row. This is exactly why the normalizers are pure functions:
    // the same input yields the same output, so nothing had to be stored in a
    // reviewer-facing table to reproduce what the reviewer approved.
    const recomputed = normalizePhone(response.mobile, {
      field: "mobile",
      required: false,
      dontKnowTreatment: "excluded_answer",
      defaultRegion: phoneRegion,
    });
    if (recomputed.value === null || !recomputed.changed) {
      throw new BadRequestException({
        error: {
          code: "NOTHING_TO_APPLY",
          message: "This number no longer needs correcting — it may have been edited since.",
        },
      });
    }

    await tx.surveyResponse.update({
      where: { id: responseId },
      data: { mobile: recomputed.value },
    });
    // The audit entry must not carry the number either: the before/after here
    // is the SHAPE of the change, not the respondent's phone.
    return { field: "mobile", before: "(unstandardized)", after: "(E.164)" };
  }

  /**
   * Write a corrected numeric answer back into SurveyResponse.answers.
   *
   * ─── The scoring caveat, stated rather than hidden ────────────────────────
   * This does NOT re-score the response, and it deliberately must not:
   * DeterministicScoringService.scoreResponse has no delete step, so calling it
   * a second time would append a duplicate ResponseAnswer and a duplicate
   * ResponseSeverityScore rather than replacing them.
   *
   * That is not a regression this introduces. The answer being corrected is one
   * `Number(raw)` already turned into NaN and dropped, so it was never in the
   * score to begin with — before and after, the score is missing it. Applying
   * the correction strictly improves the stored data and leaves the score
   * exactly as stale as it already was.
   *
   * The audit entry says so explicitly, so nobody reads an accepted correction
   * as "the score now includes this". A re-scoring trigger is its own piece of
   * work and needs scoreResponse to become idempotent first.
   */
  private async applyToAnswer(
    tx: Prisma.TransactionClient,
    responseId: string,
    flag: { field: string; proposedValue: string | null; detail: unknown },
  ): Promise<{ field: string; before: string | null; after: string }> {
    const detail = (flag.detail ?? {}) as { surveyQuestionId?: string };
    const surveyQuestionId = detail.surveyQuestionId;
    if (!surveyQuestionId || flag.proposedValue === null) {
      throw new BadRequestException({
        error: {
          code: "NOTHING_TO_APPLY",
          message: "This finding has no correction that can be written back to the answer.",
        },
      });
    }

    const response = await tx.surveyResponse.findUnique({
      where: { id: responseId },
      select: { answers: true },
    });
    if (!response) {
      throw new NotFoundException({
        error: {
          code: "RESPONSE_NOT_FOUND",
          message: "The response this finding refers to no longer exists.",
        },
      });
    }

    const answers = { ...((response.answers ?? {}) as Record<string, unknown>) };
    const before = answers[surveyQuestionId];
    if (before === undefined) {
      throw new BadRequestException({
        error: {
          code: "NOTHING_TO_APPLY",
          message: "That answer is no longer on this response — it may have been edited since.",
        },
      });
    }

    answers[surveyQuestionId] = flag.proposedValue;
    await tx.surveyResponse.update({
      where: { id: responseId },
      data: { answers: answers as Prisma.InputJsonValue },
    });

    return {
      field: flag.field,
      before: before === null ? null : String(before),
      after: flag.proposedValue,
    };
  }
}
