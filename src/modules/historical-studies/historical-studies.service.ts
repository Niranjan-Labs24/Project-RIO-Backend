import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { getOrgStore, requireActor, requireOrgId } from '../../tenancy/org-context';
import { roleByKey } from '../../rbac/role-matrix';
import { StudyConfigService } from '../study-config/study-config.service';
import { EvidenceStorageService } from '../evidence/evidence.storage.service';
import type {
  CreateHistoricalStudyPayload,
  HistoricalStudy,
  HistoricalStudyRow,
} from './historical-studies.types';

// RIO-FR-013 (client Q25, confirmed by Ganesh 2026-09-04) — a reference
// upload for studies conducted before the platform existed. Metadata plus
// one file, no lifecycle of its own (contrast with Study/Need/Survey),
// permanent once uploaded (client Q27 — archive entries are never deleted,
// same rule applied here for consistency even though this is a different
// table).
@Injectable()
export class HistoricalStudiesService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly storage: EvidenceStorageService,
    private readonly studyConfig: StudyConfigService,
  ) {}

  async create(payload: CreateHistoricalStudyPayload): Promise<HistoricalStudy> {
    const orgId = requireOrgId();
    const uploadedBy = requireActor();

    const title = payload.title.trim();
    if (!title) {
      throw new BadRequestException({ error: { code: 'TITLE_REQUIRED', message: 'Title is required.' } });
    }
    const author = payload.author.trim();
    if (!author) {
      throw new BadRequestException({ error: { code: 'AUTHOR_REQUIRED', message: 'Author is required.' } });
    }
    const methodologyVersionLabel = payload.methodologyVersionLabel.trim();
    if (!methodologyVersionLabel) {
      throw new BadRequestException({
        error: { code: 'METHODOLOGY_VERSION_REQUIRED', message: 'Methodology version is required.' },
      });
    }
    const studyDate = new Date(payload.studyDate);
    if (Number.isNaN(studyDate.getTime())) {
      throw new BadRequestException({ error: { code: 'INVALID_STUDY_DATE', message: 'Invalid study date.' } });
    }

    // Same convention as Study.targetSector (RIO-FR-013, client Q26) —
    // validated against the configured list, not a DB-level FK.
    if (payload.targetSector !== undefined) {
      const names = await this.studyConfig.listActiveTargetSectorNames();
      if (names.length > 0 && !names.includes(payload.targetSector)) {
        throw new BadRequestException({
          error: { code: 'INVALID_TARGET_SECTOR', message: `"${payload.targetSector}" is not a configured Target Sector.` },
        });
      }
    }

    const { file } = payload;
    this.storage.assertAllowedExtension(file.originalName);
    this.storage.assertAllowedSize(file.originalName, file.sizeBytes);
    this.storage.assertFileSignature(file.originalName, file.buffer);
    const fileHash = this.storage.hashBuffer(file.buffer);
    const storageKey = await this.storage.save(file.originalName, file.buffer);

    let row: HistoricalStudyRow;
    try {
      row = (await this.tenant.runInOrgContext((tx) =>
        tx.historicalStudy.create({
          data: {
            orgId,
            title,
            region: payload.region,
            governorateIds: payload.governorateIds,
            centerIds: payload.centerIds,
            targetSector: payload.targetSector ?? null,
            studyDate,
            author,
            methodologyVersionLabel,
            fileName: file.originalName,
            fileType: file.mimeType,
            fileSize: file.sizeBytes,
            storageKey,
            fileHash,
            uploadedBy,
          },
        }),
      )) as unknown as HistoricalStudyRow;
    } catch (err) {
      // The insert can genuinely fail (e.g. a stale org context) after the
      // file is already on disk — don't leave an orphaned file behind.
      await this.storage.remove(storageKey);
      throw err;
    }

    return this.enrich([row]).then((rows) => rows[0]!);
  }

  async list(): Promise<HistoricalStudy[]> {
    const rows = await (this.isCrossEntity()
      ? this.tenant.runAsSupervisor((tx) => tx.historicalStudy.findMany({ orderBy: { studyDate: 'desc' } }))
      : this.tenant.runInOrgContext((tx) => tx.historicalStudy.findMany({ orderBy: { studyDate: 'desc' } })));
    return this.enrich(rows as unknown as HistoricalStudyRow[]);
  }

  async getFile(id: string): Promise<{ row: HistoricalStudyRow; buffer: Buffer }> {
    const row = (await (this.isCrossEntity()
      ? this.tenant.runAsSupervisor((tx) => tx.historicalStudy.findUnique({ where: { id } }))
      : this.tenant.runInOrgContext((tx) => tx.historicalStudy.findUnique({ where: { id } })))) as unknown as
      | HistoricalStudyRow
      | null;
    if (!row) {
      throw new BadRequestException({ error: { code: 'HISTORICAL_STUDY_NOT_FOUND', message: 'Not found.' } });
    }
    const buffer = await this.storage.read(row.storageKey);
    return { row, buffer };
  }

  private isCrossEntity(): boolean {
    const role = getOrgStore()?.role;
    return role !== undefined && roleByKey(role)?.crossEntity === true;
  }

  private async enrich(rows: HistoricalStudyRow[]): Promise<HistoricalStudy[]> {
    const orgIds = Array.from(new Set(rows.map((r) => r.orgId)));
    const userIds = Array.from(new Set(rows.map((r) => r.uploadedBy)));
    const governorateIds = Array.from(new Set(rows.flatMap((r) => r.governorateIds)));
    const centerIds = Array.from(new Set(rows.flatMap((r) => r.centerIds)));
    const [orgs, users, governorates, centers] = await Promise.all([
      orgIds.length === 0
        ? Promise.resolve([])
        : this.tenant.runAsSupervisor((tx) => tx.organisation.findMany({ where: { id: { in: orgIds } } })),
      userIds.length === 0
        ? Promise.resolve([])
        : this.tenant.runAsSupervisor((tx) => tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })),
      governorateIds.length === 0
        ? Promise.resolve([])
        : this.tenant.runAsSupervisor((tx) => tx.governorate.findMany({ where: { id: { in: governorateIds } } })),
      centerIds.length === 0
        ? Promise.resolve([])
        : this.tenant.runAsSupervisor((tx) => tx.center.findMany({ where: { id: { in: centerIds } } })),
    ]);
    const orgById = new Map(orgs.map((o) => [o.id, o]));
    const userNameById = new Map(users.map((u) => [u.id, u.name]));
    const governorateNameById = new Map(governorates.map((g) => [g.id, g.name]));
    const centerNameById = new Map(centers.map((c) => [c.id, c.name]));

    return rows.map((row) => ({
      id: row.id,
      orgId: row.orgId,
      orgName: orgById.get(row.orgId)?.name ?? row.orgId,
      title: row.title,
      region: row.region,
      governorateIds: row.governorateIds,
      governorateNames: row.governorateIds.map((id) => governorateNameById.get(id) ?? id),
      centerIds: row.centerIds,
      centerNames: row.centerIds.map((id) => centerNameById.get(id) ?? id),
      targetSector: row.targetSector,
      studyDate: row.studyDate.toISOString().slice(0, 10),
      author: row.author,
      methodologyVersionLabel: row.methodologyVersionLabel,
      fileName: row.fileName,
      fileType: row.fileType,
      fileSize: row.fileSize,
      uploadedBy: row.uploadedBy,
      uploadedByName: userNameById.get(row.uploadedBy) ?? null,
      uploadedAt: row.uploadedAt.toISOString(),
    }));
  }
}
