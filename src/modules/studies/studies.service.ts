import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { requireActor, requireOrgId } from '../../tenancy/org-context';
import { roleByKey } from '../../rbac/role-matrix';
import { AuditService } from '../audit/audit.service';
import type { AuditChange } from '../audit/audit.types';
import {
  DELETABLE_STUDY_STATUSES,
  type AssignableReviewer,
  type CreateStudyPayload,
  type ListStudiesQuery,
  type Study,
  type StudyDetail,
  type StudyListResult,
  type StudyRow,
  type UpdateStudyPayload,
} from './studies.types';

// Source of truth is role-matrix.ts, not a hardcoded literal — resolved
// once at module load since ROLE_MATRIX is static. "Reviewer/Approver" in
// product terms maps to the `human_reviewer` role, which is the one that
// actually approves/modifies AI Classification before publishing.
const REVIEWER_APPROVER_ROLE_ID = roleByKey('human_reviewer')!.id;

@Injectable()
export class StudiesService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(payload: CreateStudyPayload): Promise<Study> {
    const orgId = requireOrgId();
    const createdBy = requireActor();
    const created = await this.tenant.runInOrgContext(async (tx) => {
      const assignedReviewerId = await this.resolveAssignedReviewer(tx, payload.assignedReviewerId);
      return tx.study.create({
        data: { orgId, title: payload.title, villages: payload.villages ?? [], createdBy, assignedReviewerId },
      });
    }) as StudyRow;
    await this.audit.record({ action: 'create', entityType: 'study', entityId: created.id, entityLabel: created.title });
    return this.toStudy(created);
  }

  // Study-create's reviewer picker: every active Reviewer/Approver
  // (human_reviewer) in the caller's own org. Exposed via studies
  // (studySurvey:create), not users (entityTeam:read) — a caller who can
  // create a Study doesn't necessarily have entityTeam access, but still
  // needs this list.
  async listAssignableReviewers(): Promise<AssignableReviewer[]> {
    const rows = await this.tenant.runInOrgContext((tx) =>
      tx.user.findMany({
        where: { roleId: REVIEWER_APPROVER_ROLE_ID, status: 'active' },
        orderBy: { name: 'asc' },
      }),
    );
    return rows.map((r) => ({ id: r.id, name: r.name, email: r.email }));
  }

  // Required unless the org has zero active Reviewer/Approver users
  // (nothing to assign); when a value is given, it must actually be one —
  // org membership is implicit (every query here runs inside
  // runInOrgContext's RLS-scoped session), role and active-status are
  // checked explicitly.
  private async resolveAssignedReviewer(
    tx: Prisma.TransactionClient,
    assignedReviewerId: string | undefined,
  ): Promise<string | null> {
    if (!assignedReviewerId) {
      const reviewerCount = await tx.user.count({ where: { roleId: REVIEWER_APPROVER_ROLE_ID, status: 'active' } });
      if (reviewerCount > 0) {
        throw new BadRequestException({
          error: { code: 'ASSIGNED_REVIEWER_REQUIRED', message: 'Select an assigned reviewer.' },
        });
      }
      return null;
    }
    const reviewer = await tx.user.findFirst({
      where: { id: assignedReviewerId, roleId: REVIEWER_APPROVER_ROLE_ID, status: 'active' },
    });
    if (!reviewer) {
      throw new BadRequestException({
        error: {
          code: 'INVALID_ASSIGNED_REVIEWER',
          message: 'The selected reviewer must be an active Reviewer/Approver in this organisation.',
        },
      });
    }
    return reviewer.id;
  }

  // Bounded pagination (NFR-006): default 100, hard cap 200. `status`/
  // `village`/`search` are optional filters — an API-consistency addition,
  // not a new business rule, so they're inert (list everything) when omitted.
  async list(opts: ListStudiesQuery = {}): Promise<StudyListResult> {
    const take = Math.min(Math.max(opts.limit ?? 100, 1), 200);
    const skip = Math.max(opts.offset ?? 0, 0);
    const where = {
      ...(opts.status ? { status: opts.status } : {}),
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
    const [row, evidenceCount] = await this.tenant.runInOrgContext((tx) =>
      Promise.all([
        tx.study.findUnique({ where: { id } }),
        tx.evidence.count({ where: { studyId: id } }),
      ]),
    );
    if (!row) throw new NotFoundException({ error: { code: 'STUDY_NOT_FOUND', message: 'Study not found' } });
    return { ...this.toStudy(row as StudyRow), evidenceCount };
  }

  // Title and villages are the only Study-level fields a user can edit
  // directly — status only ever advances through the Need/Evidence/AI
  // Classification/Human Review workflow, never a direct PATCH.
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

  // RIO-FR-001 (per business rules): a study can be deleted only up to
  // evidence_submitted — once AI Classification or Human Review has acted on
  // it, other people rely on it and it can no longer be deleted.
  async remove(id: string): Promise<void> {
    const removed = await this.tenant.runInOrgContext(async (tx) => {
      const existing = (await tx.study.findUnique({ where: { id } })) as StudyRow | null;
      if (!existing) throw new NotFoundException({ error: { code: 'STUDY_NOT_FOUND', message: 'Study not found' } });
      if (!DELETABLE_STUDY_STATUSES.includes(existing.status)) {
        throw new ConflictException({
          error: {
            code: 'STUDY_NOT_DELETABLE',
            message: 'A classified or reviewed study cannot be deleted.',
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
      status: row.status,
      assignedReviewerId: row.assignedReviewerId,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
