import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe';
import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import { CreateStudyConfigOptionBody, UpdateStudyConfigOptionBody } from './study-config.contract';
import { StudyConfigService } from './study-config.service';
import type {
  CreateStudyConfigOptionDto, UpdateStudyConfigOptionDto,
} from './study-config.contract';
import type { StudyConfigOption } from './study-config.types';

// Same RBAC shape as DomainsController: reads open to nearly every role
// (methodologyQuestionBank RO is granted broadly), writes restricted to
// whoever holds methodologyQuestionBank:write — System Admin only, per
// Sprint 2 clarification Q31 ("only NCNP Admin may initiate methodology
// configuration changes").
@Controller('study-config')
export class StudyConfigController {
  constructor(private readonly studyConfig: StudyConfigService) {}

  @Get('study-types')
  @RequirePermission('methodologyQuestionBank', 'read')
  listStudyTypes(): Promise<StudyConfigOption[]> {
    return this.studyConfig.listStudyTypes();
  }

  @Post('study-types')
  @RequirePermission('methodologyQuestionBank', 'write')
  createStudyType(
    @Body(new TypeBoxValidationPipe(CreateStudyConfigOptionBody)) body: CreateStudyConfigOptionDto,
  ): Promise<StudyConfigOption> {
    return this.studyConfig.createStudyType(body);
  }

  @Patch('study-types/:id')
  @RequirePermission('methodologyQuestionBank', 'write')
  updateStudyType(
    @Param('id', new UuidParamPipe()) id: string,
    @Body(new TypeBoxValidationPipe(UpdateStudyConfigOptionBody)) body: UpdateStudyConfigOptionDto,
  ): Promise<StudyConfigOption> {
    return this.studyConfig.updateStudyType(id, body);
  }

  @Patch('study-types/:id/activate')
  @RequirePermission('methodologyQuestionBank', 'write')
  activateStudyType(@Param('id', new UuidParamPipe()) id: string): Promise<StudyConfigOption> {
    return this.studyConfig.setStudyTypeActive(id, true);
  }

  @Patch('study-types/:id/deactivate')
  @RequirePermission('methodologyQuestionBank', 'write')
  deactivateStudyType(@Param('id', new UuidParamPipe()) id: string): Promise<StudyConfigOption> {
    return this.studyConfig.setStudyTypeActive(id, false);
  }

  @Get('target-sectors')
  @RequirePermission('methodologyQuestionBank', 'read')
  listTargetSectors(): Promise<StudyConfigOption[]> {
    return this.studyConfig.listTargetSectors();
  }

  @Post('target-sectors')
  @RequirePermission('methodologyQuestionBank', 'write')
  createTargetSector(
    @Body(new TypeBoxValidationPipe(CreateStudyConfigOptionBody)) body: CreateStudyConfigOptionDto,
  ): Promise<StudyConfigOption> {
    return this.studyConfig.createTargetSector(body);
  }

  @Patch('target-sectors/:id')
  @RequirePermission('methodologyQuestionBank', 'write')
  updateTargetSector(
    @Param('id', new UuidParamPipe()) id: string,
    @Body(new TypeBoxValidationPipe(UpdateStudyConfigOptionBody)) body: UpdateStudyConfigOptionDto,
  ): Promise<StudyConfigOption> {
    return this.studyConfig.updateTargetSector(id, body);
  }

  @Patch('target-sectors/:id/activate')
  @RequirePermission('methodologyQuestionBank', 'write')
  activateTargetSector(@Param('id', new UuidParamPipe()) id: string): Promise<StudyConfigOption> {
    return this.studyConfig.setTargetSectorActive(id, true);
  }

  @Patch('target-sectors/:id/deactivate')
  @RequirePermission('methodologyQuestionBank', 'write')
  deactivateTargetSector(@Param('id', new UuidParamPipe()) id: string): Promise<StudyConfigOption> {
    return this.studyConfig.setTargetSectorActive(id, false);
  }

  @Get('decision-types')
  @RequirePermission('methodologyQuestionBank', 'read')
  listDecisionTypes(): Promise<StudyConfigOption[]> {
    return this.studyConfig.listDecisionTypes();
  }

  @Post('decision-types')
  @RequirePermission('methodologyQuestionBank', 'write')
  createDecisionType(
    @Body(new TypeBoxValidationPipe(CreateStudyConfigOptionBody)) body: CreateStudyConfigOptionDto,
  ): Promise<StudyConfigOption> {
    return this.studyConfig.createDecisionType(body);
  }

  @Patch('decision-types/:id')
  @RequirePermission('methodologyQuestionBank', 'write')
  updateDecisionType(
    @Param('id', new UuidParamPipe()) id: string,
    @Body(new TypeBoxValidationPipe(UpdateStudyConfigOptionBody)) body: UpdateStudyConfigOptionDto,
  ): Promise<StudyConfigOption> {
    return this.studyConfig.updateDecisionType(id, body);
  }

  @Patch('decision-types/:id/activate')
  @RequirePermission('methodologyQuestionBank', 'write')
  activateDecisionType(@Param('id', new UuidParamPipe()) id: string): Promise<StudyConfigOption> {
    return this.studyConfig.setDecisionTypeActive(id, true);
  }

  @Patch('decision-types/:id/deactivate')
  @RequirePermission('methodologyQuestionBank', 'write')
  deactivateDecisionType(@Param('id', new UuidParamPipe()) id: string): Promise<StudyConfigOption> {
    return this.studyConfig.setDecisionTypeActive(id, false);
  }
}
