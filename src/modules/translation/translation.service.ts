import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { buildContentTranslationTask } from '../ai/prompts/content-translation.task';
import type { SupportedLocale, TranslateContentResult } from './translation.types';

// Arabic block (U+0600–06FF), Arabic Supplement (U+0750–077F), Arabic
// Extended-A (U+08A0–08FF), and the Arabic presentation-forms blocks
// (U+FB50–FDFF, U+FE70–FEFF) — written as explicit \u{...} code-point
// escapes rather than pasted Arabic characters, so this survives any
// editor/encoding round-trip unambiguously. Enough to tell "this string is
// written in Arabic" from "this string is written in English" for the
// free-text content this service actually sees (Need titles/statements,
// evidence descriptions, decision notes, sharing purposes, ...) — it does
// not need to be a general-purpose language detector for the whole
// Unicode standard.
const ARABIC_SCRIPT_RE = /[\u{0600}-\u{06FF}\u{0750}-\u{077F}\u{08A0}-\u{08FF}\u{FB50}-\u{FDFF}\u{FE70}-\u{FEFF}]/u;
// At least one letter in either script — a string with no letters at all
// (a number, a code, punctuation, whitespace) has no language to translate.
const HAS_LETTERS_RE = /[\u{0600}-\u{06FF}\u{0750}-\u{077F}\u{08A0}-\u{08FF}\u{FB50}-\u{FDFF}\u{FE70}-\u{FEFF}A-Za-z]/u;

/**
 * RIO Arabic Localization — Approach 3 (Hybrid), client-confirmed
 * 2026-09-08. The dynamic-content half of the hybrid approach: translates
 * one piece of user-typed text on demand the first time it needs to be
 * shown in the other language, and stores the result permanently
 * (TranslationCache) so the same source string is never translated twice —
 * see the schema model's comment for the cost/consistency reasoning.
 *
 * Deliberately provider-agnostic at this layer: it calls AiService, which
 * is what actually decides Cohere-on-OCI vs. Gemini (AI_PROVIDER). This
 * service does not know or care which one answers.
 */
@Injectable()
export class TranslationService {
  private readonly logger = new Logger(TranslationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
  ) {}

  /** Arabic script present anywhere in the string wins — a mixed string
   * (e.g. an Arabic sentence naming an English acronym) is Arabic-authored
   * content, not English with foreign characters in it. Still used to LABEL
   * a string's dominant script (cache key, response metadata) — but see
   * `needsTranslation` below for the separate question of whether a string
   * has anything left to translate. */
  detectLocale(text: string): SupportedLocale {
    return ARABIC_SCRIPT_RE.test(text) ? 'ar' : 'en';
  }

  /** Whether `text` still has any content in the OPPOSITE script from
   * `targetLocale` — not the same question as `detectLocale`'s "which
   * script dominates". A backend-generated string that concatenates a
   * fixed English template with a dynamic value that already happens to be
   * Arabic (e.g. a report title, "Individual Survey Report — Survey:
   * <Arabic need name>") is majority-Arabic by character count, so
   * `detectLocale` calls it 'ar' — but the English template portion is
   * still untranslated. Using `sourceLocale === targetLocale` as the skip
   * condition (as this used to) left that English half stuck forever: once
   * any Arabic appeared anywhere in the string, the whole string looked
   * "already Arabic" and translation was skipped. Checking for the
   * opposite script directly, instead of comparing two single-locale
   * labels, catches genuinely mixed-script strings on both directions.
   *
   * Only for the auto-detect path. A caller-supplied `sourceLocaleHint`
   * (e.g. "this is a transliterated Arabic proper noun with no Arabic
   * script at all") is trusted outright — script-sniffing the text would
   * second-guess information the caller has and this function doesn't. */
  private needsTranslation(text: string, targetLocale: SupportedLocale): boolean {
    if (!HAS_LETTERS_RE.test(text)) return false;
    return targetLocale === 'ar' ? /[A-Za-z]/.test(text) : ARABIC_SCRIPT_RE.test(text);
  }

