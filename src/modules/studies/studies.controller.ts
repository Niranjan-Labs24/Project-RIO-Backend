import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import { parseIntParam } from '../../common/http/query.util';
import { CreateStudyBody, UpdateStudyBody } from './studies.contract';
import { StudiesService } from './studies.service';
import type {
  CreateStudyPayload,
  Study,
  StudyDetail,
  StudyListResult,
  StudyStatus,
  UpdateStudyPayload,
} from './studies.types';

const STUDY_STATUSES: readonly StudyStatus[] = [
  'draft', 'need_captured', 'evidence_submitted', 'ai_classified', 'human_reviewed',
];

function parseStatus(value?: string): StudyStatus | undefined {
  return STUDY_STATUSES.includes(value as StudyStatus) ? (value as StudyStatus) : undefined;
}

@Controller('studies')
export class StudiesController {
  constructor(private readonly studies: StudiesService) {}

  @Post()
  @RequirePermission('studySurvey', 'create')
  create(@Body(new TypeBoxValidationPipe(CreateStudyBody)) body: CreateStudyPayload): Promise<Study> {
    return this.studies.create(body);
  }

  @Get()
  @RequirePermission('studySurvey', 'read')
  list(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('status') status?: string,
    @Query('village') village?: string,
    @Query('search') search?: string,
  ): Promise<StudyListResult> {
    return this.studies.list({
      limit: parseIntParam(limit),
      offset: parseIntParam(offset),
      status: parseStatus(status),
      village: village || undefined,
      search: search || undefined,
    });
  }

  @Get(':id')
  @RequirePermission('studySurvey', 'read')
  getById(@Param('id') id: string): Promise<StudyDetail> {
    return this.studies.getById(id);
  }

  @Patch(':id')
  @RequirePermission('studySurvey', 'write')
  update(
    @Param('id') id: string,
    @Body(new TypeBoxValidationPipe(UpdateStudyBody)) body: UpdateStudyPayload,
  ): Promise<Study> {
    return this.studies.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('studySurvey', 'write')
  remove(@Param('id') id: string): Promise<void> {
    return this.studies.remove(id);
  }
}
