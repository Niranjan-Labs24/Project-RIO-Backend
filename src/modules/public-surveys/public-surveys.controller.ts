import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import { CreateSurveyLinkBody } from './public-surveys.contract';
import { PublicSurveysService } from './public-surveys.service';
import type { CreateSurveyLinkPayload, PublicSurveyLink } from './public-surveys.types';

// Mounted under needs/:needId/... — each Need runs its own independent
// survey/link set now (see the Need-lifecycle migration); studySurvey
// permission is reused as-is since Research Officer already has full CRUD
// on it.
@Controller('needs/:needId')
export class PublicSurveysController {
  constructor(private readonly surveys: PublicSurveysService) {}

  @Get('survey-links')
  @RequirePermission('studySurvey', 'read')
  listLinks(@Param('needId') needId: string): Promise<PublicSurveyLink[]> {
    return this.surveys.listLinks(needId);
  }

  @Post('survey-links')
  @RequirePermission('studySurvey', 'create')
  createLink(
    @Param('needId') needId: string,
    @Body(new TypeBoxValidationPipe(CreateSurveyLinkBody)) body: CreateSurveyLinkPayload,
  ): Promise<PublicSurveyLink> {
    return this.surveys.createLink(needId, body ?? {});
  }

  @Patch('survey-links/:linkId/deactivate')
  @RequirePermission('studySurvey', 'write')
  deactivateLink(@Param('needId') needId: string, @Param('linkId') linkId: string): Promise<PublicSurveyLink> {
    return this.surveys.deactivateLink(needId, linkId);
  }
}
