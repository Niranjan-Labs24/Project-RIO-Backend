import type { PrismaClient } from '../src/generated/prisma';
import { TenantPrismaService } from '../src/tenancy/tenant-prisma.service';
import { DeterministicScoringService } from '../src/modules/priority/scoring.service';
import { appClient, ownerClient } from './db.helper';
import { createGap04Fixture, type Gap04Fixture } from './gap04-scoring-fixture';

// GAP-04 Task 1 — scoreResponse idempotency (delete-first).
//
// A durable job may redeliver score_response after a crash/retry. Because the
// ResponseAnswer / ResponseSeverityScore rows have no unique constraint, a
// naive re-run would DOUBLE them. This asserts, against the real Docker DB,
// that scoring the same response twice leaves exactly the same row counts as
// scoring it once — i.e. the second run replaced rather than duplicated.
describe('GAP-04 scoreResponse idempotency (delete-first)', () => {
  let owner: PrismaClient;
  let app: PrismaClient;
  let scoring: DeterministicScoringService;
  let fixture: Gap04Fixture;

  beforeAll(async () => {
    owner = ownerClient();
    app = appClient();
    // Score through the app role (cnap_app) inside runAsOrg — same connection
    // role the production scoring path uses.
    const tenant = new TenantPrismaService(app as never, app as never);
    scoring = new DeterministicScoringService(tenant);
    fixture = await createGap04Fixture(owner);
  }, 30_000);

  // response_answers / response_severity_scores are FORCE ROW LEVEL SECURITY:
  // even the owner sees zero rows unless app.current_org_id is set for the
  // scope. Count inside an org-scoped owner transaction, same as the fixture.
  async function counts(): Promise<{ answers: number; scores: number }> {
    return owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', $1, true)`, fixture.orgId);
      const answers = await tx.responseAnswer.count({ where: { surveyResponseId: fixture.responseId } });
      const scores = await tx.responseSeverityScore.count({ where: { surveyResponseId: fixture.responseId } });
      return { answers, scores };
    });
  }

  afterAll(async () => {
    if (fixture) await fixture.cleanup();
    await owner.$disconnect();
    await app.$disconnect();
  });

  it('scoring the same response twice does not duplicate answers/scores', async () => {
    await scoring.scoreResponse(fixture.responseId, fixture.orgId);
    const first = await counts();

    expect(first.answers).toBeGreaterThan(0);
    expect(first.scores).toBeGreaterThan(0);

    // Re-deliver: run scoring a second time.
    await scoring.scoreResponse(fixture.responseId, fixture.orgId);
    const second = await counts();

    expect(second.answers).toBe(first.answers);
    expect(second.scores).toBe(first.scores);
  }, 30_000);
});
