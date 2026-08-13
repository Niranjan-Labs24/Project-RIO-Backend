import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe';
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { RequirePermission } from '../../common/guards/permission.guard';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import { BulkImportNeedsBody, CreateNeedBody, UpdateNeedBody } from './needs.contract';
import { NeedsImportService } from './needs-import.service';
import type { BulkImportNeedsPayload, ImportNeedsResult, PdfPreviewResult } from './needs-import.types';
import { NeedsService } from './needs.service';
import type { CreateNeedPayload, Need, UpdateNeedPayload } from './needs.types';

const MAX_IMPORT_FILE_SIZE_BYTES = 10 * 1024 * 1024;

// A Study is a container that can hold many Needs, so collection routes
// (create/list/import) stay under `studies/:studyId/needs`; item routes
// (get/patch one specific Need) live under `needs/:needId`, unscoped by
// studyId (a Need doesn't move between Studies, so its id alone is enough
// to look it up).
@Controller()
export class NeedsController {
  constructor(
    private readonly needs: NeedsService,
    private readonly needsImport: NeedsImportService,
  ) {}

  @Post('studies/:studyId/needs')
  @RequirePermission('dataCollection', 'create')
  create(
    @Param('studyId', new UuidParamPipe()) studyId: string,
    @Body(new TypeBoxValidationPipe(CreateNeedBody)) body: CreateNeedPayload,
  ): Promise<Need> {
    return this.needs.create(studyId, body);
  }

  @Get('studies/:studyId/needs')
  @RequirePermission('dataCollection', 'read')
  listByStudyId(@Param('studyId', new UuidParamPipe()) studyId: string): Promise<Need[]> {
    return this.needs.listByStudyId(studyId);
  }

  // CSV/XLSX direct import — one Need per row.
  @Post('studies/:studyId/needs/import')
  @RequirePermission('dataCollection', 'create')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMPORT_FILE_SIZE_BYTES } }))
  importNeeds(
    @Param('studyId', new UuidParamPipe()) studyId: string,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<ImportNeedsResult> {
    if (!file) {
      throw new BadRequestException({ error: { code: 'NO_FILE', message: 'A file is required' } });
    }
    return this.needsImport.importFromFile(studyId, file);
  }

  // Parses an uploaded PDF and returns extracted Needs for user review
  @Post('studies/:studyId/needs/preview-pdf')
  @RequirePermission('dataCollection', 'create')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMPORT_FILE_SIZE_BYTES } }))
  previewPdf(
    @Param('studyId', new UuidParamPipe()) studyId: string,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<PdfPreviewResult> {
    if (!file) {
      throw new BadRequestException({ error: { code: 'NO_FILE', message: 'A PDF file is required' } });
    }
    return this.needsImport.previewPdfFromFile(studyId, file);
  }

  // Parses uploaded survey results document (PDF/DOCX/XLSX/CSV) and returns extracted Needs for user review
  @Post('studies/:studyId/needs/preview-survey-results')
  @RequirePermission('dataCollection', 'create')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMPORT_FILE_SIZE_BYTES } }))
  previewSurveyResults(
    @Param('studyId', new UuidParamPipe()) studyId: string,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<PdfPreviewResult> {
    if (!file) {
      throw new BadRequestException({ error: { code: 'NO_FILE', message: 'A survey results document is required' } });
    }
    return this.needsImport.previewSurveyResultsFromFile(studyId, file);
  }

  // Creates confirmed Needs in bulk after PDF review
  @Post('studies/:studyId/needs/import-bulk')
  @RequirePermission('dataCollection', 'create')
  importBulk(
    @Param('studyId', new UuidParamPipe()) studyId: string,
    @Body(new TypeBoxValidationPipe(BulkImportNeedsBody)) body: BulkImportNeedsPayload,
  ): Promise<ImportNeedsResult> {
    return this.needsImport.importBulk(studyId, body);
  }

  @Get('needs/:needId')
  @RequirePermission('dataCollection', 'read')
  getById(@Param('needId', new UuidParamPipe()) needId: string): Promise<Need> {
    return this.needs.getById(needId);
  }

  @Patch('needs/:needId')
  @RequirePermission('dataCollection', 'write')
  update(
    @Param('needId', new UuidParamPipe()) needId: string,
    @Body(new TypeBoxValidationPipe(UpdateNeedBody)) body: UpdateNeedPayload,
  ): Promise<Need> {
    return this.needs.update(needId, body ?? {});
  }

  @Delete('needs/:needId')
  @HttpCode(204)
  @RequirePermission('dataCollection', 'write')
  remove(@Param('needId', new UuidParamPipe()) needId: string): Promise<void> {
    return this.needs.remove(needId);
  }
}
