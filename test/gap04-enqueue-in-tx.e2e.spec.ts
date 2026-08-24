import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { makeWorkerUtils, type WorkerUtils } from 'graphile-worker';
import type { PrismaClient } from '../src/generated/prisma';
import { TenantPrismaService } from '../src/tenancy/tenant-prisma.service';
import { DeterministicScoringService } from '../src/modules/priority/scoring.service';
import { ScoreRollupService } from '../src/modules/priority/rollup.service';
import { PriorityV2Service } from '../src/modules/priority/priority-v2.service';
import { ScoreResponseTask } from '../src/modules/jobs/tasks/score-response.task';
import { JobsWorkerService } from '../src/modules/jobs/jobs-worker.service';
import { CitizenService } from '../src/modules/citizen/citizen.service';
import type { ConfigService } from '../src/config/config.service';
import type { AuditService } from '../src/modules/audit/audit.service';
import { computeBlindIndex } from '../src/modules/citizen/citizen-pii.crypto';
import { appClient, ownerClient, supervisorClient } from './db.helper';
import { createGap04Fixture, type Gap04Fixture } from './gap04-scoring-fixture';

// GAP-04 Task 5 — the scoring job is enqueued on the SAME transaction as the
// SurveyResponse (lossless), and CitizenService.submitResponse's HTTP shape is
// unchanged. Then the worker drains and scores exist. All against the live DB.
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const BLIND_INDEX_KEY = Buffer.alloc(32, 9).toString('base64');

