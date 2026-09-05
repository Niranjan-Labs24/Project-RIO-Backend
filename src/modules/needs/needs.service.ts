import { EXCLUDE_MERGED } from './need-visibility';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { getOrgStore, requireActor, requireOrgId } from '../../tenancy/org-context';
import { AuditService } from '../audit/audit.service';
import type { AuditChange } from '../audit/audit.types';
import { GeographyService } from '../geography/geography.service';
import { AiDecisionsService } from '../ai-decisions/ai-decisions.service';
import { StudyConfigService } from '../study-config/study-config.service';
import { resolveConfidenceBand, type ConfidenceBand } from '../ai-decisions/confidence-band';
import { MethodologyConfigService } from '../methodology-config/methodology-config.service';
import { DataCleaningService } from '../data-cleaning/data-cleaning.service';
import { NeedThemesService } from './need-themes.service';
import { NeedSummaryService } from './need-summary.service';
import { NEED_EDITABLE_STATUSES, type CreateNeedPayload, type Need, type NeedRow, type UpdateNeedPayload } from './needs.types';


const DIFF_FIELDS = ['title', 'statement', 'village', 'referenceId', 'affectedPeople', 'affectedHouseholds','affectedPopulation'] as const;

// RIO-DATA-003: system-generated internal reference, derived from the
// `internalRefSeq` autoincrement column so there's a single source of
// truth for the number — never stored as a formatted string.
export function formatInternalReferenceId(seq: number): string {
  return `NEED-${String(seq).padStart(6, '0')}`;
}

// The audit dialog renders `change.field` verbatim, so these are display
// labels, not column names.
const DIFF_FIELD_LABELS: Record<(typeof DIFF_FIELDS)[number], string> = {
  title: 'Title',
  statement: 'Statement',
  village: 'Village',
  referenceId: 'Reference ID',
  affectedPopulation: 'Affected Population',
  affectedPeople: 'Affected People',
  affectedHouseholds: 'Affected Households',
};

// Raw shape Prisma returns once `needGovernorates`/`needCenters` are
// included — reduced to plain id arrays before anything else in this file
// touches it, same pattern as OrganizationsService's RawOrgWithGeo/toOrgRow.
type RawNeedWithGeo = Omit<NeedRow, 'governorateIds' | 'centerIds' | 'needDomains'> & {
  needGovernorates: { governorateId: string }[];
  needCenters: { centerId: string }[];
  needDomains: { domain: string; subDomain: string }[];
  study?: {
    studyGovernorates: { governorateId: string }[];
    studyCenters: { centerId: string }[];
  } | null;
};
const GEO_INCLUDE = {
  needGovernorates: true,
  needCenters: true,
  needDomains: true,
  study: { include: { studyGovernorates: true, studyCenters: true } },
} as const;

