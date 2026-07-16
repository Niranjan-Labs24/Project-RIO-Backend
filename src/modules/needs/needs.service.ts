import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { requireActor, requireOrgId } from '../../tenancy/org-context';
import { AuditService } from '../audit/audit.service';
import type { AuditChange } from '../audit/audit.types';
import type { CreateNeedPayload, Need, NeedRow, UpdateNeedPayload } from './needs.types';

const DIFF_FIELDS = ['title', 'statement', 'village'] as const;

// System-set on every Need created through this endpoint — never
// client-writable. A future creation path (e.g. AI-classification-derived)
// would pass a different literal here, not accept one from the request body.
const MANUAL_ENTRY_SOURCE = 'manual_entry';

@Injectable()
export class NeedsService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
  ) {}

  // RIO-FR-001: a Study contains exactly one Need. The DB's unique(study_id)
  // is the real guarantee; this pre-check exists only to return a clean 409
  // instead of a raw constraint-violation 500.
  async create(studyId: string, payload: CreateNeedPayload): Promise<Need> {
    const orgId = requireOrgId();
    const createdBy = requireActor();
    const created = await this.tenant.runInOrgContext(async (tx) => {
      const study = await tx.study.findUnique({ where: { id: studyId } });
      if (!study) throw new NotFoundException({ error: { code: 'STUDY_NOT_FOUND', message: 'Study not found' } });
      const existing = await tx.need.findUnique({ where: { studyId } });
      if (existing) {
        throw new ConflictException({ error: { code: 'NEED_ALREADY_EXISTS', message: 'This study already has a need' } });
      }
      const need = (await tx.need.create({
        data: {
          studyId,
          orgId,
          title: payload.title,
          statement: payload.statement,
          village: payload.village,
          source: MANUAL_ENTRY_SOURCE,
          createdBy,
        },
      })) as NeedRow;
      await tx.study.update({ where: { id: studyId }, data: { status: 'need_captured' } });
      return need;
    });
    await this.audit.record({ action: 'create', entityType: 'need', entityId: created.id, entityLabel: created.title.slice(0, 80) });
    return this.toNeed(created);
  }

  async getByStudyId(studyId: string): Promise<Need> {
    const row = (await this.tenant.runInOrgContext((tx) => tx.need.findUnique({ where: { studyId } }))) as NeedRow | null;
    if (!row) throw new NotFoundException({ error: { code: 'NEED_NOT_FOUND', message: 'Need not found' } });
    return this.toNeed(row);
  }

  async update(studyId: string, patch: UpdateNeedPayload): Promise<Need> {
    const { updated, changes } = await this.tenant.runInOrgContext(async (tx) => {
      const current = (await tx.need.findUnique({ where: { studyId } })) as NeedRow | null;
      if (!current) throw new NotFoundException({ error: { code: 'NEED_NOT_FOUND', message: 'Need not found' } });
      const changes = this.diff(current, patch);
      const updated = (await tx.need.update({
        where: { studyId },
        data: {
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.statement !== undefined ? { statement: patch.statement } : {}),
          ...(patch.village !== undefined ? { village: patch.village } : {}),
        },
      })) as NeedRow;
      return { updated, changes };
    });
    if (changes.length > 0) {
      await this.audit.record({ action: 'edit', entityType: 'need', entityId: updated.id, entityLabel: updated.title.slice(0, 80), changes });
    }
    return this.toNeed(updated);
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

  private toNeed(row: NeedRow): Need {
    return {
      id: row.id,
      studyId: row.studyId,
      title: row.title,
      statement: row.statement,
      village: row.village,
      source: row.source,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
