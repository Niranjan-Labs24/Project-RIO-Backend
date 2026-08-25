import { Injectable, Logger } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { ConfigService } from '../../config/config.service';
import {
  classifySession,
  stepRank,
  type SessionRow,
  type SurveySessionStepName,
} from './abandonment';
import type { RecordEventPayload, RecordEventResult, StartSessionResult } from './survey-sessions.types';

/**
 * Survey abandonment tracking — client answer, 24 Aug (RPT10 Q-2).
 *
 * "Yes, the system should track abandonment … at the session/event level
 * (that a survey was started and not completed), not by retaining the partial
 * answer data itself."
 *
 * So: this service records that a sitting happened, how far it got and when
 * it stopped. It never touches an answer value — the only column it writes
 * that relates to answers at all is `answeredCount`, an integer. Formal
 * submission remains the sole way a response becomes a data record, exactly
 * as the client restated in the same answer.
 *
 * Every method here is BEST-EFFORT. Tracking a sitting must never be able to
 * stop a citizen submitting: a failed session write is logged and swallowed,
 * and the flow continues with no session attached (that response then simply
 * has no abandonment row, and RPT10 tracking-coverage note says so).
 */
@Injectable()
export class SurveySessionsService {
  private readonly logger = new Logger(SurveySessionsService.name);

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly config: ConfigService,
  ) {}

  get idleMinutes(): number {
    return this.config.surveyAbandonmentIdleMinutes;
  }

  /**
   * Opens a session when the citizen page loads. Resolves the currently
   * PUBLISHED survey itself rather than trusting the client, so a session is
   * always attributed to the version the respondent actually saw — the same
   * reason submitResponse re-reads it (see SURVEY_VERSION_CHANGED).
   */
  async start(link: { id: string; orgId: string; needId: string; studyId: string }): Promise<StartSessionResult | null> {
    try {
      const survey = await this.tenant.runAsSupervisor((tx) =>
        tx.survey.findFirst({
          where: { needId: link.needId, status: 'PUBLISHED' },
          select: { id: true, _count: { select: { surveyQuestions: true } } },
        }),
      );
      const session = await this.tenant.runAsOrg(link.orgId, (tx) =>
        tx.surveySession.create({
          data: {
            orgId: link.orgId,
            needId: link.needId,
            studyId: link.studyId,
            surveyLinkId: link.id,
            surveyId: survey?.id ?? null,
            questionCount: survey?._count.surveyQuestions ?? 0,
            events: { create: { orgId: link.orgId, step: 'OPENED', position: 0 } },
          },
          select: { id: true },
        }),
      );
      return { sessionId: session.id };
    } catch (err) {
      this.logger.warn(`Failed to open survey session for link ${link.id}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Advances a session. `furthestStep` only ever moves forwards — a
   * respondent stepping back to fix an answer must not make the abandonment
   * stage read earlier than the point they actually reached.
   */
  async recordEvent(
    link: { id: string; orgId: string },
    sessionId: string,
    payload: RecordEventPayload,
  ): Promise<RecordEventResult> {
    try {
      const recorded = await this.tenant.runAsOrg(link.orgId, async (tx) => {
        const existing = await tx.surveySession.findFirst({
          where: { id: sessionId, surveyLinkId: link.id },
          select: { id: true, furthestStep: true, answeredCount: true, submittedAt: true },
        });
        // Unknown id, another link session, or an already-submitted one: no
        // row, no event, no error. Nothing downstream depends on the caller
        // learning which of the three it was.
        if (!existing || existing.submittedAt) return false;

        const advances = stepRank(payload.step) > stepRank(existing.furthestStep as SurveySessionStepName);
        const verifiedSteps: SurveySessionStepName[] = ['OTP_VERIFIED', 'ANSWERING', 'REVIEW'];
        await tx.surveySession.update({
          where: { id: existing.id },
          data: {
            lastEventAt: new Date(),
            status: verifiedSteps.includes(payload.step) ? 'VERIFIED' : 'IN_PROGRESS',
            ...(advances ? { furthestStep: payload.step } : {}),
            // Highest watermark, not the latest value — clearing an answer
            // must not make recorded progress go backwards mid-sitting.
            ...(payload.answeredCount !== undefined
              ? { answeredCount: Math.max(existing.answeredCount, payload.answeredCount) }
              : {}),
          },
        });
        // One row per ADVANCE only. Without this guard a page that re-posts
        // its current step (navigation, a re-render, a retry) would write an
        // unbounded event log for a single sitting.
        if (advances) {
          await tx.surveySessionEvent.create({
            data: { orgId: link.orgId, sessionId: existing.id, step: payload.step, position: payload.position ?? 0 },
          });
        }
        return true;
      });
      return { recorded };
    } catch (err) {
      this.logger.warn(`Failed to record survey session event ${sessionId}: ${(err as Error).message}`);
      return { recorded: false };
    }
  }

  /**
   * Attaches the OTP challenge contact details to the session — the same two
   * values CitizenOtpChallenge already stores, copied here for one purpose:
   * the completion reminder. A session that never reaches this point has no
   * contact and can never be reminded.
   */
  async linkChallenge(
    orgId: string,
    sessionId: string,
    challenge: { id: string; contact: string; mobile: string | null },
  ): Promise<void> {
    await this.safely(sessionId, () =>
      this.tenant.runAsOrg(orgId, (tx) =>
        tx.surveySession.updateMany({
          where: { id: sessionId, submittedAt: null },
          data: {
            otpChallengeId: challenge.id,
            contact: challenge.contact,
            mobile: challenge.mobile,
            status: 'IN_PROGRESS',
            furthestStep: 'OTP_REQUESTED',
            lastEventAt: new Date(),
          },
        }),
      ),
    );
  }

  /**
   * Closes a session against the real SurveyResponse it produced. Called
   * after the submission transaction commits — a session is SUBMITTED only
   * when a response row exists to point at, never on the client say-so.
   */
  async markSubmitted(orgId: string, sessionId: string, surveyResponseId: string): Promise<void> {
    await this.safely(sessionId, () =>
      this.tenant.runAsOrg(orgId, (tx) =>
        tx.surveySession.updateMany({
          where: { id: sessionId, submittedAt: null },
          data: {
            status: 'SUBMITTED',
            furthestStep: 'SUBMITTED',
            surveyResponseId,
            submittedAt: new Date(),
            lastEventAt: new Date(),
          },
        }),
      ),
    );
  }

  /**
   * Marks every stale unfinished session ABANDONED. Persisting the state is
   * what makes it queryable and reminder-able; RPT10 does NOT depend on this
   * having run — it re-derives the same classification from `lastEventAt`
   * with the same function (classifySession), so a report generated between
   * two sweeps is still correct.
   *
   * Cross-org: read via the supervisor client, then write per org, because
   * survey_sessions is RLS-protected and there is no cross-org write path for
   * a policied table (see TenantPrismaService.runAsSupervisorWrite).
   */
  async sweepAbandoned(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.idleMinutes * 60_000);
    const stale = await this.tenant.runAsSupervisor((tx) =>
      tx.surveySession.findMany({
        where: { submittedAt: null, status: { notIn: ['SUBMITTED', 'ABANDONED'] }, lastEventAt: { lt: cutoff } },
        select: { id: true, orgId: true },
      }),
    );
    if (!stale.length) return 0;

    const byOrg = new Map<string, string[]>();
    for (const row of stale) byOrg.set(row.orgId, [...(byOrg.get(row.orgId) ?? []), row.id]);

    let marked = 0;
    for (const [orgId, ids] of byOrg) {
      try {
        const res = await this.tenant.runAsOrg(orgId, (tx) =>
          tx.surveySession.updateMany({
            where: { id: { in: ids }, submittedAt: null, status: { notIn: ['SUBMITTED', 'ABANDONED'] } },
            data: { status: 'ABANDONED', abandonedAt: now },
          }),
        );
        marked += res.count;
      } catch (err) {
        this.logger.error(`Failed to mark abandoned sessions for org ${orgId}: ${(err as Error).message}`);
      }
    }
    return marked;
  }

  /** Sessions in scope, in the shape the pure summariser expects. Used by
   *  RPT10; scoped by study, optionally narrowed to one survey version. */
  async loadSessionsForReport(scope: { studyId: string; surveyId?: string }): Promise<SessionRow[]> {
    const rows = await this.tenant.runAsSupervisor((tx) =>
      tx.surveySession.findMany({
        where: { studyId: scope.studyId, ...(scope.surveyId ? { surveyId: scope.surveyId } : {}) },
        select: {
          id: true,
          surveyId: true,
          furthestStep: true,
          questionCount: true,
          answeredCount: true,
          startedAt: true,
          lastEventAt: true,
          submittedAt: true,
          remindersSent: true,
        },
      }),
    );
    return rows.map((r) => ({ ...r, furthestStep: r.furthestStep as SurveySessionStepName }));
  }

  /** Shared with SurveyReminderService — the live classification, so the two
   *  never disagree about whether a session is still recoverable. */
  isAbandoned(row: SessionRow, now = new Date()): boolean {
    return classifySession(row, now, this.idleMinutes) === 'ABANDONED';
  }

  private async safely(sessionId: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.warn(`Survey session ${sessionId} update failed: ${(err as Error).message}`);
    }
  }
}