  async translate(
    text: string,
    targetLocale: SupportedLocale,
    sourceLocaleHint?: SupportedLocale,
  ): Promise<TranslateContentResult> {
    const sourceLocale = sourceLocaleHint ?? this.detectLocale(text);

    const skip = sourceLocaleHint
      ? sourceLocaleHint === targetLocale
      : !this.needsTranslation(text, targetLocale);
    if (skip) {
      return { translatedText: text, sourceLocale, targetLocale, unchanged: true };
    }

    const cacheKey = this.cacheKeyFor(sourceLocale, targetLocale, text);
    const cached = await this.prisma.translationCache.findUnique({ where: { cacheKey } });
    if (cached) {
      return {
        translatedText: cached.translatedText,
        sourceLocale,
        targetLocale,
        unchanged: false,
      };
    }

    // The prompt's source language is always the OPPOSITE of targetLocale,
    // not `sourceLocale` (which labels the string's dominant script and can
    // itself equal targetLocale for a mixed string, per `needsTranslation`
    // above) — telling the model "translate from Arabic to Arabic" for a
    // majority-Arabic-but-still-partly-English string made it a same-
    // language no-op under the prompt's own "already in target" rule,
    // leaving the English portion stuck untranslated forever.
    const promptSourceLocale: SupportedLocale =
      sourceLocaleHint ?? (targetLocale === 'ar' ? 'en' : 'ar');
    const task = buildContentTranslationTask(promptSourceLocale, targetLocale);
    let translatedText: string;
    try {
      const { response } = await this.ai.run(task, text);
      translatedText = response.translatedText;
    } catch (err) {
      // Best-effort: a translation failure (AI down, rate-limited, not
      // configured) falls back to showing the original text rather than
      // breaking the page it's embedded in — same "manual mode" philosophy
      // AiService itself uses when a provider key is missing.
      this.logger.warn(
        `Translation ${sourceLocale}->${targetLocale} failed, returning source text: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { translatedText: text, sourceLocale, targetLocale, unchanged: true };
    }

    // `upsert`, not `create`: two concurrent requests for the same
    // never-before-seen string can both miss the cache above and both call
    // the AI provider — temperature 0 means they compute the same answer
    // either way, so the second write just re-confirms the first rather
    // than needing special race handling.
    try {
      await this.prisma.translationCache.upsert({
        where: { cacheKey },
        create: { cacheKey, sourceLocale, targetLocale, sourceText: text, translatedText },
        update: { translatedText },
      });
    } catch (err) {
      // A caching failure must never fail the translation itself — a real
      // instance of exactly this (a missing UPDATE grant on this table,
      // fixed in the 20260908114700 migration) previously made every
      // translation request 500 after already paying for the AI call,
      // which the caller's own catch-all then silently downgraded to
      // "just show the untranslated text" — the AI-generated translation
      // above is real and correct; only permanent caching is lost. Worst
      // case here is re-translating this string next time, not breaking
      // the feature outright.
      this.logger.warn(
        `Failed to cache translation ${sourceLocale}->${targetLocale}, continuing without it: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return { translatedText, sourceLocale, targetLocale, unchanged: false };
  }

  /**
   * Cached translations for many strings in ONE query.
   *
   * `translate()` is the right shape for a handful of strings, but the report
   * export asks about ~150 at a time, and a `findUnique` each turned a fully
   * cached Arabic export into 8.6 seconds of sequential round trips — with
   * nothing to show for them, since every answer was already stored. One
   * `findMany` over the same keys does it in a single trip.
   *
   * Returns only what is already cached. The caller translates the misses
   * through `translate()` as before, so nothing about cost or correctness
   * changes — only the number of queries.
   */
  async cachedTranslations(
    texts: readonly string[],
    targetLocale: SupportedLocale,
  ): Promise<Map<string, string>> {
    const byKey = new Map<string, string>();
    for (const text of texts) {
      byKey.set(this.cacheKeyFor(this.detectLocale(text), targetLocale, text), text);
    }
    if (byKey.size === 0) return new Map();

    const rows = await this.prisma.translationCache.findMany({
      where: { cacheKey: { in: [...byKey.keys()] } },
      select: { cacheKey: true, translatedText: true },
    });

    const out = new Map<string, string>();
    for (const row of rows) {
      const source = byKey.get(row.cacheKey);
      if (source !== undefined) out.set(source, row.translatedText);
    }
    return out;
  }

  private cacheKeyFor(
    sourceLocale: SupportedLocale,
    targetLocale: SupportedLocale,
    text: string,
  ): string {
    return createHash('sha256').update(`${sourceLocale}:${targetLocale}:${text}`).digest('hex');
  }
}
