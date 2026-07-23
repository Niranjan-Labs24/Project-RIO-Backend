import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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

// The three tiers runClassificationWithFallback tries, in order — recorded
// on every AiDecision.suggestion so the UI (and this file's own tests) can
// tell a real Gemini call apart from a fallback. "Never leave the Need
// without AI suggestions": tier 3 is a plain domain-list lookup and can
// only fail if literally zero domains are configured for this org.
type ClassificationSource = 'ai' | 'prior_needs' | 'default';

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
  // while pending_ai_classification (first run, set by NeedsService.create)
  // or ai_classification_failed (see retryClassification) — anything further
  // along throws, same guard as the old manual classify() had. `draft` is
  // also accepted defensively — it's the bare schema default a Need should
  // never actually rest at post-creation, but a still-`draft` Need (e.g. one
  // imported before NeedsImportService set this explicitly) needs the same
  // "kick off classification" path, not a dead end.
  async classifyAutomatically(needId: string): Promise<AiDecision> {
    return this.runAndPersistClassification(needId);
  }

  // Approver/Researcher-facing Retry — reachable while ai_classification_failed
  // (the normal case) or draft (see classifyAutomatically's comment — a Need
  // stuck at the bare default with no classification ever having run needs
  // the same "start it" action, not a separate one). Clears any previous
  // attempt's error/timestamp before re-running, so a failed run never
  // leaves stale fields behind once a later attempt succeeds.
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
    let source: ClassificationSource;
    try {
      const tier = await this.runClassificationWithFallback(needId, { statement: need.statement, village: need.village });
      result = tier.result;
      source = tier.source;
    } catch (err) {
      // Only reachable if the guaranteed-to-succeed default-domain tier
      // itself throws (zero active domains configured org-wide) — the only
      // case that legitimately produces ai_classification_failed.
      const message = (err as Error).message || 'AI classification failed and no fallback domain was available.';
      await this.tenant.runInOrgContext((tx) =>
        tx.need.update({
          where: { id: needId },
          data: { status: 'ai_classification_failed', classificationError: message, classifiedAt: new Date() },
        }),
      );
      throw err;
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
          suggestion: { ...result.suggestion, source } as unknown as Prisma.InputJsonValue,
          confidence: result.confidence,
        },
      })) as unknown as AiDecisionRow;
      await tx.need.update({
        where: { id: needId },
        data: {
          status: 'ai_classified',
          classifiedAt: new Date(),
          classificationError: null,
          // Written once, here — never touched again, including by review()
          // on approve/override, so this always reflects what AI actually
          // predicted regardless of what a human later decides.
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
    const domain = result.suggestion.domains[0];
    const subDomain = result.suggestion.subDomains[0];
    if (domain && subDomain) {
      try {
        await this.surveys.generateSuggestedQuestions(needId, domain, subDomain);
      } catch (err) {
        this.logger.warn(`Suggested-question generation failed for need ${needId}: ${(err as Error).message}`);
      }
    }

    return this.toAiDecision(created);
  }

  private async runClassificationWithFallback(
    needId: string,
    subject: { statement: string; village: string[] },
  ): Promise<{ result: ClassificationResult; source: ClassificationSource }> {
    // Tier 1 — real AI (unchanged from before).
    try {
      const domains = (await this.domains.listDomainsWithSubDomains()).filter((d) => d.isActive);
      const candidates: ClassificationCandidate[] = domains.map((d) => ({
        domainCode: d.code,
        domainName: d.name,
        subDomains: d.subDomains.filter((sd) => sd.isActive).map((sd) => ({ code: sd.code, name: sd.name })),
      }));
      if (candidates.length === 0) throw new Error('No active domains configured');
      const result = await classifyNeedWithAi(this.ai, subject, redactPii(subject.statement), candidates);
      return { result, source: 'ai' };
    } catch (err) {
      this.logger.warn(`Real AI classification unavailable, trying prior-Needs fallback: ${(err as Error).message}`);
    }

    // Tier 2 — most common (domain, subDomain) pair among this Need's own
    // Governorates/Centers' prior classified Needs in this org. Deterministic:
    // group by pair, pick the highest count, break ties by most recent
    // classifiedAt — never a vague "pick one".
    try {
      const fallback = await this.classifyFromPriorNeeds(needId, subject);
      if (fallback) return { result: fallback, source: 'prior_needs' };
    } catch (err) {
      this.logger.warn(`Prior-Needs fallback unavailable, trying default domain: ${(err as Error).message}`);
    }

    // Tier 3 — default domain. Cannot fail unless zero active domains exist
    // for this org at all, which is the only case that should ever surface
    // as ai_classification_failed.
    const domains = (await this.domains.listDomainsWithSubDomains()).filter((d) => d.isActive);
    const top = domains.find((d) => d.subDomains.some((sd) => sd.isActive));
    if (!top) {
      throw new Error('No active domains are configured for this organization.');
    }
    const topSubDomain = top.subDomains.find((sd) => sd.isActive)!;
    const result: ClassificationResult = {
      modelName: 'default-domain-fallback',
      modelVersion: '1.0.0',
      confidence: 0,
      suggestion: {
        domains: [top.name],
        subDomains: [topSubDomain.name],
        rationale: 'No AI suggestion or prior classified Need was available in this geography — defaulted to the top configured domain.',
        redactedStatement: redactPii(subject.statement),
        village: subject.village.join(', '),
      },
    };
    return { result, source: 'default' };
  }

  private async classifyFromPriorNeeds(
    needId: string,
    subject: { statement: string; village: string[] },
  ): Promise<ClassificationResult | null> {
    const geo = await this.tenant.runInOrgContext(async (tx) => {
      const need = await tx.need.findUnique({
        where: { id: needId },
        include: { needGovernorates: true, needCenters: true },
      });
      return {
        governorateIds: (need?.needGovernorates ?? []).map((g) => g.governorateId),
        centerIds: (need?.needCenters ?? []).map((c) => c.centerId),
      };
    });
    if (geo.governorateIds.length === 0 && geo.centerIds.length === 0) return null;

    const priorNeeds = await this.tenant.runInOrgContext(async (tx) =>
      tx.need.findMany({
        where: {
          id: { not: needId },
          domain: { not: null },
          subDomain: { not: null },
          OR: [
            ...(geo.governorateIds.length > 0
              ? [{ needGovernorates: { some: { governorateId: { in: geo.governorateIds } } } }]
              : []),
            ...(geo.centerIds.length > 0 ? [{ needCenters: { some: { centerId: { in: geo.centerIds } } } }] : []),
          ],
        },
        select: { domain: true, subDomain: true, classifiedAt: true },
        orderBy: { classifiedAt: 'desc' },
        take: 200,
      }),
    );
    if (priorNeeds.length === 0) return null;

    const counts = new Map<string, { domain: string; subDomain: string; count: number; latest: Date | null }>();
    for (const n of priorNeeds) {
      const key = `${n.domain} ${n.subDomain}`;
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
        if (n.classifiedAt && (!existing.latest || n.classifiedAt > existing.latest)) existing.latest = n.classifiedAt;
      } else {
        counts.set(key, { domain: n.domain as string, subDomain: n.subDomain as string, count: 1, latest: n.classifiedAt });
      }
    }
    const [best] = [...counts.values()].sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return (b.latest?.getTime() ?? 0) - (a.latest?.getTime() ?? 0);
    });
    if (!best) return null;

    return {
      modelName: 'prior-needs-fallback',
      modelVersion: '1.0.0',
      confidence: 0,
      suggestion: {
        domains: [best.domain],
        subDomains: [best.subDomain],
        rationale: `AI classification was unavailable — defaulted to the most common Domain/Sub-Domain (${best.count} prior Need(s)) among previously classified Needs in the same geography.`,
        redactedStatement: redactPii(subject.statement),
        village: subject.village.join(', '),
      },
    };
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
        const source =
          payload.decision === 'modified' && payload.overrideValue
            ? (payload.overrideValue as { domains?: string[]; subDomains?: string[] })
            : (existing.suggestion as { domains?: string[]; subDomains?: string[] } | null);
        const approvedDomain = source?.domains?.[0];
        const approvedSubDomain = source?.subDomains?.[0];
        if (approvedDomain && approvedSubDomain) {
          await tx.need.update({
            where: { id: row.needId },
            data: { domain: approvedDomain, subDomain: approvedSubDomain },
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
      overrideValue: payload.domainOverride
        ? { domains: [payload.domainOverride.domain], subDomains: [payload.domainOverride.subDomain] }
        : undefined,
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

  // Override-Domain preview: does NOT write domain/subDomain onto the Need
  // (that only happens inside approveAiReview's domainOverride handling) —
  // only regenerates the Suggested Questions list for the candidate domain,
  // so a browser refresh mid-override never leaves the Need half-decided.
  async overrideDomainPreview(needId: string, body: AiReviewOverrideDomainDto): Promise<unknown> {
    return this.surveys.generateSuggestedQuestions(needId, body.domain, body.subDomain);
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
