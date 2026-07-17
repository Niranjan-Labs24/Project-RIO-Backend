import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { requireActor, requireOrgId } from '../../tenancy/org-context';
import { AuditService } from '../audit/audit.service';
import { classifyNeed } from './classification.placeholder';
import { scoreStub } from './scoring.placeholder';
import type {
  AiDecision,
  AiDecisionRow,
  ReviewDecisionPayload,
  ScoringStubResponse,
} from './ai-decisions.types';

@Injectable()
export class AiDecisionsService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
  ) {}

  // RIO-FR-003: Human Review needs something to act on, so classification
  // writes a real (placeholder-logic) row — unlike scoring below. Gated on
  // status (not merely "does evidence exist") — per Ganesh, AI must not run
  // until evidence has been explicitly submitted (EvidenceService.submit),
  // not just uploaded.
  async classify(studyId: string): Promise<AiDecision> {
    const orgId = requireOrgId();
    const created = await this.tenant.runInOrgContext(async (tx) => {
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
      const result = classifyNeed({ statement: need.statement, village: need.village });
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
      return row;
    });
    await this.audit.record({ action: 'edit', entityType: 'ai_decision', entityId: updated.id, entityLabel: `review for study ${updated.studyId}` });
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
