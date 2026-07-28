import { Controller, Get, Post, Patch, Delete, Param, Body, Query } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { ReportSummaryService, SummaryScopeType, ScopeFilters } from './report-summary.service';

@Controller()
export class PrioritySummaryController {
  constructor(private readonly summaryService: ReportSummaryService) {}

  @Post('studies/:studyId/surveys/:surveyId/priority-summary/preview-snapshot')
  @RequirePermission('priorityScoring', 'read')
  async previewSnapshot(
    @Param('studyId') studyId: string,
    @Param('surveyId') surveyId: string,
    @Body() body: { scope?: SummaryScopeType; scopeFilters?: ScopeFilters },
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
    @Param('studyId') studyId: string,
    @Param('surveyId') surveyId: string,
    @Body() body: { scope?: SummaryScopeType; scopeFilters?: ScopeFilters },
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
    @Param('studyId') studyId: string,
    @Param('surveyId') surveyId: string,
    @Query('scope') scope?: SummaryScopeType,
    @Query('villageId') villageId?: string,
  ) {
    return this.summaryService.getSummary(studyId, surveyId, scope || 'VILLAGE', villageId || '');
  }

  @Patch('priority-summaries/:summaryId')
  @RequirePermission('priorityScoring', 'write')
  async saveDraftEdits(
    @Param('summaryId') summaryId: string,
    @Body() body: { editedOutputJson: Record<string, unknown> },
  ) {
    return this.summaryService.saveDraftEdits(summaryId, body.editedOutputJson);
  }

  @Post('priority-summaries/:summaryId/save')
  @RequirePermission('priorityScoring', 'write')
  async saveSummary(
    @Param('summaryId') summaryId: string,
    @Body() body?: { editedOutputJson?: Record<string, unknown> },
  ) {
    return this.summaryService.saveSummary(summaryId, body?.editedOutputJson);
  }

  @Get('studies/:studyId/surveys/:surveyId/priority-summaries/saved')
  @RequirePermission('priorityScoring', 'read')
  async getSavedSummariesList(
    @Param('studyId') studyId: string,
    @Param('surveyId') surveyId: string,
  ) {
    return this.summaryService.getSavedSummariesList(studyId, surveyId);
  }

  @Delete('priority-summaries/:summaryId')
  @RequirePermission('priorityScoring', 'write')
  async deleteSavedSummary(@Param('summaryId') summaryId: string) {
    return this.summaryService.deleteSavedSummary(summaryId);
  }

  @Post('priority-summaries/:summaryId/confirm')
  @RequirePermission('priorityScoring', 'approve')
  async confirmSummary(@Param('summaryId') summaryId: string) {
    return this.summaryService.confirmSummary(summaryId);
  }

  @Get('studies/:studyId/surveys/:surveyId/priority-summary/history')
  @RequirePermission('priorityScoring', 'read')
  async getSummaryHistory(
    @Param('studyId') studyId: string,
    @Param('surveyId') surveyId: string,
    @Query('scope') scope?: SummaryScopeType,
  ) {
    return this.summaryService.getSummaryHistory(studyId, surveyId, scope || 'VILLAGE');
  }

  @Patch('evidence/:evidenceId/toggle-inclusion')
  @RequirePermission('studySurvey', 'write')
  async toggleEvidenceInclusion(
    @Param('evidenceId') evidenceId: string,
    @Body() body: { isIncludedInReport: boolean },
  ) {
    return this.summaryService.toggleEvidenceInclusion(evidenceId, body.isIncludedInReport);
  }

  @Post('priority-summaries/:summaryId/save-report')
  @RequirePermission('reportsDashboards', 'create')
  async saveReportFromSummary(@Param('summaryId') summaryId: string) {
    return this.summaryService.saveReportFromSummary(summaryId);
  }
}
