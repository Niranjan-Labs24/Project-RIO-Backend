import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { extname } from 'node:path';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { getOrgStore, requireActor, requireOrgId } from '../../tenancy/org-context';
import { roleByKey } from '../../rbac/role-matrix';
import { StudyConfigService } from '../study-config/study-config.service';
import { EvidenceStorageService } from '../evidence/evidence.storage.service';
import { NeedsImportService } from '../needs/needs-import.service';
import type { ImportNeedsResult } from '../needs/needs-import.types';
import {
  IMPORTABLE_HISTORICAL_EXTENSIONS,
  type CreateHistoricalStudyPayload,
  type HistoricalStudy,
  type HistoricalStudyImportResult,
  type HistoricalStudyRow,
} from './historical-studies.types';

// RIO-FR-013 (client Q25, confirmed by Ganesh 2026-09-04) — a reference
// upload for studies conducted before the platform existed. Metadata plus
// one file, no lifecycle of its own (contrast with Study/Need/Survey),
// permanent once uploaded (client Q27 — archive entries are never deleted,
// same rule applied here for consistency even though this is a different
// table).
@Injectable()
export class HistoricalStudiesService {
  private readonly logger = new Logger(HistoricalStudiesService.name);

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly storage: EvidenceStorageService,
    private readonly studyConfig: StudyConfigService,
    private readonly needsImport: NeedsImportService,
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

  // RIO-DATA-002 / FR-17 — import an archived pre-platform study into the
  // unified dashboard. The BRD is explicit that this must not be an external
  // BI link; a downloadable attachment (which is all RIO-FR-013 gives) fails
  // the same test, because you still leave the platform to read the numbers.
  //
  // So the needs *inside* the old file become real Need rows under a real
  // Study flagged `isHistorical`. Modelling it as an ordinary Study is the
  // whole trick: the dashboard, its filters and FR-003 priority scoring then
  // apply to imported needs with no special-casing anywhere downstream.
  async importToDashboard(id: string): Promise<HistoricalStudyImportResult> {
    const orgId = requireOrgId();
    const createdBy = requireActor();

    // getFile() lets cross-entity roles read any org's archive entry, which
    // is right for a download but not for a write: the Study and Needs it
    // produces are org-scoped rows, so importing someone else's archive
    // entry would file their data under the caller's org.
    const { row, buffer } = await this.getFile(id);
    if (row.orgId !== orgId) {
      throw new BadRequestException({
        error: {
          code: 'CROSS_ORG_IMPORT_FORBIDDEN',
          message: 'A historical study can only be imported by the entity that uploaded it.',
        },
      });
    }

    const ext = extname(row.fileName).toLowerCase();
    if (!(IMPORTABLE_HISTORICAL_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new BadRequestException({
        error: {
          code: 'UNSUPPORTED_FILE_TYPE',
          message:
            `"${row.fileName}" cannot be imported automatically. Only ` +
            `${IMPORTABLE_HISTORICAL_EXTENSIONS.join(', ')} files carry one need per row. ` +
            'Unstructured files must be converted to that shape first — see the migration requirements.',
        },
      });
    }

    // The UNIQUE on studies.historical_study_id is the real guard; this
    // check exists to return a useful message and the existing studyId
    // instead of a raw constraint violation.
    const alreadyImported = await this.tenant.runInOrgContext((tx) =>
      tx.study.findFirst({ where: { historicalStudyId: id }, select: { id: true, title: true } }),
    );
    if (alreadyImported) {
      throw new BadRequestException({
        error: {
          code: 'ALREADY_IMPORTED',
          message: `"${row.title}" has already been imported as the study "${alreadyImported.title}".`,
          studyId: alreadyImported.id,
        },
      });
    }

    // Cycle numbers are UNIQUE per org and count forward from 1 for studies
    // run on the platform. A pre-platform study is not part of that
    // sequence, so it counts backwards from 0 instead: the first import
    // reads as "cycle 0", the baseline before cycle 1, and later ones as
    // -1, -2. This keeps the unique constraint satisfied without ever
    // renumbering a real cycle.
    const study = await this.tenant.runInOrgContext(async (tx) => {
      const minRow = await tx.study.findFirst({
        where: { orgId },
        orderBy: { cycleNumber: 'asc' },
        select: { cycleNumber: true },
      });
      const cycleNumber = Math.min(minRow?.cycleNumber ?? 1, 1) - 1;

      const created = await tx.study.create({
        data: {
          orgId,
          title: row.title,
          cycleNumber,
          status: 'active',
          targetSector: row.targetSector,
          isHistorical: true,
          historicalStudyDate: row.studyDate,
          historicalStudyId: row.id,
          createdBy,
        },
      });

      // Carry the archive entry's geography onto the Study so the
      // dashboard's region/governorate/center filters see the imported
      // needs. Without this the study aggregates to no region at all.
      if (row.governorateIds.length > 0) {
        await tx.studyGovernorate.createMany({
          data: row.governorateIds.map((governorateId) => ({ studyId: created.id, orgId, governorateId })),
          skipDuplicates: true,
        });
      }
      if (row.centerIds.length > 0) {
        await tx.studyCenter.createMany({
          data: row.centerIds.map((centerId) => ({ studyId: created.id, orgId, centerId })),
          skipDuplicates: true,
        });
      }
      return created;
    });

    // From here the Study row exists, so any failure has to clean it up —
    // an empty historical study in the dashboard is worse than none.
    let result: ImportNeedsResult;
    try {
      result = await this.needsImport.importFromFile(study.id, {
        originalname: row.fileName,
        buffer,
      });
    } catch (err) {
      await this.deleteStudyQuietly(study.id);
      throw err;
    }

    // Every row failed validation. The Study would be an empty shell, and
    // the caller needs the row errors to fix the file and retry — which the
    // `historical_study_id` UNIQUE would otherwise block forever.
    if (result.imported === 0) {
      await this.deleteStudyQuietly(study.id);
      throw new BadRequestException({
        error: {
          code: 'NO_ROWS_IMPORTED',
          message: `No needs could be read from "${row.fileName}". Nothing was added to the dashboard.`,
          totalRows: result.totalRows,
          errors: result.errors,
        },
      });
    }

    return {
      historicalStudyId: row.id,
      studyId: study.id,
      studyTitle: study.title,
      cycleNumber: study.cycleNumber,
      totalRows: result.totalRows,
      imported: result.imported,
      failed: result.failed,
      errors: result.errors,
    };
  }

  // Best-effort rollback of the Study created moments earlier. A failure
  // here must not mask the original error that triggered the rollback, so it
  // is logged rather than thrown.
  private async deleteStudyQuietly(studyId: string): Promise<void> {
    try {
      await this.tenant.runInOrgContext((tx) => tx.study.delete({ where: { id: studyId } }));
    } catch (err) {
      this.logger.error(
        `Failed to roll back study ${studyId} after a historical import error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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
