import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { requireActor, requireOrgId } from '../../tenancy/org-context';
import { AuditService } from '../audit/audit.service';
import { AiService } from '../ai/ai.service';
import { DomainsService } from '../domains/domains.service';
import { SurveysService } from '../surveys/surveys.service';
import { classifyNeedWithAi } from './classification.ai';
import { redactPii, type ClassificationCandidate, type ClassificationResult } from './classification.placeholder';
import { scoreStub } from './scoring.placeholder';
import type {
  AiDecision,
  AiDecisionRow,
  ReviewDecisionPayload,
  ScoringStubResponse,
} from './ai-decisions.types';
import type { AiReviewApproveDto, AiReviewOverrideDomainDto } from './ai-decisions.contract';
import type { NeedStatus } from '../needs/needs.types';

// Product decision (confirmed): a Researcher's manual classification is
// currently treated as equivalent to an Approver override — it lands the
// Need on the same reviewer_approved status review()'s approved/modified
// branch would produce, with no separate Approver review step of its own.
// This is the ONE place that decision is expressed — manualClassify() below
// reads this constant rather than writing 'reviewer_approved' inline, so if
// the client later wants a real Approver review step after manual
// classification (e.g. landing on 'ai_classified' instead, same as the
// AI-success path), changing that behavior is a one-line edit here, not a
// hunt through the method body.
const MANUAL_CLASSIFICATION_RESULT_STATUS: NeedStatus = 'reviewer_approved';

