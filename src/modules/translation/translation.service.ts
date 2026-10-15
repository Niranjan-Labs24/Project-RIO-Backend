import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { buildContentTranslationTask } from '../ai/prompts/content-translation.task';
import type { SupportedLocale, TranslateContentResult } from './translation.types';
import { localizeEnumWords, rejectTranslation } from './translation-quality';
import { chunk, translateBatch } from './summary-localization';

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
const ARABIC_SCRIPT_RE =
  /[\u{0600}-\u{06FF}\u{0750}-\u{077F}\u{08A0}-\u{08FF}\u{FB50}-\u{FDFF}\u{FE70}-\u{FEFF}]/u;
// At least one letter in either script — a string with no letters at all
// (a number, a code, punctuation, whitespace) has no language to translate.
const HAS_LETTERS_RE =
  /[\u{0600}-\u{06FF}\u{0750}-\u{077F}\u{08A0}-\u{08FF}\u{FB50}-\u{FDFF}\u{FE70}-\u{FEFF}A-Za-z]/u;

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

  /** The registry's name in `targetLocale` when `text` is exactly the same
   *  entity's name in the other language; null when it isn't a registry name
   *  (or the lookup fails — never blocks a translation). */
  private async registryCounterpart(
    text: string,
    targetLocale: SupportedLocale,
  ): Promise<string | null> {
    return (await this.registryCounterparts([text], targetLocale)).get(text) ?? null;
  }

  /**
   * Official names for every text in `texts` that names a registered
   * organisation, in one round of queries. Organisation names are never
   * machine-translated: the Arabic (and English) name is the NIC registry's.
   *
   * An organisation is found through its own row first — the name shown on
   * screen is `organisations.name`, linked to the registry by registration
   * number, so a renamed organisation still resolves. The registry's own
   * name columns are the fallback (signup copies the registry name, and
   * Arabic text has no organisation row to match).
   *
   * Signup names the first user "<organization name> Admin" (see
   * auth.repository), so that account's display name is a registry name plus
   * a fixed suffix — the name part comes from the registry and only the
   * suffix is translated.
   */
  private async registryCounterparts(
    texts: readonly string[],
    targetLocale: SupportedLocale,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    // Each text is tried as "<name> Admin" first, then as a name on its own.
    const candidates = new Map<string, { name: string; admin: boolean }[]>();
    for (const text of texts) {
      const whole = text.trim().replace(/\s+/g, ' ');
      if (!whole || whole.length > 500) continue;
      const admin = /^(.*\S)\s+Admin$/i.exec(whole);
      candidates.set(text, [
        ...(admin ? [{ name: admin[1]!, admin: true }] : []),
        { name: whole, admin: false },
      ]);
    }
    if (candidates.size === 0) return out;
    const names = [...new Set([...candidates.values()].flat().map((c) => c.name))];

    try {
      const orgsByName = await this.prisma.organisation.findMany({
        where: { name: { in: names, mode: 'insensitive' }, registrationNumber: { not: null } },
        select: { name: true, registrationNumber: true },
      });
      const rows = await this.prisma.nicRegistry.findMany({
        where: {
          OR: [
            { nicNumber: { in: orgsByName.map((o) => o.registrationNumber!) } },
            { nameAr: { in: names } },
            { nameEn: { in: names, mode: 'insensitive' } },
          ],
        },
        select: { nicNumber: true, nameEn: true, nameAr: true },
      });
      // The organisation's own current name is its English name on screen.
      const orgsByNic = await this.prisma.organisation.findMany({
        where: { registrationNumber: { in: rows.map((r) => r.nicNumber) } },
        select: { name: true, registrationNumber: true },
      });

      const key = (s: string) => s.trim().toLowerCase();
      const nicByOrgName = new Map(orgsByName.map((o) => [key(o.name), o.registrationNumber!]));
      const rowByNic = new Map(rows.map((r) => [r.nicNumber, r]));
      const orgNameByNic = new Map(orgsByNic.map((o) => [o.registrationNumber!, o.name]));
      const rowByName = new Map<string, (typeof rows)[number]>();
      for (const r of rows) {
        if (r.nameAr) rowByName.set(key(r.nameAr), r);
        if (r.nameEn && !rowByName.has(key(r.nameEn))) rowByName.set(key(r.nameEn), r);
      }

      for (const [text, options] of candidates) {
        for (const { name, admin } of options) {
          const nic = nicByOrgName.get(key(name));
          const row = (nic ? rowByNic.get(nic) : undefined) ?? rowByName.get(key(name));
          if (!row) continue;
          const official = (
            targetLocale === 'en' ? (orgNameByNic.get(row.nicNumber) ?? row.nameEn) : row.nameAr
          )?.trim();
          if (!official) continue;
          out.set(text, admin ? `${official} ${targetLocale === 'ar' ? 'مسؤول' : 'Admin'}` : official);
          break;
        }
      }
    } catch (err) {
      this.logger.warn(
        `Registry name lookup skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return out;
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

    // An entity's official name is master data, not free text: the national
    // registry already holds its English AND Arabic name, so show that rather
    // than an AI rendering of whichever one was typed at signup (which came
    // back as a different name entirely once switched to the other language).
    const official = await this.registryCounterpart(text, targetLocale);
    if (official) {
      return { translatedText: official, sourceLocale, targetLocale, unchanged: false };
    }

    const cacheKey = this.cacheKeyFor(sourceLocale, targetLocale, text);
    const cached = await this.prisma.translationCache.findUnique({ where: { cacheKey } });
    const cachedText = cached && localizeEnumWords(cached.translatedText, targetLocale);
    // Re-checked on read: an entry cached before a quality rule existed is
    // treated as a miss rather than served forever.
    if (cachedText && !rejectTranslation(text, cachedText, targetLocale)) {
      return {
        translatedText: cachedText,
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
      translatedText = localizeEnumWords(response.translatedText, targetLocale);
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

    // Checked BEFORE caching, because a cached answer is never re-examined:
    // a half-English "translation" stored here used to be served for that
    // string forever after.
    //  - Figures changed → the answer is unsafe to show at all (it would
    //    stop reconciling with the Priority Dashboard); fall back to source.
    //  - Source-language words left → still better to show than the source,
    //    but not cached, so the next request gets another attempt.
    const rejection = rejectTranslation(text, translatedText, targetLocale);
    if (rejection === 'NUMBERS_CHANGED' || rejection === 'EMPTY') {
      this.logger.warn(
        `Translation ${sourceLocale}->${targetLocale} rejected (${rejection}), returning source text.`,
      );
      return { translatedText: text, sourceLocale, targetLocale, unchanged: true };
    }
    if (rejection) {
      this.logger.warn(
        `Translation ${sourceLocale}->${targetLocale} incomplete (${rejection}); showing it without caching.`,
      );
      return { translatedText, sourceLocale, targetLocale, unchanged: false };
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
   * Many strings in as few provider calls as possible: cached answers come
   * from one query, every miss goes to the provider in batched calls (not one
   * call per string), and accepted answers are cached. Same quality rules as
   * translate(). Used by the public batch endpoint, where one request must
   * not fan out into hundreds of provider calls (PR #84 review). Results keep
   * the input order; a string that could not be translated comes back as
   * itself with `unchanged: true`.
   */
  async translateMany(
    texts: readonly string[],
    targetLocale: SupportedLocale,
  ): Promise<TranslateContentResult[]> {
    const unchanged = (text: string): TranslateContentResult => ({
      translatedText: text,
      sourceLocale: this.detectLocale(text),
      targetLocale,
      unchanged: true,
    });
    const results = new Map<string, TranslateContentResult>();
    const needed = [...new Set(texts)].filter((t) => this.needsTranslation(t, targetLocale));

    // Registry names first, then the cache — see cachedTranslations.
    const cached = await this.cachedTranslations(needed, targetLocale);
    for (const [text, translatedText] of cached) {
      results.set(text, {
        translatedText,
        sourceLocale: this.detectLocale(text),
        targetLocale,
        unchanged: false,
      });
    }
    const misses = needed.filter((t) => !results.has(t));
    const promptSource: SupportedLocale = targetLocale === 'ar' ? 'en' : 'ar';
    for (const batch of chunk(misses)) {
      let accepted = new Map<string, string>();
      try {
        accepted = await translateBatch(this.ai, batch, promptSource, targetLocale);
      } catch (err) {
        this.logger.warn(
          `Batch translation ${promptSource}->${targetLocale} failed, returning source text: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      for (const [text, translatedText] of accepted) {
        const sourceLocale = this.detectLocale(text);
        results.set(text, { translatedText, sourceLocale, targetLocale, unchanged: false });
        const cacheKey = this.cacheKeyFor(sourceLocale, targetLocale, text);
        await this.prisma.translationCache
          .upsert({
            where: { cacheKey },
            create: { cacheKey, sourceLocale, targetLocale, sourceText: text, translatedText },
            update: { translatedText },
          })
          .catch((err: unknown) =>
            this.logger.warn(
              `Failed to cache batch translation: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      }
    }
    return texts.map((t) => results.get(t) ?? unchanged(t));
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
   * Returns only what needs no new translation. The caller translates the
   * misses through `translate()` as before, so nothing about cost or
   * correctness changes — only the number of queries.
   *
   * Organisation names resolve from the registry BEFORE the cache, the same
   * order as `translate()`: a machine translation of an organisation name
   * cached at some point must never win over its official name. Both callers
   * (translateMany and the report export's sweep) get that order from here.
   */
  async cachedTranslations(
    texts: readonly string[],
    targetLocale: SupportedLocale,
  ): Promise<Map<string, string>> {
    const out = await this.registryCounterparts(texts, targetLocale);
    const byKey = new Map<string, string>();
    for (const text of texts) {
      if (out.has(text)) continue;
      byKey.set(this.cacheKeyFor(this.detectLocale(text), targetLocale, text), text);
    }
    if (byKey.size === 0) return out;

    const rows = await this.prisma.translationCache.findMany({
      where: { cacheKey: { in: [...byKey.keys()] } },
      select: { cacheKey: true, translatedText: true },
    });

    for (const row of rows) {
      const source = byKey.get(row.cacheKey);
      if (source === undefined) continue;
      const translated = localizeEnumWords(row.translatedText, targetLocale);
      if (rejectTranslation(source, translated, targetLocale)) continue;
      out.set(source, translated);
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