@Injectable()
export class NeedsService {
  private readonly logger = new Logger(NeedsService.name);

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly geography: GeographyService,
    private readonly aiDecisions: AiDecisionsService,
    private readonly studyConfig: StudyConfigService,
    private readonly methodologyConfig: MethodologyConfigService,
    private readonly needThemes: NeedThemesService,
    private readonly needSummaries: NeedSummaryService,
    private readonly dataCleaning: DataCleaningService,
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
      const study = await tx.study.findUnique({
        where: { id: studyId },
        include: { studyGovernorates: true, studyCenters: true },
      });
      if (!study) throw new NotFoundException({ error: { code: 'STUDY_NOT_FOUND', message: 'Study not found' } });
      const studyGovernorateIds = (study.studyGovernorates ?? []).map((g) => g.governorateId);
      const studyCenterIds = (study.studyCenters ?? []).map((c) => c.centerId);
      const governorateIds = (payload.governorateIds && payload.governorateIds.length > 0) ? payload.governorateIds : studyGovernorateIds;
      const centerIds = (payload.centerIds && payload.centerIds.length > 0) ? payload.centerIds : studyCenterIds;
      await this.assertGeographyInStudyScope(tx, studyId, governorateIds, centerIds);
      const row = (await tx.need.create({
        data: {
          studyId,
          orgId,
          title,
          statement: payload.statement,
          village: payload.village ?? [],
          source: 'manual_entry',
          referenceId: payload.referenceId ?? null,
          affectedPopulation: payload.affectedPopulation ?? null,
          affectedPeople: payload.affectedPeople ?? null,
          affectedHouseholds: payload.affectedHouseholds ?? null,
          createdBy,
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
        needDomains: [],
      };
    });
    await this.audit.record({
      action: 'create',
      entityType: 'need',
      entityId: created.id,
      entityLabel: created.title.slice(0, 80),
      sourceRef: created.referenceId,
      // before: null on every field — a create has no prior state. Recorded
      // explicitly so the audit detail view shows what the Need was created
      // with, rather than an empty change panel.
      changes: [
        { field: 'Title', before: null, after: created.title },
        { field: 'Statement', before: null, after: created.statement },
        { field: 'Village', before: null, after: created.village },
        { field: 'Affected Population', before: null, after: created.affectedPopulation },
        { field: 'Source', before: null, after: created.source },
        { field: 'Status', before: null, after: created.status },
      ],
    });

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

    // RIO-AI-003's auto-suggest, for the manual-entry path. Fire-and-forget for
    // the same reason as classification above, and additionally because
    // summarisation is assistive: the Need is already persisted and must not be
    // rolled back if the model is unavailable. maybeGenerateForNeed swallows
    // its own failures, so this catch only covers the promise itself.
    this.needSummaries.maybeGenerateForNeed(created.id, 'manual_entry').catch((err: Error) => {
      this.logger.warn(`Need summary generation failed for need ${created.id}: ${err.message}`);
    });

    // RIO-FR-003 AC 6. Fire-and-forget for the same reason as the two above,
    // and additionally because the recurrence factor reads themes at SCORING
    // time — a need created before extraction finishes simply scores without
    // them, and picks them up on its next scoring run.
    this.needThemes.maybeExtractForNeed(created.id).catch((err: Error) => {
      this.logger.warn(`Theme extraction failed for need ${created.id}: ${err.message}`);
    });

    // RIO-FR-002. Fire-and-forget for the same reasons as the three above, and
    // one more that is specific to cleaning: it must never be able to fail a
    // save. The Need is persisted and audited by this point, and a missing
    // flag is a far smaller harm than losing a researcher's entry because the
    // geographic reference was briefly unreachable. DataCleaningService
    // resolves rather than throwing, so this catch only covers the promise.
    //
    // orgId is passed explicitly rather than read from ambient context: this
    // runs after the HTTP response, and an explicit org is what makes that
    // safe to reason about.
    this.dataCleaning.cleanNeed(created.id, orgId, 'manual_entry').catch((err: Error) => {
      this.logger.warn(`Data cleaning failed for need ${created.id}: ${err.message}`);
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
    // RIO-RBAC-002 (client-confirmed 2026-08-29) — same isCrossOrgReader
    // split as getById below, extended to system_reviewer (also
    // crossEntity:true, also platform-wide with no tenant org of its own).
    // Without this, StudiesService.list()'s cross-org branch could return a
    // study belonging to another org, but this call — always RLS-scoped —
    // then silently found zero needs for it. That's what was actually
    // breaking the needs-count column on /studies, and blocking Public
    // Surveys and Survey Builder entirely for these roles, since both chain
    // through this same per-study needs lookup.
    const store = getOrgStore();
    const isCrossOrgReader =
      store?.role === 'system_admin' ||
      store?.role === 'system_reviewer' ||
      store?.role === 'center_supervisor';
    const rows = (isCrossOrgReader
      ? await this.tenant.runAsSupervisor((tx) =>
          tx.need.findMany({ where: { studyId, ...EXCLUDE_MERGED }, orderBy: { createdAt: 'asc' }, include: GEO_INCLUDE }),
        )
      : await this.tenant.runInOrgContext((tx) =>
          tx.need.findMany({ where: { studyId, ...EXCLUDE_MERGED }, orderBy: { createdAt: 'asc' }, include: GEO_INCLUDE }),
        )) as RawNeedWithGeo[];
    const [names, confidences] = await Promise.all([
      this.resolveUserNames(rows.map((r) => r.createdBy)),
      this.resolveAiConfidence(rows.map((r) => r.id)),
    ]);
    return rows.map((row) =>
      this.toNeed(this.toNeedRow(row), names.get(row.createdBy) ?? null, confidences.get(row.id) ?? null),
    );
  }

  async getById(needId: string): Promise<Need> {
    // RIO-RBAC-002 (client-confirmed, 2026-08-27 round; system_reviewer
    // added 2026-08-29) — System Admin and System Reviewer are both
    // platform-wide with no tenant org of their own, and Center Supervisor
    // is cross-entity read; mirrors StudiesService.getById's identical
    // isCrossOrgReader split. Without this, following a link into a Need
    // outside one's own org (e.g. to create a Public Survey Link there) got
    // a 404 before ever reaching that action's own X-Act-As-Org check.
    const store = getOrgStore();
    const isCrossOrgReader =
      store?.role === 'system_admin' ||
      store?.role === 'system_reviewer' ||
      store?.role === 'center_supervisor';
    const row = (isCrossOrgReader
      ? await this.tenant.runAsSupervisor((tx) => tx.need.findUnique({ where: { id: needId }, include: GEO_INCLUDE }))
      : await this.tenant.runInOrgContext((tx) => tx.need.findUnique({ where: { id: needId }, include: GEO_INCLUDE }))
    ) as RawNeedWithGeo | null;
    if (!row) throw new NotFoundException({ error: { code: 'NEED_NOT_FOUND', message: 'Need not found' } });
    const [createdByName, confidences] = await Promise.all([
      this.resolveUserName(row.createdBy, isCrossOrgReader),
      this.resolveAiConfidence([row.id]),
    ]);
    return this.toNeed(this.toNeedRow(row), createdByName, confidences.get(row.id) ?? null);
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
          ...(patch.affectedPopulation !== undefined ? { affectedPopulation: patch.affectedPopulation } : {}),
          ...(patch.affectedPeople !== undefined ? { affectedPeople: patch.affectedPeople } : {}),
          ...(patch.affectedHouseholds !== undefined ? { affectedHouseholds: patch.affectedHouseholds } : {}),
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
      await this.audit.record({
        action: 'edit',
        entityType: 'need',
        entityId: updated.id,
        entityLabel: updated.title.slice(0, 80),
        changes,
        sourceRef: updated.referenceId,
      });
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

    // RIO-AI-003: a summary of the OLD statement is not a summary of this Need
    // any more. Awaited, unlike the fire-and-forget generation below it,
    // because leaving a superseded summary marked CONFIRMED for even a moment
    // is what would let a stale wording reach a report generated in that
    // window. Only the statement matters here — retitling or moving geography
    // does not invalidate a description summary.
    if (changes.some((c) => c.field === DIFF_FIELD_LABELS.statement)) {
      await this.needSummaries.markStaleForNeed(updated.id);
      // The statement is what themes are derived from, so a rewrite can change
      // what the need is about — and therefore its recurrence count.
      this.needThemes.maybeExtractForNeed(updated.id).catch((err: Error) => {
        this.logger.warn(`Theme re-extraction failed for need ${updated.id}: ${err.message}`);
      });
      this.needSummaries.maybeGenerateForNeed(updated.id, 'manual_entry').catch((err: Error) => {
        this.logger.warn(`Need summary regeneration failed for need ${updated.id}: ${err.message}`);
      });
    }

    // RIO-FR-002. Re-run on ANY change, not only a statement rewrite: the
    // fields cleaning cares about are village, domain and geography, and an
    // edit that fixes a village name has to clear the flag that reported it.
    // DataCleaningService supersedes flags that no longer apply, so this is
    // also how the queue shrinks when someone corrects a record directly
    // instead of accepting the proposal.
    if (changes.length > 0) {
      this.dataCleaning.cleanNeed(updated.id, orgId, 'manual_entry').catch((err: Error) => {
        this.logger.warn(`Data cleaning failed for need ${updated.id}: ${err.message}`);
      });
    }

    return this.toNeed(updated, await this.resolveUserName(updated.createdBy));
  }

  // RIO-FR-005 (Q12) — analyst-entered, so deliberately NOT gated behind
  // NEED_EDITABLE_STATUSES the way title/statement/geography are above:
  // gap classification is a priority-scoring-stage judgment call that can
  // legitimately be entered/revised any time after a Need exists, not just
  // during the pre-classification editing window.
  // Same pattern as StudiesService.assertValidStudyType — an empty active
  // list means nothing validates yet (never true here since GapTypeOption
  // is seeded with 5 defaults, but kept consistent with the shared
  // convention rather than a special case).
  private async assertValidGapType(value: string | null): Promise<void> {
    if (value === null) return;
    const names = await this.studyConfig.listActiveGapTypeNames();
    if (names.length > 0 && !names.includes(value)) {
      throw new BadRequestException({
        error: { code: 'INVALID_GAP_TYPE', message: `"${value}" is not a configured Gap Type.` },
      });
    }
  }

  async setGapType(needId: string, gapType: string | null): Promise<Need> {
    await this.assertValidGapType(gapType);
    const updated = await this.tenant.runInOrgContext(async (tx) => {
      const currentRaw = (await tx.need.findUnique({ where: { id: needId }, include: GEO_INCLUDE })) as RawNeedWithGeo | null;
      if (!currentRaw) throw new NotFoundException({ error: { code: 'NEED_NOT_FOUND', message: 'Need not found' } });
      const before = currentRaw.gapType;
      const updatedRaw = (await tx.need.update({
        where: { id: needId },
        data: { gapType },
        include: GEO_INCLUDE,
      })) as RawNeedWithGeo;
      if (before !== gapType) {
        await this.audit.record({
          action: 'edit',
          entityType: 'need',
          entityId: needId,
          entityLabel: currentRaw.title.slice(0, 80),
          changes: [{ field: 'gapType', before, after: gapType }],
          sourceRef: currentRaw.referenceId,
        });
      }
      return this.toNeedRow(updatedRaw);
    });
    return this.toNeed(updated, await this.resolveUserName(updated.createdBy));
  }

  /**
   * RIO-FR-003 AC 1 — the urgency level a human assigns.
   *
   * Deliberately its own action rather than a field on update(): urgency is a
   * priority judgement, not Need data, so it carries the same
   * priorityScoring:write gate as gap type above rather than
   * dataCollection:write. It is also settable after a Need is locked for
   * editing, because the judgement can change while the facts do not.
   */
  async setUrgency(needId: string, urgency: string | null): Promise<Need> {
    const updated = await this.tenant.runInOrgContext(async (tx) => {
      const currentRaw = (await tx.need.findUnique({ where: { id: needId }, include: GEO_INCLUDE })) as RawNeedWithGeo | null;
      if (!currentRaw) throw new NotFoundException({ error: { code: 'NEED_NOT_FOUND', message: 'Need not found' } });
      const before = currentRaw.urgency;
      const updatedRaw = (await tx.need.update({
        where: { id: needId },
        data: { urgency },
        include: GEO_INCLUDE,
      })) as RawNeedWithGeo;
      if (before !== urgency) {
        await this.audit.record({
          action: 'edit',
          entityType: 'need',
          entityId: needId,
          entityLabel: currentRaw.title.slice(0, 80),
          changes: [{ field: 'urgency', before, after: urgency }],
          sourceRef: currentRaw.referenceId,
        });
      }
      return this.toNeedRow(updatedRaw);
    });
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
    await this.audit.record({
      action: 'delete',
      entityType: 'need',
      entityId: removed.id,
      entityLabel: removed.title.slice(0, 80),
      sourceRef: removed.referenceId,
      // Mirror image of the create above — after: null, and `before` holds
      // the record as it last existed. This is the only surviving copy of a
      // deleted Need's contents, so it is worth capturing in full.
      changes: [
        { field: 'Title', before: removed.title, after: null },
        { field: 'Statement', before: removed.statement, after: null },
        { field: 'Village', before: removed.village, after: null },
        { field: 'Affected Population', before: removed.affectedPopulation, after: null },
        { field: 'Source', before: removed.source, after: null },
        { field: 'Status', before: removed.status, after: null },
      ],
    });
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
  private async resolveUserName(userId: string, crossOrg = false): Promise<string | null> {
    const names = await this.resolveUserNames([userId], crossOrg);
    return names.get(userId) ?? null;
  }

  /**
   * RIO-AI-001 — the latest `need_classification` AiDecision's confidence for
   * each of `needIds`, already banded.
   *
   * One query for the whole page rather than one per Need: the Needs list
   * renders this for every row, and a per-row lookup would turn a single list
   * request into N+1. Ordered ascending and written into the map as it goes,
   * so the LAST write per need wins — i.e. the newest decision, which is the
   * one a re-classification produced.
   */
  private async resolveAiConfidence(
    needIds: string[],
  ): Promise<Map<string, { confidence: number | null; band: ConfidenceBand }>> {
    const distinct = [...new Set(needIds)];
    const out = new Map<string, { confidence: number | null; band: ConfidenceBand }>();
    if (distinct.length === 0) return out;

    const [rows, settings] = await Promise.all([
      this.tenant.runInOrgContext((tx) =>
        tx.aiDecision.findMany({
          where: { needId: { in: distinct }, touchpoint: 'need_classification' },
          orderBy: { createdAt: 'asc' },
          select: { needId: true, confidence: true },
        }),
      ),
      this.methodologyConfig.getRaw(),
    ]);

    for (const row of rows) {
      const confidence = row.confidence === null ? null : Number(row.confidence);
      out.set(row.needId, {
        confidence,
        band: resolveConfidenceBand(confidence, settings.aiClassificationSettings),
      });
    }
    return out;
  }

  // `crossOrg` — RIO-RBAC-002: the creator of a Need read via the
  // cross-org-reader path below (System Admin/Center Supervisor viewing a
  // Need outside their own org) belongs to THAT org, not the ambient one —
  // `runInOrgContext` would RLS-filter them out entirely, silently
  // resolving to no name. `runAsSupervisor` (SELECT-only, no RLS) is the
  // same bypass Studies' getById already uses for its own cross-org read.
  private async resolveUserNames(userIds: string[], crossOrg = false): Promise<Map<string, string>> {
    const distinctIds = [...new Set(userIds)];
    if (distinctIds.length === 0) return new Map();
    const query = (tx: Prisma.TransactionClient) =>
      tx.user.findMany({ where: { id: { in: distinctIds } }, select: { id: true, name: true } });
    const users = crossOrg
      ? await this.tenant.runAsSupervisor(query)
      : await this.tenant.runInOrgContext(query);
    return new Map(users.map((u) => [u.id, u.name]));
  }

  // Reduces the raw `needGovernorates`/`needCenters` join arrays Prisma
  // returns (once included) down to plain id arrays — every other method
  // in this file works with that flattened NeedRow shape, never the raw
  // join rows directly.
  private toNeedRow(raw: RawNeedWithGeo): NeedRow {
    const studyGovernorateIds = (raw.study?.studyGovernorates ?? []).map((g) => g.governorateId);
    const studyCenterIds = (raw.study?.studyCenters ?? []).map((c) => c.centerId);
    const governorateIds =
      raw.needGovernorates && raw.needGovernorates.length > 0
        ? raw.needGovernorates.map((g) => g.governorateId)
        : studyGovernorateIds;
    const centerIds =
      raw.needCenters && raw.needCenters.length > 0
        ? raw.needCenters.map((c) => c.centerId)
        : studyCenterIds;

    return {
      ...raw,
      governorateIds,
      centerIds,
      needDomains: raw.needDomains.map((d) => ({ domain: d.domain, subDomain: d.subDomain })),
    };
  }

  private toNeed(
    row: NeedRow,
    createdByName: string | null,
    aiConfidence: { confidence: number | null; band: ConfidenceBand } | null = null,
  ): Need {
    return {
      id: row.id,
      studyId: row.studyId,
      orgId: row.orgId,
      title: row.title,
      statement: row.statement,
      village: row.village,
      governorateIds: row.governorateIds,
      centerIds: row.centerIds,
      source: row.source,
      referenceId: row.referenceId,
      internalReferenceId: formatInternalReferenceId(row.internalRefSeq),
      affectedPopulation: row.affectedPopulation,
      status: row.status,
      analyticalStatus: row.analyticalStatus,
      domain: row.domain,
      subDomain: row.subDomain,
      allDomainsSelected: row.allDomainsSelected,
      needDomains: row.needDomains,
      aiSuggestedDomain: row.aiSuggestedDomain,
      aiSuggestedSubDomain: row.aiSuggestedSubDomain,
      // Null band = no classification has run for this Need at all. Callers
      // that don't resolve it (create/update, where the caller already knows
      // no new decision exists) pass nothing and get null — never a
      // default-banded 'standard', which would read as "the AI was confident".
      aiConfidence: aiConfidence?.confidence ?? null,
      aiConfidenceBand: aiConfidence?.band ?? null,
      classifiedAt: row.classifiedAt ? row.classifiedAt.toISOString() : null,
      classificationError: row.classificationError,
      proposedDomains: Array.isArray(row.proposedDomains)
        ? (row.proposedDomains as Array<{ domain: string; subDomain: string }>)
        : null,
      proposedReason: row.proposedReason,
      gapType: row.gapType,
      urgency: row.urgency ?? null,
      themes: row.themes ?? [],
      affectedPeople: row.affectedPeople,
      affectedHouseholds: row.affectedHouseholds,
      createdBy: row.createdBy,
      createdByName,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
