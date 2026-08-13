import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe';
import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { parseIntParam } from '../../common/http/query.util';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import {
  ApproveSurveyBody,
  ApproveSurveyDto,
  RejectSurveyBody,
  RejectSurveyDto,
  SetMethodologyVersionBody,
  SetMethodologyVersionDto,
  SetSampleDescriptionBody,
  SetSampleDescriptionDto,
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

  // RIO-FR-011: the "currently live" survey for the Need, not "latest
  // version" — Response Summary and other read-only screens must resolve
  // against this, not getSurveyByNeedId, or they silently flip to an
  // unpublished draft the moment one is created.
  @Get('needs/:needId/survey/published')
  @RequirePermission('studySurvey', 'read')
  getPublishedSurveyByNeedId(@Param('needId', new UuidParamPipe()) needId: string) {
    return this.service.getPublishedSurveyForOrgByNeedId(needId);
  }

  @Get('needs/:needId/survey/versions')
  @RequirePermission('studySurvey', 'read')
  listSurveyVersions(@Param('needId', new UuidParamPipe()) needId: string) {
    return this.service.listSurveyVersionsByNeedId(needId);
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
  // needs/:needId like the rest of this controller. Both query params
  // omitted means allDomainsSelected (AI couldn't classify) — every
  // reusable custom question is in scope then, same convention as
  // getQuestions([]) for the Question Bank tab. A partial pair (only one of
  // the two provided) is treated the same as neither — there's no such
  // thing as "match on domain alone" for this feature.
  @Get('custom-questions')
  @RequirePermission('surveyBuilder', 'read')
  listReusableCustomQuestions(
    @Query('domain') domain?: string,
    @Query('subDomain') subDomain?: string,
  ) {
    if (domain && subDomain) return this.service.listReusableCustomQuestions(domain, subDomain);
    if (!domain && !subDomain) return this.service.listReusableCustomQuestions();
    return [];
  }

  @Patch('surveys/:id/questions')
  @RequirePermission('surveyBuilder', 'write')
  updateQuestions(
    @Param('id', new UuidParamPipe()) id: string,
    @Body(new TypeBoxValidationPipe(UpdateSurveyQuestionsBody)) body: UpdateSurveyQuestionsDto,
  ) {
    return this.service.updateQuestions(id, body.questions, body.removalReasons ?? {});
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

  // Researcher-only, same editability window as setMethodologyVersion — a
  // Survey Design step (Target Group / Expected Sample Size / Selection
  // Approach / Geographic Coverage), shown read-only to the Approver during
  // review via the same GET responses this controller already returns.
  @Patch('surveys/:id/sample-description')
  @RequirePermission('surveyBuilder', 'write')
  setSampleDescription(
    @Param('id', new UuidParamPipe()) id: string,
    @Body(new TypeBoxValidationPipe(SetSampleDescriptionBody)) body: SetSampleDescriptionDto,
  ) {
    return this.service.setSampleDescription(
      id,
      body.targetGroup,
      body.expectedSampleSize,
      body.selectionApproach,
      body.geographicCoverage,
    );
  }

  // RIO-FR-011 (client-confirmed): the only way to change a PUBLISHED
  // survey — creates a new DRAFT version (copying the published one's
  // questions/methodology/sample-description as a starting point) rather
  // than editing in place.
  //
  // Bug fix (Aug 13): this used to be surveyBuilder:write, which Human
  // Reviewer holds too (restored the same day, for a completely unrelated
  // reason — curating questions mid-review). Starting a fresh post-publish
  // edit cycle isn't the Reviewer's job; `create` is the precise gate —
  // every role that should reach this (Researcher, Field Researcher, NGO
  // Admin, System Admin) holds it, and Human Reviewer, uniquely, doesn't
  // (read/write/approve only — see role-matrix.ts).
  @Post('surveys/:id/new-version')
  @RequirePermission('surveyBuilder', 'create')
  createNewVersion(@Param('id', new UuidParamPipe()) id: string) {
    return this.service.createNewVersion(id);
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
  approveSurvey(
    @Param('id', new UuidParamPipe()) id: string,
    @Body(new TypeBoxValidationPipe(ApproveSurveyBody)) body: ApproveSurveyDto,
  ) {
    return this.service.approveSurvey(id, body.comments);
  }

  @Post('surveys/:id/reject')
  @RequirePermission('surveyBuilder', 'approve')
  rejectSurvey(
    @Param('id', new UuidParamPipe()) id: string,
    @Body(new TypeBoxValidationPipe(RejectSurveyBody)) body: RejectSurveyDto,
  ) {
    return this.service.rejectSurvey(id, body.reasonCode, body.comments);
  }

  // Researcher (or anyone with surveyBuilder:create): the actual go-live
  // step once the Approver has already approved. Client-confirmed (Aug 13
  // call) — approval no longer auto-publishes, this is now a separate,
  // deliberate action.
  //
  // Bug fix (Aug 13, same day): originally gated on `write`, which Human
  // Reviewer also holds (for curating questions mid-review — unrelated to
  // publishing). `create` is the correct gate — see createNewVersion's
  // comment just above for the exact same reasoning; Human Reviewer is the
  // one role that holds write+approve but not create on this module.
  @Post('surveys/:id/publish')
  @RequirePermission('surveyBuilder', 'create')
  publishSurvey(@Param('id', new UuidParamPipe()) id: string) {
    return this.service.publishSurvey(id);
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
