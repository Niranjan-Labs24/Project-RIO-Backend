import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { requireActor, requireOrgId } from '../../tenancy/org-context';
import { AuditService } from '../audit/audit.service';
import type {
  CreateInitiativePayload,
  Initiative,
  InitiativeRow,
  NeedAnalyticalStatusEvent,
  UpdateInitiativePayload,
} from './initiatives.types';

// RIO-FR-009. Visibility (client Q15) is enforced entirely by the
// `initiatives_read` RLS policy — own org's rows, or any org's row with
// `open_to_other_entities = true` — so `list`/`get` need no extra WHERE
// clause here; a plain `runInOrgContext` read already comes back
// pre-filtered to exactly what the caller is allowed to see.
@Injectable()
export class InitiativesService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<Initiative[]> {
    const rows = await this.tenant.runInOrgContext((tx) =>
      tx.initiative.findMany({ orderBy: { createdAt: 'desc' } }),
    );
    return this.enrich(rows as unknown as InitiativeRow[]);
  }

  async get(id: string): Promise<Initiative> {
    const row = await this.tenant.runInOrgContext((tx) => tx.initiative.findUnique({ where: { id } }));
    if (!row) {
      throw new NotFoundException({ error: { code: 'INITIATIVE_NOT_FOUND', message: 'Initiative not found' } });
    }
    const enriched = await this.enrich([row as unknown as InitiativeRow]);
    return enriched[0]!;
  }

  async create(payload: CreateInitiativePayload): Promise<Initiative> {
    const orgId = requireOrgId();
    const createdBy = requireActor();

    if (payload.expectedEndDate && payload.startDate && payload.expectedEndDate < payload.startDate) {
      throw new BadRequestException({
        error: { code: 'INVALID_DATE_RANGE', message: 'Expected end date cannot be before the start date.' },
      });
    }

    const row = await this.tenant.runInOrgContext((tx) =>
      tx.initiative.create({
        data: {
          orgId,
          name: payload.name,
          domain: payload.domain ?? null,
          geography: payload.geography ?? null,
          startDate: payload.startDate ? new Date(payload.startDate) : null,
          expectedEndDate: payload.expectedEndDate ? new Date(payload.expectedEndDate) : null,
          status: payload.status ?? 'active',
          fundingSource: payload.fundingSource ?? null,
          description: payload.description ?? null,
          budget: payload.budget ?? null,
          openToOtherEntities: payload.openToOtherEntities ?? false,
          createdBy,
        },
      }),
    );

    await this.audit.record({
      action: 'create',
      entityType: 'initiative',
      entityId: row.id,
      entityLabel: row.name,
      changes: [{ field: 'Name', before: null, after: row.name }],
    });

    return this.get(row.id);
  }

  async update(id: string, payload: UpdateInitiativePayload): Promise<Initiative> {
    // The initiatives_update RLS policy's WITH CHECK already refuses to
    // write a row outside the caller's own org — but a blocked UPDATE just
    // affects zero rows rather than throwing, so this existence check
    // (inside the same org context) is what turns that into a real
    // NOT_FOUND rather than a silently-no-op "success".
    const existing = await this.tenant.runInOrgContext((tx) => tx.initiative.findUnique({ where: { id } }));
    if (!existing || existing.orgId !== requireOrgId()) {
      throw new ForbiddenException({
        error: { code: 'FORBIDDEN', message: 'Only the owning organisation can edit this initiative.' },
      });
    }

    const row = await this.tenant.runInOrgContext((tx) =>
      tx.initiative.update({
        where: { id },
        data: {
          ...(payload.name !== undefined ? { name: payload.name } : {}),
          ...(payload.domain !== undefined ? { domain: payload.domain } : {}),
          ...(payload.geography !== undefined ? { geography: payload.geography } : {}),
          ...(payload.startDate !== undefined ? { startDate: new Date(payload.startDate) } : {}),
          ...(payload.expectedEndDate !== undefined ? { expectedEndDate: new Date(payload.expectedEndDate) } : {}),
          ...(payload.status !== undefined ? { status: payload.status } : {}),
          ...(payload.fundingSource !== undefined ? { fundingSource: payload.fundingSource } : {}),
          ...(payload.description !== undefined ? { description: payload.description } : {}),
          ...(payload.budget !== undefined ? { budget: payload.budget } : {}),
          ...(payload.openToOtherEntities !== undefined ? { openToOtherEntities: payload.openToOtherEntities } : {}),
        },
      }),
    );

    await this.audit.record({
      action: 'edit',
      entityType: 'initiative',
      entityId: row.id,
      entityLabel: row.name,
      changes: [],
    });

    return this.get(id);
  }

  // RIO-FR-009 (client Q18) — many-to-many; linking sets the Need's
  // analytical status to `linked_to_initiative` (client Q17c: this is a
  // manual change, so it's logged with an actor, unlike the automatic
  // open_gap/documented_in_study transitions).
  async linkNeed(needId: string, initiativeId: string): Promise<void> {
    const orgId = requireOrgId();
    const linkedBy = requireActor();

    await this.tenant.runInOrgContext(async (tx) => {
      const need = await tx.need.findUnique({ where: { id: needId } });
      if (!need) throw new NotFoundException({ error: { code: 'NEED_NOT_FOUND', message: 'Need not found' } });
      const initiative = await tx.initiative.findUnique({ where: { id: initiativeId } });
      if (!initiative) {
        throw new NotFoundException({ error: { code: 'INITIATIVE_NOT_FOUND', message: 'Initiative not found' } });
      }

      await tx.needInitiative.upsert({
        where: { needId_initiativeId: { needId, initiativeId } },
        create: { needId, initiativeId, orgId, linkedBy },
        update: {},
      });

      if (need.analyticalStatus !== 'linked_to_initiative') {
        await tx.need.update({ where: { id: needId }, data: { analyticalStatus: 'linked_to_initiative' } });
        await tx.needAnalyticalStatusEvent.create({
          data: { needId, orgId, fromStatus: need.analyticalStatus, toStatus: 'linked_to_initiative', changedBy: linkedBy },
        });
      }
    });
  }

  // Unlinking recomputes: if this Need now has zero remaining links, it
  // reverts to `open_gap` (client Q17a: automatic) — unless it's already
  // `documented_in_study`, which is treated as a separate, sticky milestone
  // this action shouldn't undo. (The documented_in_study auto-set itself,
  // from a Need appearing in a published report, is not yet wired into
  // ReportsService — tracked as a known follow-up, not implemented here.)
  async unlinkNeed(needId: string, initiativeId: string): Promise<void> {
    const orgId = requireOrgId();
    const changedBy = requireActor();

    await this.tenant.runInOrgContext(async (tx) => {
      const need = await tx.need.findUnique({ where: { id: needId } });
      if (!need) throw new NotFoundException({ error: { code: 'NEED_NOT_FOUND', message: 'Need not found' } });

      await tx.needInitiative.deleteMany({ where: { needId, initiativeId } });

      const remaining = await tx.needInitiative.count({ where: { needId } });
      if (remaining === 0 && need.analyticalStatus === 'linked_to_initiative') {
        await tx.need.update({ where: { id: needId }, data: { analyticalStatus: 'open_gap' } });
        await tx.needAnalyticalStatusEvent.create({
          data: { needId, orgId, fromStatus: 'linked_to_initiative', toStatus: 'open_gap', changedBy },
        });
      }
    });
  }

  // Powers the Need detail page's "linked initiatives" list — join-row scan
  // scoped by the caller's own RLS context, same as list()/get() above.
  async listLinkedInitiatives(needId: string): Promise<Initiative[]> {
    const links = await this.tenant.runInOrgContext((tx) =>
      tx.needInitiative.findMany({ where: { needId }, select: { initiativeId: true } }),
    );
    if (links.length === 0) return [];

    const rows = await this.tenant.runInOrgContext((tx) =>
      tx.initiative.findMany({ where: { id: { in: links.map((l) => l.initiativeId) } } }),
    );
    return this.enrich(rows as unknown as InitiativeRow[]);
  }

  async listAnalyticalStatusHistory(needId: string): Promise<NeedAnalyticalStatusEvent[]> {
    const rows = await this.tenant.runInOrgContext((tx) =>
      tx.needAnalyticalStatusEvent.findMany({ where: { needId }, orderBy: { changedAt: 'asc' } }),
    );
    return rows.map((r) => ({
      id: r.id,
      fromStatus: r.fromStatus as NeedAnalyticalStatusEvent['fromStatus'],
      toStatus: r.toStatus as NeedAnalyticalStatusEvent['toStatus'],
      changedBy: r.changedBy,
      changedAt: r.changedAt.toISOString(),
      note: r.note,
    }));
  }

  private async enrich(rows: InitiativeRow[]): Promise<Initiative[]> {
    const orgIds = Array.from(new Set(rows.map((r) => r.orgId)));
    const initiativeIds = rows.map((r) => r.id);
    const [orgs, linkCounts] = await Promise.all([
      orgIds.length === 0
        ? Promise.resolve([])
        : this.tenant.runAsSupervisor((tx) => tx.organisation.findMany({ where: { id: { in: orgIds } } })),
      initiativeIds.length === 0
        ? Promise.resolve([])
        : this.tenant.runAsSupervisor((tx) =>
            tx.needInitiative.groupBy({ by: ['initiativeId'], where: { initiativeId: { in: initiativeIds } }, _count: true }),
          ),
    ]);
    const orgById = new Map(orgs.map((o) => [o.id, o]));
    const countByInitiativeId = new Map(linkCounts.map((c) => [c.initiativeId, c._count]));

    return rows.map((row) => ({
      id: row.id,
      orgId: row.orgId,
      orgName: orgById.get(row.orgId)?.name ?? row.orgId,
      name: row.name,
      domain: row.domain,
      geography: row.geography,
      startDate: row.startDate ? row.startDate.toISOString().slice(0, 10) : null,
      expectedEndDate: row.expectedEndDate ? row.expectedEndDate.toISOString().slice(0, 10) : null,
      status: row.status,
      fundingSource: row.fundingSource,
      description: row.description,
      budget: row.budget === null || row.budget === undefined ? null : String(row.budget),
      openToOtherEntities: row.openToOtherEntities,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      linkedNeedCount: countByInitiativeId.get(row.id) ?? 0,
    }));
  }
}
