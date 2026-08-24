import { Injectable, Logger } from '@nestjs/common';
import { TenantPrismaService } from '../../../tenancy/tenant-prisma.service';
import { DeterministicScoringService } from '../../priority/scoring.service';
import { ScoreRollupService } from '../../priority/rollup.service';

// GAP-04: the durable `score_response` job payload. Enqueued transactionally
// with the SurveyResponse (CitizenService.submitResponse) and carried through
// graphile-worker. orgId is explicit — the citizen submission flow is
// unauthenticated, so the scoring/roll-up calls have no ambient org context to
// fall back on (same reasoning as DeterministicScoringService#scoreResponse).
export interface ScoreResponsePayload {
  responseId: string;
  orgId: string;
}

@Injectable()
export class ScoreResponseTask {
  private readonly logger = new Logger(ScoreResponseTask.name);

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly scoringEngine: DeterministicScoringService,
    private readonly rollupService: ScoreRollupService,
  ) {}

  /**
   * Runs exactly the scoring + roll-up logic that used to live in the
   * unawaited floating promise in CitizenService.submitResponse — now durable
   * and retryable. It is DELIBERATELY allowed to throw: graphile-worker catches
   * a rejected task, records the error, and retries per the job's max_attempts.
   * Swallowing here (as the old .catch did) would silently drop scores forever,
   * which is precisely the durability gap GAP-04 closes.
   *
   * Idempotent by construction: scoreResponse delete-firsts its own
   * answers/scores (Task 1), and calculateRollups upserts — so a retry after a
   * partial failure re-computes cleanly rather than duplicating.
   */
  async handle(payload: ScoreResponsePayload): Promise<void> {
    const { responseId, orgId } = payload;

    await this.scoringEngine.scoreResponse(responseId, orgId);

    const resp = await this.tenant.runAsSupervisor((tx) =>
      tx.surveyResponse.findUnique({ where: { id: responseId }, include: { need: true } }),
    );
    if (!resp) {
      // The response vanished between enqueue and processing (e.g. deleted).
      // Nothing to roll up; not an error worth retrying.
      this.logger.warn(`score_response: SurveyResponse ${responseId} not found; skipping roll-up`);
      return;
    }

    const survey = await this.tenant.runAsSupervisor((tx) =>
      tx.survey.findFirst({ where: { needId: resp.needId, status: 'PUBLISHED' } }),
    );
    if (!survey) {
      this.logger.warn(`score_response: no PUBLISHED survey for need ${resp.needId}; skipping roll-up`);
      return;
    }

    const villageId = resp.need.village?.[0] || null;
    // Village-scoped, then study-wide (villageId = null). Per-study roll-up
    // races are prevented upstream by the queue_name = `study:<studyId>`
    // serialization on the enqueue (graphile-worker runs one job per named
    // queue at a time), so these two calls never overlap another study job.
    await this.rollupService.calculateRollups(resp.studyId, survey.id, villageId, { orgId });
    await this.rollupService.calculateRollups(resp.studyId, survey.id, null, { orgId });
  }
}
