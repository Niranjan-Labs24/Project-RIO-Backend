import { ConflictException, NotFoundException, Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { requireActor, requireOrgId } from '../../tenancy/org-context';
import { AuditService } from '../audit/audit.service';
import { EvidenceStorageService, MAX_EVIDENCE_FILES_PER_STUDY } from './evidence.storage.service';
import type { Evidence, EvidenceRow, UploadedFilePayload } from './evidence.types';

@Injectable()
export class EvidenceService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly storage: EvidenceStorageService,
  ) {}

  // RIO-FR-Add-01: evidence is uploaded after the Need is captured. Per
  // Ganesh, uploading no longer advances Study.status by itself — the
  // researcher must explicitly submit() before AI Classification is allowed
  // to run, so status stays untouched here.
  async upload(studyId: string, files: UploadedFilePayload[]): Promise<Evidence[]> {
    const orgId = requireOrgId();
    const uploadedBy = requireActor();

    for (const file of files) {
      this.storage.assertAllowedExtension(file.originalName);
      this.storage.assertAllowedSize(file.originalName, file.sizeBytes);
    }

    const need = await this.tenant.runInOrgContext((tx) => tx.need.findUnique({ where: { studyId } }));
    if (!need) {
      throw new NotFoundException({ error: { code: 'NEED_NOT_FOUND', message: 'Capture the need before uploading evidence' } });
    }

    const existingCount = await this.tenant.runInOrgContext((tx) => tx.evidence.count({ where: { studyId } }));
    if (existingCount + files.length > MAX_EVIDENCE_FILES_PER_STUDY) {
      throw new ConflictException({
        error: {
          code: 'EVIDENCE_LIMIT_REACHED',
          message: `A study can have at most ${MAX_EVIDENCE_FILES_PER_STUDY} evidence files (${existingCount} already uploaded).`,
        },
      });
    }

    const created: EvidenceRow[] = [];
    for (const file of files) {
      const storageKey = await this.storage.save(file.originalName, file.buffer);
      const row = (await this.tenant.runInOrgContext((tx) =>
        tx.evidence.create({
          data: {
            studyId,
            orgId,
            fileName: file.originalName,
            fileType: file.mimeType,
            fileSize: file.sizeBytes,
            storageKey,
            uploadedBy,
          },
        }),
      )) as EvidenceRow;
      created.push(row);
    }

    for (const row of created) {
      await this.audit.record({ action: 'create', entityType: 'evidence', entityId: row.id, entityLabel: row.fileName });
    }
    const uploaderName = await this.resolveUserName(uploadedBy);
    return created.map((r) => this.toEvidence(r, uploaderName));
  }

  // RIO-FR-Add-01 / per Ganesh: an explicit step, separate from uploading —
  // AI Classification is gated on this having happened (see
  // AiDecisionsService.classify), not merely on evidence existing.
  async submit(studyId: string): Promise<void> {
    await this.tenant.runInOrgContext(async (tx) => {
      const study = await tx.study.findUnique({ where: { id: studyId } });
      if (!study) throw new NotFoundException({ error: { code: 'STUDY_NOT_FOUND', message: 'Study not found' } });
      if (study.status === 'draft' || study.status === 'need_captured') {
        const need = await tx.need.findUnique({ where: { studyId } });
        if (!need) {
          throw new ConflictException({ error: { code: 'NEED_NOT_FOUND', message: 'Capture the need before submitting evidence' } });
        }
        const evidenceCount = await tx.evidence.count({ where: { studyId } });
        if (evidenceCount === 0) {
          throw new ConflictException({ error: { code: 'EVIDENCE_REQUIRED', message: 'Upload at least one evidence file before submitting' } });
        }
        await tx.study.update({ where: { id: studyId }, data: { status: 'evidence_submitted' } });
      }
      // Already evidence_submitted/ai_classified/human_reviewed: submitting
      // again is a harmless no-op, not an error — re-running upload+submit
      // after adding more evidence shouldn't be blocked.
    });
    await this.audit.record({ action: 'edit', entityType: 'study', entityId: studyId, entityLabel: 'evidence submitted' });
  }

  async listByStudyId(studyId: string): Promise<Evidence[]> {
    const rows = (await this.tenant.runInOrgContext((tx) =>
      tx.evidence.findMany({ where: { studyId }, orderBy: { uploadedAt: 'desc' } }),
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

  async remove(id: string): Promise<void> {
    const row = await this.tenant.runInOrgContext(async (tx) => {
      const existing = (await tx.evidence.findUnique({ where: { id } })) as EvidenceRow | null;
      if (!existing) throw new NotFoundException({ error: { code: 'EVIDENCE_NOT_FOUND', message: 'Evidence not found' } });
      await tx.evidence.delete({ where: { id } });
      return existing;
    });
    await this.storage.remove(row.storageKey);
    await this.audit.record({ action: 'delete', entityType: 'evidence', entityId: row.id, entityLabel: row.fileName });
  }

  private toEvidence(row: EvidenceRow, uploadedByName: string | null): Evidence {
    return {
      id: row.id,
      studyId: row.studyId,
      fileName: row.fileName,
      fileType: row.fileType,
      fileSize: row.fileSize,
      uploadedBy: row.uploadedBy,
      uploadedByName,
      uploadedAt: row.uploadedAt.toISOString(),
    };
  }
}
