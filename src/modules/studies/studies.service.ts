import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { requireActor, requireOrgId } from '../../tenancy/org-context';
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

  // Assigns the next sequential per-org cycleNumber (1, 2, 3... across
  // every Study the org has ever created) and creates the Study in one
  // step. A concurrent create for the same org could race between reading
  // the current max and inserting — the @@unique([orgId, cycleNumber])
  // constraint catches that as a P2002, retried once with a freshly-read
  // max before giving up with a clean error (same "map P2002 to a clean
  // error" precedent as OrganizationsService.createWithAdmin).
  private async createWithCycleNumber(
    tx: Prisma.TransactionClient,
    orgId: string,
    createdBy: string,
    payload: CreateStudyPayload,
    attempt = 0,
  ): Promise<StudyRow> {
    const cycleNumber = await this.nextCycleNumber(tx, orgId);
    try {
      const row = await tx.study.create({
        data: {
          orgId,
          title: payload.title,
          villages: payload.villages ?? [],
          createdBy,
          cycleNumber,
          methodologyVersionId: payload.methodologyVersionId ?? null,
          studyGovernorates: {
            createMany: { data: payload.governorateIds.map((governorateId) => ({ orgId, governorateId })) },
          },
          studyCenters: {
            createMany: { data: payload.centerIds.map((centerId) => ({ orgId, centerId })) },
          },
        },
        include: GEO_INCLUDE,
      });
      return this.toStudyRow(row as RawStudyWithGeo);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        if (attempt === 0) return this.createWithCycleNumber(tx, orgId, createdBy, payload, attempt + 1);
        throw new ConflictException({
          error: { code: 'CYCLE_NUMBER_CONFLICT', message: 'Could not assign a Cycle Number for this organization — please retry.' },
        });
      }
      throw err;
    }
  }

  private async nextCycleNumber(tx: Prisma.TransactionClient, orgId: string): Promise<number> {
    const agg = await tx.study.aggregate({ where: { orgId }, _max: { cycleNumber: true } });
    return (agg._max.cycleNumber ?? 0) + 1;
  }

  // A Study's Governorates/Centers must each be one of the Organization's
  // own selected Governorates/Centers — not just any real Governorate/
  // Center that happens to exist — otherwise a Study could reference
  // geography the org itself never configured. Checked in this order so
  // the caller always gets the most specific, actionable error first:
  //   1. Every Governorate/Center exists and the hierarchy is internally
  //      consistent (via GeographyService, using the org's own Region).
  //   2. Every Governorate is one of the org's own selected Governorates.
  //   3. Every Center is one of the org's own selected Centers.
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

  // Bounded pagination (NFR-006): default 100, hard cap 200. `village`/
  // `search` are optional filters — an API-consistency addition, not a new
  // business rule, so they're inert (list everything) when omitted.
  async list(opts: ListStudiesQuery = {}): Promise<StudyListResult> {
    const take = Math.min(Math.max(opts.limit ?? 100, 1), 200);
    const skip = Math.max(opts.offset ?? 0, 0);
    const where = {
      ...(opts.village ? { villages: { has: opts.village } } : {}),
      ...(opts.search ? { title: { contains: opts.search, mode: 'insensitive' as const } } : {}),
    };
    const [rows, total] = await this.tenant.runInOrgContext((tx) =>
      Promise.all([
        tx.study.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip, include: GEO_INCLUDE }),
        tx.study.count({ where }),
      ]),
    );
    return {
      items: (rows as RawStudyWithGeo[]).map((r) => this.toStudy(this.toStudyRow(r))),
      total,
      limit: take,
      offset: skip,
    };
  }

  async getById(id: string): Promise<StudyDetail> {
    const [row, evidenceCount, needCount] = await this.tenant.runInOrgContext((tx) =>
      Promise.all([
        tx.study.findUnique({ where: { id }, include: GEO_INCLUDE }),
        tx.evidence.count({ where: { studyId: id } }),
        tx.need.count({ where: { studyId: id } }),
      ]),
    );
    if (!row) throw new NotFoundException({ error: { code: 'STUDY_NOT_FOUND', message: 'Study not found' } });
    return { ...this.toStudy(this.toStudyRow(row as RawStudyWithGeo)), evidenceCount, needCount };
  }

  // Title, villages, governorateIds, centerIds, and methodologyVersionId are
  // the only Study-level fields — a Study is a pure container. Governorates/
  // Centers/MethodologyVersion are independently patchable; validated
  // against the *final* merged state (patch value or current), same pattern
  // as OrganizationsService.updateCurrent.
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
}
