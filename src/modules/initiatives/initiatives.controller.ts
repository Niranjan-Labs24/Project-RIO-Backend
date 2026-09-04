import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe';
import { RequirePermission } from '../../common/guards/permission.guard';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import { CreateInitiativeBody, UpdateInitiativeBody } from './initiatives.contract';
import type { CreateInitiativeDto, UpdateInitiativeDto } from './initiatives.contract';
import { InitiativesService } from './initiatives.service';
import type { Initiative, NeedAnalyticalStatusEvent } from './initiatives.types';

@Controller('initiatives')
export class InitiativesController {
  constructor(private readonly initiatives: InitiativesService) {}

  @Get()
  @RequirePermission('initiatives', 'read')
  list(): Promise<Initiative[]> {
    return this.initiatives.list();
  }

  @Get(':id')
  @RequirePermission('initiatives', 'read')
  get(@Param('id', new UuidParamPipe()) id: string): Promise<Initiative> {
    return this.initiatives.get(id);
  }

  @Post()
  @RequirePermission('initiatives', 'create')
  create(
    @Body(new TypeBoxValidationPipe(CreateInitiativeBody)) body: CreateInitiativeDto,
  ): Promise<Initiative> {
    return this.initiatives.create(body);
  }

  @Patch(':id')
  @RequirePermission('initiatives', 'write')
  update(
    @Param('id', new UuidParamPipe()) id: string,
    @Body(new TypeBoxValidationPipe(UpdateInitiativeBody)) body: UpdateInitiativeDto,
  ): Promise<Initiative> {
    return this.initiatives.update(id, body);
  }
}

// Nested under Needs — linking/unlinking and history are Need-scoped
// actions, mirroring NeedDecisionsController's own :needId-nested shape.
@Controller('needs/:needId/initiatives')
export class NeedInitiativesController {
  constructor(private readonly initiatives: InitiativesService) {}

  @Get()
  @RequirePermission('initiatives', 'read')
  list(@Param('needId', new UuidParamPipe()) needId: string): Promise<Initiative[]> {
    return this.initiatives.listLinkedInitiatives(needId);
  }

  @Post(':initiativeId')
  @RequirePermission('initiatives', 'write')
  async link(
    @Param('needId', new UuidParamPipe()) needId: string,
    @Param('initiativeId', new UuidParamPipe()) initiativeId: string,
  ): Promise<{ linked: true }> {
    await this.initiatives.linkNeed(needId, initiativeId);
    return { linked: true };
  }

  @Patch(':initiativeId/unlink')
  @RequirePermission('initiatives', 'write')
  async unlink(
    @Param('needId', new UuidParamPipe()) needId: string,
    @Param('initiativeId', new UuidParamPipe()) initiativeId: string,
  ): Promise<{ linked: false }> {
    await this.initiatives.unlinkNeed(needId, initiativeId);
    return { linked: false };
  }

  @Get('status-history')
  @RequirePermission('initiatives', 'read')
  statusHistory(
    @Param('needId', new UuidParamPipe()) needId: string,
  ): Promise<NeedAnalyticalStatusEvent[]> {
    return this.initiatives.listAnalyticalStatusHistory(needId);
  }
}
