import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { StudyConfigModule } from '../study-config/study-config.module';
import { NeedThemesService } from './need-themes.service';

/**
 * RIO-FR-003 AC 6. Its own module rather than a provider inside NeedsModule
 * because PriorityModule needs the recurrence count too, and importing the
 * whole of NeedsModule from the scoring engine would create a cycle
 * (NeedsModule already depends on AiDecisionsModule, which the scoring path
 * sits underneath).
 */
@Module({
  imports: [AiModule, StudyConfigModule],
  providers: [NeedThemesService],
  exports: [NeedThemesService],
})
export class NeedThemesModule {}
