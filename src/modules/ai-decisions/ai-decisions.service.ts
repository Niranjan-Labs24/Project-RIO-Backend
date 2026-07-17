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
  async classify(studyId: string): Promise<AiDecision> {
    const orgId = requireOrgId();
    const need = await this.tenant.runInOrgContext(async (tx) => {
      const study = await tx.study.findUnique({ where: { id: studyId } });
      if (!study) {
        throw new NotFoundException({ error: { code: 'STUDY_NOT_FOUND', message: 'Study not found' } });
      }
      const need = await tx.need.findUnique({ where: { studyId } });
      if (!need) {
        throw new NotFoundException({ error: { code: 'NEED_NOT_FOUND', message: 'Capture the need before classifying' } });
      }
      if (study.status === 'draft' || study.status === 'need_captured') {
        throw new ConflictException({ error: { code: 'EVIDENCE_NOT_SUBMITTED', message: 'Submit evidence before running AI Classification' } });
      }
      return need;
    });

    const result = await this.runClassification({ statement: need.statement, village: need.village });

    const created = await this.tenant.runInOrgContext(async (tx) => {
      const row = (await tx.aiDecision.create({
        data: {
          orgId,
          studyId,
          touchpoint: 'need_classification',
          subjectType: 'need',
          subjectId: need.id,
          modelName: result.modelName,
          modelVersion: result.modelVersion,
          suggestion: result.suggestion as unknown as Prisma.InputJsonValue,
          confidence: result.confidence,
        },
      })) as unknown as AiDecisionRow;
      await tx.study.update({ where: { id: studyId }, data: { status: 'ai_classified' } });
      return row;
    });
    await this.audit.record({ action: 'create', entityType: 'ai_decision', entityId: created.id, entityLabel: `classification for study ${studyId}` });
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

  async listByStudyId(studyId: string): Promise<AiDecision[]> {
    const rows = (await this.tenant.runInOrgContext((tx) =>
      tx.aiDecision.findMany({ where: { studyId }, orderBy: { createdAt: 'desc' } }),
    )) as unknown as AiDecisionRow[];
    return rows.map((r) => this.toAiDecision(r));
  }

  async review(id: string, payload: ReviewDecisionPayload): Promise<AiDecision> {
    const decidedBy = requireActor();
    const updated = await this.tenant.runInOrgContext(async (tx) => {
      const existing = (await tx.aiDecision.findUnique({ where: { id } })) as unknown as AiDecisionRow | null;
      if (!existing) throw new NotFoundException({ error: { code: 'AI_DECISION_NOT_FOUND', message: 'AI decision not found' } });
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
      await tx.study.update({ where: { id: row.studyId }, data: { status: 'human_reviewed' } });

      // Approved (as-is) or modified (overridden) both produce a final
      // domain/sub-domain — write it onto the Study so Survey Builder's
      // recommend-questions has something to key off. Rejected has no final
      // classification, so Study.domain/subDomain stay whatever they were.
      if (payload.decision === 'approved' || payload.decision === 'modified') {
        const source =
          payload.decision === 'modified' && payload.overrideValue
            ? (payload.overrideValue as { domains?: string[]; subDomains?: string[] })
            : (existing.suggestion as { domains?: string[]; subDomains?: string[] } | null);
        const domain = source?.domains?.[0];
        const subDomain = source?.subDomains?.[0];
        if (domain && subDomain) {
          await tx.study.update({ where: { id: row.studyId }, data: { domain, subDomain } });
        }
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
      entityLabel: `review for study ${updated.studyId}`,
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
