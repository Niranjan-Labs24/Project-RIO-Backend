import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import { CreateSurveyLinkBody } from './public-surveys.contract';
import { PublicSurveysService } from './public-surveys.service';
import type { CreateSurveyLinkPayload, PublicSurveyLink } from './public-surveys.types';
import type { SurveyDefinition } from '../survey-definition/survey-definition.placeholder';

// Mounted under studies/:studyId/... as a separate controller (same
// precedent as AiDecisionsController) — Studies stays a Dev2-owned module
// this session doesn't touch directly; studySurvey permission is reused
// as-is since Research Officer already has full CRUD on it.
@Controller('studies/:studyId')
export class PublicSurveysController {
  constructor(private readonly surveys: PublicSurveysService) {}

  @Get('survey-definition')
  @RequirePermission('studySurvey', 'read')
  getDefinition(@Param('studyId') studyId: string): SurveyDefinition {
    return this.surveys.getDefinition(studyId);
  }

  @Get('survey-links')
  @RequirePermission('studySurvey', 'read')
  listLinks(@Param('studyId') studyId: string): Promise<PublicSurveyLink[]> {
    return this.surveys.listLinks(studyId);
  }

  @Post('survey-links')
  @RequirePermission('studySurvey', 'create')
  createLink(
    @Param('studyId') studyId: string,
    @Body(new TypeBoxValidationPipe(CreateSurveyLinkBody)) body: CreateSurveyLinkPayload,
  ): Promise<PublicSurveyLink> {
    return this.surveys.createLink(studyId, body ?? {});
  }

  @Patch('survey-links/:linkId/deactivate')
  @RequirePermission('studySurvey', 'write')
  deactivateLink(@Param('studyId') studyId: string, @Param('linkId') linkId: string): Promise<PublicSurveyLink> {
    return this.surveys.deactivateLink(studyId, linkId);
  }
}
