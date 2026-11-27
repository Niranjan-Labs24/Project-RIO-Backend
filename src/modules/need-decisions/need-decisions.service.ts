import { parseDateParam } from "../../common/validation/bounded";
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { requireActor, requireOrgId } from '../../tenancy/org-context';
import { AuditService } from '../audit/audit.service';
import { StudyConfigService } from '../study-config/study-config.service';
import {
  DECISION_STATUSES,
  type CreateNeedDecisionPayload,
  type DecisionStatus,
  type NeedDecision,
  type NeedDecisionRow,
  type NeedDecisionStatusEvent,
  type NeedDecisionStatusEventRow,
  type UpdateNeedDecisionPayload,
  type UpdateNeedDecisionStatusPayload,
} from './need-decisions.types';

// Terminal states a decision cannot leave. Not fully linear (Q11's
// confirmed lifecycle is "Open -> In Progress -> Completed / Cancelled",
// i.e. either terminal state is reachable from either open state) — this
// only blocks moving *out of* a terminal state, not a specific ordering
// into one.
const TERMINAL_STATUSES: DecisionStatus[] = ['completed', 'cancelled'];

@Injectable()
export class NeedDecisionsService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly studyConfig: StudyConfigService,
  ) {}

  async listForNeed(needId: string): Promise<NeedDecision[]> {
    const rows = await this.tenant.runRead((tx) =>
      tx.needDecision.findMany({
        where: { needId },
        orderBy: { createdAt: 'desc' },
        include: { statusEvents: { orderBy: { changedAt: 'asc' } } },
      }),
    );
    return rows.map((r) => this.toDecision(r as NeedDecisionRow & { statusEvents: NeedDecisionStatusEventRow[] }));
  }

  // RIO-FR-005 (Q34) — a decision cannot be logged against a Need with no
  // *approved* priority score yet. A computed-but-unapproved score counts
  // as "no score" for this rule (client-confirmed) — matches
  // PriorityService's own "approvedOnly" convention (surveyLinkId: null =
  // the consolidated, cross-link score this rule cares about).
  async create(needId: string, payload: CreateNeedDecisionPayload): Promise<NeedDecision> {
    const orgId = requireOrgId();
    const createdBy = requireActor();

    const activeTypes = await this.studyConfig.listActiveDecisionTypeNames();
    if (activeTypes.length > 0 && !activeTypes.includes(payload.decisionType)) {
      throw new BadRequestException({
        error: { code: 'INVALID_DECISION_TYPE', message: `"${payload.decisionType}" is not a configured Decision Type.` },
      });
    }

    const created = await this.tenant.runInOrgContext(async (tx) => {
      const need = await tx.need.findUnique({ where: { id: needId }, select: { id: true, title: true } });
      if (!need) {
        throw new NotFoundException({ error: { code: 'NEED_NOT_FOUND', message: 'Need not found' } });
      }
      const approvedScore = await tx.priorityScore.findFirst({
        where: { needId, surveyLinkId: null, approvedAt: { not: null } },
      });
      if (!approvedScore) {
        throw new BadRequestException({
          error: {
            code: 'NO_APPROVED_PRIORITY_SCORE',
            message: 'This need has no Human-Reviewer-approved priority score yet — a decision cannot be logged until one is approved.',
          },
        });
      }

      const row = await tx.needDecision.create({
        data: {
          needId,
          orgId,
          decisionType: payload.decisionType,
          responsibleParty: payload.responsibleParty,
          decisionDate: parseDateParam(payload.decisionDate, "decisionDate"),
          notes: payload.notes,
          createdBy,
          status: 'open',
        },
      });
      await tx.needDecisionStatusEvent.create({
        data: { decisionId: row.id, orgId, fromStatus: null, toStatus: 'open', changedBy: createdBy },
      });
      return { row, needTitle: need.title };
    });

    await this.audit.record({
      action: 'create',
      entityType: 'need_decision',
      entityId: created.row.id,
      entityLabel: `${payload.decisionType} — ${created.needTitle}`,
      changes: [
        { field: 'Decision Type', before: null, after: payload.decisionType },
        { field: 'Responsible Party', before: null, after: payload.responsibleParty },
        { field: 'Status', before: null, after: 'open' },
      ],
    });

    return this.get(created.row.id);
  }

  // UAT PRI-06: correct a decision after it was logged — type, responsible
  // party, date and notes. Status is changed only through updateStatus (it
  // has its own history). A completed or cancelled decision is closed and
  // can no longer be edited. Every changed field is recorded in the audit
  // log with its value before and after.
  async update(needId: string, id: string, payload: UpdateNeedDecisionPayload): Promise<NeedDecision> {
    if (payload.decisionType !== undefined) {
      const activeTypes = await this.studyConfig.listActiveDecisionTypeNames();
      if (activeTypes.length > 0 && !activeTypes.includes(payload.decisionType)) {
        throw new BadRequestException({
          error: { code: 'INVALID_DECISION_TYPE', message: `"${payload.decisionType}" is not a configured Decision Type.` },
        });
      }
    }

    const result = await this.tenant.runInOrgContext(async (tx) => {
      const current = await tx.needDecision.findUnique({ where: { id } });
      if (!current || current.needId !== needId) {
        throw new NotFoundException({ error: { code: 'DECISION_NOT_FOUND', message: 'Decision not found' } });
      }
      if (TERMINAL_STATUSES.includes(current.status as DecisionStatus)) {
        throw new ForbiddenException({
          error: {
            code: 'DECISION_ALREADY_TERMINAL',
            message: `This decision is already ${current.status} and can no longer be edited.`,
          },
        });
      }
      const before = {
        decisionType: current.decisionType,
        responsibleParty: current.responsibleParty,
        decisionDate: current.decisionDate.toISOString().slice(0, 10),
        notes: current.notes,
      };
      const after = {
        decisionType: payload.decisionType ?? before.decisionType,
        responsibleParty: payload.responsibleParty?.trim() || before.responsibleParty,
        decisionDate: payload.decisionDate ?? before.decisionDate,
        notes:
          payload.notes === undefined ? before.notes : payload.notes === null ? null : payload.notes.trim() || null,
      };
      const labels: Record<keyof typeof before, string> = {
        decisionType: 'Decision Type',
        responsibleParty: 'Responsible Party',
        decisionDate: 'Decision Date',
        notes: 'Notes',
      };
      const changes = (Object.keys(before) as Array<keyof typeof before>)
        .filter((k) => before[k] !== after[k])
        .map((k) => ({ field: labels[k], before: before[k], after: after[k] }));
      if (changes.length > 0) {
        await tx.needDecision.update({
          where: { id },
          data: {
            decisionType: after.decisionType,
            responsibleParty: after.responsibleParty,
            decisionDate: parseDateParam(after.decisionDate, 'decisionDate'),
            notes: after.notes,
          },
        });
      }
      return { changes, label: after.decisionType };
    });

    if (result.changes.length > 0) {
      await this.audit.record({
        action: 'edit',
        entityType: 'need_decision',
        entityId: id,
        entityLabel: `Decision edited — ${result.label}`,
        changes: result.changes,
      });
    }
    return this.get(id);
  }

  async updateStatus(id: string, payload: UpdateNeedDecisionStatusPayload): Promise<NeedDecision> {
    const orgId = requireOrgId();
    const changedBy = requireActor();

    const updated = await this.tenant.runInOrgContext(async (tx) => {
      const current = await tx.needDecision.findUnique({ where: { id } });
      if (!current) {
        throw new NotFoundException({ error: { code: 'DECISION_NOT_FOUND', message: 'Decision not found' } });
      }
      if (TERMINAL_STATUSES.includes(current.status as DecisionStatus)) {
        throw new ForbiddenException({
          error: {
            code: 'DECISION_ALREADY_TERMINAL',
            message: `This decision is already ${current.status} and cannot be moved to a different status.`,
          },
        });
      }
      if (current.status === payload.status) {
        return current;
      }
      await tx.needDecision.update({ where: { id }, data: { status: payload.status } });
      await tx.needDecisionStatusEvent.create({
        data: {
          decisionId: id,
          orgId,
          fromStatus: current.status,
          toStatus: payload.status,
          changedBy,
          note: payload.note,
        },
      });
      return current;
    });

    await this.audit.record({
      action: 'edit',
      entityType: 'need_decision',
      entityId: id,
      entityLabel: `Decision status change`,
      changes: [{ field: 'Status', before: updated.status, after: payload.status }],
    });

    return this.get(id);
  }

  private async get(id: string): Promise<NeedDecision> {
    const row = await this.tenant.runRead((tx) =>
      tx.needDecision.findUniqueOrThrow({
        where: { id },
        include: { statusEvents: { orderBy: { changedAt: 'asc' } } },
      }),
    );
    return this.toDecision(row);
  }

  private toDecision(row: NeedDecisionRow & { statusEvents: NeedDecisionStatusEventRow[] }): NeedDecision {
    return {
      id: row.id,
      needId: row.needId,
      decisionType: row.decisionType,
      responsibleParty: row.responsibleParty,
      status: row.status as DecisionStatus,
      decisionDate: row.decisionDate.toISOString().slice(0, 10),
      notes: row.notes,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      history: row.statusEvents.map((e) => this.toStatusEvent(e)),
    };
  }

  private toStatusEvent(row: NeedDecisionStatusEventRow): NeedDecisionStatusEvent {
    return {
      id: row.id,
      fromStatus: row.fromStatus as DecisionStatus | null,
      toStatus: row.toStatus as DecisionStatus,
      changedBy: row.changedBy,
      changedAt: row.changedAt.toISOString(),
      note: row.note,
    };
  }
}

// Re-exported so callers/tests importing from the service file don't need
// a second import from the types module just for this constant.
export { DECISION_STATUSES };
