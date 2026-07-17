import { Controller, Get, Query } from '@nestjs/common';
import { QuestionsService } from './questions.service';
import { RequirePermission } from '../../common/guards/permission.guard';

@Controller('question-bank')
export class QuestionsController {
  constructor(private readonly service: QuestionsService) {}

  @Get('domain-options')
  @RequirePermission('studySurvey', 'read')
  getDomainOptions() {
    return this.service.getDomainOptions();
  }

  @Get('questions')
  @RequirePermission('studySurvey', 'read')
  getQuestions(
    @Query('domain') domain?: string,
    @Query('subDomain') subDomain?: string,
  ) {
    return this.service.getQuestions(domain || '', subDomain || '');
  }
}
