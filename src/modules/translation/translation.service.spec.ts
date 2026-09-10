import { describe, it, expect, vi } from 'vitest';
import { TranslationService } from './translation.service';

type CacheRow = {
  cacheKey: string;
  sourceLocale: string;
  targetLocale: string;
  sourceText: string;
  translatedText: string;
};

/**
 * Fakes just enough of PrismaService for these tests: an in-memory map
 * keyed by cacheKey, backing `translationCache.findUnique`/`upsert` — the
 * same "in-memory row store behind the real delegate shape" pattern used in
 * need-summary.service.spec.ts.
 */
function makeService(opts: {
  aiResponse?: { translatedText: string };
  aiThrows?: Error;
  seeded?: CacheRow[];
  upsertThrows?: Error;
} = {}) {
  const rows = new Map<string, CacheRow>((opts.seeded ?? []).map((r) => [r.cacheKey, r]));
  const runSpy = vi.fn(async () => {
    if (opts.aiThrows) throw opts.aiThrows;
    return { response: opts.aiResponse ?? { translatedText: 'translated' } };
  });

  const prisma = {
    translationCache: {
      findUnique: async ({ where: { cacheKey } }: { where: { cacheKey: string } }) =>
        rows.get(cacheKey) ?? null,
      upsert: async ({ where: { cacheKey }, create }: { where: { cacheKey: string }; create: CacheRow }) => {
        if (opts.upsertThrows) throw opts.upsertThrows;
        const row = { ...create };
        rows.set(cacheKey, row);
        return row;
      },
    },
  } as never;

  const ai = { run: runSpy } as never;
  const service = new TranslationService(prisma, ai);
  return { service, runSpy, rows };
}

describe('TranslationService.detectLocale', () => {
  it('detects Arabic script', () => {
    const { service } = makeService();
    expect(service.detectLocale('الصحة')).toBe('ar');
  });

  it('detects English as the default for Latin text', () => {
    const { service } = makeService();
    expect(service.detectLocale('Health')).toBe('en');
  });

  it('treats mixed Arabic+Latin text as Arabic-authored', () => {
    const { service } = makeService();
    expect(service.detectLocale('Health الصحة')).toBe('ar');
  });
});

describe('TranslationService.translate', () => {
  it('short-circuits without calling AI when source already matches target', async () => {
    const { service, runSpy } = makeService();
    const result = await service.translate('Health', 'en');
    expect(result).toEqual({ translatedText: 'Health', sourceLocale: 'en', targetLocale: 'en', unchanged: true });
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('short-circuits without calling AI when the text has no letters to translate', async () => {
    const { service, runSpy } = makeService();
    const result = await service.translate('12345', 'ar');
    expect(result.unchanged).toBe(true);
    expect(result.translatedText).toBe('12345');
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('calls AI and stores the result on a cache miss', async () => {
    const { service, runSpy, rows } = makeService({ aiResponse: { translatedText: 'الصحة' } });
    const result = await service.translate('Health', 'ar');
    expect(result).toEqual({ translatedText: 'الصحة', sourceLocale: 'en', targetLocale: 'ar', unchanged: false });
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(rows.size).toBe(1);
  });

  it('returns the cached translation without calling AI on a cache hit', async () => {
    const seeded: CacheRow = {
      cacheKey: 'x',
      sourceLocale: 'en',
      targetLocale: 'ar',
      sourceText: 'Health',
      translatedText: 'الصحة (cached)',
    };
    // Force the same cache key the service itself would compute, by seeding
    // via a first real call, then asserting the second call reuses it.
    const first = makeService({ aiResponse: { translatedText: 'الصحة (cached)' } });
    await first.service.translate('Health', 'ar');
    const seededRows = [...first.rows.values()];
    expect(seededRows).toEqual([seeded].map((r) => ({ ...r, cacheKey: seededRows[0]!.cacheKey })));

    const { service, runSpy } = makeService({ seeded: seededRows });
    const result = await service.translate('Health', 'ar');
    expect(result).toEqual({
      translatedText: 'الصحة (cached)',
      sourceLocale: 'en',
      targetLocale: 'ar',
      unchanged: false,
    });
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('falls back to the original text when the AI call fails, without throwing', async () => {
    const { service, rows } = makeService({ aiThrows: new Error('provider down') });
    const result = await service.translate('Health', 'ar');
    expect(result).toEqual({ translatedText: 'Health', sourceLocale: 'en', targetLocale: 'ar', unchanged: true });
    expect(rows.size).toBe(0);
  });

  it('respects an explicit sourceLocale hint instead of auto-detecting', async () => {
    const { service, runSpy } = makeService({ aiResponse: { translatedText: 'Health' } });
    // Text has no Arabic script, but caller says it's Arabic anyway (e.g. a
    // transliterated proper noun) — the hint must win over detection.
    const result = await service.translate('Sihha', 'en', 'ar');
    expect(result.sourceLocale).toBe('ar');
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it('produces the same cache key for the same text regardless of call order (content-addressed, not per-field)', async () => {
    const { service, runSpy, rows } = makeService({ aiResponse: { translatedText: 'الصحة' } });
    await service.translate('Health', 'ar');
    await service.translate('Health', 'ar');
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(rows.size).toBe(1);
  });

  it('still returns the real AI translation when caching it fails, rather than failing the whole request', async () => {
    // Regression test: a real permission bug (missing UPDATE grant on
    // translation_cache — see the 20260908114700 migration) made this
    // upsert throw on every call, which — before this fix — propagated
    // out of translate() uncaught, 500'd the endpoint, and made the
    // frontend's own catch-all silently fall back to the untranslated
    // text. The AI-produced translation must survive even if it can
    // never be cached.
    const { service, rows } = makeService({
      aiResponse: { translatedText: 'الصحة' },
      upsertThrows: new Error('permission denied for table translation_cache'),
    });
    const result = await service.translate('Health', 'ar');
    expect(result).toEqual({ translatedText: 'الصحة', sourceLocale: 'en', targetLocale: 'ar', unchanged: false });
    expect(rows.size).toBe(0);
  });
});
