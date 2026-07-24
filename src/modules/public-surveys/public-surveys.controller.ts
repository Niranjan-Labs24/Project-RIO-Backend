import { Body, Controller, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RequirePermission } from '../../common/guards/permission.guard';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import { parseIntParam } from '../../common/http/query.util';
import { CreateSurveyLinkBody } from './public-surveys.contract';
import { PublicSurveysService } from './public-surveys.service';
import type {
  CreateSurveyLinkPayload,
  PublicSurveyLink,
  QuestionResponseListResult,
  SurveyResponseDetail,
  SurveyResponseListResult,
} from './public-surveys.types';

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

  @Get('survey-responses')
  @RequirePermission('studySurvey', 'read')
  listResponses(
    @Param('needId') needId: string,
    @Query('surveyLinkId') surveyLinkId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('search') search?: string,
  ): Promise<SurveyResponseListResult> {
    return this.surveys.listResponses(needId, {
      surveyLinkId: surveyLinkId || undefined,
      limit: parseIntParam(limit),
      offset: parseIntParam(offset),
      search: search || undefined,
    });
  }

  // Same rows as GET survey-responses, with each one's answers already
  // joined in — see PublicSurveysService#listResponsesWithAnswers.
  @Get('survey-responses-full')
  @RequirePermission('studySurvey', 'read')
  listResponsesWithAnswers(
    @Param('needId') needId: string,
    @Query('surveyLinkId') surveyLinkId?: string,
  ): Promise<SurveyResponseDetail[]> {
    return this.surveys.listResponsesWithAnswers(needId, surveyLinkId || undefined);
  }

  // `@Res()` without `passthrough` — bypasses Nest's default response
  // pipeline entirely (which would otherwise JSON-serialize a returned
  // Buffer into `{"type":"Buffer","data":[...]}` instead of sending it
  // as-is), same pattern as ReportsController#export.
  @Get('survey-responses/export')
  @RequirePermission('studySurvey', 'export')
  async exportResponses(
    @Res() res: Response,
    @Param('needId') needId: string,
    @Query('format') format: 'csv' | 'excel' = 'csv',
    @Query('surveyLinkId') surveyLinkId?: string,
  ): Promise<void> {
    const date = new Date().toISOString().slice(0, 10);
    if (format === 'excel') {
      const body = await this.surveys.exportResponsesExcel(needId, surveyLinkId || undefined);
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="survey-responses-${date}.xlsx"`,
        'Content-Length': String(body.length),
      });
      res.end(body);
      return;
    }
    const csv = await this.surveys.exportResponsesCsv(needId, surveyLinkId || undefined);
    res.set({
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="survey-responses-${date}.csv"`,
    });
    res.end(csv);
  }

  // One question's answers across every response — backs the dedicated
  // per-question responses page. Distinct segment count from
  // `survey-responses/:responseId` below, so route order doesn't matter,
  // but kept above it anyway for readability.
  @Get('survey-responses/questions/:questionId')
  @RequirePermission('studySurvey', 'read')
  listQuestionResponses(
    @Param('needId') needId: string,
    @Param('questionId') questionId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('search') search?: string,
  ): Promise<QuestionResponseListResult> {
    return this.surveys.listQuestionResponses(needId, questionId, {
      limit: parseIntParam(limit),
      offset: parseIntParam(offset),
      search: search || undefined,
    });
  }

  // More specific than :linkId/deactivate above but less specific than
  // `export` — must stay below `export` so Nest doesn't match "export" as a
  // :responseId param first.
  @Get('survey-responses/:responseId')
  @RequirePermission('studySurvey', 'read')
  getResponse(
    @Param('needId') needId: string,
    @Param('responseId') responseId: string,
  ): Promise<SurveyResponseDetail> {
    return this.surveys.getResponse(needId, responseId);
  }
}
