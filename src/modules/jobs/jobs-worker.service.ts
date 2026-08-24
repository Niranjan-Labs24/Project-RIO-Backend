import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { run, type Runner } from 'graphile-worker';
import { ConfigService } from '../../config/config.service';
import { ScoreResponseTask, type ScoreResponsePayload } from './tasks/score-response.task';

// GAP-04: in-process graphile-worker runner. Owns the runner lifecycle via
// Nest hooks (the app calls enableShutdownHooks() in main.ts, so
// onModuleDestroy fires on SIGINT/SIGTERM). Modelled on BackupService — a
// background provider, no controller.
//
// Uses the OWNER connection (config.databaseUrl = cnap_owner): graphile-worker
// installs/migrates its own schema on first run() and then polls/locks/
// completes jobs, all of which need owner privileges. ENQUEUE, by contrast,
// happens on the app role (cnap_app) inside the request transaction (see
// CitizenService.submitResponse) — that path only needs the minimal grants
// added in 20260824160000_graphile_worker_grants.
@Injectable()
export class JobsWorkerService implements OnModuleInit, OnModuleDestroy {
  private runner?: Runner;
  private readonly logger = new Logger(JobsWorkerService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly scoreResponseTask: ScoreResponseTask,
  ) {}

  async onModuleInit(): Promise<void> {
    this.runner = await run({
      // Owner connection: installs the graphile_worker schema on first run
      // and runs the poller/locker.
      connectionString: this.config.databaseUrl,
      concurrency: 4,
      // Nest's shutdown hooks drive stop() (onModuleDestroy) — don't let
      // graphile-worker install its own SIGINT/SIGTERM handlers.
      noHandleSignals: true,
      taskList: {
        score_response: (payload) =>
          this.scoreResponseTask.handle(payload as ScoreResponsePayload),
      },
    });
    this.logger.log('graphile-worker runner started (task: score_response)');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.runner) {
      await this.runner.stop();
      this.runner = undefined;
      this.logger.log('graphile-worker runner stopped');
    }
  }
}
