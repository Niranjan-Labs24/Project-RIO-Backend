import { BadRequestException, GoneException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { Prisma } from '../../generated/prisma';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { PasswordService } from '../../auth/password.service';
import { SmsService } from '../../sms/sms.service';
import { AuditService } from '../audit/audit.service';
import { SurveysService } from '../surveys/surveys.service';
import { DeterministicScoringService } from '../priority/scoring.service';
import { ScoreRollupService } from '../priority/rollup.service';
import type {
  CheckDuplicatePayload, CheckDuplicateResult, CitizenOtpChallengeRow, PublicSurveyLinkRow, RequestOtpPayload,
  RequestOtpResult, ResolvedSurvey, SubmitResponsePayload, SubmitResponseResult, VerifyOtpPayload, VerifyOtpResult,
} from './citizen.types';

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const SECONDS_PER_QUESTION = 20;

@Injectable()
export class CitizenService {
  private readonly logger = new Logger(CitizenService.name);

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly passwords: PasswordService,
    private readonly sms: SmsService,
    private readonly surveys: SurveysService,
    private readonly audit: AuditService,
    private readonly scoringEngine: DeterministicScoringService,
    private readonly rollupService: ScoreRollupService,
  ) {}

  // The published Survey Builder survey is the only source of questions for
  // the citizen flow — no placeholder, no fixed seed set. Re-reads fresh on
  // every call (no caching), so if a survey is edited and republished, the
  // very next citizen to open the link sees the latest version.
  async resolveSurvey(token: string): Promise<ResolvedSurvey> {
    const link = await this.findActiveLinkOrThrow(token);
    const [{ study, org }, survey] = await Promise.all([
      this.tenant.runAsSupervisor(async (tx) => ({
        study: await tx.study.findUnique({ where: { id: link.studyId } }),
        org: await tx.organisation.findUnique({ where: { id: link.orgId } }),
      })),
      this.surveys.getPublishedSurveyByNeedId(link.needId),
    ]);

    if (!survey) {
      throw new NotFoundException({
        error: { code: 'SURVEY_NOT_PUBLISHED', message: 'This study does not have a published survey yet.' },
      });
    }

    const questions = survey.questions.map((q: { answerType: string; answerOptions: string[] | null; id: string; questionText: string; isRequired: boolean }) => {
      const { type, options } = this.mapAnswerTypeForCitizen(q.answerType, q.answerOptions);
      return {
        // The SurveyQuestion row's own id — the one identity that exists
        // for both a Question Bank question and an additional one, which
        // has no Question row to key off.
        code: q.id,
        text: q.questionText,
        type,
        options,
        required: q.isRequired,
      };
    });

    return {
      studyId: link.studyId,
      title: survey.title,
      version: survey.id,
      studyTitle: study?.title ?? survey.title,
      organizationName: org?.name ?? "",
      questions,
      questionCount: questions.length,
      estimatedMinutes: Math.max(1, Math.ceil((questions.length * SECONDS_PER_QUESTION) / 60)),
    };
  }

  // Maps Survey Builder's internal answerType vocabulary (Question Bank:
  // select/numeric/boolean/text; additional questions: long_text/
  // short_text/multiple_choice/checkbox/yes_no/rating) onto the citizen
  // flow's rendering type — single_choice (pick one), multi_choice (pick
  // several), scale (1-5), or free text.
  private mapAnswerTypeForCitizen(
    answerType: string,
    answerOptions: string[] | null,
  ): { type: string; options?: string[] } {
    switch (answerType) {
      case 'select':
      case 'multiple_choice':
        return { type: 'single_choice', options: answerOptions ?? [] };
      case 'checkbox':
        return { type: 'multi_choice', options: answerOptions ?? [] };
      case 'boolean':
      case 'yes_no':
        return { type: 'single_choice', options: answerOptions ?? ['Yes', 'No'] };
      case 'rating':
        return { type: 'scale', options: answerOptions ?? ['1', '2', '3', '4', '5'] };
      default:
        return { type: 'text' };
    }
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
    // Mobile-only verification: `contact` (email) is captured for the
    // duplicate check and stored on the eventual SurveyResponse, but never
    // OTP'd — it's additional contact info, not a second verification
    // channel. Deliberately soft-fail, not hard-fail: an earlier version of
    // this rejected the request outright when delivery failed (expiring the
    // challenge + throwing OTP_DELIVERY_FAILED), which stranded a citizen
    // respondent with no way to ever get a code whenever SMS wasn't
    // configured/working.
    const codeTexted = await this.sms.sendOtpCode(payload.mobile, code);
    // Dev only: surface the code in the response itself (below) so
    // local/test runs aren't blocked on a real phone when delivery fails —
    // never logged (OTPs and raw phone numbers must never appear in logs;
    // this is the sole reveal channel, not a redundant one).
    return {
      challengeId: challenge.id,
      expiresAt: expiresAt.toISOString(),
      codeTexted,
      code: !codeTexted && process.env.NODE_ENV !== 'production' ? code : undefined,
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
          regionId: org?.regionId ?? null,
          governorateIds: need?.needGovernorates.map((g) => g.governorateId) ?? [],
          centerIds: need?.needCenters.map((c) => c.centerId) ?? [],
          village: need?.village ?? [],
          answers: payload.answers as unknown as Prisma.InputJsonValue,
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

  private async findActiveLinkOrThrow(token: string): Promise<PublicSurveyLinkRow> {
    const link = await this.tenant.runAsSupervisor((tx) => tx.publicSurveyLink.findUnique({ where: { token } }));
    if (!link || !link.isActive) {
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
