import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { getOrgStore, requireActor, requireOrgId } from '../../tenancy/org-context';
import { AuditService } from '../audit/audit.service';
import type { AuditChange } from '../audit/audit.types';
import { GeographyService } from '../geography/geography.service';
import type {
  CreateStudyPayload,
  ListStudiesQuery,
  Study,
  StudyDetail,
  StudyListResult,
  StudyRow,
  UpdateStudyPayload,
} from './studies.types';

const DIFF_FIELDS = ['title', 'villages', 'methodologyVersionId'] as const;

// Raw shape Prisma returns once `studyGovernorates`/`studyCenters` are
// included — reduced to plain id arrays before anything else in this file
// touches it, same pattern as OrganizationsService's RawOrgWithGeo/toOrgRow.
type RawStudyWithGeo = Omit<StudyRow, 'governorateIds' | 'centerIds'> & {
  studyGovernorates: { governorateId: string }[];
  studyCenters: { centerId: string }[];
};
const GEO_INCLUDE = { studyGovernorates: true, studyCenters: true } as const;

@Injectable()
export class StudiesService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly geography: GeographyService,
  ) {}

  async create(payload: CreateStudyPayload): Promise<Study> {
    const orgId = requireOrgId();
    const createdBy = requireActor();
    const created = await this.tenant.runInOrgContext(async (tx) => {
      await this.assertGeographyInOrgScope(tx, orgId, payload.governorateIds, payload.centerIds);
      if (payload.methodologyVersionId) {
        await this.assertMethodologyVersionPublished(tx, payload.methodologyVersionId);
      }
      return this.createWithCycleNumber(tx, orgId, createdBy, payload);
    });
    await this.audit.record({ action: 'create', entityType: 'study', entityId: created.id, entityLabel: created.title });
    return this.toStudy(created);
  }

  private async createWithCycleNumber(
    tx: Prisma.TransactionClient,
    orgId: string,
    createdBy: string,
    payload: CreateStudyPayload,
  ): Promise<StudyRow> {
    try {
      const maxRow = await tx.study.findFirst({
        where: { orgId },
        orderBy: { cycleNumber: 'desc' },
        select: { cycleNumber: true },
      });
      const cycleNumber = (maxRow?.cycleNumber ?? 0) + 1;
      const created = await tx.study.create({
        data: {
          orgId,
          title: payload.title,
          villages: payload.villages ?? [],
          methodologyVersionId: payload.methodologyVersionId ?? null,
          cycleNumber,
          createdBy,
          studyGovernorates: { createMany: { data: payload.governorateIds.map((governorateId) => ({ orgId, governorateId })) } },
          studyCenters: { createMany: { data: payload.centerIds.map((centerId) => ({ orgId, centerId })) } },
        },
        include: GEO_INCLUDE,
      });
      return this.toStudyRow(created as RawStudyWithGeo);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const maxRow = await tx.study.findFirst({
          where: { orgId },
          orderBy: { cycleNumber: 'desc' },
          select: { cycleNumber: true },
        });
        const cycleNumber = (maxRow?.cycleNumber ?? 0) + 1;
        const created = await tx.study.create({
          data: {
            orgId,
            title: payload.title,
            villages: payload.villages ?? [],
            methodologyVersionId: payload.methodologyVersionId ?? null,
            cycleNumber,
            createdBy,
            studyGovernorates: { createMany: { data: payload.governorateIds.map((governorateId) => ({ orgId, governorateId })) } },
            studyCenters: { createMany: { data: payload.centerIds.map((centerId) => ({ orgId, centerId })) } },
          },
          include: GEO_INCLUDE,
        });
        return this.toStudyRow(created as RawStudyWithGeo);
      }
      throw e;
    }
  }

  private async assertGeographyInOrgScope(
    tx: Prisma.TransactionClient,
    orgId: string,
    governorateIds: string[],
    centerIds: string[],
  ): Promise<void> {
    const org = (await tx.organisation.findUnique({
      where: { id: orgId },
      include: { orgGovernorates: true, orgCenters: true },
    })) as { regionId: string | null; orgGovernorates: { governorateId: string }[]; orgCenters: { centerId: string }[] } | null;
    const orgGovernorateIds = (org?.orgGovernorates ?? []).map((g) => g.governorateId);
    const orgCenterIds = (org?.orgCenters ?? []).map((c) => c.centerId);

    await this.geography.validateHierarchy({ regionId: org?.regionId ?? null, governorateIds, centerIds });

    const orgGovernorateIdSet = new Set(orgGovernorateIds);
    const orphanGovernorate = governorateIds.find((id) => !orgGovernorateIdSet.has(id));
    if (orphanGovernorate) {
      throw new BadRequestException({
        error: { code: 'GOVERNORATE_NOT_IN_ORG_SCOPE', message: "One or more Governorates are not one of the organization's selected Governorates." },
      });
    }

    const orgCenterIdSet = new Set(orgCenterIds);
    const orphanCenter = centerIds.find((id) => !orgCenterIdSet.has(id));
    if (orphanCenter) {
      throw new BadRequestException({
        error: { code: 'CENTER_NOT_IN_ORG_SCOPE', message: "One or more Centers are not one of the organization's selected Centers." },
      });
    }
  }

  private async assertMethodologyVersionPublished(tx: Prisma.TransactionClient, id: string): Promise<void> {
    const version = await tx.methodologyVersion.findUnique({ where: { id }, select: { status: true } });
    if (!version) {
      throw new NotFoundException({ error: { code: 'METHODOLOGY_VERSION_NOT_FOUND', message: 'Methodology Version not found' } });
    }
    if (version.status !== 'PUBLISHED') {
      throw new BadRequestException({
        error: { code: 'METHODOLOGY_VERSION_NOT_PUBLISHED', message: 'Only a Published Methodology Version may be selected.' },
      });
    }
  }

  async list(opts: ListStudiesQuery = {}): Promise<StudyListResult> {
    const store = getOrgStore();
    const isSysAdmin = store?.role === 'system_admin';

    const take = Math.min(Math.max(opts.limit ?? 100, 1), 200);
    const skip = Math.max(opts.offset ?? 0, 0);
    const where: Prisma.StudyWhereInput = {
      ...(opts.organizationId ? { orgId: opts.organizationId } : {}),
      ...(opts.village ? { villages: { has: opts.village } } : {}),
      ...(opts.search ? { title: { contains: opts.search, mode: 'insensitive' as const } } : {}),
    };

    let rows: (RawStudyWithGeo & { org?: { name: string } | null; _count?: { needs: number } })[] = [];
    let total = 0;

    if (isSysAdmin) {
      const result = await this.tenant.runAsSupervisor((tx) =>
        Promise.all([
          tx.study.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take,
            skip,
            include: {
              ...GEO_INCLUDE,
              org: { select: { name: true } },
              _count: { select: { needs: true } },
            },
          }),
          tx.study.count({ where }),
        ]),
      );
      rows = result[0] as (RawStudyWithGeo & { org?: { name: string } | null; _count?: { needs: number } })[];
      total = result[1];

      await this.audit.record({
        action: 'SYSTEM_ADMIN_VIEWED_STUDIES',
        entityType: 'study',
        entityId: opts.organizationId ?? 'all',
        entityLabel: opts.organizationId ? 'Organization Studies' : 'All Platform Studies',
        organizationId: opts.organizationId,
      });
    } else {
      const result = await this.tenant.runInOrgContext((tx) =>
        Promise.all([
          tx.study.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take,
            skip,
            include: {
              ...GEO_INCLUDE,
              org: { select: { name: true } },
              _count: { select: { needs: true } },
            },
          }),
          tx.study.count({ where }),
        ]),
      );
      rows = result[0] as (RawStudyWithGeo & { org?: { name: string } | null; _count?: { needs: number } })[];
      total = result[1];
    }

    return {
      items: rows.map((r) => ({
        ...this.toStudy(this.toStudyRow(r)),
        orgName: r.org?.name ?? undefined,
        surveysCount: r._count?.needs ?? 0,
      })),
      total,
      limit: take,
      offset: skip,
    };
  }

  async getById(id: string): Promise<StudyDetail> {
    const store = getOrgStore();
    const isSysAdmin = store?.role === 'system_admin';

    let row: (RawStudyWithGeo & { org?: { name: string } | null }) | null = null;
    let evidenceCount = 0;
    let needCount = 0;
    let needsList: any[] = [];

    if (isSysAdmin) {
      const result = await this.tenant.runAsSupervisor((tx) =>
        Promise.all([
          tx.study.findUnique({
            where: { id },
            include: {
              ...GEO_INCLUDE,
              org: { select: { name: true } },
            },
          }),
          tx.evidence.count({ where: { studyId: id } }),
          tx.need.count({ where: { studyId: id } }),
          tx.need.findMany({
            where: { studyId: id },
            orderBy: { createdAt: 'desc' },
            include: {
              surveys: { include: { _count: { select: { surveyQuestions: true } } } },
              surveyResponses: { select: { id: true } },
              _count: { select: { evidence: true } },
              priorityScores: { take: 1, orderBy: { scoredAt: 'desc' } },
            },
          }),
        ]),
      );
      row = result[0] as (RawStudyWithGeo & { org?: { name: string } | null }) | null;
      evidenceCount = result[1];
      needCount = result[2];
      needsList = result[3];

      if (row) {
        await this.audit.record({
          action: 'SYSTEM_ADMIN_VIEWED_STUDIES',
          entityType: 'study',
          entityId: id,
          entityLabel: row.title,
          organizationId: row.orgId,
        });
      }
    } else {
      const result = await this.tenant.runInOrgContext((tx) =>
        Promise.all([
          tx.study.findUnique({
            where: { id },
            include: {
              ...GEO_INCLUDE,
              org: { select: { name: true } },
            },
          }),
          tx.evidence.count({ where: { studyId: id } }),
          tx.need.count({ where: { studyId: id } }),
          tx.need.findMany({
            where: { studyId: id },
            orderBy: { createdAt: 'desc' },
            include: {
              surveys: { include: { _count: { select: { surveyQuestions: true } } } },
              surveyResponses: { select: { id: true } },
              _count: { select: { evidence: true } },
              priorityScores: { take: 1, orderBy: { scoredAt: 'desc' } },
            },
          }),
        ]),
      );
      row = result[0] as (RawStudyWithGeo & { org?: { name: string } | null }) | null;
      evidenceCount = result[1];
      needCount = result[2];
      needsList = result[3];
    }

    if (!row) throw new NotFoundException({ error: { code: 'STUDY_NOT_FOUND', message: 'Study not found' } });

    const needs = needsList.map((n: any) => {
      const survey = n.surveys?.[0];
      return {
        id: n.id,
        title: n.title,
        status: n.status,
        village: Array.isArray(n.village) ? n.village.join(', ') : (n.village ?? '—'),
        domainCategory: n.domain ?? n.aiSuggestedDomain ?? '—',
        createdAt: n.createdAt ? new Date(n.createdAt).toISOString() : new Date().toISOString(),
        responseCount: n.surveyResponses?.length ?? 0,
        questionCount: survey?._count?.surveyQuestions ?? 0,
        score: n.priorityScores?.[0]?.overallScore ?? null,
        evidenceCount: n._count?.evidence ?? 0,
      };
    });

    return {
      ...this.toStudy(this.toStudyRow(row)),
      orgName: row.org?.name ?? undefined,
      evidenceCount,
      needCount,
      needs,
    };
  }

  async update(id: string, payload: UpdateStudyPayload): Promise<Study> {
    const orgId = requireOrgId();
    const { updated, changes } = await this.tenant.runInOrgContext(async (tx) => {
      const currentRaw = (await tx.study.findUnique({ where: { id }, include: GEO_INCLUDE })) as RawStudyWithGeo | null;
      if (!currentRaw) throw new NotFoundException({ error: { code: 'STUDY_NOT_FOUND', message: 'Study not found' } });
      const current = this.toStudyRow(currentRaw);

      const nextGovernorateIds = payload.governorateIds ?? current.governorateIds;
      const nextCenterIds = payload.centerIds ?? current.centerIds;
      if (payload.governorateIds !== undefined || payload.centerIds !== undefined) {
        await this.assertGeographyInOrgScope(tx, orgId, nextGovernorateIds, nextCenterIds);
      }
      if (payload.methodologyVersionId !== undefined && payload.methodologyVersionId !== null) {
        await this.assertMethodologyVersionPublished(tx, payload.methodologyVersionId);
      }

      const changes = this.diff(current, payload, nextGovernorateIds, nextCenterIds);

      await tx.study.update({
        where: { id },
        data: {
          ...(payload.title !== undefined ? { title: payload.title } : {}),
          ...(payload.villages !== undefined ? { villages: payload.villages } : {}),
          ...(payload.methodologyVersionId !== undefined ? { methodologyVersionId: payload.methodologyVersionId } : {}),
        },
      });

      if (payload.governorateIds !== undefined) {
        await tx.studyGovernorate.deleteMany({ where: { studyId: id } });
        if (payload.governorateIds.length > 0) {
          await tx.studyGovernorate.createMany({
            data: payload.governorateIds.map((governorateId) => ({ studyId: id, orgId, governorateId })),
          });
        }
      }
      if (payload.centerIds !== undefined) {
        await tx.studyCenter.deleteMany({ where: { studyId: id } });
        if (payload.centerIds.length > 0) {
          await tx.studyCenter.createMany({
            data: payload.centerIds.map((centerId) => ({ studyId: id, orgId, centerId })),
          });
        }
      }

      const updatedRaw = (await tx.study.findUnique({ where: { id }, include: GEO_INCLUDE })) as RawStudyWithGeo;
      return { updated: this.toStudyRow(updatedRaw), changes };
    });
    if (changes.length > 0) {
      await this.audit.record({ action: 'edit', entityType: 'study', entityId: updated.id, entityLabel: updated.title, changes });
    }
    return this.toStudy(updated);
  }

  // A Study can be deleted only while none of its Needs have moved past
  // draft — once a Need has evidence, a classification, or a survey, other
  // people rely on it and the Study can no longer be deleted out from under
  // them. An empty Study (no Needs yet) is always deletable.
  async remove(id: string): Promise<void> {
    const removed = await this.tenant.runInOrgContext(async (tx) => {
      const existing = (await tx.study.findUnique({ where: { id } })) as StudyRow | null;
      if (!existing) throw new NotFoundException({ error: { code: 'STUDY_NOT_FOUND', message: 'Study not found' } });
      const advancedNeeds = await tx.need.count({ where: { studyId: id, status: { not: 'draft' } } });
      if (advancedNeeds > 0) {
        throw new ConflictException({
          error: {
            code: 'STUDY_NOT_DELETABLE',
            message: 'A study with a classified or reviewed need cannot be deleted.',
          },
        });
      }
      await tx.study.delete({ where: { id } });
      return existing;
    });
    await this.audit.record({ action: 'delete', entityType: 'study', entityId: removed.id, entityLabel: removed.title });
  }

  private diff(
    current: StudyRow,
    patch: UpdateStudyPayload,
    nextGovernorateIds: string[],
    nextCenterIds: string[],
  ): AuditChange[] {
    const before = current as unknown as Record<string, unknown>;
    const after = patch as unknown as Record<string, unknown>;
    const changes: AuditChange[] = [];
    for (const f of DIFF_FIELDS) {
      if (after[f] !== undefined && JSON.stringify(before[f]) !== JSON.stringify(after[f])) {
        changes.push({ field: f, before: before[f], after: after[f] });
      }
    }
    // governorateIds/centerIds aren't real columns on `studies` (they live
    // in the join tables) so DIFF_FIELDS can't cover them generically — diff
    // the sets directly against whatever the final set will be.
    if (patch.governorateIds !== undefined && !this.sameIdSet(current.governorateIds, nextGovernorateIds)) {
      changes.push({ field: 'governorateIds', before: current.governorateIds, after: nextGovernorateIds });
    }
    if (patch.centerIds !== undefined && !this.sameIdSet(current.centerIds, nextCenterIds)) {
      changes.push({ field: 'centerIds', before: current.centerIds, after: nextCenterIds });
    }
    return changes;
  }

  private sameIdSet(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sorted = (xs: string[]) => [...xs].sort();
    return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
  }

  // Reduces the raw `studyGovernorates`/`studyCenters` join arrays Prisma
  // returns (once included) down to plain id arrays — every other method in
  // this file works with that flattened StudyRow shape, never the raw join
  // rows directly.
  private toStudyRow(raw: RawStudyWithGeo): StudyRow {
    return {
      ...raw,
      governorateIds: raw.studyGovernorates.map((g) => g.governorateId),
      centerIds: raw.studyCenters.map((c) => c.centerId),
    };
  }

  private toStudy(row: StudyRow): Study {
    return {
      id: row.id,
      title: row.title,
      villages: row.villages,
      governorateIds: row.governorateIds,
      centerIds: row.centerIds,
      methodologyVersionId: row.methodologyVersionId,
      cycleNumber: row.cycleNumber,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async archive(id: string, reason?: string): Promise<Study> {
    const actorId = requireActor();
    const store = getOrgStore();
    const isSysAdmin = store?.role === 'system_admin';

    const raw = isSysAdmin
      ? await this.tenant.runAsSupervisor((tx) => tx.study.findUnique({ where: { id }, include: { needs: true, reports: true, ...GEO_INCLUDE } }))
      : await this.tenant.runInOrgContext((tx) => tx.study.findUnique({ where: { id }, include: { needs: true, reports: true, ...GEO_INCLUDE } }));

    if (!raw) {
      throw new NotFoundException({ error: { code: 'STUDY_NOT_FOUND', message: 'Study not found' } });
    }

    if (raw.status === 'archived') {
      throw new BadRequestException({ error: { code: 'STUDY_ALREADY_ARCHIVED', message: 'Study is already archived.' } });
    }

    const needs = raw.needs ?? [];
    const reports = raw.reports ?? [];
    const hasIncompleteNeeds = needs.length > 0 && needs.some((n: any) => n.status !== 'survey_published');
    const hasReleasedReport = reports.some((r: any) => r.status === 'released' || r.status === 'archived');

    if (hasIncompleteNeeds && !hasReleasedReport) {
      throw new BadRequestException({
        error: {
          code: 'STUDY_INCOMPLETE_FOR_ARCHIVE',
          message: 'Study cannot be archived until all surveys are completed and reports are published.',
        },
      });
    }

    const now = new Date();
    const updated = isSysAdmin
      ? await this.tenant.runAsSupervisor((tx) =>
          tx.study.update({
            where: { id },
            data: { status: 'archived', archivedAt: now, archivedBy: actorId, archiveReason: reason ?? null },
            include: GEO_INCLUDE,
          }),
        )
      : await this.tenant.runInOrgContext((tx) =>
          tx.study.update({
            where: { id },
            data: { status: 'archived', archivedAt: now, archivedBy: actorId, archiveReason: reason ?? null },
            include: GEO_INCLUDE,
          }),
        );

    await this.audit.record({
      action: 'STUDY_ARCHIVED',
      entityType: 'study',
      entityId: id,
      entityLabel: raw.title,
      organizationId: raw.orgId,
      metadata: { reason: reason ?? null },
    });

    return this.toStudy(this.toStudyRow(updated as RawStudyWithGeo));
  }

  async restore(id: string): Promise<Study> {
    requireActor();
    const store = getOrgStore();
    const isSysAdmin = store?.role === 'system_admin';

    const raw = isSysAdmin
      ? await this.tenant.runAsSupervisor((tx) => tx.study.findUnique({ where: { id }, include: GEO_INCLUDE }))
      : await this.tenant.runInOrgContext((tx) => tx.study.findUnique({ where: { id }, include: GEO_INCLUDE }));

    if (!raw) {
      throw new NotFoundException({ error: { code: 'STUDY_NOT_FOUND', message: 'Study not found' } });
    }

    if (raw.status !== 'archived') {
      throw new BadRequestException({ error: { code: 'STUDY_NOT_ARCHIVED', message: 'Only an archived study can be restored.' } });
    }

    const updated = isSysAdmin
      ? await this.tenant.runAsSupervisor((tx) =>
          tx.study.update({
            where: { id },
            data: { status: 'completed', archivedAt: null, archivedBy: null, archiveReason: null },
            include: GEO_INCLUDE,
          }),
        )
      : await this.tenant.runInOrgContext((tx) =>
          tx.study.update({
            where: { id },
            data: { status: 'completed', archivedAt: null, archivedBy: null, archiveReason: null },
            include: GEO_INCLUDE,
          }),
        );

    await this.audit.record({
      action: 'STUDY_RESTORED',
      entityType: 'study',
      entityId: id,
      entityLabel: raw.title,
      organizationId: raw.orgId,
    });

    return this.toStudy(this.toStudyRow(updated as RawStudyWithGeo));
  }
}
