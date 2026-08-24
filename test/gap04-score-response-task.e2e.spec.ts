import { Client } from 'pg';
import { makeWorkerUtils, type WorkerUtils } from 'graphile-worker';
import type { PrismaClient } from '../src/generated/prisma';
import { TenantPrismaService } from '../src/tenancy/tenant-prisma.service';
import { DeterministicScoringService } from '../src/modules/priority/scoring.service';
import { ScoreRollupService } from '../src/modules/priority/rollup.service';
import { PriorityV2Service } from '../src/modules/priority/priority-v2.service';
import { ScoreResponseTask } from '../src/modules/jobs/tasks/score-response.task';
import { JobsWorkerService } from '../src/modules/jobs/jobs-worker.service';
import type { ConfigService } from '../src/config/config.service';
import type { AuditService } from '../src/modules/audit/audit.service';
import { appClient, ownerClient, supervisorClient } from './db.helper';
import { createGap04Fixture, type Gap04Fixture } from './gap04-scoring-fixture';

// GAP-04 Task 4 — the durable score_response task, end to end against the real
// Docker DB: enqueue a job (via graphile-worker's own utils on the app path is
// not required here — we enqueue with the owner utils, the task logic is what's
// under test), let the in-process runner drain it, then assert scores + roll-
// ups exist. Enqueue TWICE (same job_key) and confirm no duplication (relies on
// Task 1 idempotency + calculateRollups upsert).
//
// The runner is ALWAYS stopped in afterAll (clean vitest exit).
describe('GAP-04 score_response durable task (drain + idempotent)', () => {
  let owner: PrismaClient;
  let app: PrismaClient;
  let supervisor: PrismaClient;
  let runner: JobsWorkerService;
  let workerUtils: WorkerUtils;
  let fixture: Gap04Fixture;

  function fakeConfig(): ConfigService {
    return { databaseUrl: process.env.DATABASE_URL } as unknown as ConfigService;
  }
  // The task's roll-up path calls ScoreRollupService.calculateRollups, which
  // does NOT touch AuditService/PriorityV2Service (only recalculateStudyScores
  // does). Stubs keep construction simple.
  function fakeAudit(): AuditService {
    return { record: async () => undefined, recordWithTx: async () => undefined } as unknown as AuditService;
  }

  beforeAll(async () => {
    owner = ownerClient();
    app = appClient();
    supervisor = supervisorClient();
    fixture = await createGap04Fixture(owner);

    // Real service graph, scoring/roll-up through the app role inside runAsOrg
    // and the cross-org supervisor read path for the task's response/survey
    // refetch (matches production's TenantPrismaService wiring).
    const tenant = new TenantPrismaService(app as never, supervisor as never);
    const scoring = new DeterministicScoringService(tenant);
    const priorityV2 = new PriorityV2Service(tenant);
    const rollup = new ScoreRollupService(tenant, fakeAudit(), scoring, priorityV2);
    const task = new ScoreResponseTask(tenant, scoring, rollup);

    runner = new JobsWorkerService(fakeConfig(), task);
    await runner.onModuleInit();

    // Enqueue via graphile-worker utils (owner connection). The transactional-
    // enqueue-on-cnap_app path is covered separately in the Task 5 suite; here
    // we only need a job in the queue for the runner to drain.
    workerUtils = await makeWorkerUtils({ connectionString: process.env.DATABASE_URL });
  }, 40_000);

  afterAll(async () => {
    await runner.onModuleDestroy();
    if (workerUtils) await workerUtils.release();
    if (fixture) await fixture.cleanup();
    await owner.$disconnect();
    await app.$disconnect();
    await supervisor.$disconnect();
  });

  async function counts(): Promise<{ answers: number; scores: number; rollups: number }> {
    return owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', $1, true)`, fixture.orgId);
      const answers = await tx.responseAnswer.count({ where: { surveyResponseId: fixture.responseId } });
      const scores = await tx.responseSeverityScore.count({ where: { surveyResponseId: fixture.responseId } });
      const rollups = await tx.scoreRollup.count({ where: { studyId: fixture.studyId } });
      return { answers, scores, rollups };
    });
  }

  async function pendingJobs(jobKey: string): Promise<number> {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      const r = await c.query(`SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE key = $1`, [jobKey]);
      return r.rows[0].n as number;
    } finally {
      await c.end();
    }
  }

  async function waitForDrain(jobKey: string, timeoutMs = 20_000): Promise<void> {
    const start = Date.now();
    for (;;) {
      if ((await pendingJobs(jobKey)) === 0) return;
      if (Date.now() - start > timeoutMs) throw new Error(`job ${jobKey} did not drain in time`);
      await new Promise((res) => setTimeout(res, 300));
    }
  }

  it('drains an enqueued score_response job and writes scores + roll-ups; a second enqueue does not duplicate', async () => {
    const jobKey = `score:${fixture.responseId}`;

    await workerUtils.addJob(
      'score_response',
      { responseId: fixture.responseId, orgId: fixture.orgId },
      { jobKey, maxAttempts: 5, queueName: `study:${fixture.studyId}` },
    );
    await waitForDrain(jobKey);

    const first = await counts();
    expect(first.answers).toBeGreaterThan(0);
    expect(first.scores).toBeGreaterThan(0);
    expect(first.rollups).toBeGreaterThan(0);

    // Re-enqueue the same job — the durable retry / re-submit path.
    await workerUtils.addJob(
      'score_response',
      { responseId: fixture.responseId, orgId: fixture.orgId },
      { jobKey, maxAttempts: 5, queueName: `study:${fixture.studyId}` },
    );
    await waitForDrain(jobKey);

    const second = await counts();
    expect(second.answers).toBe(first.answers);
    expect(second.scores).toBe(first.scores);
    expect(second.rollups).toBe(first.rollups);
  }, 60_000);
});
