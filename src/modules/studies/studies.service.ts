import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { getOrgStore, requireActor, requireOrgId } from '../../tenancy/org-context';
import { AuditService } from '../audit/audit.service';
import type { AuditChange } from '../audit/audit.types';
import { GeographyService } from '../geography/geography.service';
import { StudyConfigService } from '../study-config/study-config.service';
import { calculateSampleSize, DEFAULT_MARGIN_OF_ERROR } from './sample-size';
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

// Matches the `include` shape of the two (system-admin/tenant) `need.findMany`
// calls in getById below — both queries request the same fields, just via
// different tenant-context roles, so one type covers both.
type NeedWithSurveyMeta = Prisma.NeedGetPayload<{
  include: {
    surveys: { include: { _count: { select: { surveyQuestions: true } } } };
    surveyResponses: { select: { id: true } };
    _count: { select: { evidence: true } };
    priorityScores: true;
  };
}>;

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
    private readonly studyConfig: StudyConfigService,
  ) {}

  // RIO-FR-012 (Q3/Q4) — Study Type/Target Sector are validated against the
  // active option lists here, at the API boundary, rather than a DB-level
  // FK (see study-config.service.ts's own comment on why). Undefined is
  // always allowed (the field is optional); an empty active list means
  // nothing validates yet, which is the correct behavior until a System
  // Admin populates real values — it must never silently accept just
  // anything once options do exist.
  private async assertValidStudyType(value: string | undefined): Promise<void> {
    if (value === undefined) return;
    const names = await this.studyConfig.listActiveStudyTypeNames();
    if (names.length > 0 && !names.includes(value)) {
      throw new BadRequestException({
        error: { code: 'INVALID_STUDY_TYPE', message: `"${value}" is not a configured Study Type.` },
      });
    }
  }

  private async assertValidTargetSector(value: string | undefined): Promise<void> {
    if (value === undefined) return;
    const names = await this.studyConfig.listActiveTargetSectorNames();
    if (names.length > 0 && !names.includes(value)) {
      throw new BadRequestException({
        error: { code: 'INVALID_TARGET_SECTOR', message: `"${value}" is not a configured Target Sector.` },
      });
    }
  }

  async create(payload: CreateStudyPayload): Promise<Study> {
    const orgId = requireOrgId();
    const createdBy = requireActor();
    await this.assertValidStudyType(payload.studyType);
    await this.assertValidTargetSector(payload.targetSector);
    // Resolved inside the transaction, read by the audit record after it commits.
    let methodologyLabel: string | null = null;
    const created = await this.tenant.runInOrgContext(async (tx) => {
      await this.assertGeographyInOrgScope(tx, orgId, payload.governorateIds, payload.centerIds);
      if (payload.methodologyVersionId) {
        methodologyLabel = await this.assertMethodologyVersionPublished(tx, payload.methodologyVersionId);
      }
      return this.createWithCycleNumber(tx, orgId, createdBy, payload);
    });
    await this.audit.record({
      action: 'create', entityType: 'study', entityId: created.id, entityLabel: created.title,
      // before: null on a create — captured so the detail view shows the
      // study's opening state, which later edits are read against.
      changes: [
        { field: 'Title', before: null, after: created.title },
        { field: 'Cycle number', before: null, after: created.cycleNumber },
        { field: 'Methodology version', before: null, after: methodologyLabel },
      ],
    });
    return this.toStudy(created);
  }

  private async createWithCycleNumber(
    tx: Prisma.TransactionClient,
    orgId: string,
    createdBy: string,
    payload: CreateStudyPayload,
  ): Promise<StudyRow> {
    // RIO-FR-024: computed once, here, and stored — never recomputed later,
    // so a report always reflects the sample-size target that applied when
    // the study was set up, even if the org's default margin changes.
    const marginOfError = payload.marginOfError ?? DEFAULT_MARGIN_OF_ERROR;
    const sampleSize = calculateSampleSize(payload.population, marginOfError);
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
          methodologyVersionId: payload.methodologyVersionId,
          population: payload.population,
          marginOfError,
          requiredSampleSize: sampleSize.requiredSampleSize,
          minimumDetectableEffect: sampleSize.minimumDetectableEffect,
          cycleNumber,
          createdBy,
          studyType: payload.studyType,
          targetSector: payload.targetSector,
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
            methodologyVersionId: payload.methodologyVersionId,
            population: payload.population,
            marginOfError,
            requiredSampleSize: sampleSize.requiredSampleSize,
            minimumDetectableEffect: sampleSize.minimumDetectableEffect,
            cycleNumber,
            createdBy,
            studyType: payload.studyType,
            targetSector: payload.targetSector,
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

  /**
   * Returns the human-readable version label alongside the validation, so the
   * caller can put "v2.1" in the audit trail instead of the row's UUID — the
   * lookup is already happening, and a raw id in a before/after table tells a
   * reader nothing.
   */
  private async assertMethodologyVersionPublished(tx: Prisma.TransactionClient, id: string): Promise<string> {
    const version = await tx.methodologyVersion.findUnique({ where: { id }, select: { status: true, version: true } });
    if (!version) {
      throw new NotFoundException({ error: { code: 'METHODOLOGY_VERSION_NOT_FOUND', message: 'Methodology Version not found' } });
    }
    if (version.status !== 'PUBLISHED') {
      throw new BadRequestException({
        error: { code: 'METHODOLOGY_VERSION_NOT_PUBLISHED', message: 'Only a Published Methodology Version may be selected.' },
      });
    }
    return version.version;
  }

  async list(opts: ListStudiesQuery = {}): Promise<StudyListResult> {
    const store = getOrgStore();
    // RIO-RBAC-002 (AC1, fixed 2026-08-23) — center_supervisor holds
    // studySurvey:read with crossEntity:true in the role matrix, but this
    // branch used to check `=== 'system_admin'` literally, so the grant
    // never actually reached across orgs despite being held — every
    // Supervisor was silently scoped to whatever single org they're
    // provisioned under. This is the read path; archive/restore below stay
    // system_admin-only unless a runtime grant (AC2) authorized this
    // specific request.
    const isCrossOrgReader = store?.role === 'system_admin' || store?.role === 'center_supervisor';

    const take = Math.min(Math.max(opts.limit ?? 100, 1), 200);
    const skip = Math.max(opts.offset ?? 0, 0);
    const where: Prisma.StudyWhereInput = {
      ...(opts.organizationId ? { orgId: opts.organizationId } : {}),
      ...(opts.village ? { villages: { has: opts.village } } : {}),
      ...(opts.search ? { title: { contains: opts.search, mode: 'insensitive' as const } } : {}),
    };

    let rows: (RawStudyWithGeo & { org?: { name: string } | null; _count?: { needs: number } })[] = [];
    let total = 0;

    if (isCrossOrgReader) {
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

      // RIO-RBAC-002 (AC4) — a distinct action name per role, so an Entity
      // Admin filtering the Audit Log for SUPERVISOR_VIEWED_STUDIES sees
      // exactly the transparency the AC asks for, without System Admin's
      // own routine cross-org views mixed in.
      await this.audit.record({
        action: store?.role === 'center_supervisor' ? 'SUPERVISOR_VIEWED_STUDIES' : 'SYSTEM_ADMIN_VIEWED_STUDIES',
        entityType: 'study',
        // `null`, never the string 'all': audit_logs.entity_id is a UUID
        // column, so a sentinel here made Postgres reject the INSERT
        // ("invalid input syntax for type uuid") and AuditService.record()
        // swallowed it as a warning — every cross-org study view silently
        // went unaudited. The "all organisations" case is carried by
        // entityLabel and `scope` below, matching SurveysService.list.
        entityId: opts.organizationId ?? null,
        entityLabel: opts.organizationId ? 'Organization Studies' : 'All Platform Studies',
        organizationId: opts.organizationId,
        metadata: { scope: opts.organizationId ? 'organization' : 'all' },
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
    // RIO-RBAC-002 (AC1, fixed 2026-08-23) — see list()'s comment above.
    const isCrossOrgReader = store?.role === 'system_admin' || store?.role === 'center_supervisor';

    let row: (RawStudyWithGeo & { org?: { name: string } | null }) | null = null;
    let evidenceCount = 0;
    let needCount = 0;
    let needsList: NeedWithSurveyMeta[] = [];

    if (isCrossOrgReader) {
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
          action: store?.role === 'center_supervisor' ? 'SUPERVISOR_VIEWED_STUDIES' : 'SYSTEM_ADMIN_VIEWED_STUDIES',
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

    const needs = needsList.map((n) => {
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
    await this.assertValidStudyType(payload.studyType);
    await this.assertValidTargetSector(payload.targetSector);
    const { updated, changes } = await this.tenant.runInOrgContext(async (tx) => {
      const currentRaw = (await tx.study.findUnique({ where: { id }, include: GEO_INCLUDE })) as RawStudyWithGeo | null;
      if (!currentRaw) throw new NotFoundException({ error: { code: 'STUDY_NOT_FOUND', message: 'Study not found' } });
      const current = this.toStudyRow(currentRaw);

      const nextGovernorateIds = payload.governorateIds ?? current.governorateIds;
      const nextCenterIds = payload.centerIds ?? current.centerIds;
      if (payload.governorateIds !== undefined || payload.centerIds !== undefined) {
        await this.assertGeographyInOrgScope(tx, orgId, nextGovernorateIds, nextCenterIds);
      }
      if (payload.methodologyVersionId !== undefined) {
        await this.assertMethodologyVersionPublished(tx, payload.methodologyVersionId);
      }

      const changes = this.diff(current, payload, nextGovernorateIds, nextCenterIds);

      await tx.study.update({
        where: { id },
        data: {
          ...(payload.title !== undefined ? { title: payload.title } : {}),
          ...(payload.villages !== undefined ? { villages: payload.villages } : {}),
          ...(payload.methodologyVersionId !== undefined ? { methodologyVersionId: payload.methodologyVersionId } : {}),
          ...(payload.studyType !== undefined ? { studyType: payload.studyType } : {}),
          ...(payload.targetSector !== undefined ? { targetSector: payload.targetSector } : {}),
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
    let removedMethodologyLabel: string | null = null;
    const removed = await this.tenant.runInOrgContext(async (tx) => {
      const existing = (await tx.study.findUnique({ where: { id } })) as StudyRow | null;
      if (!existing) throw new NotFoundException({ error: { code: 'STUDY_NOT_FOUND', message: 'Study not found' } });
      // Resolved to its label for the audit entry — the deleted study's row is
      // the only remaining record of which methodology it ran against, and a
      // UUID there would be unreadable.
      removedMethodologyLabel = existing.methodologyVersionId
        ? ((await tx.methodologyVersion.findUnique({
            where: { id: existing.methodologyVersionId },
            select: { version: true },
          }))?.version ?? null)
        : null;
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
    await this.audit.record({
      action: 'delete', entityType: 'study', entityId: removed.id, entityLabel: removed.title,
      // after: null — the study is gone and this is the only surviving record
      // of what it contained.
      changes: [
        { field: 'Title', before: removed.title, after: null },
        { field: 'Cycle number', before: removed.cycleNumber, after: null },
        { field: 'Methodology version', before: removedMethodologyLabel, after: null },
      ],
    });
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
      population: row.population,
      marginOfError: row.marginOfError,
      requiredSampleSize: row.requiredSampleSize,
      minimumDetectableEffect: row.minimumDetectableEffect,
      cycleNumber: row.cycleNumber,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      studyType: row.studyType,
      targetSector: row.targetSector,
    };
  }

  async archive(id: string, reason?: string): Promise<Study> {
    const actorId = requireActor();
    const store = getOrgStore();
    // RIO-RBAC-002 (AC2) — a write action, so center_supervisor only takes
    // the cross-org path when PermissionGuard just authorized THIS request
    // via an active grant (store.grantCitation set) — never unconditionally
    // like the read paths above. No grant, no cross-org write, exactly the
    // "cannot edit unless an explicit approved grant exists" rule.
    const isCrossOrgWriter = store?.role === 'system_admin' || (store?.role === 'center_supervisor' && !!store.grantCitation);

    const raw = isCrossOrgWriter
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
    const hasNeeds = needs.length > 0;
    const allNeedsCompleted = hasNeeds && needs.every((n) => n.status === 'survey_published');
    const hasReleasedReport = reports.some((r) => r.status === 'released' || r.status === 'archived');

    if (!hasNeeds || !allNeedsCompleted || !hasReleasedReport) {
      throw new BadRequestException({
        error: {
          code: 'STUDY_INCOMPLETE_FOR_ARCHIVE',
          message: 'Study cannot be archived until all surveys are completed and at least one report is published.',
        },
      });
    }

    const now = new Date();
    const updated = isCrossOrgWriter
      ? await this.tenant.runAsOrg(raw.orgId, (tx) =>
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
    // RIO-RBAC-002 (AC2) — same rule as archive() above.
    const isCrossOrgWriter = store?.role === 'system_admin' || (store?.role === 'center_supervisor' && !!store.grantCitation);

    const raw = isCrossOrgWriter
      ? await this.tenant.runAsSupervisor((tx) => tx.study.findUnique({ where: { id }, include: GEO_INCLUDE }))
      : await this.tenant.runInOrgContext((tx) => tx.study.findUnique({ where: { id }, include: GEO_INCLUDE }));

    if (!raw) {
      throw new NotFoundException({ error: { code: 'STUDY_NOT_FOUND', message: 'Study not found' } });
    }

    if (raw.status !== 'archived') {
      throw new BadRequestException({ error: { code: 'STUDY_NOT_ARCHIVED', message: 'Only an archived study can be restored.' } });
    }

    const updated = isCrossOrgWriter
      ? await this.tenant.runAsOrg(raw.orgId, (tx) =>
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
