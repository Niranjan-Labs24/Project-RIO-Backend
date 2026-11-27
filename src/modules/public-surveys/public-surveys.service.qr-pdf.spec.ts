import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { PublicSurveysService } from './public-surveys.service';

// UAT DST-03 — the survey link's QR code as a PDF. Uses the real QR encoder
// (unlike the links spec, which mocks it for the email PNG).
function setup(link: Record<string, unknown> | null = { id: 'l1', needId: 'n1', label: 'Wave 1', token: 'tok' }) {
  const tx = {
    need: { findUnique: vi.fn().mockResolvedValue({ id: 'n1', title: 'Distance to a health facility' }) },
    publicSurveyLink: { findUnique: vi.fn().mockResolvedValue(link) },
  };
  const tenant = {
    runRead: async (fn: (t: unknown) => unknown) => fn(tx),
    runInOrgContext: async (fn: (t: unknown) => unknown) => fn(tx),
  };
  const translation = {
    translate: vi.fn().mockResolvedValue({ translatedText: 'المسافة إلى مرفق صحي', unchanged: false }),
  };
  const svc = new PublicSurveysService(
    tenant as never,
    { publicAppUrl: 'https://app.test' } as never,
    { record: vi.fn() } as never,
    { sendSurveyLink: vi.fn() } as never,
    translation as never,
  );
  return { svc, translation };
}

describe('PublicSurveysService.linkQrPdf (UAT DST-03)', () => {
  it('returns a one-page PDF in English without translating the title', async () => {
    const { svc, translation } = setup();
    const pdf = await svc.linkQrPdf('n1', 'l1', 'en');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('/Count 1');
    expect(translation.translate).not.toHaveBeenCalled();
  });

  it('uses the Arabic title for an Arabic PDF', async () => {
    const { svc, translation } = setup();
    const pdf = await svc.linkQrPdf('n1', 'l1', 'ar');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(translation.translate).toHaveBeenCalledWith('Distance to a health facility', 'ar');
  });

  it('404s a link that does not exist or belongs to another need', async () => {
    await expect(setup(null).svc.linkQrPdf('n1', 'l1', 'en')).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      setup({ id: 'l1', needId: 'other', label: 'x', token: 't' }).svc.linkQrPdf('n1', 'l1', 'en'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
