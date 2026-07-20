import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { requireActor, requireOrgId } from '../../tenancy/org-context';
import { AuditService } from '../audit/audit.service';
import type { AuditChange } from '../audit/audit.types';
import { NEED_EDITABLE_STATUSES, type CreateNeedPayload, type Need, type NeedRow, type UpdateNeedPayload } from './needs.types';

const DIFF_FIELDS = ['title', 'statement', 'village', 'referenceId'] as const;

@Injectable()
export class NeedsService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
  ) {}

  // A Study can hold many Needs — each one runs its own independent
  // workflow (see NeedStatus). No "does one already exist" guard anymore.
  async create(studyId: string, payload: CreateNeedPayload): Promise<Need> {
    const orgId = requireOrgId();
    const createdBy = requireActor();
    const created = await this.tenant.runInOrgContext(async (tx) => {
      const study = await tx.study.findUnique({ where: { id: studyId } });
      if (!study) throw new NotFoundException({ error: { code: 'STUDY_NOT_FOUND', message: 'Study not found' } });
      return (await tx.need.create({
        data: {
          studyId,
          orgId,
          title: payload.title,
          statement: payload.statement,
          village: payload.village,
          // RIO-FR-001: this is the manual-create endpoint, so the Need
          // always came in this way — never accepted from the client.
          source: 'manual_entry',
          referenceId: payload.referenceId ?? null,
          createdBy,
        },
      })) as NeedRow;
    });
    await this.audit.record({ action: 'create', entityType: 'need', entityId: created.id, entityLabel: created.title.slice(0, 80) });
    return this.toNeed(created, await this.resolveUserName(created.createdBy));
  }

  async listByStudyId(studyId: string): Promise<Need[]> {
    const rows = (await this.tenant.runInOrgContext((tx) =>
      tx.need.findMany({ where: { studyId }, orderBy: { createdAt: 'asc' } }),
    )) as NeedRow[];
    const names = await this.resolveUserNames(rows.map((r) => r.createdBy));
    return rows.map((row) => this.toNeed(row, names.get(row.createdBy) ?? null));
  }

  async getById(needId: string): Promise<Need> {
    const row = (await this.tenant.runInOrgContext((tx) => tx.need.findUnique({ where: { id: needId } }))) as NeedRow | null;
    if (!row) throw new NotFoundException({ error: { code: 'NEED_NOT_FOUND', message: 'Need not found' } });
    return this.toNeed(row, await this.resolveUserName(row.createdBy));
  }

  async update(needId: string, patch: UpdateNeedPayload): Promise<Need> {
    const { updated, changes } = await this.tenant.runInOrgContext(async (tx) => {
      const current = (await tx.need.findUnique({ where: { id: needId } })) as NeedRow | null;
      if (!current) throw new NotFoundException({ error: { code: 'NEED_NOT_FOUND', message: 'Need not found' } });
      if (!NEED_EDITABLE_STATUSES.includes(current.status)) {
        throw new ConflictException({ error: { code: 'NEED_NOT_EDITABLE', message: 'This need has already moved past draft and can no longer be edited' } });
      }
      const changes = this.diff(current, patch);
      const updated = (await tx.need.update({
        where: { id: needId },
        data: {
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.statement !== undefined ? { statement: patch.statement } : {}),
          ...(patch.village !== undefined ? { village: patch.village } : {}),
          ...(patch.referenceId !== undefined ? { referenceId: patch.referenceId } : {}),
        },
      })) as NeedRow;
      return { updated, changes };
    });
    if (changes.length > 0) {
      await this.audit.record({ action: 'edit', entityType: 'need', entityId: updated.id, entityLabel: updated.title.slice(0, 80), changes });
    }
    return this.toNeed(updated, await this.resolveUserName(updated.createdBy));
  }

  // Same editability rule as update() — a Need can only be removed while
  // still `draft`. Every later stage has downstream artifacts (evidence, an
  // AI classification, a survey...) that other people may already rely on;
  // Prisma's onDelete: Cascade would silently take all of that with it, so
  // this is deliberately not offered once a Need has moved past draft.
  async remove(needId: string): Promise<void> {
    const removed = await this.tenant.runInOrgContext(async (tx) => {
      const existing = (await tx.need.findUnique({ where: { id: needId } })) as NeedRow | null;
      if (!existing) throw new NotFoundException({ error: { code: 'NEED_NOT_FOUND', message: 'Need not found' } });
      if (!NEED_EDITABLE_STATUSES.includes(existing.status)) {
        throw new ConflictException({ error: { code: 'NEED_NOT_DELETABLE', message: 'This need has already moved past draft and can no longer be deleted' } });
      }
      await tx.need.delete({ where: { id: needId } });
      return existing;
    });
    await this.audit.record({ action: 'delete', entityType: 'need', entityId: removed.id, entityLabel: removed.title.slice(0, 80) });
  }

  private diff(current: NeedRow, patch: UpdateNeedPayload): AuditChange[] {
    const before = current as unknown as Record<string, unknown>;
    const after = patch as unknown as Record<string, unknown>;
    const changes: AuditChange[] = [];
    for (const f of DIFF_FIELDS) {
      // JSON.stringify comparison (not `!==`) so `village`, an array, is
      // compared by value — reference inequality would report a "change"
      // on every save even when the array's contents are identical.
      if (after[f] !== undefined && JSON.stringify(before[f]) !== JSON.stringify(after[f])) {
        changes.push({ field: f, before: before[f], after: after[f] });
      }
    }
    return changes;
  }

  // Same pattern as EvidenceService's own actor-name resolution — the
  // creator is always in the same org as the Need (RLS-scoped lookup).
  private async resolveUserName(userId: string): Promise<string | null> {
    const names = await this.resolveUserNames([userId]);
    return names.get(userId) ?? null;
  }

  private async resolveUserNames(userIds: string[]): Promise<Map<string, string>> {
    const distinctIds = [...new Set(userIds)];
    if (distinctIds.length === 0) return new Map();
    const users = await this.tenant.runInOrgContext((tx) =>
      tx.user.findMany({ where: { id: { in: distinctIds } }, select: { id: true, name: true } }),
    );
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private toNeed(row: NeedRow, createdByName: string | null): Need {
    return {
      id: row.id,
      studyId: row.studyId,
      title: row.title,
      statement: row.statement,
      village: row.village,
      source: row.source,
      referenceId: row.referenceId,
      status: row.status,
      domain: row.domain,
      subDomain: row.subDomain,
      createdBy: row.createdBy,
      createdByName,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
