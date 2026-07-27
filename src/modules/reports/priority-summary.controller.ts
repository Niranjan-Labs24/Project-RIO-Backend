import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe';
import { Controller, Get, Post, Patch, Delete, Param, Body, Query } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import {
  SaveDraftEditsBody,
  SaveDraftEditsDto,
  SaveSummaryBody,
  SaveSummaryDto,
  SummaryScopeBody,
  SummaryScopeDto,
  ToggleEvidenceInclusionBody,
  ToggleEvidenceInclusionDto,
} from './priority-summary.contract';
import { ReportSummaryService, SummaryScopeType } from './report-summary.service';

@Controller()
export class PrioritySummaryController {
  constructor(private readonly summaryService: ReportSummaryService) {}

  @Post('studies/:studyId/surveys/:surveyId/priority-summary/preview-snapshot')
  @RequirePermission('priorityScoring', 'read')
  async previewSnapshot(
    @Param('studyId', new UuidParamPipe()) studyId: string,
    @Param('surveyId', new UuidParamPipe()) surveyId: string,
    @Body(new TypeBoxValidationPipe(SummaryScopeBody)) body: SummaryScopeDto,
  ) {
    return this.summaryService.previewSnapshot(
      studyId,
      surveyId,
      body.scope || 'VILLAGE',
      body.scopeFilters || {},
    );
  }

  @Post('studies/:studyId/surveys/:surveyId/priority-summary/generate')
  @RequirePermission('priorityScoring', 'create')
  async generateSummary(
    @Param('studyId', new UuidParamPipe()) studyId: string,
    @Param('surveyId', new UuidParamPipe()) surveyId: string,
    @Body(new TypeBoxValidationPipe(SummaryScopeBody)) body: SummaryScopeDto,
  ) {
    return this.summaryService.generatePrioritySummary(
      studyId,
      surveyId,
      body.scope || 'VILLAGE',
      body.scopeFilters || {},
    );
  }

  @Get('studies/:studyId/surveys/:surveyId/priority-summary')
  @RequirePermission('priorityScoring', 'read')
  async getSummary(
    @Param('studyId', new UuidParamPipe()) studyId: string,
    @Param('surveyId', new UuidParamPipe()) surveyId: string,
    @Query('scope') scope?: SummaryScopeType,
    @Query('villageId') villageId?: string,
  ) {
    return this.summaryService.getSummary(studyId, surveyId, scope || 'VILLAGE', villageId || '');
  }

  @Patch('priority-summaries/:summaryId')
  @RequirePermission('priorityScoring', 'write')
  async saveDraftEdits(
    @Param('summaryId', new UuidParamPipe()) summaryId: string,
    @Body(new TypeBoxValidationPipe(SaveDraftEditsBody)) body: SaveDraftEditsDto,
  ) {
    return this.summaryService.saveDraftEdits(summaryId, body.editedOutputJson);
  }

  @Post('priority-summaries/:summaryId/save')
  @RequirePermission('priorityScoring', 'write')
  async saveSummary(
    @Param('summaryId', new UuidParamPipe()) summaryId: string,
    @Body(new TypeBoxValidationPipe(SaveSummaryBody)) body: SaveSummaryDto,
  ) {
    return this.summaryService.saveSummary(summaryId, body.editedOutputJson);
  }

  @Get('studies/:studyId/surveys/:surveyId/priority-summaries/saved')
  @RequirePermission('priorityScoring', 'read')
  async getSavedSummariesList(
    @Param('studyId', new UuidParamPipe()) studyId: string,
    @Param('surveyId', new UuidParamPipe()) surveyId: string,
  ) {
    return this.summaryService.getSavedSummariesList(studyId, surveyId);
  }

  @Delete('priority-summaries/:summaryId')
  @RequirePermission('priorityScoring', 'write')
  async deleteSavedSummary(@Param('summaryId', new UuidParamPipe()) summaryId: string) {
    return this.summaryService.deleteSavedSummary(summaryId);
  }

  @Post('priority-summaries/:summaryId/confirm')
  @RequirePermission('priorityScoring', 'approve')
  async confirmSummary(@Param('summaryId', new UuidParamPipe()) summaryId: string) {
    return this.summaryService.confirmSummary(summaryId);
  }

  @Get('studies/:studyId/surveys/:surveyId/priority-summary/history')
  @RequirePermission('priorityScoring', 'read')
  async getSummaryHistory(
    @Param('studyId', new UuidParamPipe()) studyId: string,
    @Param('surveyId', new UuidParamPipe()) surveyId: string,
    @Query('scope') scope?: SummaryScopeType,
  ) {
    return this.summaryService.getSummaryHistory(studyId, surveyId, scope || 'VILLAGE');
  }

  @Patch('evidence/:evidenceId/toggle-inclusion')
  @RequirePermission('studySurvey', 'write')
  async toggleEvidenceInclusion(
    @Param('evidenceId', new UuidParamPipe()) evidenceId: string,
    @Body(new TypeBoxValidationPipe(ToggleEvidenceInclusionBody)) body: ToggleEvidenceInclusionDto,
  ) {
    return this.summaryService.toggleEvidenceInclusion(evidenceId, body.isIncludedInReport);
  }

  @Post('priority-summaries/:summaryId/save-report')
  @RequirePermission('reportsDashboards', 'create')
  async saveReportFromSummary(@Param('summaryId', new UuidParamPipe()) summaryId: string) {
    return this.summaryService.saveReportFromSummary(summaryId);
  }
}