@Injectable()
export class AiDecisionsService {
  private readonly logger = new Logger(AiDecisionsService.name);

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly ai: AiService,
    private readonly domains: DomainsService,
    private readonly surveys: SurveysService,
  ) {}

  // Called once, synchronously, right after NeedsService.create() commits
  // its own transaction (never from inside that transaction — a slow/failing
  // AI call must never block or roll back Need creation). Only ever invoked
  // while pending_ai_classification (the normal case, set by
  // NeedsService.create) or draft — the bare schema default a Need should
  // never actually rest at post-creation, but a still-`draft` Need (e.g. one
  // imported before NeedsImportService set this explicitly) needs the same
  // "kick off classification" path, not a dead end. ai_classification_failed
  // is no longer a real outcome runAndPersistClassification ever produces
  // (see its own comment) — kept in the guard below defensively, but this
  // branch is effectively unreachable via the automatic path now.
  async classifyAutomatically(needId: string): Promise<AiDecision> {
    return this.runAndPersistClassification(needId);
  }

  // Retry — was the primary way off ai_classification_failed; that status
  // is no longer produced by runAndPersistClassification (an "unclear"
  // outcome is now ai_classified + allDomainsSelected instead — see that
  // method), so this guard's ai_classification_failed branch is dead for
  // now. Left in place rather than removed: Phase 3's extended Override
  // mechanism is the intended replacement path for "re-run AI on an
  // allDomainsSelected Need," at which point this whole method may be
  // retired — not decided yet. `draft` stays reachable (see
  // classifyAutomatically's comment).
  async retryClassification(needId: string): Promise<AiDecision> {
    await this.tenant.runInOrgContext(async (tx) => {
      const need = await tx.need.findUnique({ where: { id: needId } });
      if (!need) throw new NotFoundException({ error: { code: 'NEED_NOT_FOUND', message: 'Need not found' } });
      if (need.status !== 'ai_classification_failed' && need.status !== 'draft') {
        throw new ConflictException({
          error: { code: 'NEED_NOT_FAILED', message: 'Retry is only available for a Need whose classification has failed.' },
        });
      }
      await tx.need.update({
        where: { id: needId },
        data: { classificationError: null, classifiedAt: null, status: 'pending_ai_classification' },
      });
    });
    return this.runAndPersistClassification(needId);
  }

  // Researcher-driven manual classification — same status caveat as
  // retryClassification above: ai_classification_failed is no longer a
  // real outcome, so this method's guard is currently unreachable via the
  // automatic path. Left as-is pending Phase 3, which extends the Override
  // mechanism to also cover changing domains on an ai_classified (incl.
  // allDomainsSelected) Need — this method may end up redundant with that,
  // not decided yet. There is no AI suggestion here for an Approver to
  // review/approve/override: the Researcher's own Domain/Sub-domain
  // selection directly becomes the authoritative classification, so this
  // writes exactly what review()'s approved/modified branch would
  // (Need.domain/subDomain + the status in MANUAL_CLASSIFICATION_RESULT_STATUS
  // above) without an AiDecision row to route through — a manual pick has
  // nothing to route.
  async manualClassify(needId: string, body: AiReviewOverrideDomainDto): Promise<void> {
    // Only honors the first pair — manualClassify predates multi-domain and
    // is already effectively unreachable via the automatic path (see the
    // guard below and this method's own doc comment above); extending it to
    // genuinely commit every pair is exactly the "reductant... optimization"
    // deferred alongside deciding whether this method survives at all.
    // Contract enforces minItems: 1, so index 0 always exists at runtime.
    const { domain, subDomain } = body.pairs[0]!;
    const { needTitle } = await this.tenant.runInOrgContext(async (tx) => {
      const need = await tx.need.findUnique({ where: { id: needId } });
      if (!need) throw new NotFoundException({ error: { code: 'NEED_NOT_FOUND', message: 'Need not found' } });
      if (need.status !== 'ai_classification_failed' && need.status !== 'draft') {
        throw new ConflictException({
          error: {
            code: 'NEED_NOT_FAILED',
            message: 'Manual classification is only available for a Need whose automatic classification failed.',
          },
        });
      }
      if (!(await this.isActiveDomainSubDomain(domain, subDomain))) {
        throw new BadRequestException({
          error: { code: 'INVALID_DOMAIN', message: 'Select a valid, active Domain and Sub-domain.' },
        });
      }
      await tx.need.update({
        where: { id: needId },
        data: {
          domain,
          subDomain,
          status: MANUAL_CLASSIFICATION_RESULT_STATUS,
          classifiedAt: new Date(),
          classificationError: null,
        },
      });
      return { needTitle: need.title };
    });
    await this.audit.record({
      action: 'edit',
      entityType: 'need',
      entityId: needId,
      entityLabel: `Manual classification for need "${needTitle}"`,
      changes: [
        { field: 'Domain', before: null, after: domain },
        { field: 'Sub-Domain', before: null, after: subDomain },
      ],
    });
    // Same "never leave the Need without suggested questions" guarantee as
    // the automatic path (runAndPersistClassification) — best-effort, a
    // failure here must not undo the classification that just succeeded.
    try {
      await this.surveys.generateSuggestedQuestions(needId, [{ domain, subDomain }]);
    } catch (err) {
      this.logger.warn(`Suggested-question generation failed for manually classified need ${needId}: ${(err as Error).message}`);
    }
  }

  private async isActiveDomainSubDomain(domain: string, subDomain: string): Promise<boolean> {
    const domains = (await this.domains.listDomainsWithSubDomains()).filter((d) => d.isActive);
    const matched = domains.find((d) => d.name === domain);
    return Boolean(matched?.subDomains.some((sd) => sd.isActive && sd.name === subDomain));
  }

  private async runAndPersistClassification(needId: string): Promise<AiDecision> {
    const orgId = requireOrgId();
    const need = await this.tenant.runInOrgContext(async (tx) => {
      const need = await tx.need.findUnique({ where: { id: needId } });
      if (!need) {
        throw new NotFoundException({ error: { code: 'NEED_NOT_FOUND', message: 'Need not found' } });
      }
      if (
        need.status !== 'pending_ai_classification' &&
        need.status !== 'ai_classification_failed' &&
        need.status !== 'draft'
      ) {
        throw new ConflictException({
          error: { code: 'NEED_ALREADY_CLASSIFIED', message: 'This need has already been classified and moved further in its workflow.' },
        });
      }
      return need;
    });

    let result: ClassificationResult;
    let allDomainsSelected = false;
    try {
      result = await this.runClassification({ statement: need.statement, village: need.village });
    } catch (err) {
      // Product decision: AI being unable to confidently classify this Need
      // (unavailable, zero active domains, or an unclear/hallucinated
      // response — see runClassification) is now a special kind of SUCCESS,
      // not a dead end. Every active Domain/Sub-domain is implicitly in
      // scope (Need.allDomainsSelected) and this flows through the exact
      // same ai_classified -> Override/Approve/Reject pipeline as a real
      // classification, with a synthetic AiDecision recording why, instead
      // of the old separate ai_classification_failed status/UI branch.
      const message = (err as Error).message || 'AI could not confidently classify this need.';
      result = {
        modelName: 'unclear-all-domains',
        modelVersion: '1.0.0',
        confidence: 0,
        suggestion: {
          domains: [],
          subDomains: [],
          rationale:
            `AI could not confidently classify this need (${message}). Every Domain and Sub-domain has ` +
            'been selected by default — narrow this down via Override.',
          redactedStatement: redactPii(need.statement),
          village: need.village.join(', '),
        },
      };
      allDomainsSelected = true;
    }

    const created = await this.tenant.runInOrgContext(async (tx) => {
      const row = (await tx.aiDecision.create({
        data: {
          orgId,
          needId,
          studyId: need.studyId,
          touchpoint: 'need_classification',
          subjectType: 'need',
          subjectId: need.id,
          modelName: result.modelName,
          modelVersion: result.modelVersion,
          suggestion: { ...result.suggestion } as unknown as Prisma.InputJsonValue,
          confidence: result.confidence,
        },
      })) as unknown as AiDecisionRow;
      await tx.need.update({
        where: { id: needId },
        data: {
          status: 'ai_classified',
          classifiedAt: new Date(),
          classificationError: null,
          allDomainsSelected,
          // Written once, here — never touched again, including by review()
          // on approve/override, so this always reflects what AI actually
          // predicted regardless of what a human later decides. Null in the
          // allDomainsSelected case — there's no single prediction to freeze.
          aiSuggestedDomain: result.suggestion.domains[0] ?? null,
          aiSuggestedSubDomain: result.suggestion.subDomains[0] ?? null,
        },
      });
      return row;
    });
    await this.audit.record({ action: 'create', entityType: 'ai_decision', entityId: created.id, entityLabel: `AI classification for need "${need.title}"` });

    // "Never leave the Need without AI suggestions" covers questions too —
    // generate them off whatever domain/subDomain this classification landed
    // on, immediately, before any human has looked at it. Best-effort: a
    // failure here must not undo the classification that just succeeded.
    // Empty pairs (the allDomainsSelected case) is handled by
    // generateSuggestedQuestions itself — every active Question Bank entry
    // is eligible, no domain filter at all.
    const domain = result.suggestion.domains[0];
    const subDomain = result.suggestion.subDomains[0];
    const pairs = domain && subDomain ? [{ domain, subDomain }] : [];
    try {
      await this.surveys.generateSuggestedQuestions(needId, pairs);
    } catch (err) {
      this.logger.warn(`Suggested-question generation failed for need ${needId}: ${(err as Error).message}`);
    }

    return this.toAiDecision(created);
  }

  // No fallback tier of its own — still just AI-succeeds-or-throws. The
  // caller (runAndPersistClassification) is what decides what a throw here
  // means (an ai_classified Need with allDomainsSelected, not a dead end —
  // see that method's own comment); this function itself never guesses.
  private async runClassification(
    subject: { statement: string; village: string[] },
  ): Promise<ClassificationResult> {
    const domains = (await this.domains.listDomainsWithSubDomains()).filter((d) => d.isActive);
    const candidates: ClassificationCandidate[] = domains.map((d) => ({
      domainCode: d.code,
      domainName: d.name,
      subDomains: d.subDomains.filter((sd) => sd.isActive).map((sd) => ({ code: sd.code, name: sd.name })),
    }));
    if (candidates.length === 0) throw new Error('No active domains configured');
    const result = await classifyNeedWithAi(this.ai, subject, redactPii(subject.statement), candidates);

    // The AI is instructed to only pick from the given candidate list, but
    // nothing enforces that — an unclear/hallucinated response naming a
    // domain or sub-domain outside it must be treated as a failed
    // classification (routed to manual), not silently accepted.
    const domain = result.suggestion.domains[0];
    const subDomain = result.suggestion.subDomains[0];
    const matchedDomain = candidates.find((c) => c.domainName === domain);
    if (!domain || !subDomain || !matchedDomain || !matchedDomain.subDomains.some((sd) => sd.name === subDomain)) {
      throw new Error('AI returned an unclear or unrecognized domain/sub-domain classification.');
    }

    return result;
  }

  async listByNeedId(needId: string): Promise<AiDecision[]> {
    const rows = (await this.tenant.runInOrgContext((tx) =>
      tx.aiDecision.findMany({ where: { needId }, orderBy: { createdAt: 'desc' } }),
    )) as unknown as AiDecisionRow[];
    return rows.map((r) => this.toAiDecision(r));
  }

  async review(id: string, payload: ReviewDecisionPayload): Promise<AiDecision> {
    const decidedBy = requireActor();
    const { updated, needTitle } = await this.tenant.runInOrgContext(async (tx) => {
      const existing = (await tx.aiDecision.findUnique({ where: { id } })) as unknown as AiDecisionRow | null;
      if (!existing) throw new NotFoundException({ error: { code: 'AI_DECISION_NOT_FOUND', message: 'AI decision not found' } });
      // A decision can only be reviewed once — without this, a second
      // PATCH .../review call silently overwrites a prior approve/reject
      // with no record that anything downstream (e.g. an already-created
      // Survey) was built against the original decision.
      if (existing.humanDecision !== null) {
        throw new ConflictException({
          error: { code: 'AI_DECISION_ALREADY_REVIEWED', message: 'This classification has already been reviewed.' },
        });
      }
      const need = await tx.need.findUnique({ where: { id: existing.needId } });
      if (!need) throw new NotFoundException({ error: { code: 'NEED_NOT_FOUND', message: 'Need not found' } });
      // Guards against reviewing a decision that's stale relative to the
      // Need's current progress (e.g. a superseded AiDecision from before a
      // rejection sent the Need back for re-classification).
      if (need.status !== 'ai_classified') {
        throw new ConflictException({
          error: { code: 'NEED_NOT_PENDING_REVIEW', message: 'This need is not currently awaiting classification review.' },
        });
      }
      const row = (await tx.aiDecision.update({
        where: { id },
        data: {
          humanDecision: {
            decision: payload.decision,
            notes: payload.notes,
            overrideValue: payload.overrideValue,
          } as Prisma.InputJsonValue,
          decidedBy,
          decidedAt: new Date(),
        },
      })) as unknown as AiDecisionRow;

      if (payload.decision === 'approved' || payload.decision === 'modified') {
        // Approved (as-is) or modified (overridden) both produce a final
        // classification. A Need no longer collects Domain/Sub-Domain
        // manually at creation — this review is the only place that ever
        // sets the authoritative "Approved" `domain`/`subDomain` fields
        // Survey Builder's Question Bank matching and downstream
        // reporting/scoring read.
        //
        // `aiSuggestedDomain`/`aiSuggestedSubDomain` are DELIBERATELY left
        // untouched here — they were written once, when classification
        // completed (see runAndPersistClassification), and must always
        // reflect the AI's original prediction, even after an override, so
        // the two can be compared side by side (audit trail of predicted
        // vs. decided).
        await tx.need.update({ where: { id: row.needId }, data: { status: 'reviewer_approved' } });

        // `pairs` is the full, final Domain/Sub-domain list for this Need —
        // either the Approver's override (any number of pairs, no limit) or,
        // on a plain as-is Approve, the AI's own single suggested pair (empty
        // when the AI couldn't classify at all — allDomainsSelected stays
        // true in that case, since nothing narrowed it down).
        const overridePairs =
          payload.decision === 'modified'
            ? (payload.overrideValue as { pairs?: Array<{ domain: string; subDomain: string }> } | undefined)?.pairs
            : undefined;
        const suggestion = existing.suggestion as { domains?: string[]; subDomains?: string[] } | null;
        const pairs =
          overridePairs ??
          (suggestion?.domains?.[0] && suggestion?.subDomains?.[0]
            ? [{ domain: suggestion.domains[0], subDomain: suggestion.subDomains[0] }]
            : []);

        if (pairs.length > 0) {
          // Full replace, not append — a Researcher/Approver's multi-select
          // is always the final word on a Need's classification (confirmed
          // product decision), so any prior NeedDomain rows (from an earlier
          // override, or none at all) are wiped and rewritten from scratch.
          // Dedupe defensively in case the client sent the same pair twice.
          const deduped = [...new Map(pairs.map((p) => [`${p.domain} ${p.subDomain}`, p])).values()];
          await tx.needDomain.deleteMany({ where: { needId: row.needId } });
          await tx.needDomain.createMany({
            data: deduped.map((p) => ({ needId: row.needId, orgId: need.orgId, domain: p.domain, subDomain: p.subDomain })),
          });
          await tx.need.update({
            where: { id: row.needId },
            data: {
              // pairs.length > 0 guarantees deduped is non-empty too.
              domain: deduped[0]!.domain,
              subDomain: deduped[0]!.subDomain,
              // A real, narrowed-down classification exists now — this is
              // exactly what clears the "AI couldn't classify, everything is
              // implicitly in scope" sentinel from runAndPersistClassification.
              allDomainsSelected: false,
            },
          });
        }
      } else {
        // Rejected: send the Need back to pending_ai_classification so it
        // can be edited (evidence/Statement/Governorates/Centers) and a
        // fresh classification run against the edited data — it must NOT
        // advance to reviewer_approved, which would misrepresent a
        // rejection as an approval.
        await tx.need.update({ where: { id: row.needId }, data: { status: 'pending_ai_classification' } });
      }
      return { updated: row, needTitle: need.title };
    });
    // 'approved' surfaces as the 'approve' audit action (so an Audit Log
    // filter on Approved actually finds it) — 'modified'/'rejected' are
    // still an edit to the AI decision record, not a fresh approval.
    await this.audit.record({
      action: payload.decision === 'approved' ? 'approve' : 'edit',
      entityType: 'ai_decision',
      entityId: updated.id,
      entityLabel: `Classification review for need "${needTitle}"`,
    });
    return this.toAiDecision(updated);
  }

  // Approver's classification decision — Override (optional) + Approve.
  // Deliberately does NOT touch the survey or publish it: that's a separate,
  // later step the Approver takes on the Survey Builder page (methodology
  // version, curating AI-suggested + Question Bank questions, adding
  // open-ended questions, then Submit for Approval / Approve & Publish —
  // all already fully built there, see SurveysService/SurveysController).
  // Approving here only sets the authoritative domain/subDomain and moves
  // the Need to `reviewer_approved`, which is exactly the gate
  // SurveysService.assertClassificationApproved already checks before
  // letting the Survey Builder page's question-curation actions run.
  async approveAiReview(needId: string, payload: AiReviewApproveDto): Promise<void> {
    const latest = await this.latestUndecidedDecision(needId);
    await this.review(latest.id, {
      decision: payload.domainOverride ? 'modified' : 'approved',
      notes: payload.domainOverride?.reason,
      overrideValue: payload.domainOverride ? { pairs: payload.domainOverride.pairs } : undefined,
    });
  }

  // Mirrors today's Survey rejection, but also resets the Need itself back
  // to pending_ai_classification (not the Survey-only REJECTED status a
  // plain rejectSurvey call would leave it at) so it can be edited and
  // re-classified from scratch via Retry.
  async rejectAiReview(needId: string, comments: string): Promise<void> {
    const latest = await this.latestUndecidedDecision(needId);
    await this.review(latest.id, { decision: 'rejected', notes: comments });
    const survey = await this.surveys.getSurveyByNeedId(needId);
    if (survey && survey.status === 'DRAFT') {
      // A DRAFT survey has no SUBMITTED state to reject from (rejectSurvey
      // requires SUBMITTED) — nothing further to do to it; the Need's own
      // status reset above is what actually re-opens editing/re-classification.
      return;
    }
    if (survey && survey.status === 'SUBMITTED') {
      await this.surveys.rejectSurvey(survey.id, comments);
    }
  }

  // Override-Domain preview: does NOT write domain/subDomain (or NeedDomain
  // rows) onto the Need — that only happens inside approveAiReview's
  // domainOverride handling (see review()) — only regenerates the Suggested
  // Questions list, merged+deduped across every candidate pair, so a
  // browser refresh mid-override never leaves the Need half-decided.
  async overrideDomainPreview(needId: string, body: AiReviewOverrideDomainDto): Promise<unknown> {
    return this.surveys.generateSuggestedQuestions(needId, body.pairs);
  }

  private async latestUndecidedDecision(needId: string): Promise<AiDecisionRow> {
    const rows = (await this.tenant.runInOrgContext((tx) =>
      tx.aiDecision.findMany({ where: { needId }, orderBy: { createdAt: 'desc' } }),
    )) as unknown as AiDecisionRow[];
    const undecided = rows.find((r) => r.humanDecision === null);
    if (!undecided) {
      throw new NotFoundException({ error: { code: 'AI_DECISION_NOT_FOUND', message: 'No AI classification is pending review for this need.' } });
    }
    return undecided;
  }

  // RIO-FR-003: no Survey Response exists yet to score against (out of
  // scope), so this is a pure stub — no DB write at all.
  score(): ScoringStubResponse {
    return scoreStub();
  }

  private toAiDecision(row: AiDecisionRow): AiDecision {
    return {
      id: row.id,
      needId: row.needId,
      studyId: row.studyId,
      touchpoint: row.touchpoint,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      modelName: row.modelName,
      modelVersion: row.modelVersion,
      suggestion: row.suggestion,
      confidence: Number(row.confidence),
      humanDecision: row.humanDecision,
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
