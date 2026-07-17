import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma } from '../../generated/prisma';
import { ConfigService } from '../../config/config.service';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { requireOrgId, requireActor } from '../../tenancy/org-context';
import { AuditService } from '../audit/audit.service';
import { getSurveyDefinition, type SurveyDefinition } from '../survey-definition/survey-definition.placeholder';
import type { CreateSurveyLinkPayload, PublicSurveyLink, PublicSurveyLinkRow } from './public-surveys.types';

type LinkWithResponseCount = Omit<PublicSurveyLinkRow, 'responseCount'> & { _count: { responses: number } };

@Injectable()
export class PublicSurveysService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async listLinks(studyId: string): Promise<PublicSurveyLink[]> {
    await this.findStudyOrThrow(studyId);
    const rows = await this.tenant.runInOrgContext((tx) =>
      tx.publicSurveyLink.findMany({
        where: { studyId },
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { responses: true } } },
      }),
    );
    return rows.map((r) => this.toPublicLink(r as unknown as LinkWithResponseCount));
  }

  async createLink(studyId: string, payload: CreateSurveyLinkPayload): Promise<PublicSurveyLink> {
    await this.findStudyOrThrow(studyId);
    const orgId = requireOrgId();
    const actorId = requireActor();
    const token = randomBytes(24).toString('base64url');
    const expiresAt = payload.expiresInDays
      ? new Date(Date.now() + payload.expiresInDays * 24 * 60 * 60 * 1000)
      : null;
    // Contract-level `pattern: '\S'` already rejects an all-whitespace body,
    // so trimming here can only shrink a valid label, never produce a blank
    // one — no need to re-check blankness after trim.
    const label = payload.label.trim();

    let row: LinkWithResponseCount;
    try {
      row = (await this.tenant.runInOrgContext((tx) =>
        tx.publicSurveyLink.create({
          data: { orgId, studyId, label, token, createdBy: actorId, expiresAt },
          include: { _count: { select: { responses: true } } },
        }),
      )) as unknown as LinkWithResponseCount;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({
          error: { code: 'SURVEY_LINK_LABEL_ALREADY_EXISTS', message: 'A survey link with this label already exists for this study.' },
        });
      }
      throw err;
    }
    await this.audit.record({ action: 'create', entityType: 'survey', entityId: row.id, entityLabel: label });
    return this.toPublicLink(row);
  }

  async deactivateLink(studyId: string, linkId: string): Promise<PublicSurveyLink> {
    await this.findStudyOrThrow(studyId);
    const row = await this.tenant.runInOrgContext(async (tx) => {
      const existing = await tx.publicSurveyLink.findUnique({ where: { id: linkId } });
      if (!existing || existing.studyId !== studyId) {
        throw new NotFoundException({ error: { code: 'SURVEY_LINK_NOT_FOUND', message: 'Survey link not found' } });
      }
      return tx.publicSurveyLink.update({
        where: { id: linkId },
        data: { isActive: false },
        include: { _count: { select: { responses: true } } },
      });
    });
    await this.audit.record({ action: 'edit', entityType: 'survey', entityId: row.id, entityLabel: row.label, changes: [{ field: 'isActive', before: true, after: false }] });
    return this.toPublicLink(row as unknown as LinkWithResponseCount);
  }

  getDefinition(studyId: string): SurveyDefinition {
    return getSurveyDefinition(studyId);
  }

  private async findStudyOrThrow(studyId: string): Promise<void> {
    const study = await this.tenant.runInOrgContext((tx) => tx.study.findUnique({ where: { id: studyId } }));
    if (!study) throw new NotFoundException({ error: { code: 'STUDY_NOT_FOUND', message: 'Study not found' } });
  }

  private toPublicLink(row: LinkWithResponseCount): PublicSurveyLink {
    return {
      id: row.id,
      studyId: row.studyId,
      label: row.label,
      token: row.token,
      publicUrl: `${this.config.publicAppUrl}/public/survey/${row.token}`,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      isActive: row.isActive,
      createdAt: row.createdAt.toISOString(),
      responseCount: row._count.responses,
    };
  }
}
