import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe';
import { RequirePermission } from '../../common/guards/permission.guard';
import { MAX_EVIDENCE_FILE_SIZE_BYTES } from '../evidence/evidence.storage.service';
import { HistoricalStudiesService } from './historical-studies.service';
import type { HistoricalStudy } from './historical-studies.types';

interface CreateHistoricalStudyBody {
  title?: string;
  region?: string; // JSON-stringified string[] from multipart form data
  governorateIds?: string; // JSON-stringified string[]
  centerIds?: string; // JSON-stringified string[]
  targetSector?: string;
  studyDate?: string;
  author?: string;
  methodologyVersionLabel?: string;
}

// Multipart form fields arrive as plain strings — arrays are sent
// JSON-stringified. Malformed input is treated as an empty array rather
// than failing the whole upload over one cosmetic field.
function parseStringArray(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

@Controller('historical-studies')
export class HistoricalStudiesController {
  constructor(private readonly historicalStudies: HistoricalStudiesService) {}

  @Get()
  @RequirePermission('archiveSharingAudit', 'read')
  list(): Promise<HistoricalStudy[]> {
    return this.historicalStudies.list();
  }

  @Post()
  @RequirePermission('archiveSharingAudit', 'write')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_EVIDENCE_FILE_SIZE_BYTES } }))
  create(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: CreateHistoricalStudyBody,
  ): Promise<HistoricalStudy> {
    if (!file) {
      throw new BadRequestException({ error: { code: 'FILE_REQUIRED', message: 'A file is required.' } });
    }
    if (!body.title || !body.studyDate || !body.author || !body.methodologyVersionLabel) {
      throw new BadRequestException({
        error: { code: 'MISSING_FIELDS', message: 'Title, study date, author, and methodology version are required.' },
      });
    }
    return this.historicalStudies.create({
      title: body.title,
      region: parseStringArray(body.region),
      governorateIds: parseStringArray(body.governorateIds),
      centerIds: parseStringArray(body.centerIds),
      targetSector: body.targetSector || undefined,
      studyDate: body.studyDate,
      author: body.author,
      methodologyVersionLabel: body.methodologyVersionLabel,
      file: {
        originalName: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        buffer: file.buffer,
      },
    });
  }

  @Get(':id/file')
  @RequirePermission('archiveSharingAudit', 'read')
  async download(@Param('id', new UuidParamPipe()) id: string, @Res() res: Response): Promise<void> {
    const { row, buffer } = await this.historicalStudies.getFile(id);
    res.set({
      'Content-Type': row.fileType,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(row.fileName)}"`,
    });
    res.send(buffer);
  }
}
