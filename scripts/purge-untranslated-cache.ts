import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma';
import { rejectTranslation } from '../src/modules/translation/translation-quality';
import type { SupportedLocale } from '../src/modules/translation/translation.types';

/**
 * One-off cleanup for translation_cache rows that are not real translations.
 *
 * ─── What went wrong ────────────────────────────────────────────────────────
 * TranslationService cached whatever the provider answered. When the model
 * returned a string still partly in the source language (most often a long
 * English AI summary coming back half-translated), that answer was cached
 * permanently, and every later view of the same text in Arabic reused it —
 * so the English never went away, even after the provider recovered.
 *
 * TranslationService now runs the answer through rejectTranslation() before
 * caching (translation-quality.ts). This script applies the SAME check to the
 * rows written before that, so a purged string is simply re-translated on its
 * next view.
 *
 * Deletion is safe by construction: the cache holds no source of truth, only
 * a memo of an AI call. The worst outcome of deleting a good row is paying for
 * that one translation again.
 *
 * Dry run by default. Pass --apply to delete.
 */
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const PAGE = 1_000;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const bad: Array<{ cacheKey: string; reason: string; preview: string }> = [];
  let scanned = 0;
  let cursor: string | undefined;

  for (;;) {
    const rows = await prisma.translationCache.findMany({
      select: { cacheKey: true, targetLocale: true, sourceText: true, translatedText: true },
      orderBy: { cacheKey: 'asc' },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { cacheKey: cursor } } : {}),
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      scanned++;
      const reason = rejectTranslation(
        row.sourceText,
        row.translatedText,
        row.targetLocale as SupportedLocale,
      );
      if (reason) {
        bad.push({ cacheKey: row.cacheKey, reason, preview: row.translatedText.slice(0, 80) });
      }
    }
    cursor = rows[rows.length - 1]!.cacheKey;
  }

  const byReason = new Map<string, number>();
  for (const b of bad) byReason.set(b.reason, (byReason.get(b.reason) ?? 0) + 1);
  console.log(`Scanned ${scanned} cached translation(s); ${bad.length} fail the quality check.`);
  for (const [reason, count] of byReason) console.log(`  ${reason}: ${count}`);
  for (const b of bad.slice(0, 10)) console.log(`  e.g. [${b.reason}] ${b.preview}`);

  if (!apply) {
    console.log('Dry run — nothing deleted. Re-run with --apply to delete these rows.');
    return;
  }
  for (let i = 0; i < bad.length; i += PAGE) {
    await prisma.translationCache.deleteMany({
      where: { cacheKey: { in: bad.slice(i, i + PAGE).map((b) => b.cacheKey) } },
    });
  }
  console.log(`Deleted ${bad.length} row(s). They will be re-translated on next view.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
