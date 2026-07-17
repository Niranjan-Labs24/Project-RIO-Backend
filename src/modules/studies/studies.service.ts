import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { requireActor, requireOrgId } from '../../tenancy/org-context';
import { AuditService } from '../audit/audit.service';
import type { AuditChange } from '../audit/audit.types';
import type {
  CreateStudyPayload,
  ListStudiesQuery,
  Study,
  StudyDetail,
  StudyListResult,
  StudyRow,
  UpdateStudyPayload,
} from './studies.types';

@Injectable()
export class StudiesService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(payload: CreateStudyPayload): Promise<Study> {
    const orgId = requireOrgId();
    const createdBy = requireActor();
    const created = await this.tenant.runInOrgContext((tx) =>
      tx.study.create({
        data: { orgId, title: payload.title, villages: payload.villages ?? [], createdBy },
      }),
    ) as StudyRow;
    await this.audit.record({ action: 'create', entityType: 'study', entityId: created.id, entityLabel: created.title });
    return this.toStudy(created);
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
        tx.study.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip }),
        tx.study.count({ where }),
      ]),
    );
    return {
      items: (rows as StudyRow[]).map((r) => this.toStudy(r)),
      total,
      limit: take,
      offset: skip,
    };
  }

  async getById(id: string): Promise<StudyDetail> {
    const [row, evidenceCount, needCount] = await this.tenant.runInOrgContext((tx) =>
      Promise.all([
        tx.study.findUnique({ where: { id } }),
        tx.evidence.count({ where: { studyId: id } }),
        tx.need.count({ where: { studyId: id } }),
      ]),
    );
    if (!row) throw new NotFoundException({ error: { code: 'STUDY_NOT_FOUND', message: 'Study not found' } });
    return { ...this.toStudy(row as StudyRow), evidenceCount, needCount };
  }

  // Title and villages are the only Study-level fields — a Study is a pure
  // container, so there's nothing else here to edit directly.
  async update(id: string, payload: UpdateStudyPayload): Promise<Study> {
    const { updated, changes } = await this.tenant.runInOrgContext(async (tx) => {
      const current = (await tx.study.findUnique({ where: { id } })) as StudyRow | null;
      if (!current) throw new NotFoundException({ error: { code: 'STUDY_NOT_FOUND', message: 'Study not found' } });
      const changes: AuditChange[] = [];
      if (payload.title !== undefined && payload.title !== current.title) {
        changes.push({ field: 'title', before: current.title, after: payload.title });
      }
      if (payload.villages !== undefined) {
        changes.push({ field: 'villages', before: current.villages, after: payload.villages });
      }
      const updated = (await tx.study.update({
        where: { id },
        data: {
          ...(payload.title !== undefined ? { title: payload.title } : {}),
          ...(payload.villages !== undefined ? { villages: payload.villages } : {}),
        },
      })) as StudyRow;
      return { updated, changes };
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

  private toStudy(row: StudyRow): Study {
    return {
      id: row.id,
      title: row.title,
      villages: row.villages,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
