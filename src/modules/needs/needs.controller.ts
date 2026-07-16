import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import { CreateNeedBody, UpdateNeedBody } from './needs.contract';
import { NeedsService } from './needs.service';
import type { CreateNeedPayload, Need, UpdateNeedPayload } from './needs.types';

@Controller('studies/:studyId/need')
export class NeedsController {
  constructor(private readonly needs: NeedsService) {}

  @Post()
  @RequirePermission('dataCollection', 'create')
  create(
    @Param('studyId') studyId: string,
    @Body(new TypeBoxValidationPipe(CreateNeedBody)) body: CreateNeedPayload,
  ): Promise<Need> {
    return this.needs.create(studyId, body);
  }

  @Get()
  @RequirePermission('dataCollection', 'read')
  getByStudyId(@Param('studyId') studyId: string): Promise<Need> {
    return this.needs.getByStudyId(studyId);
  }

  @Patch()
  @RequirePermission('dataCollection', 'write')
  update(
    @Param('studyId') studyId: string,
    @Body(new TypeBoxValidationPipe(UpdateNeedBody)) body: UpdateNeedPayload,
  ): Promise<Need> {
    return this.needs.update(studyId, body ?? {});
  }
}
