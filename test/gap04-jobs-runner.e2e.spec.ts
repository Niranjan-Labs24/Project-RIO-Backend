import { Client } from 'pg';
import type { ConfigService } from '../src/config/config.service';
import { JobsWorkerService } from '../src/modules/jobs/jobs-worker.service';
import type { ScoreResponseTask } from '../src/modules/jobs/tasks/score-response.task';

// GAP-04 Task 3 — the in-process graphile-worker runner boots and stops
// cleanly against the real Docker DB, and installs its schema on boot.
//
// The runner is ALWAYS stopped in afterAll so vitest exits cleanly (no leaked
// pollers/connections) — per the GAP-04 execution note.
describe('GAP-04 JobsWorkerService runner (boot/stop + schema)', () => {
  let service: JobsWorkerService;

  function fakeConfig(): ConfigService {
    // Owner connection — same as production (config.databaseUrl = cnap_owner).
    return { databaseUrl: process.env.DATABASE_URL } as unknown as ConfigService;
  }
  // The runner boot/stop is what this suite exercises; the task itself is
  // covered by gap04-score-response-task.e2e.spec.ts. A no-op stub keeps this
  // test focused on lifecycle.
  function fakeTask(): ScoreResponseTask {
    return { handle: async () => undefined } as unknown as ScoreResponseTask;
  }

  beforeAll(() => {
    service = new JobsWorkerService(fakeConfig(), fakeTask());
  });

  afterAll(async () => {
    // Defensive: ensure the runner is stopped even if a test failed mid-way.
    await service.onModuleDestroy();
  });

  it('boots, installs the graphile_worker schema, then stops cleanly', async () => {
    await service.onModuleInit();

    // Schema installed by the runner's owner connection.
    const owner = new Client({ connectionString: process.env.DATABASE_URL });
    await owner.connect();
    try {
      const schema = await owner.query(
        `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'graphile_worker'`,
      );
      expect(schema.rowCount).toBe(1);
      const fn = await owner.query(
        `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'graphile_worker' AND p.proname = 'add_job'`,
      );
      expect(fn.rowCount).toBeGreaterThanOrEqual(1);
    } finally {
      await owner.end();
    }

    // Stops without hanging or throwing.
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  }, 30_000);
});
