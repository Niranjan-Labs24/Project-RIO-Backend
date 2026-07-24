import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import {
  RejectSurveyBody,
  RejectSurveyDto,
  SetMethodologyVersionBody,
  SetMethodologyVersionDto,
  UpdateSurveyQuestionsBody,
  UpdateSurveyQuestionsDto,
} from './surveys.contract';
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

  // Researcher-only, same editability window as updateQuestions — see
  // SurveysService#assertEditable.
  @Patch('surveys/:id/methodology-version')
  @RequirePermission('surveyBuilder', 'write')
  setMethodologyVersion(
    @Param('id') id: string,
    @Body(new TypeBoxValidationPipe(SetMethodologyVersionBody)) body: SetMethodologyVersionDto,
  ) {
    return this.service.setMethodologyVersion(id, body.version);
  }

  // Researcher: hand the current draft (or a fixed-up rejected one) to the
  // Approver. Content itself is saved separately, via updateQuestions above
  // — this route only ever moves status.
  @Post('surveys/:id/submit')
  @RequirePermission('surveyBuilder', 'write')
  submitForApproval(@Param('id') id: string) {
    return this.service.submitForApproval(id);
  }

  // Approver-only from here down — never a co-author, so no write/create
  // grant lets a role reach these; only `approve` does (see role-matrix.ts).
  @Post('surveys/:id/approve')
  @RequirePermission('surveyBuilder', 'approve')
  approveAndPublish(@Param('id') id: string) {
    return this.service.approveAndPublish(id);
  }

  @Post('surveys/:id/reject')
  @RequirePermission('surveyBuilder', 'approve')
  rejectSurvey(
    @Param('id') id: string,
    @Body(new TypeBoxValidationPipe(RejectSurveyBody)) body: RejectSurveyDto,
  ) {
    return this.service.rejectSurvey(id, body.comments);
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
