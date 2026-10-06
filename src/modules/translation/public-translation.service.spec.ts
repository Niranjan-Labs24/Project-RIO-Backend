import { describe, expect, it, vi } from 'vitest';
import { containsPublicText, PublicTranslationService } from './public-translation.service';
import type { CitizenService } from '../citizen/citizen.service';
import type { PublicArchiveService } from '../archive/public-archive.service';
import type { TranslationService } from './translation.service';

function setup() {
  const citizen = {
    resolveSurvey: vi
      .fn()
      .mockResolvedValue({ questions: [{ text: 'Public question', textAr: 'سؤال عام' }] }),
  };
  const archive = {
    list: vi.fn().mockResolvedValue({ entries: [{ title: 'Published title' }] }),
    detail: vi
      .fn()
      .mockResolvedValue({ report: { content: { executiveSummary: 'Public narrative' } } }),
    document: vi.fn().mockResolvedValue({ view: { pages: [{ text: 'Public document text' }] } }),
  };
  const translation = {
    translate: vi.fn().mockResolvedValue({ translatedText: 'مترجم' }),
    translateMany: vi.fn(async (texts: string[]) => texts.map(() => ({ translatedText: 'مترجم' }))),
  };
  const service = new PublicTranslationService(
    citizen as unknown as CitizenService,
    archive as unknown as PublicArchiveService,
    translation as unknown as TranslationService,
    { listActiveNames: vi.fn().mockResolvedValue([{ name: 'Health' }]) } as never,
    {
      listRegions: vi.fn().mockResolvedValue([]),
      listGovernorates: vi.fn().mockResolvedValue([]),
      listCenters: vi.fn().mockResolvedValue([]),
    } as never,
    { listOrganizations: vi.fn().mockResolvedValue([]) } as never,
    { client: undefined } as never,
  );
  return { citizen, archive, translation, service };
}
describe('public resource translation', () => {
  it('resolves survey access before translating canonical question text', async () => {
    const { service, citizen, translation } = setup();
    await service.translate({
      scope: { type: 'survey', token: 'valid' },
      text: 'Public question',
      targetLocale: 'ar',
    });
    expect(citizen.resolveSurvey).toHaveBeenCalledWith('valid');
    expect(translation.translate).toHaveBeenCalledWith('Public question', 'ar');
  });
  it('translates only publicly listed registration reference values', async () => {
    const { service } = setup();
    await expect(
      service.translate({ scope: { type: 'reference' }, text: 'Health', targetLocale: 'ar' }),
    ).resolves.toBeDefined();
    await expect(
      service.translate({ scope: { type: 'reference' }, text: 'Secret NGO', targetLocale: 'ar' }),
    ).rejects.toThrow();
  });
  it('supports reverse translation of stored Arabic content', async () => {
    const { service, translation } = setup();
    await service.translate({
      scope: { type: 'survey', token: 'valid' },
      text: 'سؤال عام',
      targetLocale: 'en',
    });
    expect(translation.translate).toHaveBeenCalledWith('سؤال عام', 'en');
  });
  it('rejects arbitrary text even with a valid public link', async () => {
    const { service, translation } = setup();
    await expect(
      service.translate({
        scope: { type: 'survey', token: 'valid' },
        text: 'Private unrelated prompt',
        targetLocale: 'ar',
      }),
    ).rejects.toThrow();
    expect(translation.translate).not.toHaveBeenCalled();
  });
  it('does not translate expired or inaccessible resources', async () => {
    const { service, citizen, translation } = setup();
    citizen.resolveSurvey.mockRejectedValue(new Error('Expired'));
    await expect(
      service.translate({
        scope: { type: 'survey', token: 'expired' },
        text: 'Public question',
        targetLocale: 'ar',
      }),
    ).rejects.toThrow('Expired');
    expect(translation.translate).not.toHaveBeenCalled();
  });
  it('permits only released archive data and its humanised field labels', async () => {
    const { service, archive } = setup();
    await service.translate({
      scope: { type: 'archive-list' },
      text: 'Published title',
      targetLocale: 'ar',
    });
    await service.translate({
      scope: { type: 'archive-detail', kind: 'report', id: 'released' },
      text: 'Executive summary',
      targetLocale: 'ar',
    });
    expect(archive.detail).toHaveBeenCalledWith('report', 'released');
  });
  it('supports document chunks but never resolves a private storage key', async () => {
    const { service, archive } = setup();
    await service.translate({
      scope: { type: 'archive-document', id: 'released' },
      text: 'document text',
      targetLocale: 'ar',
    });
    expect(archive.document).toHaveBeenCalledWith('released');
  });
  it('does not accept empty text or invent content absent from the resource', () => {
    expect(containsPublicText({ title: 'Hello' }, '')).toBe(false);
    expect(containsPublicText({ title: 'Hello' }, 'unpublished')).toBe(false);
  });
  it('accepts an enum value in the words the public report shows it as', () => {
    expect(containsPublicText({ domainKey: 'CROSS_DOMAIN_FACTS' }, 'Cross domain facts')).toBe(
      true,
    );
    expect(containsPublicText({ domainKey: 'CROSS_DOMAIN_FACTS' }, 'Cross domain secrets')).toBe(
      false,
    );
  });
  it('translates a batch against one load of the resource, nulling text it does not hold', async () => {
    const { service, archive, translation } = setup();
    const out = await service.translateBatch(
      {
        scope: { type: 'archive-detail', kind: 'report', id: 'released' },
        texts: ['Public narrative', 'Private unrelated prompt', 'Executive summary'],
        targetLocale: 'ar',
      },
      '10.0.0.1',
    );
    expect(archive.detail).toHaveBeenCalledTimes(1);
    expect(out[0]).toEqual({ translatedText: 'مترجم' });
    expect(out[1]).toBeNull();
    expect(out[2]).toEqual({ translatedText: 'مترجم' });
    expect(translation.translateMany).toHaveBeenCalledWith(
      ['Public narrative', 'Executive summary'],
      'ar',
    );
    expect(translation.translate).not.toHaveBeenCalled();
  });
  it('translates duplicate inputs once and maps the answer back to every position', async () => {
    const { service, translation } = setup();
    const out = await service.translateBatch(
      {
        scope: { type: 'archive-detail', kind: 'report', id: 'released' },
        texts: Array(50).fill('Public narrative'),
        targetLocale: 'ar',
      },
      '10.0.0.2',
    );
    expect(translation.translateMany).toHaveBeenCalledTimes(1);
    expect(translation.translateMany).toHaveBeenCalledWith(['Public narrative'], 'ar');
    expect(out).toHaveLength(50);
    expect(out.every((r) => r?.translatedText === 'مترجم')).toBe(true);
  });
  it('refuses a batch over the character limit before doing any work', async () => {
    const { service, archive, translation } = setup();
    const big = Array.from({ length: 5 }, (_, i) => `${i}`.repeat(4_500));
    await expect(
      service.translateBatch(
        {
          scope: { type: 'archive-detail', kind: 'report', id: 'released' },
          texts: big,
          targetLocale: 'ar',
        },
        '10.0.0.3',
      ),
    ).rejects.toMatchObject({ response: { error: { code: 'PUBLIC_TRANSLATION_TOO_LARGE' } } });
    expect(archive.detail).not.toHaveBeenCalled();
    expect(translation.translateMany).not.toHaveBeenCalled();
  });
  it('stops one IP once its character budget is spent, across requests', async () => {
    const { service, archive, translation } = setup();
    const long = 'Public narrative '.repeat(1_000).trim();
    archive.detail.mockResolvedValue({ report: { content: { executiveSummary: long } } });
    const body = {
      scope: { type: 'archive-detail' as const, kind: 'report' as const, id: 'released' },
      texts: [long.slice(0, 4_900)],
      targetLocale: 'ar' as const,
    };
    let refused = 0;
    for (let i = 0; i < 20; i++) {
      await service.translateBatch(body, '10.0.0.4').catch((e: { getStatus: () => number }) => {
        expect(e.getStatus()).toBe(429);
        refused++;
      });
    }
    // 60,000 characters per minute = 12 requests of 4,900.
    expect(translation.translateMany).toHaveBeenCalledTimes(12);
    expect(refused).toBe(8);
    // Another client is unaffected.
    await expect(service.translateBatch(body, '10.0.0.5')).resolves.toBeDefined();
  });
});