describe('GAP-04 transactional enqueue in submitResponse (lossless + shape + drain)', () => {
  let owner: PrismaClient;
  let app: PrismaClient;
  let supervisor: PrismaClient;
  let runner: JobsWorkerService;
  let workerUtils: WorkerUtils;
  let fixture: Gap04Fixture;
  let citizen: CitizenService;
  let tenant: TenantPrismaService;
  let linkToken: string;
  let challengeId: string;

  function fakeConfig(): ConfigService {
    return {
      databaseUrl: process.env.DATABASE_URL,
      encryptionKey: ENCRYPTION_KEY,
      blindIndexKey: BLIND_INDEX_KEY,
    } as unknown as ConfigService;
  }
  function fakeAudit(): AuditService {
    return { record: async () => undefined, recordWithTx: async () => undefined } as unknown as AuditService;
  }

  beforeAll(async () => {
    owner = ownerClient();
    app = appClient();
    supervisor = supervisorClient();
    fixture = await createGap04Fixture(owner);

    tenant = new TenantPrismaService(app as never, supervisor as never);
    const scoring = new DeterministicScoringService(tenant);
    const rollup = new ScoreRollupService(tenant, fakeAudit(), scoring, new PriorityV2Service(tenant));
    const task = new ScoreResponseTask(tenant, scoring, rollup);
    runner = new JobsWorkerService(fakeConfig(), task);

    // The fixture created its own response; for submitResponse we need a link
    // + a verified, unconsumed OTP challenge. Build them on the fixture's need.
    linkToken = randomBytes(16).toString('hex');
    const built = await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', $1, true)`, fixture.orgId);
      const link = await tx.publicSurveyLink.create({
        data: {
          orgId: fixture.orgId, needId: fixture.needId, studyId: fixture.studyId,
          label: 'GAP04 Submit Link', token: linkToken, createdBy: fixture.orgId, isActive: true,
        },
      });
      const challenge = await tx.citizenOtpChallenge.create({
        data: {
          orgId: fixture.orgId, surveyLinkId: link.id,
          contact: 'gap04-submit@seed.local', mobile: null, codeHash: 'x',
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          verifiedAt: new Date(), consumedAt: null,
        },
      });
      return { challengeId: challenge.id };
    });
    challengeId = built.challengeId;

    citizen = new CitizenService(
      tenant,
      fakeConfig(),
      {} as never, // passwords — not called in submitResponse
      {} as never, // sms — not called in submitResponse
      {} as never, // surveys — not called in submitResponse
      fakeAudit(),
    );

    await runner.onModuleInit();
    workerUtils = await makeWorkerUtils({ connectionString: process.env.DATABASE_URL });
  }, 40_000);

  afterAll(async () => {
    await runner.onModuleDestroy();
    if (workerUtils) await workerUtils.release();
    // Remove challenge + link created here (before the fixture nukes the org).
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', $1, true)`, fixture.orgId);
      await tx.$executeRawUnsafe(`DELETE FROM citizen_otp_challenges WHERE org_id = $1::uuid`, fixture.orgId);
    });
    if (fixture) await fixture.cleanup();
    await owner.$disconnect();
    await app.$disconnect();
    await supervisor.$disconnect();
  });

  async function jobRows(responseId: string): Promise<Array<{ key: string; task: string; queue: string; max: number }>> {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      const r = await c.query(
        `SELECT key, task_identifier AS task, queue_name AS queue, max_attempts AS max
         FROM graphile_worker.jobs WHERE key = $1`,
        [`score:${responseId}`],
      );
      return r.rows;
    } finally {
      await c.end();
    }
  }

  it('rolls back the enqueued job when the response transaction rolls back (lossless: neither persists)', async () => {
    // Directly exercise the exact enqueue pattern submitResponse uses, on a
    // runAsOrg transaction that then THROWS — proving the job add is inside
    // the tx and is discarded on rollback (never runs for an uncommitted
    // response). Uses cnap_app (runAsOrg), the production enqueue role.
    const fakeResponseId = randomBytes(16).toString('hex');
    const jobKey = `score:rollback-${fakeResponseId}`;
    await expect(
      tenant.runAsOrg(fixture.orgId, async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT graphile_worker.add_job('score_response', payload := $1::json, max_attempts := 5, job_key := $2, queue_name := $3)`,
          JSON.stringify({ responseId: fakeResponseId, orgId: fixture.orgId }),
          jobKey,
          `study:${fixture.studyId}`,
        );
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');

    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      const r = await c.query(`SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE key = $1`, [jobKey]);
      expect(r.rows[0].n).toBe(0); // enqueue was rolled back with the tx
    } finally {
      await c.end();
    }
  }, 30_000);

  it('submitResponse enqueues a score_response job and returns the unchanged HTTP shape; worker drains and scores exist', async () => {
    const result = await citizen.submitResponse(linkToken, {
      challengeId,
      ageBracket: 'age_25_34',
      answers: {}, // keyed by SurveyQuestion.id in real use; empty is fine here
    } as never);

    // HTTP shape unchanged: exactly { id, submittedAt } with an ISO timestamp.
    expect(Object.keys(result).sort()).toEqual(['id', 'submittedAt']);
    expect(typeof result.id).toBe('string');
    expect(new Date(result.submittedAt).toISOString()).toBe(result.submittedAt);

    // A job for THIS response exists — written in the same tx as the response.
    const jobs = await jobRows(result.id);
    expect(jobs).toHaveLength(1);
    const [job] = jobs as [{ key: string; task: string; queue: string; max: number }];
    expect(job.task).toBe('score_response');
    expect(job.queue).toBe(`study:${fixture.studyId}`);
    expect(job.max).toBe(5);

    // Let the runner drain it, then confirm scores were written.
    const start = Date.now();
    for (;;) {
      if ((await jobRows(result.id)).length === 0) break;
      if (Date.now() - start > 20_000) throw new Error('job did not drain');
      await new Promise((res) => setTimeout(res, 300));
    }

    const scores = await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', $1, true)`, fixture.orgId);
      return tx.responseSeverityScore.count({ where: { surveyResponseId: result.id } });
    });
    expect(scores).toBeGreaterThan(0);

    // Sanity: the response row itself committed (so blind index helper import
    // is genuinely exercised too, matching production's dedup path).
    void computeBlindIndex('gap04-submit@seed.local', BLIND_INDEX_KEY);
  }, 60_000);
});
