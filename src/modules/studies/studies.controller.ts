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
  UpdateStudyPayload,
} from './studies.types';

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
    @Query('village') village?: string,
    @Query('search') search?: string,
  ): Promise<StudyListResult> {
    return this.studies.list({
      limit: parseIntParam(limit),
      offset: parseIntParam(offset),
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
