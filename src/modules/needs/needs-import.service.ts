import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { extname } from 'node:path';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { requireActor, requireOrgId } from '../../tenancy/org-context';
import { AuditService } from '../audit/audit.service';
import { AiDecisionsService } from '../ai-decisions/ai-decisions.service';
import { AiService } from '../ai/ai.service';
import { parseCsvNeeds, parseExcelNeeds, parsePdfNeeds, parseSurveyDocumentNeeds, type ParsedNeedRow } from './needs-import.parser';
import type { BulkImportNeedsPayload, ImportNeedsResult, PdfPreviewResult } from './needs-import.types';

const MAX_IMPORT_ROWS = 2000;

function splitVillages(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

// Two rows/existing-Needs are "the same Need" if either:
//   - they both have a Reference ID and it matches (case/whitespace
//     insensitive) — the strongest signal, since it's the submitter's own
//     external id; or
//   - neither has a Reference ID, but Title + Village match — the fallback
//     for files that don't carry one.
// Scoped to the Study being imported into, not the whole org — the same
// Reference ID under a different Study is a different Need.
function dedupeKey(title: string, village: string, referenceId: string): string {
  const normalizedRef = referenceId.trim().toLowerCase();
  if (normalizedRef) return `ref:${normalizedRef}`;
  const normalizedVillages = splitVillages(village).map((v) => v.toLowerCase()).sort().join(',');
  return `title-village:${title.trim().toLowerCase()}|${normalizedVillages}`;
}

@Injectable()
export class NeedsImportService {
  private readonly logger = new Logger(NeedsImportService.name);

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly aiDecisions: AiDecisionsService,
    @Optional() @Inject(AiService) private readonly aiService?: AiService,
  ) {}

  async previewPdfFromFile(
    studyId: string,
    file: { originalname: string; buffer: Buffer },
  ): Promise<PdfPreviewResult> {
    const ext = extname(file.originalname).toLowerCase();
    if (ext !== '.pdf') {
      throw new BadRequestException({
        error: { code: 'UNSUPPORTED_FILE_TYPE', message: 'Only PDF files can be previewed.' },
      });
    }

    try {
      const rows = await parsePdfNeeds(file.buffer, this.aiService);
      return {
        totalExtracted: rows.length,
        needs: rows.map((r, idx) => ({
          id: `extracted-${idx + 1}`,
          title: r.title,
          statement: r.statement,
          village: r.village,
          referenceId: r.referenceId,
        })),
      };
    } catch (err: unknown) {
      throw new BadRequestException({
        error: {
          code: 'PDF_PARSING_FAILED',
          message: err instanceof Error ? err.message : 'Failed to parse PDF document.',
        },
      });
    }
  }

  async previewSurveyResultsFromFile(
    studyId: string,
    file: { originalname: string; buffer: Buffer },
  ): Promise<PdfPreviewResult> {
    try {
      const rows = await parseSurveyDocumentNeeds(file.buffer, file.originalname, this.aiService);
      return {
        totalExtracted: rows.length,
        needs: rows.map((r, idx) => ({
          id: `survey-extracted-${idx + 1}`,
          title: r.title,
          statement: r.statement,
          village: r.village,
          referenceId: r.referenceId,
        })),
      };
    } catch (err: unknown) {
      throw new BadRequestException({
        error: {
          code: 'SURVEY_PARSING_FAILED',
          message: err instanceof Error ? err.message : 'Failed to parse survey results document.',
        },
      });
    }
  }

  async importBulk(
    studyId: string,
    payload: BulkImportNeedsPayload,
  ): Promise<ImportNeedsResult> {
    const orgId = requireOrgId();
    const createdBy = requireActor();

    const { existingNeeds, studyTitle, studyGovernorateIds, studyCenterIds } = await this.tenant.runInOrgContext(async (tx) => {
      const study = await tx.study.findUnique({
        where: { id: studyId },
        include: { studyGovernorates: true, studyCenters: true },
      });
      if (!study) throw new NotFoundException({ error: { code: 'STUDY_NOT_FOUND', message: 'Study not found' } });
      const existingNeeds = await tx.need.findMany({
        where: { studyId },
        select: { title: true, village: true, referenceId: true },
      });
      return {
        existingNeeds,
        studyTitle: study.title,
        studyGovernorateIds: (study.studyGovernorates ?? []).map((g) => g.governorateId),
        studyCenterIds: (study.studyCenters ?? []).map((c) => c.centerId),
      };
    });

    const items = payload.needs ?? [];
    if (items.length === 0) {
      throw new BadRequestException({
        error: { code: 'EMPTY_PAYLOAD', message: 'At least one need item is required.' },
      });
    }

    if (items.length > MAX_IMPORT_ROWS) {
      throw new BadRequestException({
        error: { code: 'IMPORT_TOO_LARGE', message: `A single import can have at most ${MAX_IMPORT_ROWS} items.` },
      });
    }

    const seenKeys = new Set(
      existingNeeds.map((n) => dedupeKey(n.title, n.village.join(','), n.referenceId ?? '')),
    );

    const errors: ImportNeedsResult['errors'] = [];
    let imported = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const rowNum = i + 1;
      const title = (item.title || '').trim();
      const statement = (item.statement || '').trim();
      const village = (item.village || '').trim();
      const referenceId = (item.referenceId || '').trim();

      if (!title) {
        errors.push({ row: rowNum, message: 'Title is required.', type: 'validation' });
        continue;
      }
      if (!statement) {
        errors.push({ row: rowNum, message: 'Statement is required.', type: 'validation' });
        continue;
      }

      const key = dedupeKey(title, village, referenceId);
      if (seenKeys.has(key)) {
        errors.push({
          row: rowNum,
          message: referenceId
            ? `Duplicate Reference ID "${referenceId}" — a Need with this Reference ID already exists in this Study.`
            : 'Duplicate Need — a Need with this Title and Governorate already exists in this Study.',
          type: 'duplicate',
        });
        continue;
      }

      try {
        const created = await this.tenant.runInOrgContext((tx) =>
          tx.need.create({
            data: {
              studyId,
              orgId,
              title,
              statement,
              village: splitVillages(village),
              source: 'file_upload',
              referenceId: referenceId || null,
              createdBy,
              status: 'pending_ai_classification',
              needGovernorates: {
                createMany: {
                  data: studyGovernorateIds.map((governorateId) => ({ orgId, governorateId })),
                },
              },
              needCenters: {
                createMany: {
                  data: studyCenterIds.map((centerId) => ({ orgId, centerId })),
                },
              },
            },
          }),
        );
        seenKeys.add(key);
        imported += 1;
        this.aiDecisions.classifyAutomatically(created.id).catch((err: Error) => {
          this.logger.warn(`Automatic classification failed for imported need ${created.id}: ${err.message}`);
        });
      } catch {
        errors.push({
          row: rowNum,
          message: 'Could not save this item — please check its values and try again.',
          type: 'validation',
        });
      }
    }

    if (imported > 0) {
      await this.audit.record({
        action: 'create',
        entityType: 'need',
        entityId: studyId,
        entityLabel: `Bulk-imported ${imported} need(s) into "${studyTitle}"`,
        changes: [{ field: 'imported', before: null, after: imported }],
      });
    }

    return { totalRows: items.length, imported, failed: errors.length, errors };
  }

  // CSV/Excel only — PDF isn't parsed directly here (PDF uses preview & confirm flow)
  async importFromFile(
    studyId: string,
    file: { originalname: string; buffer: Buffer },
  ): Promise<ImportNeedsResult> {
    const orgId = requireOrgId();
    const createdBy = requireActor();

    const { existingNeeds, studyTitle, studyGovernorateIds, studyCenterIds } = await this.tenant.runInOrgContext(async (tx) => {
      const study = await tx.study.findUnique({
        where: { id: studyId },
        include: { studyGovernorates: true, studyCenters: true },
      });
      if (!study) throw new NotFoundException({ error: { code: 'STUDY_NOT_FOUND', message: 'Study not found' } });
      const existingNeeds = await tx.need.findMany({
        where: { studyId },
        select: { title: true, village: true, referenceId: true },
      });
      return {
        existingNeeds,
        studyTitle: study.title,
        studyGovernorateIds: (study.studyGovernorates ?? []).map((g) => g.governorateId),
        studyCenterIds: (study.studyCenters ?? []).map((c) => c.centerId),
      };
    });

    const ext = extname(file.originalname).toLowerCase();
    let rows: ParsedNeedRow[];
    if (ext === '.csv') {
      rows = parseCsvNeeds(file.buffer);
    } else if (ext === '.xlsx' || ext === '.xls') {
      rows = await parseExcelNeeds(file.buffer);
    } else {
      throw new BadRequestException({
        error: { code: 'UNSUPPORTED_FILE_TYPE', message: 'Only CSV, XLS and XLSX files are supported for direct import.' },
      });
    }

    if (rows.length > MAX_IMPORT_ROWS) {
      throw new BadRequestException({
        error: { code: 'IMPORT_TOO_LARGE', message: `A single import can have at most ${MAX_IMPORT_ROWS} rows (${rows.length} found).` },
      });
    }

    const seenKeys = new Set(
      existingNeeds.map((n) => dedupeKey(n.title, n.village.join(','), n.referenceId ?? '')),
    );

    const errors: ImportNeedsResult['errors'] = [];
    let imported = 0;

    for (const row of rows) {
      const validationError = this.validateRow(row);
      if (validationError) {
        errors.push({ row: row.row, message: validationError, type: 'validation' });
        continue;
      }

      const key = dedupeKey(row.title, row.village, row.referenceId);
      if (seenKeys.has(key)) {
        errors.push({
          row: row.row,
          message: row.referenceId
            ? `Duplicate Reference ID "${row.referenceId}" — a Need with this Reference ID already exists in this Study.`
            : 'Duplicate Need — a Need with this Title and Governorate already exists in this Study.',
          type: 'duplicate',
        });
        continue;
      }

      try {
        const created = await this.tenant.runInOrgContext((tx) =>
          tx.need.create({
            data: {
              studyId,
              orgId,
              title: row.title,
              statement: row.statement,
              village: splitVillages(row.village),
              source: 'file_upload',
              referenceId: row.referenceId || null,
              createdBy,
              status: 'pending_ai_classification',
              needGovernorates: {
                createMany: {
                  data: studyGovernorateIds.map((governorateId) => ({ orgId, governorateId })),
                },
              },
              needCenters: {
                createMany: {
                  data: studyCenterIds.map((centerId) => ({ orgId, centerId })),
                },
              },
            },
          }),
        );
        seenKeys.add(key);
        imported += 1;
        this.aiDecisions.classifyAutomatically(created.id).catch((err: Error) => {
          this.logger.warn(`Automatic classification failed for imported need ${created.id}: ${err.message}`);
        });
      } catch {
        errors.push({
          row: row.row,
          message: 'Could not save this row — please check its values and try again.',
          type: 'validation',
        });
      }
    }

    if (imported > 0) {
      await this.audit.record({
        action: 'create',
        entityType: 'need',
        entityId: studyId,
        entityLabel: `Bulk-imported ${imported} need(s) into "${studyTitle}"`,
        // A bulk import creates many rows at once, so the meaningful pair is
        // the count of Needs on the study before and after the import.
        changes: [
          { field: 'Needs imported', before: null, after: imported },
          { field: 'Rows skipped', before: null, after: errors.length },
          { field: 'Target study', before: null, after: studyTitle },
        ],
      });
    }

    return { totalRows: rows.length, imported, failed: errors.length, errors };
  }

  private validateRow(row: ParsedNeedRow): string | null {
    if (!row.title) return 'Title is required.';
    if (row.title.length > 300) return 'Title must be 300 characters or fewer.';
    if (!row.statement) return 'Statement is required.';
    if (!row.village || splitVillages(row.village).length === 0) return 'Governorate is required.';
    return null;
  }
}
