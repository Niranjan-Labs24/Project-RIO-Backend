import { BadRequestException, Controller, Delete, Get, HttpCode, Param, Post, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { RequirePermission } from '../../common/guards/permission.guard';
import { EvidenceService } from './evidence.service';
import { MAX_EVIDENCE_FILE_SIZE_BYTES, MAX_EVIDENCE_FILES_PER_STUDY } from './evidence.storage.service';
import type { Evidence } from './evidence.types';

@Controller('studies/:studyId/evidence')
export class EvidenceController {
  constructor(private readonly evidence: EvidenceService) {}

  @Post()
  @RequirePermission('dataCollection', 'create')
  @UseInterceptors(
    FilesInterceptor('files', MAX_EVIDENCE_FILES_PER_STUDY, {
      limits: { fileSize: MAX_EVIDENCE_FILE_SIZE_BYTES },
    }),
  )
  upload(
    @Param('studyId') studyId: string,
    @UploadedFiles() files: Express.Multer.File[],
  ): Promise<Evidence[]> {
    if (!files || files.length === 0) {
      throw new BadRequestException({ error: { code: 'NO_FILES', message: 'At least one file is required' } });
    }
    return this.evidence.upload(
      studyId,
      files.map((f) => ({ originalName: f.originalname, mimeType: f.mimetype, sizeBytes: f.size, buffer: f.buffer })),
    );
  }

  @Get()
  @RequirePermission('dataCollection', 'read')
  list(@Param('studyId') studyId: string): Promise<Evidence[]> {
    return this.evidence.listByStudyId(studyId);
  }

  // A distinct step from uploading — AI Classification only
  // becomes eligible once evidence has been explicitly submitted.
  @Post('submit')
  @HttpCode(200)
  @RequirePermission('dataCollection', 'write')
  submit(@Param('studyId') studyId: string): Promise<void> {
    return this.evidence.submit(studyId);
  }
}

@Controller('evidence')
export class EvidenceDeleteController {
  constructor(private readonly evidence: EvidenceService) {}

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('dataCollection', 'write')
  remove(@Param('id') id: string): Promise<void> {
    return this.evidence.remove(id);
  }
}
