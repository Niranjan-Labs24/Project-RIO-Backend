import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { Public } from '../../auth/public.decorator';
import { CsrfExempt } from '../../common/guards/csrf.guard';
import { RequirePermission } from '../../common/guards/permission.guard';
import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import {
  CreateNcnpClassificationBody, UpdateNcnpClassificationBody,
  type CreateNcnpClassificationDto, type UpdateNcnpClassificationDto,
} from './ncnp-classification.contract';
import { NcnpClassificationService } from './ncnp-classification.service';
import type { NcnpClassificationItem } from './ncnp-classification.types';

// GEN-07 (UAT v1.4). The active list is open: the registration form is used
// before anyone can sign in (same posture as /domains/public — reference data
// only, nothing tenant-sensitive). Maintenance is System Admin only, through
// the same methodologyQuestionBank:write grant as the other configurable lists.
@Controller('ncnp-classifications')
export class NcnpClassificationController {
  constructor(private readonly classifications: NcnpClassificationService) {}

  @Get('public')
  @CsrfExempt()
  @Public()
  listActive(): Promise<NcnpClassificationItem[]> {
    return this.classifications.listActive();
  }

  @Get()
  @RequirePermission('methodologyQuestionBank', 'read')
  listAll(): Promise<NcnpClassificationItem[]> {
    return this.classifications.listAll();
  }

  @Post()
  @RequirePermission('methodologyQuestionBank', 'write')
  create(
    @Body(new TypeBoxValidationPipe(CreateNcnpClassificationBody)) body: CreateNcnpClassificationDto,
  ): Promise<NcnpClassificationItem> {
    return this.classifications.create(body);
  }

  @Patch(':id')
  @RequirePermission('methodologyQuestionBank', 'write')
  update(
    @Param('id', new UuidParamPipe()) id: string,
    @Body(new TypeBoxValidationPipe(UpdateNcnpClassificationBody)) body: UpdateNcnpClassificationDto,
  ): Promise<NcnpClassificationItem> {
    return this.classifications.update(id, body);
  }
}
