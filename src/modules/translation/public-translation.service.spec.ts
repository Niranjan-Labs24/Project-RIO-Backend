import { describe, expect, it, vi } from 'vitest';
import { containsPublicText, PublicTranslationService } from './public-translation.service';
import type { CitizenService } from '../citizen/citizen.service';
import type { PublicArchiveService } from '../archive/public-archive.service';
import type { TranslationService } from './translation.service';

function setup() {
  const citizen = { resolveSurvey: vi.fn().mockResolvedValue({ questions: [{ text: 'Public question', textAr: 'سؤال عام' }] }) };
  const archive = {
    list: vi.fn().mockResolvedValue({ entries: [{ title: 'Published title' }] }),
    detail: vi.fn().mockResolvedValue({ report: { content: { executiveSummary: 'Public narrative' } } }),
    document: vi.fn().mockResolvedValue({ view: { pages: [{ text: 'Public document text' }] } }),
  };
  const translation = { translate: vi.fn().mockResolvedValue({ translatedText: 'مترجم' }) };
  const service = new PublicTranslationService(citizen as unknown as CitizenService, archive as unknown as PublicArchiveService, translation as unknown as TranslationService, { listActiveNames: vi.fn().mockResolvedValue([{ name: "Health" }]) } as never, { listRegions: vi.fn().mockResolvedValue([]), listGovernorates: vi.fn().mockResolvedValue([]), listCenters: vi.fn().mockResolvedValue([]) } as never, { listOrganizations: vi.fn().mockResolvedValue([]) } as never);
  return { citizen, archive, translation, service };
}
describe('public resource translation', () => {
  it('resolves survey access before translating canonical question text', async () => {
    const { service, citizen, translation } = setup();
    await service.translate({ scope: { type: 'survey', token: 'valid' }, text: 'Public question', targetLocale: 'ar' });
    expect(citizen.resolveSurvey).toHaveBeenCalledWith('valid');
    expect(translation.translate).toHaveBeenCalledWith('Public question', 'ar');
  });
  it('translates only publicly listed registration reference values', async () => {
    const { service } = setup();
    await expect(service.translate({ scope: { type: 'reference' }, text: 'Health', targetLocale: 'ar' })).resolves.toBeDefined();
    await expect(service.translate({ scope: { type: 'reference' }, text: 'Secret NGO', targetLocale: 'ar' })).rejects.toThrow();
  });
  it('supports reverse translation of stored Arabic content', async () => {
    const { service, translation } = setup();
    await service.translate({ scope: { type: 'survey', token: 'valid' }, text: 'سؤال عام', targetLocale: 'en' });
    expect(translation.translate).toHaveBeenCalledWith('سؤال عام', 'en');
  });
  it('rejects arbitrary text even with a valid public link', async () => {
    const { service, translation } = setup();
    await expect(service.translate({ scope: { type: 'survey', token: 'valid' }, text: 'Private unrelated prompt', targetLocale: 'ar' })).rejects.toThrow();
    expect(translation.translate).not.toHaveBeenCalled();
  });
  it('does not translate expired or inaccessible resources', async () => {
    const { service, citizen, translation } = setup();
    citizen.resolveSurvey.mockRejectedValue(new Error('Expired'));
    await expect(service.translate({ scope: { type: 'survey', token: 'expired' }, text: 'Public question', targetLocale: 'ar' })).rejects.toThrow('Expired');
    expect(translation.translate).not.toHaveBeenCalled();
  });
  it('permits only released archive data and its humanised field labels', async () => {
    const { service, archive } = setup();
    await service.translate({ scope: { type: 'archive-list' }, text: 'Published title', targetLocale: 'ar' });
    await service.translate({ scope: { type: 'archive-detail', kind: 'report', id: 'released' }, text: 'Executive summary', targetLocale: 'ar' });
    expect(archive.detail).toHaveBeenCalledWith('report', 'released');
  });
  it('supports document chunks but never resolves a private storage key', async () => {
    const { service, archive } = setup();
    await service.translate({ scope: { type: 'archive-document', id: 'released' }, text: 'document text', targetLocale: 'ar' });
    expect(archive.document).toHaveBeenCalledWith('released');
  });
  it('does not accept empty text or invent content absent from the resource', () => {
    expect(containsPublicText({ title: 'Hello' }, '')).toBe(false);
    expect(containsPublicText({ title: 'Hello' }, 'unpublished')).toBe(false);
  });
});
