import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { CitizenService } from './citizen.service';

/**
 * RIO-NFR-002 — a citizen response must be traceable to the exact consent
 * notice its respondent read.
 *
 * Before this change the notice was copy in the frontend bundle and its
 * version a `CONSENT_COPY_VERSION = "1.0"` constant that was rendered and then
 * thrown away: nothing was sent, nothing was stored, and there was no way to
 * answer "which notice did this person agree to?" for any response ever
 * collected. These tests pin the three rules that replace it — the version is
 * required, it is checked against the live policy rather than trusted, and it
 * is stamped onto the row.
 */

const LINK = {
  id: '00000000-0000-0000-0000-0000000000l1',
  orgId: '00000000-0000-0000-0000-0000000000o1',
  needId: '00000000-0000-0000-0000-0000000000n1',
  studyId: '00000000-0000-0000-0000-0000000000s1',
};

const VERIFIED_CHALLENGE = {
  id: '00000000-0000-0000-0000-0000000000c1',
  contact: 'citizen@example.test',
  mobile: '+966500000000',
  verifiedAt: new Date('2026-08-27T10:00:00Z'),
  consumedAt: null,
};

const ACTIVE_NOTICE = {
  kind: 'citizen_consent' as const,
  version: '2.0',
  text: 'Personal Information Consent — English body.',
  textAr: 'إشعار الموافقة — النص العربي.',
};

function makeService(overrides: { activeNotice?: unknown; noticeError?: Error } = {}) {
  const created: Record<string, unknown>[] = [];

  // Only the surface submitResponse actually touches. Everything past the
  // consent check is stubbed to the happy path, so a failure here is
  // unambiguously about consent rather than about survey or dedup logic.
  const tx = {
    citizenOtpChallenge: { updateMany: vi.fn(async () => ({ count: 1 })) },
    surveyResponse: {
      findFirst: vi.fn(async () => null),
      // Read by the fire-and-forget scoring tail that runs after the
      // transaction. Stubbed so that chain resolves quietly instead of
      // emitting unhandled rejections into every test's output.
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'response-1', submittedAt: new Date(), ...data };
      }),
    },
    survey: {
      findFirst: vi.fn(async () => ({
        id: 'survey-1',
        surveyQuestions: [{ id: 'q1' }],
      })),
    },
    need: {
      findUnique: vi.fn(async () => ({
        title: 'Water access',
        village: ['V1'],
        needGovernorates: [],
        needCenters: [],
      })),
    },
    organisation: { findUnique: vi.fn(async () => ({ regionId: null })) },
  };

  const tenant = {
    runAsOrg: async (_org: string, fn: (t: unknown) => unknown) => fn(tx),
    runAsSupervisor: async (fn: (t: unknown) => unknown) => fn(tx),
  };

  const consent = {
    getActiveCitizenPolicy: vi.fn(async () => {
      if (overrides.noticeError) throw overrides.noticeError;
      return overrides.activeNotice ?? ACTIVE_NOTICE;
    }),
  };

  const audit = {
    record: vi.fn(async (_entry: Record<string, unknown>) => undefined),
  };
  const sessions = { markSubmitted: vi.fn(async () => undefined) };

  const svc = new CitizenService(
    tenant as never,
    {} as never, // passwords — unused on this path
    {} as never, // sms
    {} as never, // surveys
    audit as never,
    // Scoring/rollup fire after the transaction and are deliberately
    // fire-and-forget in the service; stubbed so they resolve to nothing
    // rather than being asserted on here.
    { scoreResponse: vi.fn(async () => undefined) } as never,
    { calculateRollups: vi.fn(async () => undefined) } as never,
    sessions as never,
    consent as never,
    // RIO-FR-002 cleaning — fire-and-forget after the transaction, with its
    // own spec. Stubbed so it resolves; these tests are about consent.
    { cleanSurveyResponse: vi.fn(async () => undefined) } as never,
  );

  // The link/challenge lookups hit the DB through private helpers; stubbing
  // them keeps these tests on the consent rules rather than link resolution.
  const priv = svc as unknown as Record<string, unknown>;
  priv.findActiveLinkOrThrow = async () => LINK;
  priv.findChallengeOrThrow = async () => VERIFIED_CHALLENGE;

  return { svc, consent, audit, created };
}

const BASE_PAYLOAD = {
  challengeId: VERIFIED_CHALLENGE.id,
  ageBracket: 'age_25_34' as never,
  answers: { q1: 'yes' },
  consent: { version: '2.0', locale: 'en' as const },
};

describe('CitizenService.submitResponse — consent (RIO-NFR-002)', () => {
  it('stamps the accepted version, locale and timestamp onto the response', async () => {
    const { svc, created } = makeService();

    await svc.submitResponse('token', BASE_PAYLOAD);

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      consentPolicyVersion: '2.0',
      consentPolicyLocale: 'en',
    });
    expect(created[0]!.consentedAt).toBeInstanceOf(Date);
  });

  it('rejects a version that is no longer the live one', async () => {
    // The citizen's page loaded the notice, they answered for ten minutes,
    // and a System Admin published a successor in the meantime. Accepting
    // this would file consent against wording they never saw.
    const { svc, created } = makeService();

    await expect(
      svc.submitResponse('token', {
        ...BASE_PAYLOAD,
        consent: { version: '1.0', locale: 'en' },
      }),
    ).rejects.toMatchObject({
      response: {
        error: {
          code: 'CONSENT_VERSION_STALE',
          details: { submittedVersion: '1.0', currentVersion: '2.0' },
        },
      },
    });
    // Nothing written, and the OTP challenge is left unconsumed so the
    // respondent can reload and submit again without a fresh code.
    expect(created).toHaveLength(0);
  });

  it('refuses to collect anything when no citizen notice is published', async () => {
    const { svc, created } = makeService({
      noticeError: new NotFoundException({
        error: { code: 'NO_ACTIVE_CONSENT_POLICY', message: 'none' },
      }),
    });

    await expect(svc.submitResponse('token', BASE_PAYLOAD)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(created).toHaveLength(0);
  });

  it('records the acceptance as English when Arabic was asked for but untranslated', async () => {
    // Asking for Arabic against a notice with no Arabic copy yields the
    // English text, so labelling the acceptance `ar` would misrepresent what
    // was read — the same rule signup applies.
    const { svc, created } = makeService({
      activeNotice: { ...ACTIVE_NOTICE, textAr: null },
    });

    await svc.submitResponse('token', {
      ...BASE_PAYLOAD,
      consent: { version: '2.0', locale: 'ar' },
    });

    expect(created[0]).toMatchObject({ consentPolicyLocale: 'en' });
  });

  it('keeps the Arabic label when the notice really is translated', async () => {
    const { svc, created } = makeService();

    await svc.submitResponse('token', {
      ...BASE_PAYLOAD,
      consent: { version: '2.0', locale: 'ar' },
    });

    expect(created[0]).toMatchObject({ consentPolicyLocale: 'ar' });
  });

  it('logs the consent version, and still never the respondent contact details', async () => {
    const { svc, audit } = makeService();

    await svc.submitResponse('token', BASE_PAYLOAD);

    const entry = audit.record.mock.calls[0]![0];
    expect(entry.metadata).toMatchObject({ consentPolicyVersion: '2.0' });
    // RIO-NFR-002 forbids putting a citizen's answers or contact details in
    // the audit log; the consent version names a published policy, not a
    // person, which is why it is safe where those are not.
    expect(JSON.stringify(entry)).not.toContain('citizen@example.test');
    expect(JSON.stringify(entry)).not.toContain('+966500000000');
  });
});
