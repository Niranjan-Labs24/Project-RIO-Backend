import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import { SaveSurveyDraftBody, SaveSurveyDraftDto, UpdateSurveyQuestionsBody, UpdateSurveyQuestionsDto } from './surveys.contract';
import { SurveysService } from './surveys.service';

@Controller()
export class SurveysController {
  constructor(private readonly service: SurveysService) {}

  @Get('needs/:needId/survey')
  @RequirePermission('surveyBuilder', 'read')
  getSurveyByNeedId(@Param('needId') needId: string) {
    return this.service.getSurveyByNeedId(needId);
  }

  @Post('needs/:needId/survey')
  @RequirePermission('surveyBuilder', 'write')
  createEmptySurvey(@Param('needId') needId: string) {
    return this.service.createEmptySurvey(needId);
  }

  @Post('needs/:needId/recommend-questions')
  @RequirePermission('surveyBuilder', 'write')
  recommendQuestions(@Param('needId') needId: string) {
    return this.service.recommendQuestions(needId);
  }

  @Patch('surveys/:id/questions')
  @RequirePermission('surveyBuilder', 'write')
  updateQuestions(
    @Param('id') id: string,
    @Body(new TypeBoxValidationPipe(UpdateSurveyQuestionsBody)) body: UpdateSurveyQuestionsDto,
  ) {
    return this.service.updateQuestions(id, body.questions);
  }

  @Post('surveys/:id/save-draft')
  @RequirePermission('surveyBuilder', 'write')
  saveDraft(
    @Param('id') id: string,
    @Body(new TypeBoxValidationPipe(SaveSurveyDraftBody)) body: SaveSurveyDraftDto,
  ) {
    return this.service.saveDraft(id, body.status);
  }

  @Get('surveys/public/:id')
  getPublicSurvey(@Param('id') id: string) {
    return this.service.getPublicSurvey(id);
  }

  @Post('surveys/public/:id/submit')
  submitSurvey(
    @Param('id') id: string,
    @Body() body: { answers: Record<string, string> },
  ) {
    return this.service.submitSurvey(id, body.answers);
  }

  @Get('surveys/:id/responses')
  @RequirePermission('surveyBuilder', 'read')
  getSurveyResponses(@Param('id') id: string) {
    return this.service.getSurveyResponses(id);
  }
}
