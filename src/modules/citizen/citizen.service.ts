import { BadRequestException, GoneException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { Prisma } from '../../generated/prisma';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { PasswordService } from '../../auth/password.service';
import { MailerService } from '../../mailer/mailer.service';
import { getSurveyDefinition } from '../survey-definition/survey-definition.placeholder';
import type {
  CheckDuplicatePayload, CheckDuplicateResult, CitizenOtpChallengeRow, PublicSurveyLinkRow, RequestOtpPayload,
  RequestOtpResult, ResolvedSurvey, SubmitResponsePayload, SubmitResponseResult, VerifyOtpPayload, VerifyOtpResult,
} from './citizen.types';

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
// Matches the constant the frontend flow previously hardcoded client-side —
// now computed once here so the Welcome screen's estimate and the actual
// per-question pacing can never drift apart.
const SECONDS_PER_QUESTION = 20;

// Every route on this service is unauthenticated (no signed-in actor, no
// ambient org context) — the owning org is resolved from the link token via
// the cross-org SELECT-only supervisor connection, then every subsequent
// write goes through TenantPrismaService.runAsOrg(resolvedOrgId, ...), the
// same RLS-safe technique the org-creation bootstrap path already uses.
// See the PublicSurveyLink model comment in schema.prisma.
@Injectable()
export class CitizenService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly passwords: PasswordService,
    private readonly mailer: MailerService,
  ) {}

  async resolveSurvey(token: string): Promise<ResolvedSurvey> {
    const link = await this.findActiveLinkOrThrow(token);
    const definition = getSurveyDefinition(link.studyId);
    const { study, org } = await this.tenant.runAsSupervisor(async (tx) => ({
      study: await tx.study.findUnique({ where: { id: link.studyId } }),
      org: await tx.organisation.findUnique({ where: { id: link.orgId } }),
    }));
    return {
      studyId: link.studyId,
      title: definition.title,
      version: definition.version,
      studyTitle: study?.title ?? definition.title,
      organizationName: org?.name ?? "",
      questions: definition.questions,
      questionCount: definition.questions.length,
      estimatedMinutes: Math.max(1, Math.ceil((definition.questions.length * SECONDS_PER_QUESTION) / 60)),
    };
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
    const contact = this.normalizeContact(payload.contact);
    const existing = await this.tenant.runAsSupervisor((tx) =>
      tx.surveyResponse.findFirst({ where: { studyId: link.studyId, contact } }),
    );
    return { isDuplicate: existing !== null };
  }

  async requestOtp(token: string, payload: RequestOtpPayload): Promise<RequestOtpResult> {
    const link = await this.findActiveLinkOrThrow(token);
    const contact = this.normalizeContact(payload.contact);
    const code = randomInt(100_000, 999_999).toString();
    const codeHash = await this.passwords.hash(code);
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    const challenge = await this.tenant.runAsOrg(link.orgId, (tx) =>
      tx.citizenOtpChallenge.create({
        data: { orgId: link.orgId, surveyLinkId: link.id, contact, codeHash, expiresAt },
      }),
    );
    const delivered = await this.mailer.sendOtpCode(payload.contact, code);
    if (!delivered) {
      await this.tenant.runAsOrg(link.orgId, (tx) =>
        tx.citizenOtpChallenge.update({ where: { id: challenge.id }, data: { expiresAt: new Date() } }),
      );
      throw new ServiceUnavailableException({
        error: { code: 'OTP_DELIVERY_FAILED', message: 'We could not send a verification code. Please try again.' },
      });
    }
    // Dev only: surface the code so local/test runs aren't blocked on a
    // real inbox — same convention as OrganizationsService.createWithAdmin's
    // temp-password console.log.
    if (process.env.NODE_ENV !== 'production') {
      console.log(`OTP code for ${payload.contact} (challenge ${challenge.id}): ${code}`);
    }
    return { challengeId: challenge.id, expiresAt: expiresAt.toISOString() };
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

    const row = await this.tenant.runAsOrg(link.orgId, async (tx) => {
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
      // contact for this study even via a *fresh* OTP request/verification,
      // not just a reused challenge.
      const existing = await tx.surveyResponse.findFirst({
        where: { studyId: link.studyId, contact: challenge.contact },
      });
      if (existing) {
        throw new BadRequestException({
          error: { code: 'DUPLICATE_SUBMISSION', message: 'A response for this study has already been submitted with this contact.' },
        });
      }

      const created = await tx.surveyResponse.create({
        data: {
          orgId: link.orgId,
          studyId: link.studyId,
          surveyLinkId: link.id,
          contact: challenge.contact,
          contactName: payload.contactName ?? null,
          answers: payload.answers as unknown as Prisma.InputJsonValue,
        },
      });
      return created;
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
}
