import { Module } from '@nestjs/common';
import { PriorityModule } from '../priority/priority.module';
import { JobsWorkerService } from './jobs-worker.service';
import { ScoreResponseTask } from './tasks/score-response.task';

// GAP-04: durable background jobs (graphile-worker). Providers-only, like
// BackupModule — no controller. Imports PriorityModule for the scoring/roll-up
// services the score_response task delegates to (TenantPrismaService is
// globally available via TenancyModule).
@Module({
  imports: [PriorityModule],
  providers: [JobsWorkerService, ScoreResponseTask],
})
export class JobsModule {}
