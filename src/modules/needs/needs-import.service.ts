import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { extname } from 'node:path';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { requireActor, requireOrgId } from '../../tenancy/org-context';
import { AuditService } from '../audit/audit.service';
import { parseCsvNeeds, parseExcelNeeds, type ParsedNeedRow } from './needs-import.parser';
import type { ImportNeedsResult } from './needs-import.types';

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
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
  ) {}

  // CSV/Excel only — PDF isn't parsed for Needs (no AI extraction yet); a
  // submitter with a PDF instead attaches it as Evidence on a manually
  // created Need (see EvidenceService.upload), same file, different pipeline.
  async importFromFile(
    studyId: string,
    file: { originalname: string; buffer: Buffer },
  ): Promise<ImportNeedsResult> {
    const orgId = requireOrgId();
    const createdBy = requireActor();

    const existingNeeds = await this.tenant.runInOrgContext(async (tx) => {
      const study = await tx.study.findUnique({ where: { id: studyId } });
      if (!study) throw new NotFoundException({ error: { code: 'STUDY_NOT_FOUND', message: 'Study not found' } });
      return tx.need.findMany({ where: { studyId }, select: { title: true, village: true, referenceId: true } });
    });

    const ext = extname(file.originalname).toLowerCase();
    let rows: ParsedNeedRow[];
    if (ext === '.csv') {
      rows = parseCsvNeeds(file.buffer);
    } else if (ext === '.xlsx' || ext === '.xls') {
      rows = await parseExcelNeeds(file.buffer);
    } else {
      throw new BadRequestException({
        error: { code: 'UNSUPPORTED_FILE_TYPE', message: 'Only CSV, XLS and XLSX files are supported for import.' },
      });
    }

    if (rows.length > MAX_IMPORT_ROWS) {
      throw new BadRequestException({
        error: { code: 'IMPORT_TOO_LARGE', message: `A single import can have at most ${MAX_IMPORT_ROWS} rows (${rows.length} found).` },
      });
    }

    // Seeded from what's already in the Study, then grown as the batch is
    // processed — so two rows of the same file that duplicate each other
    // (not just a row duplicating an existing Need) are also caught, same
    // "seed then grow" approach as EvidenceService's file-hash dedup.
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
        await this.tenant.runInOrgContext((tx) =>
          tx.need.create({
            data: {
              studyId,
              orgId,
              title: row.title,
              statement: row.statement,
              village: splitVillages(row.village),
              // RIO-FR-001: Source is system-assigned, not read from the
              // file — every Need created through this importer came in via
              // a file upload, full stop.
              source: 'file_upload',
              referenceId: row.referenceId || null,
              createdBy,
            },
          }),
        );
        seenKeys.add(key);
        imported += 1;
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
        entityLabel: `Bulk-imported ${imported} need(s) into study ${studyId}`,
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
