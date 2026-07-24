import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { requireActor, requireOrgId } from '../../tenancy/org-context';
import { AuditService } from '../audit/audit.service';
import type { AuditChange } from '../audit/audit.types';
import { GeographyService } from '../geography/geography.service';
import { AiDecisionsService } from '../ai-decisions/ai-decisions.service';
import { NEED_EDITABLE_STATUSES, type CreateNeedPayload, type Need, type NeedRow, type UpdateNeedPayload } from './needs.types';

const DIFF_FIELDS = ['title', 'statement', 'village', 'referenceId'] as const;

// The audit dialog renders `change.field` verbatim, so these are display
// labels, not column names.
const DIFF_FIELD_LABELS: Record<(typeof DIFF_FIELDS)[number], string> = {
  title: 'Title',
  statement: 'Statement',
  village: 'Village',
  referenceId: 'Reference ID',
};

// Raw shape Prisma returns once `needGovernorates`/`needCenters` are
// included — reduced to plain id arrays before anything else in this file
// touches it, same pattern as OrganizationsService's RawOrgWithGeo/toOrgRow.
type RawNeedWithGeo = Omit<NeedRow, 'governorateIds' | 'centerIds' | 'needDomains'> & {
  needGovernorates: { governorateId: string }[];
  needCenters: { centerId: string }[];
  needDomains: { domain: string; subDomain: string }[];
};
const GEO_INCLUDE = { needGovernorates: true, needCenters: true, needDomains: true } as const;

