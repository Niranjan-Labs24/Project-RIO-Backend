import { ConflictException, NotFoundException, Injectable, Logger } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { requireActor, requireOrgId } from '../../tenancy/org-context';
import { AuditService } from '../audit/audit.service';
import { EvidenceStorageService, MAX_EVIDENCE_FILES_PER_STUDY } from './evidence.storage.service';
import { EVIDENCE_EDITABLE_STATUSES } from '../needs/needs.types';
import type { Evidence, EvidenceRow, UploadedFilePayload } from './evidence.types';

@Injectable()
export class EvidenceService {
  private readonly logger = new Logger(EvidenceService.name);

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly storage: EvidenceStorageService,
  ) {}

  // RIO-FR-Add-01: evidence is uploaded after its Need is captured. By
  // design, uploading no longer advances Need.status by itself — the
  // researcher must explicitly submit() before AI Classification is allowed
  // to run, so status stays untouched here.
  async upload(needId: string, files: UploadedFilePayload[]): Promise<Evidence[]> {
    const orgId = requireOrgId();
    const uploadedBy = requireActor();

    for (const file of files) {
      this.storage.assertAllowedExtension(file.originalName);
      this.storage.assertAllowedSize(file.originalName, file.sizeBytes);
      this.storage.assertFileSignature(file.originalName, file.buffer);
    }

    const need = await this.tenant.runInOrgContext((tx) => tx.need.findUnique({ where: { id: needId } }));
    if (!need) {
      throw new NotFoundException({ error: { code: 'NEED_NOT_FOUND', message: 'Need not found' } });
    }
    // Evidence stays editable slightly longer than the Need's own Statement/
    // Governorates/Centers (see EVIDENCE_EDITABLE_STATUSES) — through
    // ai_classified, not just up to it — since classification never reads
    // evidence content and an Approver hasn't acted yet at that stage.
    // Locks once reviewer_approved+.
    if (!EVIDENCE_EDITABLE_STATUSES.includes(need.status)) {
      throw new ConflictException({
        error: { code: 'EVIDENCE_NOT_EDITABLE', message: 'Evidence can no longer be added once this need has been approved.' },
      });
    }
    const studyId = need.studyId;

    // Duplicate detection is scoped to needId — each Need runs its own
    // independent evidence set, so the same file can validly reappear under
    // a sibling Need without being flagged. Seeded from what's already
    // stored, then grown as this batch is processed so two copies of the
    // same file in one request also flag the second one.
    const existingHashes = new Set(
      (
        await this.tenant.runInOrgContext((tx) => tx.evidence.findMany({ where: { needId }, select: { fileHash: true } }))
      )
        .map((r) => r.fileHash)
        // Rows predating the fileHash column have no hash and can't get one
        // (it comes from the upload buffer, not from storageKey), so they
        // can't participate in the comparison. Filtered out rather than left
        // in the set: a null would never match anyway, and dropping it keeps
        // the set honestly typed as Set<string>.
        .filter((hash): hash is string => hash !== null),
    );

    const prepared: Array<UploadedFilePayload & { fileHash: string; storageKey: string; isDuplicate: boolean }> = [];
    const isDuplicateByRowId = new Map<string, boolean>();
    let committed = false;
    try {
      for (const file of files) {
        const fileHash = this.storage.hashBuffer(file.buffer);
        const isDuplicate = existingHashes.has(fileHash);
        existingHashes.add(fileHash);
        const storageKey = await this.storage.save(file.originalName, file.buffer);
        prepared.push({ ...file, fileHash, storageKey, isDuplicate });
      }
      const created = await this.tenant.runInOrgContext(async (tx) => {
        // GAP-12: serialize concurrent uploads for THIS need so the capacity
        // check and the inserts are atomic (Read Committed alone can't
        // prevent two concurrent uploads from both reading count < cap
        // before either commits). Held for the rest of this transaction,
        // released automatically at commit/rollback.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'evidence:' + needId}))`;
        const existingCount = await tx.evidence.count({ where: { needId } });
        if (existingCount + files.length > MAX_EVIDENCE_FILES_PER_STUDY) {
          throw new ConflictException({
            error: {
              code: 'EVIDENCE_LIMIT_REACHED',
              message: `A need can have at most ${MAX_EVIDENCE_FILES_PER_STUDY} evidence files (${existingCount} already uploaded).`,
            },
          });
        }
        const rows: EvidenceRow[] = [];
        for (const file of prepared) {
          const row = await tx.evidence.create({
            data: {
              needId, studyId, orgId, fileName: file.originalName, fileType: file.mimeType,
              fileSize: file.sizeBytes, storageKey: file.storageKey, fileHash: file.fileHash, uploadedBy,
            },
          });
          rows.push(row as EvidenceRow);
          isDuplicateByRowId.set(row.id, file.isDuplicate);
        }
        return rows;
      });
      committed = true;
      for (const row of created) {
        await this.audit.record({
          action: 'create', entityType: 'evidence', entityId: row.id, entityLabel: row.fileName,
          // before: null on an upload — records what was attached and to which
          // Need, so the detail view is not blank for created events.
          changes: [
            { field: 'File name', before: null, after: row.fileName },
            { field: 'File type', before: null, after: row.fileType },
          ],
        });
      }
      const uploaderName = await this.resolveUserName(uploadedBy);
      return created.map((r) => this.toEvidence(r, uploaderName, isDuplicateByRowId.get(r.id) ?? false));
    } catch (error) {
      if (!committed) await Promise.all(prepared.map((file) => this.storage.remove(file.storageKey)));
      throw error;
    }
  }

  // RIO-FR-Add-01: an explicit step, separate from uploading — AI
  // Classification is gated on this having happened (see
  // AiDecisionsService.classify), not on evidence existing. Evidence is
  // optional: a Need can move straight to evidence_submitted (and from
  // there to AI Classification) with zero files attached — the attachment
  // is a supporting document a researcher may add if they have one, not a
  // prerequisite.
  async submit(needId: string): Promise<void> {
    // Assigned inside the transaction, read by the audit record below. When
    // the Need was already past draft the two match, which correctly records
    // the re-submit as a no-op rather than inventing a transition.
    let previousStatus = '';
    let nextStatus = '';
    await this.tenant.runInOrgContext(async (tx) => {
      const need = await tx.need.findUnique({ where: { id: needId } });
      if (!need) throw new NotFoundException({ error: { code: 'NEED_NOT_FOUND', message: 'Need not found' } });
      previousStatus = need.status;
      nextStatus = need.status;
      if (need.status === 'draft') {
        await tx.need.update({ where: { id: needId }, data: { status: 'evidence_submitted' } });
        nextStatus = 'evidence_submitted';
      }
      // Already evidence_submitted/ai_classified/...: submitting again is a
      // harmless no-op, not an error — re-running upload+submit after
      // adding more evidence shouldn't be blocked.
    });
    await this.audit.record({
      action: 'edit', entityType: 'need', entityId: needId, entityLabel: 'evidence submitted',
      changes: [{ field: 'Status', before: previousStatus, after: nextStatus }],
    });
  }

  async listByNeedId(needId: string): Promise<Evidence[]> {
    const rows = (await this.tenant.runInOrgContext((tx) =>
      tx.evidence.findMany({ where: { needId }, orderBy: { uploadedAt: 'desc' } }),
    )) as EvidenceRow[];
    const names = await this.resolveUserNames(rows.map((r) => r.uploadedBy));
    return rows.map((r) => this.toEvidence(r, names.get(r.uploadedBy) ?? null));
  }

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

  // Confirmed gap: this used to delete unconditionally. Mirrors
  // StudiesService.remove's shape — once evidence has been submitted
  // (Need.status past draft), it underpins AI Classification/Human Review
  // and can no longer be removed.
  async remove(id: string): Promise<void> {
    const row = await this.tenant.runInOrgContext(async (tx) => {
      const existing = (await tx.evidence.findUnique({ where: { id } })) as EvidenceRow | null;
      if (!existing) throw new NotFoundException({ error: { code: 'EVIDENCE_NOT_FOUND', message: 'Evidence not found' } });
      const need = await tx.need.findUnique({ where: { id: existing.needId } });
      if (need && !EVIDENCE_EDITABLE_STATUSES.includes(need.status)) {
        throw new ConflictException({
          error: {
            code: 'EVIDENCE_NOT_DELETABLE',
            message: 'Evidence cannot be deleted once it has been submitted.',
          },
        });
      }
      await tx.evidence.delete({ where: { id } });
      // The Need is already loaded for the status check above — carry its
      // title out so the audit entry names the Need a reader can recognise
      // rather than repeating its UUID.
      return { ...existing, needTitle: need?.title ?? null };
    });
    // GAP-13: the DB row is already gone at this point — a failed physical
    // delete here used to be silently swallowed inside
    // EvidenceStorageService.remove, orphaning the file with nothing to
    // signal it. storage.remove() now reports success/failure; on failure,
    // record a durable, retryable PendingFileDeletion row (a global table,
    // written via runAsSupervisorWrite — see tenant-prisma.service.ts) and
    // log at error level instead of dropping the failure on the floor.
    // EvidenceFileCleanupService's cron sweep retries these.
    const removed = await this.storage.remove(row.storageKey);
    if (!removed) {
      this.logger.error(
        `Failed to delete evidence file from storage (storageKey=${row.storageKey}, evidenceId=${row.id}); ` +
        'queued for retry via PendingFileDeletion',
      );
      await this.tenant.runAsSupervisorWrite((tx) =>
        tx.pendingFileDeletion.create({ data: { storageKey: row.storageKey } }),
      );
    }
    await this.audit.record({
      action: 'delete', entityType: 'evidence', entityId: row.id, entityLabel: row.fileName,
      // after: null — the file is removed from storage as well as the row, so
      // this is the only surviving record of what was deleted.
      changes: [
        { field: 'File name', before: row.fileName, after: null },
        { field: 'File type', before: row.fileType, after: null },
        { field: 'Linked need', before: row.needTitle, after: null },
      ],
    });
  }

  // isDuplicate is only meaningful right after an upload (it answers "did
  // this exact file already exist for this Need when it was uploaded?") —
  // listByNeedId doesn't pass one, so it's omitted from that response
  // rather than recomputed against a different, order-dependent definition.
  private toEvidence(row: EvidenceRow, uploadedByName: string | null, isDuplicate?: boolean): Evidence {
    return {
      id: row.id,
      needId: row.needId,
      studyId: row.studyId,
      fileName: row.fileName,
      fileType: row.fileType,
      fileSize: row.fileSize,
      uploadedBy: row.uploadedBy,
      uploadedByName,
      uploadedAt: row.uploadedAt.toISOString(),
      ...(isDuplicate !== undefined ? { isDuplicate } : {}),
    };
  }
}
