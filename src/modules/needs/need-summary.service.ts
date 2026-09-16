import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import crypto from "node:crypto";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { requireActor, requireOrgId } from "../../tenancy/org-context";
import { AuditService } from "../audit/audit.service";
import { AiService } from "../ai/ai.service";
import { NEED_STATEMENT_SUMMARY_TASK } from "../ai/prompts/need-statement-summary.task";
import { MethodologyConfigService } from "../methodology-config/methodology-config.service";
import { redactPii } from "../ai-decisions/classification.placeholder";
import { decodeWarnings, encodeWarnings, verifySummary } from "./need-summary.verify";
import type { NeedSummary, NeedSummaryTriggerSource } from "./need-summary.types";

/**
 * RIO-AI-003 — suggests a shortened version of a long Need description, which a
 * Human Reviewer edits and explicitly confirms.
 *
 * Three properties are load-bearing and easy to break:
 *
 *  1. **Generation never fails the caller.** Summarisation is additive: a Need
 *     must still be created, imported or edited when the model is rate-limited
 *     or the API key is missing. Every auto-trigger path therefore goes through
 *     `maybeGenerateForNeed`, which swallows and logs rather than throwing.
 *     `regenerate` is the explicit, user-initiated path and DOES throw, because
 *     there a silent no-op would look like a broken button.
 *  2. **The AI text is never overwritten.** An edit writes
 *     `reviewerEditedText`; `aiSummaryText` keeps the model's original for the
 *     lifetime of the row. That is what makes "both stored together" provable.
 *  3. **Only one summary is live per Need.** Confirming supersedes the previous
 *     confirmed row rather than deleting it, so the decision history survives.
 */