@Injectable()
export class NeedsService {
  private readonly logger = new Logger(NeedsService.name);

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly geography: GeographyService,
    private readonly aiDecisions: AiDecisionsService,
  ) {}

  // A Study can hold many Needs — each one runs its own independent
  // workflow (see NeedStatus). No "does one already exist" guard anymore.
  async create(studyId: string, payload: CreateNeedPayload): Promise<Need> {
    const orgId = requireOrgId();
    const createdBy = requireActor();
    // Title is optional on the create form — a Need still needs something
    // to show as its display title everywhere (Needs table, workspace page
    // header, audit log), so fall back to a snippet of the Statement rather
    // than allowing an empty string through.
    const title = payload.title?.trim() || payload.statement.trim().slice(0, 80);
    const created = await this.tenant.runInOrgContext(async (tx) => {
      const study = await tx.study.findUnique({ where: { id: studyId } });
      if (!study) throw new NotFoundException({ error: { code: 'STUDY_NOT_FOUND', message: 'Study not found' } });
      const governorateIds = payload.governorateIds ?? [];
      const centerIds = payload.centerIds ?? [];
      await this.assertGeographyInStudyScope(tx, studyId, governorateIds, centerIds);
      const row = (await tx.need.create({
        data: {
          studyId,
          orgId,
          title,
          statement: payload.statement,
          village: payload.village ?? [],
          // RIO-FR-001: this is the manual-create endpoint, so the Need
          // always came in this way — never accepted from the client.
          source: 'manual_entry',
          referenceId: payload.referenceId ?? null,
          createdBy,
          // AI Classification is fully automatic now — it starts here,
          // right after the row exists, rather than as a manual action
          // gated behind evidence submission.
          status: 'pending_ai_classification',
          needGovernorates: {
            createMany: { data: governorateIds.map((governorateId) => ({ orgId, governorateId })) },
          },
          needCenters: {
            createMany: { data: centerIds.map((centerId) => ({ orgId, centerId })) },
          },
        },
      })) as unknown as NeedRow;
      return {
        ...row,
        needGovernorates: governorateIds.map((governorateId) => ({ governorateId })),
        needCenters: centerIds.map((centerId) => ({ centerId })),
        // A freshly-created Need has no NeedDomain rows yet — classification
        // (which populates them) runs only after this create transaction
        // commits, see the fire-and-forget call below.
        needDomains: [],
      };
    });
    await this.audit.record({ action: 'create', entityType: 'need', entityId: created.id, entityLabel: created.title.slice(0, 80) });

    // Fire-and-forget: the client redirects to the Need workspace page
    // immediately and polls GET /needs/:id for the status to move past
    // `pending_ai_classification` (see the frontend's AiClassificationSection)
    // rather than the create response itself waiting for classification to
    // finish. AsyncLocalStorage's org context propagates through this
    // un-awaited promise chain regardless of the HTTP response already
    // having been sent (verified: TenantPrismaService.runInOrgContext calls
    // requireOrgId() again inside classifyAutomatically, which still
    // resolves correctly here). classifyAutomatically itself persists
    // ai_classification_failed before rethrowing on total failure, so this
    // catch only needs to log.
    this.aiDecisions.classifyAutomatically(created.id).catch((err: Error) => {
      this.logger.warn(`Automatic classification failed for need ${created.id}: ${err.message}`);
    });

    return this.toNeed(this.toNeedRow(created), await this.resolveUserName(created.createdBy));
  }

  // Both the Need's Governorates and its Centers must be within the owning
  // Study's own selected geography (governorateIds/centerIds) — not just
  // any Governorate/Center the org itself configured, otherwise a Need
  // could reference geography outside the specific Study it belongs to.
  // Checked in this exact order so the caller always gets the most
  // specific, actionable error first:
  //   1. Every Governorate exists.
  //   2. Every Governorate is one of the Study's own selected Governorates.
  //   3. Every Center belongs to one of the given Governorates.
  //   4. Every Center is also one of the Study's own selected Centers.
  private async assertGeographyInStudyScope(
    tx: Prisma.TransactionClient,
    studyId: string,
    governorateIds: string[],
    centerIds: string[],
  ): Promise<void> {
    if (governorateIds.length === 0 && centerIds.length === 0) return;

    if (governorateIds.length > 0) {
      await this.geography.validateHierarchy({ governorateIds, centerIds: [] });
    }

    const study = (await tx.study.findUnique({
      where: { id: studyId },
      include: { studyGovernorates: true, studyCenters: true },
    })) as { studyGovernorates: { governorateId: string }[]; studyCenters: { centerId: string }[] } | null;
    const studyGovernorateIds = (study?.studyGovernorates ?? []).map((g) => g.governorateId);
    const studyCenterIds = (study?.studyCenters ?? []).map((c) => c.centerId);

    const studyGovernorateIdSet = new Set(studyGovernorateIds);
    const orphanGovernorate = governorateIds.find((id) => !studyGovernorateIdSet.has(id));
    if (orphanGovernorate) {
      throw new BadRequestException({
        error: { code: 'GOVERNORATE_NOT_IN_STUDY_SCOPE', message: "One or more Governorates are not one of the Study's selected Governorates." },
      });
    }

    if (centerIds.length > 0) {
      await this.geography.validateHierarchy({ governorateIds, centerIds });
      const studyCenterIdSet = new Set(studyCenterIds);
      const orphanCenter = centerIds.find((id) => !studyCenterIdSet.has(id));
      if (orphanCenter) {
        throw new BadRequestException({
          error: { code: 'CENTER_NOT_IN_STUDY_SCOPE', message: "One or more Centers are not one of the Study's selected Centers." },
        });
      }
    }
  }

  async listByStudyId(studyId: string): Promise<Need[]> {
    const rows = (await this.tenant.runInOrgContext((tx) =>
      tx.need.findMany({ where: { studyId }, orderBy: { createdAt: 'asc' }, include: GEO_INCLUDE }),
    )) as RawNeedWithGeo[];
    const names = await this.resolveUserNames(rows.map((r) => r.createdBy));
    return rows.map((row) => this.toNeed(this.toNeedRow(row), names.get(row.createdBy) ?? null));
  }

  async getById(needId: string): Promise<Need> {
    const row = (await this.tenant.runInOrgContext((tx) =>
      tx.need.findUnique({ where: { id: needId }, include: GEO_INCLUDE }),
    )) as RawNeedWithGeo | null;
    if (!row) throw new NotFoundException({ error: { code: 'NEED_NOT_FOUND', message: 'Need not found' } });
    return this.toNeed(this.toNeedRow(row), await this.resolveUserName(row.createdBy));
  }

  async update(needId: string, patch: UpdateNeedPayload): Promise<Need> {
    const orgId = requireOrgId();
    const { updated, changes } = await this.tenant.runInOrgContext(async (tx) => {
      const currentRaw = (await tx.need.findUnique({ where: { id: needId }, include: GEO_INCLUDE })) as RawNeedWithGeo | null;
      if (!currentRaw) throw new NotFoundException({ error: { code: 'NEED_NOT_FOUND', message: 'Need not found' } });
      const current = this.toNeedRow(currentRaw);
      if (!NEED_EDITABLE_STATUSES.includes(current.status)) {
        throw new ConflictException({ error: { code: 'NEED_NOT_EDITABLE', message: 'This need can no longer be edited once AI Classification has run; reject it on the AI Review screen to make changes' } });
      }
      const nextGovernorateIds = patch.governorateIds ?? current.governorateIds;
      const nextCenterIds = patch.centerIds ?? current.centerIds;
      if (patch.governorateIds !== undefined || patch.centerIds !== undefined) {
        await this.assertGeographyInStudyScope(tx, current.studyId, nextGovernorateIds, nextCenterIds);
      }
      const changes = this.diff(current, patch, nextGovernorateIds, nextCenterIds);
      await tx.need.update({
        where: { id: needId },
        data: {
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.statement !== undefined ? { statement: patch.statement } : {}),
          ...(patch.village !== undefined ? { village: patch.village } : {}),
          ...(patch.referenceId !== undefined ? { referenceId: patch.referenceId } : {}),
        },
      });
      if (patch.governorateIds !== undefined) {
        await tx.needGovernorate.deleteMany({ where: { needId } });
        if (patch.governorateIds.length > 0) {
          await tx.needGovernorate.createMany({
            data: patch.governorateIds.map((governorateId) => ({ needId, orgId, governorateId })),
          });
        }
      }
      if (patch.centerIds !== undefined) {
        await tx.needCenter.deleteMany({ where: { needId } });
        if (patch.centerIds.length > 0) {
          await tx.needCenter.createMany({
            data: patch.centerIds.map((centerId) => ({ needId, orgId, centerId })),
          });
        }
      }
      const updatedRaw = (await tx.need.findUnique({ where: { id: needId }, include: GEO_INCLUDE })) as RawNeedWithGeo;
      return { updated: this.toNeedRow(updatedRaw), changes };
    });
    if (changes.length > 0) {
      await this.audit.record({ action: 'edit', entityType: 'need', entityId: updated.id, entityLabel: updated.title.slice(0, 80), changes });
    }

    // A Need only reaches this editable path in `pending_ai_classification`
    // after an Approver Reject (see AiDecisionsService.review), or in
    // `ai_classification_failed` after Retry hasn't run again yet — both
    // mean "the last classification attempt (if any) no longer reflects
    // this Need's current data" once something has actually changed.
    // Fire-and-forget, same as NeedsService.create — the caller (edit form)
    // doesn't wait for this to finish either; the workspace page's own
    // polling picks up the eventual status change.
    if (changes.length > 0 && (updated.status === 'pending_ai_classification' || updated.status === 'ai_classification_failed')) {
      this.aiDecisions.classifyAutomatically(updated.id).catch((err: Error) => {
        this.logger.warn(`Automatic re-classification failed for need ${updated.id}: ${err.message}`);
      });
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
        throw new ConflictException({ error: { code: 'NEED_NOT_DELETABLE', message: 'This need can no longer be deleted once AI Classification has run' } });
      }
      await tx.need.delete({ where: { id: needId } });
      return existing;
    });
    await this.audit.record({ action: 'delete', entityType: 'need', entityId: removed.id, entityLabel: removed.title.slice(0, 80) });
  }

  private diff(
    current: NeedRow,
    patch: UpdateNeedPayload,
    nextGovernorateIds: string[],
    nextCenterIds: string[],
  ): AuditChange[] {
    const before = current as unknown as Record<string, unknown>;
    const after = patch as unknown as Record<string, unknown>;
    const changes: AuditChange[] = [];
    for (const f of DIFF_FIELDS) {
      // JSON.stringify comparison (not `!==`) so `village`, an array, is
      // compared by value — reference inequality would report a "change"
      // on every save even when the array's contents are identical.
      if (after[f] !== undefined && JSON.stringify(before[f]) !== JSON.stringify(after[f])) {
        changes.push({ field: DIFF_FIELD_LABELS[f], before: before[f], after: after[f] });
      }
    }
    // governorateIds/centerIds aren't real columns on `needs` (they live in
    // the NeedGovernorate/NeedCenter join tables) so DIFF_FIELDS can't cover
    // them generically — diff the sets directly against whatever the final
    // set will be, same pattern as OrganizationsService's own diffing.
    if (patch.governorateIds !== undefined && !this.sameIdSet(current.governorateIds, nextGovernorateIds)) {
      changes.push({ field: 'Governorates', before: current.governorateIds, after: nextGovernorateIds });
    }
    if (patch.centerIds !== undefined && !this.sameIdSet(current.centerIds, nextCenterIds)) {
      changes.push({ field: 'Centers', before: current.centerIds, after: nextCenterIds });
    }
    return changes;
  }

  private sameIdSet(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sorted = (xs: string[]) => [...xs].sort();
    return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
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

  // Reduces the raw `needGovernorates`/`needCenters` join arrays Prisma
  // returns (once included) down to plain id arrays — every other method
  // in this file works with that flattened NeedRow shape, never the raw
  // join rows directly.
  private toNeedRow(raw: RawNeedWithGeo): NeedRow {
    return {
      ...raw,
      governorateIds: raw.needGovernorates.map((g) => g.governorateId),
      centerIds: raw.needCenters.map((c) => c.centerId),
      needDomains: raw.needDomains.map((d) => ({ domain: d.domain, subDomain: d.subDomain })),
    };
  }

  private toNeed(row: NeedRow, createdByName: string | null): Need {
    return {
      id: row.id,
      studyId: row.studyId,
      title: row.title,
      statement: row.statement,
      village: row.village,
      governorateIds: row.governorateIds,
      centerIds: row.centerIds,
      source: row.source,
      referenceId: row.referenceId,
      status: row.status,
      domain: row.domain,
      subDomain: row.subDomain,
      allDomainsSelected: row.allDomainsSelected,
      needDomains: row.needDomains,
      aiSuggestedDomain: row.aiSuggestedDomain,
      aiSuggestedSubDomain: row.aiSuggestedSubDomain,
      classifiedAt: row.classifiedAt ? row.classifiedAt.toISOString() : null,
      classificationError: row.classificationError,
      createdBy: row.createdBy,
      createdByName,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
