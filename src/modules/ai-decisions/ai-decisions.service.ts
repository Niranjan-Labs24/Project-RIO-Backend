import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { requireActor, requireOrgId } from '../../tenancy/org-context';
import { AuditService } from '../audit/audit.service';
import { AiService } from '../ai/ai.service';
import { DomainsService } from '../domains/domains.service';
import { classifyNeedWithAi } from './classification.ai';
import { classifyNeed, redactPii, type ClassificationCandidate, type ClassificationResult } from './classification.placeholder';
import { scoreStub } from './scoring.placeholder';
import type {
  AiDecision,
  AiDecisionRow,
  ReviewDecisionPayload,
  ScoringStubResponse,
} from './ai-decisions.types';

@Injectable()
export class AiDecisionsService {
  private readonly logger = new Logger(AiDecisionsService.name);

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly ai: AiService,
    private readonly domains: DomainsService,
  ) {}

  // RIO-FR-003: Human Review needs something to act on, so classification
  // writes a real row either way. Gated on status (not merely "does
  // evidence exist") — AI must not run until evidence has been
  // explicitly submitted (EvidenceService.submit), not just uploaded.
  //
  // Tries real Gemini classification first (using the Need's own statement,
  // never a Study-level field), picking from the same Domain/SubDomain
  // reference list the review UI's override dropdowns already use — falls
  // back to the deterministic placeholder if Gemini isn't configured or the
  // call fails, so classification itself never hard-fails on an AI outage.
  async classify(needId: string): Promise<AiDecision> {
    const orgId = requireOrgId();
    const need = await this.tenant.runInOrgContext(async (tx) => {
      const need = await tx.need.findUnique({ where: { id: needId } });
      if (!need) {
        throw new NotFoundException({ error: { code: 'NEED_NOT_FOUND', message: 'Need not found' } });
      }
      if (need.status === 'draft') {
        throw new ConflictException({ error: { code: 'EVIDENCE_NOT_SUBMITTED', message: 'Submit evidence before running AI Classification' } });
      }
      // Strict allow-list: classification only runs from evidence_submitted.
      // Without this, re-calling classify on a Need that's already
      // ai_classified/reviewer_approved/survey_created/survey_published
      // would silently regress its status backward while any Survey already
      // built from the earlier classification stays exactly as it was —
      // the two go out of sync with nothing surfacing it.
      if (need.status !== 'evidence_submitted') {
        throw new ConflictException({
          error: { code: 'NEED_ALREADY_CLASSIFIED', message: 'This need has already been classified and moved further in its workflow.' },
        });
      }
      return need;
    });

    const result = await this.runClassification({ statement: need.statement, village: need.village });

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
          suggestion: result.suggestion as unknown as Prisma.InputJsonValue,
          confidence: result.confidence,
        },
      })) as unknown as AiDecisionRow;
      await tx.need.update({ where: { id: needId }, data: { status: 'ai_classified' } });
      return row;
    });
    await this.audit.record({ action: 'create', entityType: 'ai_decision', entityId: created.id, entityLabel: `classification for need ${needId}` });
    return this.toAiDecision(created);
  }

  private async runClassification(subject: { statement: string; village: string[] }): Promise<ClassificationResult> {
    try {
      // One query (see DomainsService.listDomainsWithSubDomains), not one
      // listSubDomains() call per domain.
      const domains = (await this.domains.listDomainsWithSubDomains()).filter((d) => d.isActive);
      const candidates: ClassificationCandidate[] = domains.map((d) => ({
        domainCode: d.code,
        domainName: d.name,
        subDomains: d.subDomains
          .filter((sd) => sd.isActive)
          .map((sd) => ({ code: sd.code, name: sd.name })),
      }));
      if (candidates.length === 0) throw new Error('No active domains configured');
      return await classifyNeedWithAi(this.ai, subject, redactPii(subject.statement), candidates);
    } catch (err) {
      this.logger.warn(`Real AI classification unavailable, falling back to placeholder: ${(err as Error).message}`);
      return classifyNeed(subject);
    }
  }

  async listByNeedId(needId: string): Promise<AiDecision[]> {
    const rows = (await this.tenant.runInOrgContext((tx) =>
      tx.aiDecision.findMany({ where: { needId }, orderBy: { createdAt: 'desc' } }),
    )) as unknown as AiDecisionRow[];
    return rows.map((r) => this.toAiDecision(r));
  }

  async review(id: string, payload: ReviewDecisionPayload): Promise<AiDecision> {
    const decidedBy = requireActor();
    const updated = await this.tenant.runInOrgContext(async (tx) => {
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
        // domain/sub-domain — write it onto the Need so Survey Builder's
        // recommend-questions has something to key off.
        await tx.need.update({ where: { id: row.needId }, data: { status: 'reviewer_approved' } });
        const source =
          payload.decision === 'modified' && payload.overrideValue
            ? (payload.overrideValue as { domains?: string[]; subDomains?: string[] })
            : (existing.suggestion as { domains?: string[]; subDomains?: string[] } | null);
        const domain = source?.domains?.[0];
        const subDomain = source?.subDomains?.[0];
        if (domain && subDomain) {
          await tx.need.update({ where: { id: row.needId }, data: { domain, subDomain } });
        }
      } else {
        // Rejected: send the Need back to evidence_submitted so a fresh
        // classify() can run — it must NOT advance to reviewer_approved,
        // which would misrepresent a rejection as an approval.
        await tx.need.update({ where: { id: row.needId }, data: { status: 'evidence_submitted' } });
      }
      return row;
    });
    // 'approved' surfaces as the 'approve' audit action (so an Audit Log
    // filter on Approved actually finds it) — 'modified'/'rejected' are
    // still an edit to the AI decision record, not a fresh approval.
    await this.audit.record({
      action: payload.decision === 'approved' ? 'approve' : 'edit',
      entityType: 'ai_decision',
      entityId: updated.id,
      entityLabel: `review for need ${updated.needId}`,
    });
    return this.toAiDecision(updated);
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
