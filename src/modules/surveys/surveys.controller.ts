import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe';
import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { parseIntParam } from '../../common/http/query.util';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import {
  RejectSurveyBody,
  RejectSurveyDto,
  SetMethodologyVersionBody,
  SetMethodologyVersionDto,
  SubmitSurveyBody,
  SubmitSurveyDto,
  UpdateSurveyQuestionsBody,
  UpdateSurveyQuestionsDto,
} from './surveys.contract';
import { SurveysService } from './surveys.service';

@Controller()
export class SurveysController {
  constructor(private readonly service: SurveysService) {}

  @Get('surveys')
  @RequirePermission('surveyBuilder', 'read')
  listSurveys(
    @Query('organizationId') organizationId?: string,
    @Query('studyId') studyId?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.service.listSurveys({
      organizationId: organizationId || undefined,
      studyId: studyId || undefined,
      status: status || undefined,
      search: search || undefined,
      limit: parseIntParam(limit),
      offset: parseIntParam(offset),
    });
  }

  @Get('surveys/:id')
  @RequirePermission('surveyBuilder', 'read')
  getSurveyById(@Param('id') id: string) {
    return this.service.getSurveyDetailById(id);
  }

  @Get('needs/:needId/survey')
  @RequirePermission('surveyBuilder', 'read')
  getSurveyByNeedId(@Param('needId', new UuidParamPipe()) needId: string) {
    return this.service.getSurveyByNeedId(needId);
  }

  @Post('needs/:needId/survey')
  @RequirePermission('surveyBuilder', 'write')
  createEmptySurvey(@Param('needId', new UuidParamPipe()) needId: string) {
    return this.service.createEmptySurvey(needId);
  }

  @Post('needs/:needId/recommend-questions')
  @RequirePermission('surveyBuilder', 'write')
  recommendQuestions(@Param('needId', new UuidParamPipe()) needId: string) {
    return this.service.recommendQuestions(needId);
  }

  // Backs the Survey Builder's "Custom Questions" tab — custom questions
  // previously typed in from scratch on some OTHER survey, for this exact
  // Domain/Sub-domain, so they can be reused instead of retyped. Org-wide
  // (not scoped to :needId — a reusable question can have come from any
  // survey), which is why it lives at its own path instead of nested under
  // needs/:needId like the rest of this controller.
  @Get('custom-questions')
  @RequirePermission('surveyBuilder', 'read')
  listReusableCustomQuestions(
    @Query('domain') domain?: string,
    @Query('subDomain') subDomain?: string,
  ) {
    if (!domain || !subDomain) return [];
    return this.service.listReusableCustomQuestions(domain, subDomain);
  }

  @Patch('surveys/:id/questions')
  @RequirePermission('surveyBuilder', 'write')
  updateQuestions(
    @Param('id', new UuidParamPipe()) id: string,
    @Body(new TypeBoxValidationPipe(UpdateSurveyQuestionsBody)) body: UpdateSurveyQuestionsDto,
  ) {
    return this.service.updateQuestions(id, body.questions);
  }

  // Researcher-only, same editability window as updateQuestions — see
  // SurveysService#assertEditable.
  @Patch('surveys/:id/methodology-version')
  @RequirePermission('surveyBuilder', 'write')
  setMethodologyVersion(
    @Param('id', new UuidParamPipe()) id: string,
    @Body(new TypeBoxValidationPipe(SetMethodologyVersionBody)) body: SetMethodologyVersionDto,
  ) {
    return this.service.setMethodologyVersion(id, body.version);
  }

  // Researcher: hand the current draft (or a fixed-up rejected one) to the
  // Approver. Content itself is saved separately, via updateQuestions above
  // — this route only ever moves status.
  @Post('surveys/:id/submit')
  @RequirePermission('surveyBuilder', 'write')
  submitForApproval(@Param('id', new UuidParamPipe()) id: string) {
    return this.service.submitForApproval(id);
  }

  // Approver-only from here down — never a co-author, so no write/create
  // grant lets a role reach these; only `approve` does (see role-matrix.ts).
  @Post('surveys/:id/approve')
  @RequirePermission('surveyBuilder', 'approve')
  approveAndPublish(@Param('id', new UuidParamPipe()) id: string) {
    return this.service.approveAndPublish(id);
  }

  @Post('surveys/:id/reject')
  @RequirePermission('surveyBuilder', 'approve')
  rejectSurvey(
    @Param('id', new UuidParamPipe()) id: string,
    @Body(new TypeBoxValidationPipe(RejectSurveyBody)) body: RejectSurveyDto,
  ) {
    return this.service.rejectSurvey(id, body.comments);
  }

  @Get('surveys/public/:id')
  getPublicSurvey(@Param('id', new UuidParamPipe()) id: string) {
    return this.service.getPublicSurvey(id);
  }

  @Post('surveys/public/:id/submit')
  submitSurvey(
    @Param('id', new UuidParamPipe()) id: string,
    @Body(new TypeBoxValidationPipe(SubmitSurveyBody)) body: SubmitSurveyDto,
  ) {
    return this.service.submitSurvey(id, body.answers);
  }

  @Get('surveys/:id/responses')
  @RequirePermission('surveyBuilder', 'read')
  getSurveyResponses(@Param('id', new UuidParamPipe()) id: string) {
    return this.service.getSurveyResponses(id);
  }
}
