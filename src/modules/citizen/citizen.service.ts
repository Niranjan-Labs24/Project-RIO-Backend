import { toJson } from '../../common/prisma/json';
import type { Prisma } from '../../generated/prisma';
import { BadRequestException, GoneException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { PasswordService } from '../../auth/password.service';
import { ConfigService } from '../../config/config.service';
import { SmsService } from '../../sms/sms.service';
import { MailerService } from '../../mailer/mailer.service';
import { AuditService } from '../audit/audit.service';
import { DataCleaningService } from '../data-cleaning/data-cleaning.service';
import { SurveysService } from '../surveys/surveys.service';
import { DeterministicScoringService } from '../priority/scoring.service';
import { ScoreRollupService } from '../priority/rollup.service';
import { SurveySessionsService } from '../survey-sessions/survey-sessions.service';
import { ConsentService } from '../consent/consent.service';
import { resolveConsentLocale } from '../consent/consent.types';
import { villageKey, villageNameKey } from '../reports/core-needs/load-core-needs';
import type { RecordEventPayload, RecordEventResult, StartSessionResult } from '../survey-sessions/survey-sessions.types';
import type {
  CheckDuplicatePayload, CheckDuplicateResult, CitizenOtpChallengeRow, PublicSurveyLinkRow, RequestOtpPayload,
  RecordOutsidePayload, RequestOtpResult, ResolvedSurvey, SubmitResponsePayload, SubmitResponseResult, VerifyOtpPayload,
  VerifyOtpResult,
} from './citizen.types';

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const SECONDS_PER_QUESTION = 20;
/** Exclusion reason of a respondent who chose "Outside these areas". */
export const OUTSIDE_STUDY_GEOGRAPHY = 'OUTSIDE_STUDY_GEOGRAPHY';
const OUTSIDE_LOCATION_LABEL = 'Outside these areas';

/**
 * Whether the OTP may be echoed in the API response. Only in development and
 * test, and only when the SMS was not delivered. Driven by the validated config
 * value (an unset NODE_ENV counts as production), never by process.env
 * directly, so a missing or mistyped NODE_ENV cannot leak codes.
 */
export function shouldRevealOtp(codeSent: boolean, nodeEnv: string | undefined): boolean {
  return !codeSent && (nodeEnv === 'development' || nodeEnv === 'test');
}

@Injectable()
export class CitizenService {
  private readonly logger = new Logger(CitizenService.name);

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly passwords: PasswordService,
    private readonly sms: SmsService,
    private readonly mailer: MailerService,
    private readonly surveys: SurveysService,
    private readonly audit: AuditService,
    private readonly scoringEngine: DeterministicScoringService,
    private readonly rollupService: ScoreRollupService,
    // Abandonment tracking (RPT10 Q-2). Best-effort throughout — every call
    // into it is allowed to fail without affecting the citizen flow.
    private readonly sessions: SurveySessionsService,
    // RIO-NFR-002 — resolves the live citizen-consent notice so a submission
    // can be pinned to the exact version its respondent read.
    private readonly consent: ConsentService,
    // RIO-FR-002 — cleaning of the submitted response. Best-effort, like
    // session tracking above.
    private readonly dataCleaning: DataCleaningService,
    private readonly config: ConfigService,
  ) {}

  // The published Survey Builder survey is the only source of questions for
  // the citizen flow — no placeholder, no fixed seed set. Re-reads fresh on
  // every call (no caching), so if a survey is edited and republished, the
  // very next citizen to open the link sees the latest version.
  async resolveSurvey(token: string): Promise<ResolvedSurvey> {
    const link = await this.findActiveLinkOrThrow(token);
    const [{ study, org, locations }, survey] = await Promise.all([
      this.tenant.runAsSupervisor(async (tx) => ({
        study: await tx.study.findUnique({ where: { id: link.studyId } }),
        org: await tx.organisation.findUnique({ where: { id: link.orgId } }),
        locations: await studyLocations(tx, link.studyId),
      })),
      this.surveys.getPublishedSurveyByNeedId(link.needId),
    ]);

    if (!survey) {
      throw new NotFoundException({
        error: { code: 'SURVEY_NOT_PUBLISHED', message: 'This study does not have a published survey yet.' },
      });
    }

    const questions = survey.questions.map(
      (q: {
        answerType: string;
        answerOptions: string[] | null;
        // RIO Arabic Localization (Approach 3, Hybrid) — added 2026-09-08.
        // These already existed on `toQuestionDto`'s output (Question Bank's
        // client-supplied Arabic text/options), they just never reached the
        // citizen — this resolver dropped them on the way through, which is
        // why a citizen choosing Arabic still saw every question in English.
        questionTextAr: string | null;
        answerOptionsAr: string[] | null;
        id: string;
        questionText: string;
        isRequired: boolean;
      }) => {
        const { type, options, optionsAr } = this.mapAnswerTypeForCitizen(
          q.answerType,
          q.answerOptions,
          q.answerOptionsAr,
        );
        return {
          // The SurveyQuestion row's own id — the one identity that exists
          // for both a Question Bank question and an additional one, which
          // has no Question row to key off.
          code: q.id,
          text: q.questionText,
          textAr: q.questionTextAr,
          type,
          options,
          optionsAr,
          required: q.isRequired,
        };
      },
    );

    return {
      studyId: link.studyId,
      title: survey.title,
      version: survey.id,
      studyTitle: study?.title ?? survey.title,
      organizationName: org?.name ?? "",
      questions,
      questionCount: questions.length,
      estimatedMinutes: Math.max(1, Math.ceil((questions.length * SECONDS_PER_QUESTION) / 60)),
      locations: {
        level: locations.level,
        options: locations.options.map(({ value, label, labelAr }) => ({ value, label, labelAr })),
      },
    };
  }

  // Maps Survey Builder's internal answerType vocabulary (Question Bank:
  // select/multiselect/checklist/numeric/boolean/text; additional questions: long_text/
  // short_text/multiple_choice/checkbox/yes_no/rating) onto the citizen
  // flow's rendering type — single_choice (pick one), multi_choice (pick
  // several), scale (1-5), numeric (a number box), or free text.
  // `optionsAr` is positionally parallel to `options` (same order, same
  // length) whenever it's present — the frontend indexes into it rather
  // than matching by value, since the *submitted* answer must always stay
  // the canonical English option (whatever downstream scoring/reporting
  // already expects), only the *displayed* label follows the UI locale.
  // Null wherever no Arabic option list was supplied (custom/additional
  // questions, or the synthesized Yes/No and 1-5 fallbacks below, which
  // have no Arabic equivalent to supply from the DB and are static UI
  // strings the frontend should localize itself, not content to translate).
  private mapAnswerTypeForCitizen(
    answerType: string,
    answerOptions: string[] | null,
    answerOptionsAr: string[] | null,
  ): { type: string; options?: string[]; optionsAr?: string[] | null } {
    switch (answerType) {
      case 'select':
      case 'multiple_choice':
        return { type: 'single_choice', options: answerOptions ?? [], optionsAr: answerOptionsAr };
      // `multiselect` / `checklist` are the Question Bank's own pick-several
      // types (19 + 3 questions in the v5.0 bank). They fell through to the
      // free-text default, so a citizen saw an empty text box instead of the
      // question's (Arabic) options — found in live UAT-06 verification.
      case 'checkbox':
      case 'multiselect':
      case 'checklist':
        return { type: 'multi_choice', options: answerOptions ?? [], optionsAr: answerOptionsAr };
      case 'boolean':
      case 'yes_no':
        return { type: 'single_choice', options: answerOptions ?? ['Yes', 'No'], optionsAr: answerOptions ? answerOptionsAr : null };
      case 'rating':
        return { type: 'scale', options: answerOptions ?? ['1', '2', '3', '4', '5'], optionsAr: answerOptions ? answerOptionsAr : null };
      // Falling through to 'text' gave a "how many days?" question a free
      // textarea, so "3", "5 days" and "3d" were all submitted against the
      // same question and only the bare number survived the statistics.
      // The stats now read a number out of any of those (see
      // parseNumericAnswer, both repos); this stops new ones being created.
      case 'numeric':
        return { type: 'numeric' };
      default:
        return { type: 'text' };
    }
  }

  // ── Abandonment tracking (client answer, 24 Aug — RPT10 Q-2) ──
  //
  // "Partially completed surveys are not saved as data records … the system
  // should track abandonment … at the session/event level." Both methods
  // below write session metadata only; neither can persist an answer, and a
  // response still becomes a data record exclusively through submitResponse.
  async startSession(token: string): Promise<StartSessionResult | null> {
    const link = await this.findActiveLinkOrThrow(token);
    return this.sessions.start(link);
  }

  async recordSessionEvent(
    token: string,
    sessionId: string,
    payload: RecordEventPayload,
  ): Promise<RecordEventResult> {
    const link = await this.findActiveLinkOrThrow(token);
    return this.sessions.recordEvent(link, sessionId, payload);
  }

  // Pre-flight check, called right after the participant enters their
  // contact details and before any OTP challenge is created — lets the
  // frontend reject an already-submitted contact without ever writing an
  // OTP challenge row. submitResponse still re-checks this itself inside
  // its transaction (belt-and-suspenders against a race between this call
  // and the eventual submit), so this endpoint is purely advisory and never
  // creates or mutates any record.
  async checkDuplicate(token: string, payload: CheckDuplicatePayload): Promise<CheckDuplicateResult> {
    const link = await this.findActiveLinkOrThrow(token);
    // Scoped to the Need, not the Study — each Need runs its own
    // independent survey, so the same person may legitimately respond once
    // per Need under the same Study. Both channels normalized (see
    // normalizeContact/normalizeMobile) so a trivial casing/whitespace
    // difference can't bypass this check. A match on EITHER channel counts
    // as a duplicate — see SurveyResponse.mobile's comment.
    const contact = this.normalizeContact(payload.contact);
    const mobile = this.normalizeMobile(payload.mobile);
    const existing = await this.tenant.runAsSupervisor((tx) =>
      tx.surveyResponse.findFirst({
        where: { needId: link.needId, OR: [{ contact }, { mobile }] },
      }),
    );
    return { isDuplicate: existing !== null };
  }

  async requestOtp(token: string, payload: RequestOtpPayload): Promise<RequestOtpResult> {
    const link = await this.findActiveLinkOrThrow(token);
    const contact = this.normalizeContact(payload.contact);
    const mobile = this.normalizeMobile(payload.mobile);
    const code = randomInt(100_000, 999_999).toString();
    const codeHash = await this.passwords.hash(code);
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    const challenge = await this.tenant.runAsOrg(link.orgId, (tx) =>
      tx.citizenOtpChallenge.create({
        data: { orgId: link.orgId, surveyLinkId: link.id, contact, mobile, codeHash, expiresAt },
      }),
    );
    // Email-delivered verification (client decision, 2026-09-30): the code
    // goes to `contact`, not to the mobile. `mobile` is still collected and
    // still required — it is half of the duplicate check below and on
    // checkDuplicate, so dropping it would let one person answer twice from
    // two email addresses. It is simply no longer the channel the code
    // travels on.
    //
    // Staff sign-in OTP is unaffected: that is AuthService with
    // MailerService.sendLoginOtpEmail, a different flow with different
    // wording.
    //
    // Deliberately soft-fail, not hard-fail: an earlier version rejected the
    // request outright when delivery failed (expiring the challenge +
    // throwing OTP_DELIVERY_FAILED), which stranded a respondent with no way
    // to ever get a code whenever delivery wasn't configured/working.
    // Give the session the contact details it needs to be remindable —
    // the same two values the challenge above already holds, and the only
    // reason SurveySession carries them at all.
    if (payload.sessionId) {
      await this.sessions.linkChallenge(link.orgId, payload.sessionId, {
        id: challenge.id,
        contact,
        mobile,
      });
    }
    const codeSent = await this.mailer.sendCitizenOtpEmail(contact, code);
    // Dev only: surface the code in the response itself (below) so
    // local/test runs aren't blocked on real mail delivery — never logged
    // (OTPs, raw phone numbers and addresses must never appear in logs;
    // this is the sole reveal channel, not a redundant one).
    return {
      challengeId: challenge.id,
      expiresAt: expiresAt.toISOString(),
      codeSent,
      code: shouldRevealOtp(codeSent, this.config.nodeEnv) ? code : undefined,
    };
  }

  async verifyOtp(token: string, payload: VerifyOtpPayload): Promise<VerifyOtpResult> {
    const link = await this.findActiveLinkOrThrow(token);
    const challenge = await this.findChallengeOrThrow(link, payload.challengeId);

    if (challenge.verifiedAt) return { verified: true };
    if (challenge.expiresAt.getTime() < Date.now()) {
      throw new GoneException({ error: { code: 'OTP_EXPIRED', message: 'This verification code has expired.' } });
    }
    if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
      throw new BadRequestException({ error: { code: 'OTP_TOO_MANY_ATTEMPTS', message: 'Too many incorrect attempts. Request a new code.' } });
    }

    const matches = await this.passwords.verify(challenge.codeHash, payload.code);
    const changed = await this.tenant.runAsOrg(link.orgId, (tx) =>
      tx.citizenOtpChallenge.updateMany({
        where: {
          id: challenge.id,
          verifiedAt: null,
          consumedAt: null,
          expiresAt: { gt: new Date() },
          attempts: { lt: OTP_MAX_ATTEMPTS },
        },
        data: matches ? { verifiedAt: new Date() } : { attempts: { increment: 1 } },
      }),
    );
    if (changed.count !== 1) {
      throw new BadRequestException({
        error: { code: 'OTP_TOO_MANY_ATTEMPTS', message: 'This verification session can no longer be used.' },
      });
    }
    if (!matches) {
      throw new BadRequestException({ error: { code: 'OTP_INCORRECT', message: 'Incorrect verification code.' } });
    }
    if (payload.sessionId) {
      await this.sessions.recordEvent(link, payload.sessionId, { step: 'OTP_VERIFIED' });
    }
    return { verified: true };
  }

  async submitResponse(token: string, payload: SubmitResponsePayload): Promise<SubmitResponseResult> {
    const link = await this.findActiveLinkOrThrow(token);
    const challenge = await this.findChallengeOrThrow(link, payload.challengeId);
    if (!challenge.verifiedAt) {
      throw new BadRequestException({ error: { code: 'OTP_NOT_VERIFIED', message: 'Verify the OTP code before submitting a response.' } });
    }
    // A verified challenge can only ever submit once — without this, a
    // still-known challengeId (e.g. a re-tapped "Submit" button, or a
    // citizen navigating back) would let the same OTP verification produce
    // multiple SurveyResponse rows.
    if (challenge.consumedAt) {
      throw new BadRequestException({
        error: { code: 'OTP_ALREADY_USED', message: 'This verification code has already been used to submit a response.' },
      });
    }

    // RIO-NFR-002 — resolved before anything is written, and before the OTP
    // challenge is consumed: a submission whose consent can't be pinned to
    // the live notice must fail without burning the respondent's verification
    // (they retry after reloading, rather than needing a fresh code).
    //
    // Throws NO_ACTIVE_CONSENT_POLICY (404) when no citizen notice is
    // published at all. That is deliberately loud: collecting personal data
    // with no consent policy configured is exactly what RIO-NFR-002 forbids,
    // so it fails at the point of misconfiguration instead of quietly
    // recording an unconsented response.
    const activeConsent = await this.consent.getActiveCitizenPolicy();
    if (activeConsent.version !== payload.consent.version) {
      // The citizen's page loaded the notice once and they answered over some
      // minutes; if a System Admin published a new version in that window,
      // this submission agreed to superseded wording. Same reasoning — and
      // the same error code — as signup's stale-consent check.
      throw new BadRequestException({
        error: {
          code: 'CONSENT_VERSION_STALE',
          message:
            'The consent notice was updated while you were answering. Please reload the page, review it, and submit again.',
          details: {
            submittedVersion: payload.consent.version,
            currentVersion: activeConsent.version,
          },
        },
      });
    }
    // Resolved, not echoed: asking for Arabic against an untranslated notice
    // yields the English text, and the record has to say so.
    const consentLocale = resolveConsentLocale(activeConsent, payload.consent.locale);
    // The area picked at registration, from the study's own geography —
    // checked before the challenge is consumed, like the consent above.
    const { options: locationOptions } = await this.tenant.runAsSupervisor((tx) => studyLocations(tx, link.studyId));
    // A study with no geography offers no choice, and so requires none.
    const location = locationOptions.length
      ? (locationOptions.find((o) => o.value === payload.location) ??
        // A page loaded before villages carried their governorate sends
        // "village:<name>": the first village of that name.
        locationOptions.find((o) => o.level === 'VILLAGE' && `village:${o.village[0]}` === payload.location))
      : { label: null, level: 'GOVERNORATE' as const, governorateIds: [], centerIds: [], village: [] };
    if (!location) {
      throw new BadRequestException({
        error: { code: 'LOCATION_INVALID', message: 'Select your area from the list.' },
      });
    }

    const { row, needTitle } = await this.tenant.runAsOrg(link.orgId, async (tx) => {
      // Atomic claim, before any other work — closes a race the plain
      // `if (challenge.consumedAt)` check above can't: two concurrent
      // submits could both pass that check before either write lands.
      // updateMany's where-guard means only one request's write can ever
      // match, so a second concurrent request is rejected here instead of
      // both creating a SurveyResponse row.
      const claimed = await tx.citizenOtpChallenge.updateMany({
        where: { id: challenge.id, verifiedAt: { not: null }, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException({
          error: { code: 'OTP_ALREADY_USED', message: 'This verification code has already been used to submit a response.' },
        });
      }
      // Belt-and-suspenders: also block a second submission from the same
      // contact/mobile for this Need even via a *fresh* OTP request/
      // verification, not just a reused challenge. Scoped to the Need, not
      // the Study — see checkDuplicate's comment. `mobile` is only in the
      // OR when the challenge actually has one (see its nullable comment).
      const existing = await tx.surveyResponse.findFirst({
        where: {
          needId: link.needId,
          OR: [{ contact: challenge.contact }, ...(challenge.mobile ? [{ mobile: challenge.mobile }] : [])],
        },
      });
      if (existing) {
        throw new BadRequestException({
          error: { code: 'DUPLICATE_SUBMISSION', message: 'A response for this need has already been submitted with this contact.' },
        });
      }

      // RIO-FR-011 clarification (Aug 11, confirmed): "an old version cannot
      // accept new responses after a newer version is published." The
      // citizen's page loads its question set once (resolveSurvey, above)
      // and answers over some minutes — if a Researcher publishes a new
      // version in that window, the citizen's already-open page still holds
      // the OLD version's question ids. Without this check, that stale
      // submission would silently succeed and get keyed to the old
      // version's SurveyQuestion rows even though a newer version is now
      // live. Reject it instead — the currently PUBLISHED survey's own
      // question ids are the only ones this submission can legitimately
      // answer against.
      const currentSurvey = await tx.survey.findFirst({
        where: { needId: link.needId, status: 'PUBLISHED' },
        include: { surveyQuestions: { select: { id: true } } },
      });
      if (!currentSurvey) {
        throw new NotFoundException({
          error: { code: 'SURVEY_NOT_PUBLISHED', message: 'This study does not have a published survey yet.' },
        });
      }
      const currentQuestionIds = new Set(currentSurvey.surveyQuestions.map((q) => q.id));
      const submittedIds = Object.keys(payload.answers ?? {});
      if (submittedIds.length > 0 && submittedIds.every((id) => !currentQuestionIds.has(id))) {
        throw new BadRequestException({
          error: {
            code: 'SURVEY_VERSION_CHANGED',
            message: 'This survey was updated while you were answering it. Please reload the page and submit again.',
          },
        });
      }

      // Geography is snapshotted from the Need/Organization at submission
      // time (never asked of the citizen directly) — see the Gender/
      // geography columns' doc comment in schema.prisma. Fetched here, in
      // the same transaction as the create, so the numbers a future
      // governorate/village-wise report reads always match what this Need
      // and org actually had at the moment this response came in.
      const [need, org] = await Promise.all([
        tx.need.findUnique({
          where: { id: link.needId },
          include: { needGovernorates: true, needCenters: true },
        }),
        tx.organisation.findUnique({ where: { id: link.orgId }, select: { regionId: true } }),
      ]);
      const created = await tx.surveyResponse.create({
        data: {
          orgId: link.orgId,
          needId: link.needId,
          studyId: link.studyId,
          surveyLinkId: link.id,
          contact: challenge.contact,
          mobile: challenge.mobile,
          contactName: payload.contactName ?? null,
          gender: payload.gender ?? null,
          ageBracket: payload.ageBracket,
          regionId: org?.regionId ?? null,
          // Placed exactly where the respondent said they live (client, 19
          // Oct 2026): a governorate or centre pick carries no village. Only
          // a study with no geography to choose from falls back to the Need's.
          governorateIds: locationOptions.length
            ? location.governorateIds
            : (need?.needGovernorates.map((g) => g.governorateId) ?? []),
          centerIds: locationOptions.length ? location.centerIds : (need?.needCenters.map((c) => c.centerId) ?? []),
          village: locationOptions.length ? location.village : (need?.village ?? []),
          locationLabel: location.label,
          answers: toJson(payload.answers),
          consentPolicyVersion: activeConsent.version,
          consentPolicyLocale: consentLocale,
          consentedAt: new Date(),
        },
      });
      // Challenge was already atomically claimed (consumedAt set) above —
      // no second write needed here.
      return { row: created, needTitle: need?.title ?? link.needId };
    });
    // RIO-NFR-002 privacy audit: no signed-in actor exists for this request
    // (citizen submissions are unauthenticated), so this is filed under the
    // owning org explicitly with a null actor — the same "explicit org,
    // no ambient context" path AuditService already supports for
    // cross-org admin actions. Contact/answers are never logged in the
    // metadata; only that a submission happened, when, and for which Need.
    // Label the Need by its own title, not its id — the Audit Log is a
    // human-facing screen and a raw UUID tells a reader nothing.
    await this.audit.record({
      action: 'create',
      entityType: 'survey_response',
      entityId: row.id,
      entityLabel: `Survey response submitted for need "${needTitle}"`,
      organizationId: link.orgId,
      // Deliberately metadata-shaped, NOT the submitted content: RIO-NFR-002
      // forbids logging a citizen's answers or contact details. The pair
      // records that a submission arrived and how large it was, which is what
      // an auditor needs, without putting respondent data in the audit log.
      changes: [
        { field: 'Survey response', before: null, after: 'submitted' },
        { field: 'Answers submitted', before: null, after: Array.isArray(payload.answers) ? payload.answers.length : null },
        { field: 'Need', before: null, after: needTitle },
        // The consent version is safe to log where the answers are not: it
        // names a published policy, not anything about the respondent.
        { field: 'Consent version', before: null, after: activeConsent.version },
      ],
      metadata: { consentPolicyVersion: activeConsent.version, consentPolicyLocale: consentLocale },
    });

    // Close the abandonment session against the response it produced —
    // after the transaction, so a session is only ever SUBMITTED when a
    // SurveyResponse row exists to point at. A submission made without a
    // session (tracking failed, or an older client) simply has none; RPT10
    // reports the tracking-coverage gap rather than assuming one.
    if (payload.sessionId) {
      await this.sessions.markSubmitted(link.orgId, payload.sessionId, row.id);
    }

    // RIO-FR-002 (Q14 — survey responses are one of the three cleaned
    // sources). Fire-and-forget with an EXPLICIT orgId for the same reason
    // the scoring calls below take one: this continuation runs detached from
    // an unauthenticated request, so there is no ambient org context to fall
    // back on.
    //
    // The response's own flags carry a masked contact/mobile and no proposed
    // value — see survey-response.rules.ts. A citizen's contact details are
    // not copied into the reviewer's queue.
    this.dataCleaning.cleanSurveyResponse(row.id, link.orgId).catch((err: Error) => {
      this.logger.warn(`Data cleaning failed for survey response ${row.id}: ${err.message}`);
    });

    // Score and rollup asynchronously. Both calls take `orgId` explicitly —
    // this continuation runs detached from the citizen's (unauthenticated)
    // request, so there's no ambient org context for them to fall back to.
    const { studyId, orgId } = row;
    this.scoringEngine.scoreResponse(row.id, orgId).then(async () => {
      const resp = await this.tenant.runAsSupervisor(async (tx) => tx.surveyResponse.findUnique({
        where: { id: row.id },
        include: { need: true }
      }));
      if (resp) {
        const survey = await this.tenant.runAsSupervisor(async (tx) => tx.survey.findFirst({
          where: { needId: resp.needId, status: 'PUBLISHED' }
        }));
        if (survey) {
          const villageId = resp.need.village?.[0] || null;
          await this.rollupService.calculateRollups(studyId, survey.id, villageId, { orgId });
          await this.rollupService.calculateRollups(studyId, survey.id, null, { orgId });
        }
      }
    }).catch((err: Error) => {
      this.logger.error(`Failed to calculate scores for response ${row.id}`, err.stack);
    });

    return { id: row.id, submittedAt: row.submittedAt.toISOString() };
  }

  // "Outside these areas" at registration (client, 19 Oct 2026). The survey
  // ends there, and the record is kept as an excluded response: no answers,
  // never scored, shown in the Core Needs Report's evidence section with the
  // reason "Outside the study geography". No OTP — nothing is answered — but
  // the same consent and one-per-contact rules as a submission.
  async recordOutside(token: string, payload: RecordOutsidePayload): Promise<SubmitResponseResult> {
    const link = await this.findActiveLinkOrThrow(token);
    const activeConsent = await this.consent.getActiveCitizenPolicy();
    if (activeConsent.version !== payload.consent.version) {
      throw new BadRequestException({
        error: {
          code: 'CONSENT_VERSION_STALE',
          message: 'The consent notice was updated. Please reload the page, review it, and try again.',
          details: { submittedVersion: payload.consent.version, currentVersion: activeConsent.version },
        },
      });
    }
    const consentLocale = resolveConsentLocale(activeConsent, payload.consent.locale);
    const contact = this.normalizeContact(payload.contact);
    const mobile = this.normalizeMobile(payload.mobile);

    const row = await this.tenant.runAsOrg(link.orgId, async (tx) => {
      const existing = await tx.surveyResponse.findFirst({
        where: { needId: link.needId, OR: [{ contact }, { mobile }] },
      });
      if (existing) {
        throw new BadRequestException({
          error: { code: 'DUPLICATE_SUBMISSION', message: 'A response for this need has already been submitted with this contact.' },
        });
      }
      const org = await tx.organisation.findUnique({ where: { id: link.orgId }, select: { regionId: true } });
      return tx.surveyResponse.create({
        data: {
          orgId: link.orgId,
          needId: link.needId,
          studyId: link.studyId,
          surveyLinkId: link.id,
          contact,
          mobile,
          contactName: payload.contactName ?? null,
          gender: payload.gender ?? null,
          ageBracket: payload.ageBracket,
          regionId: org?.regionId ?? null,
          answers: toJson({}),
          locationLabel: OUTSIDE_LOCATION_LABEL,
          exclusionReason: OUTSIDE_STUDY_GEOGRAPHY,
          consentPolicyVersion: activeConsent.version,
          consentPolicyLocale: consentLocale,
          consentedAt: new Date(),
        },
      });
    });
    await this.audit.record({
      action: 'create',
      entityType: 'survey_response',
      entityId: row.id,
      entityLabel: 'Survey response recorded as outside the study geography',
      organizationId: link.orgId,
      changes: [
        { field: 'Survey response', before: null, after: 'excluded: outside the study geography' },
        { field: 'Consent version', before: null, after: activeConsent.version },
      ],
      metadata: { consentPolicyVersion: activeConsent.version, consentPolicyLocale: consentLocale },
    });
    if (payload.sessionId) await this.sessions.markSubmitted(link.orgId, payload.sessionId, row.id);
    return { id: row.id, submittedAt: row.submittedAt.toISOString() };
  }

  private async findActiveLinkOrThrow(token: string): Promise<PublicSurveyLinkRow> {
    const link = await this.tenant.runAsSupervisor((tx) =>
      tx.publicSurveyLink.findUnique({ where: { token }, include: { org: true } }),
    );
    if (!link || !link.isActive || !link.org?.isActive) {
      throw new NotFoundException({ error: { code: 'SURVEY_LINK_NOT_FOUND', message: 'This survey link is not available.' } });
    }
    if (link.expiresAt && link.expiresAt.getTime() < Date.now()) {
      throw new GoneException({ error: { code: 'SURVEY_LINK_EXPIRED', message: 'This survey link has expired.' } });
    }
    return link;
  }

  private async findChallengeOrThrow(link: PublicSurveyLinkRow, challengeId: string): Promise<CitizenOtpChallengeRow> {
    const challenge = await this.tenant.runAsSupervisor((tx) => tx.citizenOtpChallenge.findUnique({ where: { id: challengeId } }));
    if (!challenge || challenge.surveyLinkId !== link.id) {
      throw new NotFoundException({ error: { code: 'OTP_CHALLENGE_NOT_FOUND', message: 'Verification session not found.' } });
    }
    return challenge;
  }

  private normalizeContact(contact: string): string {
    return contact.trim().toLowerCase();
  }

  // Strips phone punctuation (spaces, dashes, parens) but keeps the
  // leading '+' and digits — good enough for exact-match dedup/lookup
  // without a full E.164 validator; genuinely malformed numbers just fail
  // at the Unifonic call and soft-fail like any other delivery error.
  private normalizeMobile(mobile: string): string {
    return mobile.trim().replace(/[\s\-()]/g, '');
  }
}

type TxClient = Prisma.TransactionClient;

interface StudyLocation {
  value: string;
  label: string;
  labelAr: string | null;
  level: 'GOVERNORATE' | 'CENTRE' | 'VILLAGE';
  governorateIds: string[];
  centerIds: string[];
  village: string[];
}

/**
 * The public survey's location options (client, 19 Oct 2026): the study's own
 * geography at its lowest defined level. Villages when the study names them,
 * each shown with its governorate so two villages with one name stay apart;
 * then every selected centre, and every governorate, that has nothing listed
 * beneath it — so a resident of a governorate whose villages were never typed
 * still finds their area instead of being pushed to "Outside these areas".
 * A village carries the governorate and centre of the Need that names it.
 */
export async function studyLocations(
  tx: TxClient,
  studyId: string,
): Promise<{ level: StudyLocation['level'] | 'MIXED'; options: StudyLocation[] }> {
  const study = await tx.study.findUnique({
    where: { id: studyId },
    include: {
      studyGovernorates: { include: { governorate: { select: { id: true, name: true, nameAr: true } } } },
      studyCenters: { include: { center: { select: { id: true, name: true, nameAr: true, governorateId: true } } } },
    },
  });
  if (!study) return { level: 'GOVERNORATE', options: [] };
  const govs = (study.studyGovernorates ?? []).map((g) => g.governorate);
  const centres = (study.studyCenters ?? []).map((c) => c.center);
  const govById = new Map(govs.map((g) => [g.id, g]));
  const withGov = (name: string, govId: string | undefined, ar = false) => {
    const g = govId ? govById.get(govId) : undefined;
    const gName = g ? (ar ? (g.nameAr ?? g.name) : g.name) : null;
    return gName ? `${name} — ${gName}` : name;
  };

  const options: StudyLocation[] = [];
  // Governorates and centres that already have an option beneath them.
  const coveredGov = new Set<string>();
  const coveredCentre = new Set<string>();
  // Governorates reached through a listed village — kept apart from
  // coveredGov, which the centre loop below also fills.
  const villageGov = new Set<string>();

  // Villages are recorded on the study or, in the usual flow, on each Need.
  const needs = await tx.need.findMany({
    where: { studyId },
    select: { village: true, needGovernorates: { select: { governorateId: true } }, needCenters: { select: { centerId: true } } },
  });
  // One village is its governorate plus its name, ignoring case and spacing
  // (the Core Needs Report's villageKey): "Al-Jafr" in Al-Ahsa and in Qatif are
  // two options, "Al-Jafr" and "al  jafr" in one governorate are one. A village
  // listed only on the study (no governorate) is added when no Need names it.
  const villages = new Map<string, { name: string; governorateIds: string[]; centerIds: string[] }>();
  for (const n of needs)
    for (const raw of n.village) {
      const name = raw.trim();
      const governorateIds = n.needGovernorates.map((g) => g.governorateId);
      const key = villageKey(governorateIds[0] ?? null, name);
      if (name && !villages.has(key))
        villages.set(key, { name, governorateIds, centerIds: n.needCenters.map((c) => c.centerId) });
    }
  const namedOnNeeds = new Set([...villages.values()].map((v) => villageNameKey(v.name)));
  for (const raw of study.villages ?? []) {
    const name = raw.trim();
    if (name && !namedOnNeeds.has(villageNameKey(name)) && !villages.has(villageKey(null, name)))
      villages.set(villageKey(null, name), { name, governorateIds: [], centerIds: [] });
  }
  for (const { name, governorateIds, centerIds } of villages.values()) {
    governorateIds.forEach((id) => { coveredGov.add(id); villageGov.add(id); });
    centerIds.forEach((id) => coveredCentre.add(id));
    options.push({
      value: `village:${governorateIds[0] ?? ''}:${name}`,
      label: withGov(name, governorateIds[0]),
      // The village name is free text with no Arabic of its own: the page
      // translates the whole label.
      labelAr: null,
      level: 'VILLAGE',
      governorateIds,
      centerIds,
      village: [name],
    });
  }

  // A centre with no listed village under it. When the Needs record no centre
  // at all, a centre counts as covered once its governorate has villages.
  for (const c of centres) {
    const covered = coveredCentre.has(c.id) || (coveredCentre.size === 0 && villageGov.has(c.governorateId));
    if (covered) continue;
    coveredGov.add(c.governorateId);
    options.push({
      value: `centre:${c.id}`,
      label: withGov(c.name, c.governorateId),
      labelAr: c.nameAr ? withGov(c.nameAr, c.governorateId, true) : null,
      level: 'CENTRE',
      governorateIds: [c.governorateId],
      centerIds: [c.id],
      village: [],
    });
  }

  // A governorate with nothing beneath it in the study.
  for (const g of govs) {
    if (coveredGov.has(g.id)) continue;
    options.push({
      value: `gov:${g.id}`,
      label: g.name,
      labelAr: g.nameAr,
      level: 'GOVERNORATE',
      governorateIds: [g.id],
      centerIds: [],
      village: [],
    });
  }

  const levels = new Set(options.map((o) => o.level));
  const level = levels.size === 1 ? [...levels][0]! : levels.size === 0 ? 'GOVERNORATE' : 'MIXED';
  return { level, options };
}
