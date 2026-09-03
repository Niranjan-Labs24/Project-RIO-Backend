import { Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "../../generated/prisma";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { CleaningContextService } from "./cleaning-context.service";
import { DuplicateDetectionService } from "./duplicate-detection.service";
import {
  type CleaningRunSummary,
  type CleaningScopeType,
  type CleaningSource,
  type PendingFlag,
  type RejectedImportRow,
} from "./data-cleaning.types";
import { evaluateImportRows } from "./rules/import-row.rules";
import { evaluateNeed, type NeedCleaningInput } from "./rules/need.rules";
import {
  evaluateNumericAnswers,
  type RawNumericAnswer,
} from "./rules/response-answer.rules";
import { evaluateSurveyResponse } from "./rules/survey-response.rules";

/**
 * RIO-FR-002 — the adapter layer: reads records, runs the rules, writes
 * `cleaning_flags`.
 *
 * ─── Two invariants this service exists to hold ────────────────────────────
 *
 * 1. IT NEVER CHANGES A RECORD (Q11). It writes runs and flags, and nothing
 *    else. Standardization happens when a reviewer accepts a flag, which is a
 *    separate action on a separate endpoint. Nothing on this class touches a
 *    Need, a SurveyResponse, or anything a report reads.
 *
 * 2. IT NEVER FAILS ITS CALLER. Every public method resolves rather than
 *    throwing. Cleaning is assistive: a Need is already saved and audited by
 *    the time this runs, and losing a flag is a smaller harm than rolling back
 *    a researcher's work because the geographic reference was unreachable.
 *    Callers use it fire-and-forget, the same pattern NeedsService already
 *    uses for AI classification, summarisation and theme extraction.
 */
@Injectable()
export class DataCleaningService {
  private readonly logger = new Logger(DataCleaningService.name);

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly context: CleaningContextService,
    private readonly duplicates: DuplicateDetectionService,
  ) {}

  /** One Need, cleaned inline on create/update. Never throws. */
  async cleanNeed(needId: string, orgId: string, source: CleaningSource): Promise<void> {
    try {
      const context = await this.context.load();
      await this.tenant.runAsOrg(orgId, async (tx) => {
        const need = await this.loadNeed(tx, needId);
        if (!need) return;
        const flags = evaluateNeed(need.input, context);
        const run = await this.openRun(tx, {
          orgId,
          source,
          scopeType: "record",
          studyId: need.studyId,
          ruleSetVersion: context.settings.ruleSetVersion,
        });
        const written = await this.writeFlags(tx, {
          runId: run.id,
          orgId,
          source,
          studyId: need.studyId,
          flags,
          scope: { entityType: "need", entityIds: [needId] },
        });
        await this.closeRun(tx, run.id, {
          recordsScanned: 1,
          recordsFlagged: flags.length > 0 ? 1 : 0,
          flagsRaised: written.flagsRaised,
        });
      });
      // Q40's literal pass runs on the same trigger as cleaning: a need that
      // was just written is exactly when its duplicates are worth looking for.
      // Kept as a separate call rather than folded into the run above because
      // it writes to a different table with different semantics — a duplicate
      // candidate is a proposal about a PAIR, not a finding about a field.
      // Never throws (it swallows its own failures).
      await this.duplicates.detectForNeed(needId, orgId);
    } catch (err) {
      this.warn(`cleanNeed(${needId})`, err);
    }
  }

  /** One survey response, cleaned inline on submission. Never throws. */
  async cleanSurveyResponse(responseId: string, orgId: string): Promise<void> {
    try {
      const context = await this.context.load();
      await this.tenant.runAsOrg(orgId, async (tx) => {
        const response = await tx.surveyResponse.findUnique({
          where: { id: responseId },
          select: {
            id: true,
            studyId: true,
            needId: true,
            contact: true,
            mobile: true,
            village: true,
            answers: true,
          },
        });
        if (!response) return;
        const flags = evaluateSurveyResponse(
          {
            id: response.id,
            contact: response.contact,
            mobile: response.mobile,
            village: response.village,
          },
          context,
        );
        flags.push(
          ...evaluateNumericAnswers(
            response.id,
            await this.collectNumericAnswers(tx, response, context),
            context,
          ),
        );
        const run = await this.openRun(tx, {
          orgId,
          source: "survey_response",
          scopeType: "record",
          studyId: response.studyId,
          ruleSetVersion: context.settings.ruleSetVersion,
        });
        const written = await this.writeFlags(tx, {
          runId: run.id,
          orgId,
          source: "survey_response",
          studyId: response.studyId,
          flags,
          scope: { entityType: "survey_response", entityIds: [responseId] },
        });
        await this.closeRun(tx, run.id, {
          recordsScanned: 1,
          recordsFlagged: flags.length > 0 ? 1 : 0,
          flagsRaised: written.flagsRaised,
        });
      });
    } catch (err) {
      this.warn(`cleanSurveyResponse(${responseId})`, err);
    }
  }

  /**
   * One import: the Needs it created AND the rows it rejected, in a single run
   * so the per-source report covers the whole file rather than only the half
   * that succeeded. Never throws.
   */
  async cleanImportBatch(input: {
    orgId: string;
    studyId: string;
    createdNeedIds: string[];
    rejectedRows: RejectedImportRow[];
  }): Promise<CleaningRunSummary | null> {
    try {
      const context = await this.context.load();
      return await this.tenant.runAsOrg(input.orgId, async (tx) => {
        const run = await this.openRun(tx, {
          orgId: input.orgId,
          source: "file_upload",
          scopeType: "import_batch",
          studyId: input.studyId,
          ruleSetVersion: context.settings.ruleSetVersion,
        });

        const flags: PendingFlag[] = [...evaluateImportRows(input.rejectedRows)];
        let flaggedRecords = new Set(input.rejectedRows.map((r) => `row:${r.rowNumber}`)).size;

        for (const needId of input.createdNeedIds) {
          const need = await this.loadNeed(tx, needId);
          if (!need) continue;
          const needFlags = evaluateNeed(need.input, context);
          if (needFlags.length > 0) flaggedRecords++;
          flags.push(...needFlags);
        }

        const written = await this.writeFlags(tx, {
          runId: run.id,
          orgId: input.orgId,
          source: "file_upload",
          studyId: input.studyId,
          flags,
          scope: { entityType: "need", entityIds: input.createdNeedIds },
        });

        const scanned = input.createdNeedIds.length + input.rejectedRows.length;
        await this.closeRun(tx, run.id, {
          recordsScanned: scanned,
          recordsFlagged: flaggedRecords,
          flagsRaised: written.flagsRaised,
        });

        return {
          runId: run.id,
          recordsScanned: scanned,
          recordsFlagged: flaggedRecords,
          flagsRaised: written.flagsRaised,
          flagsSuperseded: written.flagsSuperseded,
        };
      });
    } catch (err) {
      this.warn(`cleanImportBatch(study ${input.studyId})`, err);
      return null;
    } finally {
      // An import is the likeliest source of duplicates — the same file
      // uploaded twice, or rows repeating needs already recorded. Run the
      // literal pass over every need the import created, AFTER the batch has
      // been written, so each one is compared against the others.
      //
      // In `finally` rather than inside the try: a failed cleaning run is no
      // reason to skip duplicate detection, and detectForNeed swallows its
      // own failures.
      for (const needId of input.createdNeedIds) {
        await this.duplicates.detectForNeed(needId, input.orgId);
      }
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private warn(what: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    // Warn, never error: nothing is broken for the user, a flag is simply
    // absent, and the next save or the next batch run picks the record up.
    this.logger.warn(`Data cleaning skipped for ${what}: ${message}`);
  }

  /**
   * Pair each raw numeric answer with the question that asked it.
   *
   * SurveyResponse.answers is keyed by SURVEY QUESTION id, not by the
   * methodology's question code, so the survey has to be walked to get from
   * one to the other — the same route DeterministicScoringService takes. The
   * methodology version comes from the Study, because a question's identity is
   * (methodologyVersionId, questionId) and two banks can carry the same code.
   */
  private async collectNumericAnswers(
    tx: Prisma.TransactionClient,
    response: { id: string; needId: string; studyId: string; answers: unknown },
    context: Awaited<ReturnType<CleaningContextService["load"]>>,
  ): Promise<RawNumericAnswer[]> {
    const rawAnswers = (response.answers ?? {}) as Record<string, unknown>;
    if (Object.keys(rawAnswers).length === 0) return [];

    const study = await tx.study.findUnique({
      where: { id: response.studyId },
      select: { methodologyVersionId: true },
    });
    if (!study?.methodologyVersionId) return [];

    const survey = await tx.survey.findFirst({
      where: { needId: response.needId, status: "PUBLISHED" },
      select: { surveyQuestions: { select: { id: true, question: { select: { questionId: true } } } } },
    });
    if (!survey) return [];

    const out: RawNumericAnswer[] = [];
    for (const sq of survey.surveyQuestions) {
      const code = sq.question?.questionId;
      if (!code) continue;
      const spec = context.numericQuestions.get(`${study.methodologyVersionId}:${code}`);
      // Absent means the question is not NUMERIC — nothing for this rule to do.
      if (!spec) continue;
      const raw = rawAnswers[sq.id];
      if (raw === undefined) continue;
      out.push({ surveyQuestionId: sq.id, spec, raw });
    }
    return out;
  }

  private async loadNeed(
    tx: Prisma.TransactionClient,
    needId: string,
  ): Promise<{ studyId: string; input: NeedCleaningInput } | null> {
    const need = await tx.need.findUnique({
      where: { id: needId },
      select: {
        id: true,
        studyId: true,
        title: true,
        statement: true,
        village: true,
        domain: true,
        subDomain: true,
        source: true,
        affectedPopulation: true,
        urgency: true,
        gapType: true,
        needCenters: { select: { centerId: true } },
        needGovernorates: { select: { governorateId: true } },
      },
    });
    if (!need) return null;
    return {
      studyId: need.studyId,
      input: {
        id: need.id,
        title: need.title,
        statement: need.statement,
        village: need.village,
        domain: need.domain,
        subDomain: need.subDomain,
        source: need.source,
        affectedPopulation: need.affectedPopulation,
        urgency: need.urgency,
        gapType: need.gapType,
        centerIds: need.needCenters.map((c) => c.centerId),
        governorateIds: need.needGovernorates.map((g) => g.governorateId),
      },
    };
  }

  private async openRun(
    tx: Prisma.TransactionClient,
    input: {
      orgId: string;
      source: CleaningSource;
      scopeType: CleaningScopeType;
      studyId: string | null;
      ruleSetVersion: string;
    },
  ): Promise<{ id: string }> {
    return tx.cleaningRun.create({
      data: {
        orgId: input.orgId,
        source: input.source,
        scopeType: input.scopeType,
        studyId: input.studyId,
        ruleSetVersion: input.ruleSetVersion,
        status: "running",
      },
      select: { id: true },
    });
  }

  private async closeRun(
    tx: Prisma.TransactionClient,
    runId: string,
    counts: { recordsScanned: number; recordsFlagged: number; flagsRaised: number },
  ): Promise<void> {
    await tx.cleaningRun.update({
      where: { id: runId },
      data: { ...counts, status: "completed", finishedAt: new Date() },
    });
  }

  /**
   * Turn evaluated flags into rows.
   *
   * Re-running cleaning over a record must not stack a second identical flag
   * on the reviewer's queue — the partial unique index
   * (entity_type, entity_id, field, rule_code) WHERE status = 'pending'
   * enforces that, and this is the write path that honours it:
   *
   *   * a pending flag that still applies is UPDATED in place, so it keeps its
   *     position in the queue and its created_at, and picks up the new values;
   *   * a pending flag that no longer applies becomes `superseded` rather than
   *     being deleted — the queue shrinks without the record of what was once
   *     wrong disappearing;
   *   * anything already accepted or rejected is left alone. A reviewer's
   *     decision is not something a later scan gets to revisit.
   */
  private async writeFlags(
    tx: Prisma.TransactionClient,
    input: {
      runId: string;
      orgId: string;
      source: CleaningSource;
      studyId: string | null;
      flags: PendingFlag[];
      scope: { entityType: string; entityIds: string[] };
    },
  ): Promise<{ flagsRaised: number; flagsSuperseded: number }> {
    const existing =
      input.scope.entityIds.length > 0
        ? await tx.cleaningFlag.findMany({
            where: {
              entityType: input.scope.entityType,
              entityId: { in: input.scope.entityIds },
              status: "pending",
            },
            select: { id: true, entityId: true, field: true, ruleCode: true },
          })
        : [];

    const key = (entityId: string | null, field: string, ruleCode: string): string =>
      `${entityId ?? ""}|${field}|${ruleCode}`;
    const existingByKey = new Map(
      existing.map((row) => [key(row.entityId, row.field, row.ruleCode), row.id]),
    );

    let flagsRaised = 0;
    const stillApplies = new Set<string>();

    for (const flag of input.flags) {
      const flagKey = key(flag.entityId, flag.field, flag.ruleCode);
      stillApplies.add(flagKey);
      const data = {
        runId: input.runId,
        orgId: input.orgId,
        source: input.source,
        studyId: input.studyId,
        entityType: flag.entityType,
        entityId: flag.entityId,
        rowNumber: flag.rowNumber,
        field: flag.field,
        ruleCode: flag.ruleCode,
        severity: flag.severity,
        originalValue: flag.originalValue,
        proposedValue: flag.proposedValue,
        confidence: flag.confidence,
        detail: (flag.detail ?? undefined) as Prisma.InputJsonValue | undefined,
      };

      const existingId = existingByKey.get(flagKey);
      if (existingId) {
        await tx.cleaningFlag.update({ where: { id: existingId }, data });
      } else {
        await tx.cleaningFlag.create({ data });
        flagsRaised++;
      }
    }

    const obsolete = existing.filter(
      (row) => !stillApplies.has(key(row.entityId, row.field, row.ruleCode)),
    );
    if (obsolete.length > 0) {
      await tx.cleaningFlag.updateMany({
        where: { id: { in: obsolete.map((row) => row.id) } },
        data: { status: "superseded" },
      });
    }

    return { flagsRaised, flagsSuperseded: obsolete.length };
  }
}
