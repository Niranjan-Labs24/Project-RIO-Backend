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
//
// NGO Admin is the one exception: its methodologyQuestionBank grant was
// deliberately zeroed out (client-confirmed 2026-08-20 — Methodology
// Configuration governance belongs at System Admin level only), but NGO
// Admin still holds studySurvey:create and is a real path for creating a
// Study — which needs Study Type/Target Sector to populate its own form.
// Gating "read the picklist" behind the same flag as "govern Methodology
// Configuration" conflated two different concerns; found live when a
// freshly-approved org's NGO Admin hit an empty Study Type/Target Sector
// dropdown. Same fix DomainsController already uses for its own read/write
// split (see its `public` endpoint's comment) — these two list reads carry
// no @RequirePermission at all now (still requires a valid session via the
// global JwtAuthGuard, just no RBAC module check), while every write stays
// on methodologyQuestionBank:write, unchanged.
@Controller('study-config')
export class StudyConfigController {
  constructor(private readonly studyConfig: StudyConfigService) {}

  @Get('study-types')
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

  @Get('gap-types')
  @RequirePermission('methodologyQuestionBank', 'read')
  listGapTypes(): Promise<StudyConfigOption[]> {
    return this.studyConfig.listGapTypes();
  }

  @Post('gap-types')
  @RequirePermission('methodologyQuestionBank', 'write')
  createGapType(
    @Body(new TypeBoxValidationPipe(CreateStudyConfigOptionBody)) body: CreateStudyConfigOptionDto,
  ): Promise<StudyConfigOption> {
    return this.studyConfig.createGapType(body);
  }

  @Patch('gap-types/:id')
  @RequirePermission('methodologyQuestionBank', 'write')
  updateGapType(
    @Param('id', new UuidParamPipe()) id: string,
    @Body(new TypeBoxValidationPipe(UpdateStudyConfigOptionBody)) body: UpdateStudyConfigOptionDto,
  ): Promise<StudyConfigOption> {
    return this.studyConfig.updateGapType(id, body);
  }

  @Patch('gap-types/:id/activate')
  @RequirePermission('methodologyQuestionBank', 'write')
  activateGapType(@Param('id', new UuidParamPipe()) id: string): Promise<StudyConfigOption> {
    return this.studyConfig.setGapTypeActive(id, true);
  }

  @Patch('gap-types/:id/deactivate')
  @RequirePermission('methodologyQuestionBank', 'write')
  deactivateGapType(@Param('id', new UuidParamPipe()) id: string): Promise<StudyConfigOption> {
    return this.studyConfig.setGapTypeActive(id, false);
  }

  // RIO-FR-003 AC 6 — the closed vocabulary the theme extractor picks from.
  // Same methodologyQuestionBank gate as the option lists above: editing the
  // theme list changes what needs get filed under and therefore what the
  // recurrence factor counts, which is a methodology decision.
  @Get('need-themes')
  @RequirePermission('methodologyQuestionBank', 'read')
  listNeedThemes(): Promise<StudyConfigOption[]> {
    return this.studyConfig.listNeedThemes();
  }

  @Post('need-themes')
  @RequirePermission('methodologyQuestionBank', 'write')
  createNeedTheme(
    @Body(new TypeBoxValidationPipe(CreateStudyConfigOptionBody)) body: CreateStudyConfigOptionDto,
  ): Promise<StudyConfigOption> {
    return this.studyConfig.createNeedTheme(body);
  }

  @Patch('need-themes/:id')
  @RequirePermission('methodologyQuestionBank', 'write')
  updateNeedTheme(
    @Param('id', new UuidParamPipe()) id: string,
    @Body(new TypeBoxValidationPipe(UpdateStudyConfigOptionBody)) body: UpdateStudyConfigOptionDto,
  ): Promise<StudyConfigOption> {
    return this.studyConfig.updateNeedTheme(id, body);
  }

  @Patch('need-themes/:id/activate')
  @RequirePermission('methodologyQuestionBank', 'write')
  activateNeedTheme(@Param('id', new UuidParamPipe()) id: string): Promise<StudyConfigOption> {
    return this.studyConfig.setNeedThemeActive(id, true);
  }

  @Patch('need-themes/:id/deactivate')
  @RequirePermission('methodologyQuestionBank', 'write')
  deactivateNeedTheme(@Param('id', new UuidParamPipe()) id: string): Promise<StudyConfigOption> {
    return this.studyConfig.setNeedThemeActive(id, false);
  }
}