@Injectable()
export class NeedSummaryService {
  private readonly logger = new Logger(NeedSummaryService.name);

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly ai: AiService,
    private readonly audit: AuditService,
    private readonly methodologyConfig: MethodologyConfigService,
  ) {}

  /**
   * The auto-trigger. Called after a Need is created or its statement edited,
   * from every entry point (manual, bulk import, PDF import, citizen).
   *
   * Returns null — without throwing — whenever no summary should or could be
   * produced: statement below the threshold, a live summary already covers this
   * exact text, or the model call failed. See property 1 in the class comment.
   */
  async maybeGenerateForNeed(
    needId: string,
    triggerSource: NeedSummaryTriggerSource,
  ): Promise<NeedSummary | null> {
    try {
      return await this.generate(needId, triggerSource, { manual: false });
    } catch (err) {
      // Deliberately swallowed. The Need itself is already persisted by the
      // caller; failing here would roll back real work over an assistive
      // feature. The reviewer can regenerate from the UI.
      this.logger.warn(
        `Need statement summary skipped for need ${needId} (${triggerSource}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /** The explicit "Regenerate" action. Throws so the UI can show the reason. */
  async regenerate(needId: string): Promise<NeedSummary> {
    const summary = await this.generate(needId, "manual_regenerate", { manual: true });
    if (!summary) {
      // Only reachable on the below-threshold branch, which `manual: true`
      // bypasses — but the type says nullable, so say something useful rather
      // than returning a null the controller would serialise as 200 null.
      throw new BadRequestException({
        error: {
          code: "NEED_SUMMARY_NOT_APPLICABLE",
          message: "This need has no statement to summarise.",
        },
      });
    }
    return summary;
  }

  private async generate(
    needId: string,
    triggerSource: NeedSummaryTriggerSource,
    opts: { manual: boolean },
  ): Promise<NeedSummary | null> {
    const orgId = requireOrgId();
    const generatedBy = requireActor();

    const need = await this.tenant.runInOrgContext((tx) =>
      tx.need.findFirst({ where: { id: needId, orgId } }),
    );
    if (!need) {
      throw new NotFoundException({
        error: { code: "NEED_NOT_FOUND", message: `Need ${needId} not found.` },
      });
    }

    const statement = need.statement ?? "";
    if (statement.trim().length === 0) return null;

    const { statementLengthThreshold, maxSummaryChars } =
      (await this.methodologyConfig.getRaw()).aiSummarySettings;

    // The AC's "above a defined length threshold". A manual regenerate
    // deliberately ignores it: a reviewer who asks for a summary of a shorter
    // statement has made a judgement the threshold exists to automate, not to
    // override.
    if (!opts.manual && statement.length <= statementLengthThreshold) return null;

    const inputTextHash = crypto.createHash("sha256").update(statement).digest("hex");

    // Idempotence for the auto path. Bulk import can call this twice for the
    // same row (create, then a follow-up geography patch), and re-running the
    // model would replace a summary the reviewer may already be looking at.
    if (!opts.manual) {
      const live = await this.tenant.runInOrgContext((tx) =>
        tx.needStatementSummary.findFirst({
          where: { needId, inputTextHash, status: { in: ["DRAFT", "CONFIRMED"] } },
        }),
      );
      if (live) return this.toDto(live);
    }

    // Same redaction the classification path applies, and for the same reason:
    // a field researcher's free text routinely contains a contact number for
    // the household. The prompt also forbids reproducing identifiers, but the
    // model must not receive them in the first place.
    const redacted = redactPii(statement);

    const prompt = `Maximum summary length: ${maxSummaryChars} characters. Do not exceed it.

NEED DESCRIPTION TO SUMMARISE:
${redacted}`;

    const { response } = await this.ai.run(NEED_STATEMENT_SUMMARY_TASK, prompt);

    const summaryText = (response.summary ?? "").trim();
    if (summaryText.length === 0) {
      throw new BadRequestException({
        error: {
          code: "NEED_SUMMARY_EMPTY",
          message: "The model returned an empty summary.",
        },
      });
    }

    // AC 5, made mechanical. These are stored, not enforced: every summary
    // already requires human confirmation (AC 3), so the right response to a
    // suspect summary is to point the reviewer at it, not to silently discard
    // work the model did. See need-summary.verify.ts for why the checks are
    // deliberately conservative.
    const warnings = verifySummary(statement, summaryText, response.preservedFacts ?? []);
    if (warnings.length > 0) {
      this.logger.warn(
        `Need summary for ${needId} raised ${warnings.length} verification warning(s): ` +
          warnings.map((w) => w.code).join(", "),
      );
    }

    const { promptVersion, model: modelName, modelVersion } = NEED_STATEMENT_SUMMARY_TASK;

    const created = await this.tenant.runInOrgContext(async (tx) => {
      // A fresh generation supersedes any older DRAFT for this Need, so the
      // reviewer queue never shows two competing drafts of the same need.
      await tx.needStatementSummary.updateMany({
        where: { needId, status: "DRAFT" },
        data: { status: "SUPERSEDED" },
      });
      return tx.needStatementSummary.create({
        data: {
          orgId,
          needId,
          studyId: need.studyId,
          status: "DRAFT",
          promptVersion,
          modelName,
          modelVersion,
          sourceStatement: statement,
          sourceLength: statement.length,
          inputTextHash,
          aiSummaryText: summaryText,
          triggerSource,
          verificationWarnings: encodeWarnings(warnings),
          generatedBy,
        },
      });
    });

    await this.audit.record({
      action: "generate_need_summary",
      entityType: "need_statement_summary",
      entityId: created.id,
      entityLabel: need.title ?? needId,
      changes: [
        { field: "status", before: null, after: "DRAFT" },
        { field: "triggerSource", before: null, after: triggerSource },
      ],
    });

    return this.toDto(created);
  }

  /** The live summary for a Need — the confirmed one if there is one, else the
   *  draft awaiting review. Superseded and stale rows are never "live". */
  async getForNeed(needId: string): Promise<NeedSummary | null> {
    const orgId = requireOrgId();
    const row = await this.tenant.runInOrgContext((tx) =>
      tx.needStatementSummary.findFirst({
        where: { needId, orgId, status: { in: ["CONFIRMED", "DRAFT", "STALE"] } },
        // CONFIRMED sorts before DRAFT before STALE alphabetically, which is
        // the precedence we want; generatedAt breaks ties within a status.
        orderBy: [{ status: "asc" }, { generatedAt: "desc" }],
      }),
    );
    return row ? this.toDto(row) : null;
  }

  /** The reviewer queue: every summary still awaiting a decision, oldest first
   *  so the longest-waiting need surfaces at the top. */
  async listPending(limit = 100, offset = 0): Promise<{ items: NeedSummary[]; total: number }> {
    const orgId = requireOrgId();
    const [rows, total] = await this.tenant.runInOrgContext(async (tx) => [
      await tx.needStatementSummary.findMany({
        where: { orgId, status: "DRAFT" },
        orderBy: { generatedAt: "asc" },
        take: Math.min(limit, 200),
        skip: offset,
        include: { need: { select: { title: true } } },
      }),
      await tx.needStatementSummary.count({ where: { orgId, status: "DRAFT" } }),
    ]);
    return {
      items: rows.map((r) => this.toDto(r, r.need?.title ?? null)),
      total,
    };
  }

  /** The reviewer's edit. Writes a SEPARATE column — see property 2. */
  async updateDraft(summaryId: string, editedText: string): Promise<NeedSummary> {
    const orgId = requireOrgId();
    const existing = await this.findDraftOrThrow(summaryId, orgId);

    const trimmed = editedText.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException({
        error: {
          code: "NEED_SUMMARY_TEXT_REQUIRED",
          message: "A summary cannot be saved empty. Reject or regenerate it instead.",
        },
      });
    }

    const updated = await this.tenant.runInOrgContext((tx) =>
      tx.needStatementSummary.update({
        where: { id: summaryId },
        data: { reviewerEditedText: trimmed },
      }),
    );

    await this.audit.record({
      action: "edit_need_summary",
      entityType: "need_statement_summary",
      entityId: summaryId,
      entityLabel: existing.needId,
      changes: [
        {
          field: "reviewerEditedText",
          before: existing.reviewerEditedText,
          after: trimmed,
        },
      ],
    });

    return this.toDto(updated);
  }

  /**
   * The AC's "never auto-approved — always requires explicit reviewer
   * confirmation". This is the only method that can produce a CONFIRMED row,
   * and the controller gates it on `aiReview:approve`.
   */
  async confirm(summaryId: string): Promise<NeedSummary> {
    const orgId = requireOrgId();
    const confirmedBy = requireActor();
    const existing = await this.findDraftOrThrow(summaryId, orgId);

    const updated = await this.tenant.runInOrgContext(async (tx) => {
      await tx.needStatementSummary.updateMany({
        where: { needId: existing.needId, id: { not: summaryId }, status: "CONFIRMED" },
        data: { status: "SUPERSEDED" },
      });
      return tx.needStatementSummary.update({
        where: { id: summaryId },
        data: { status: "CONFIRMED", confirmedBy, confirmedAt: new Date() },
      });
    });

    await this.audit.record({
      action: "confirm_need_summary",
      entityType: "need_statement_summary",
      entityId: summaryId,
      entityLabel: existing.needId,
      changes: [{ field: "status", before: "DRAFT", after: "CONFIRMED" }],
    });

    return this.toDto(updated);
  }

  /**
   * Bulk confirm for the reviewer queue. A bulk import of 50 needs produces 50
   * drafts, and confirming them one dialog at a time is the difference between
   * the feature being used and being skipped.
   *
   * Each id is confirmed through `confirm()` so every row still gets its own
   * audit entry — the batching is in the UI, never in the record.
   */
  async confirmMany(summaryIds: string[]): Promise<{ confirmed: string[]; skipped: string[] }> {
    const confirmed: string[] = [];
    const skipped: string[] = [];
    for (const id of summaryIds) {
      try {
        await this.confirm(id);
        confirmed.push(id);
      } catch (err) {
        // Only the two EXPECTED refusals are absorbed: an id that no longer
        // exists, and one that is no longer a DRAFT because someone else
        // confirmed it while this reviewer had the queue open. Those must not
        // abort the other 49, and the caller is told which ids did not take.
        //
        // Anything else — the database being down, a lost org context — is
        // rethrown. Swallowing it would report "already decided or replaced"
        // for all 50, which is a specific and wrong explanation of an
        // infrastructure failure, and the reviewer would believe the work was
        // done.
        if (err instanceof NotFoundException || err instanceof BadRequestException) {
          skipped.push(id);
          continue;
        }
        throw err;
      }
    }
    return { confirmed, skipped };
  }

  /**
   * What reports and lists should print for this Need — the confirmed
   * summary's effective text, or null to fall back to the original statement.
   *
   * Only CONFIRMED counts. A draft nobody has reviewed must never reach a
   * published report; that is the whole point of the human gate.
   */
  async getConfirmedTextForNeed(needId: string): Promise<string | null> {
    const orgId = requireOrgId();
    const row = await this.tenant.runInOrgContext((tx) =>
      tx.needStatementSummary.findFirst({
        where: { needId, orgId, status: "CONFIRMED" },
        orderBy: { confirmedAt: "desc" },
      }),
    );
    if (!row) return null;
    return row.reviewerEditedText ?? row.aiSummaryText;
  }

  /**
   * Called when a Need's statement is edited. A confirmed summary of the old
   * text is no longer a summary of this Need, but deleting it would destroy the
   * reviewer's decision — so it is marked STALE and shown as such.
   */
  async markStaleForNeed(needId: string): Promise<void> {
    await this.tenant.runInOrgContext((tx) =>
      tx.needStatementSummary.updateMany({
        where: { needId, status: { in: ["CONFIRMED", "DRAFT"] } },
        data: { status: "STALE" },
      }),
    );
  }

  private async findDraftOrThrow(summaryId: string, orgId: string) {
    const row = await this.tenant.runInOrgContext((tx) =>
      tx.needStatementSummary.findFirst({ where: { id: summaryId, orgId } }),
    );
    if (!row) {
      throw new NotFoundException({
        error: { code: "NEED_SUMMARY_NOT_FOUND", message: `Summary ${summaryId} not found.` },
      });
    }
    if (row.status !== "DRAFT") {
      throw new BadRequestException({
        error: {
          code: "NEED_SUMMARY_NOT_EDITABLE",
          message: `Only a DRAFT summary can be edited or confirmed (this one is ${row.status}).`,
        },
      });
    }
    return row;
  }

  private toDto(
    row: {
      id: string;
      needId: string;
      studyId: string;
      status: string;
      promptVersion: string;
      modelName: string;
      sourceStatement: string;
      sourceLength: number;
      aiSummaryText: string;
      reviewerEditedText: string | null;
      triggerSource: string;
      verificationWarnings: string[];
      generatedAt: Date;
      confirmedBy: string | null;
      confirmedAt: Date | null;
    },
    needTitle: string | null = null,
  ): NeedSummary {
    return {
      id: row.id,
      needId: row.needId,
      studyId: row.studyId,
      needTitle,
      status: row.status as NeedSummary["status"],
      promptVersion: row.promptVersion,
      modelName: row.modelName,
      // AC: "the original full text remains accessible alongside the summary".
      // Returned on every read, not behind a second request — a UI that has to
      // ask for the source separately tends to stop showing it.
      sourceStatement: row.sourceStatement,
      sourceLength: row.sourceLength,
      aiSummaryText: row.aiSummaryText,
      reviewerEditedText: row.reviewerEditedText,
      // What a consumer should display. Kept server-side so every caller
      // resolves the AI-vs-edited precedence identically.
      effectiveText: row.reviewerEditedText ?? row.aiSummaryText,
      wasEdited: row.reviewerEditedText !== null,
      triggerSource: row.triggerSource as NeedSummaryTriggerSource,
      verificationWarnings: decodeWarnings(row.verificationWarnings ?? []),
      generatedAt: row.generatedAt.toISOString(),
      confirmedBy: row.confirmedBy,
      confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
    };
  }
}
