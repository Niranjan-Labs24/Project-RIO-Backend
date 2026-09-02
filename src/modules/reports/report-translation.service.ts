import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { AiService } from "../ai/ai.service";
import { latinRuns } from "../ai/language/detect-script";
import {
  REPORT_TRANSLATION_TASK,
  type ReportTranslationResponse,
} from "../ai/prompts/report-translation.task";
import type { AppLocale } from "../../i18n/locale";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import type { ReportDoc } from "./report-doc";
import { collectDocStrings, mapDocStrings } from "./doc-strings";

/**
 * The last pass over an Arabic report: everything the dictionaries could not
 * translate, sent to the model, cached, and spliced back into the document.
 *
 * WHERE THIS SITS, AND WHY THERE
 *
 * It runs on the finished `ReportDoc`, immediately AFTER `localiseReportDoc`.
 * That ordering is the whole design:
 *
 *  - The dictionaries go first because they are exact and free. Chrome,
 *    controlled values and client-approved reference names are settled
 *    vocabulary; asking a model to re-derive them would be slower, cost tokens
 *    and let approved terminology drift.
 *  - The model gets only the residue — narrative prose, Question Bank KPI and
 *    indicator names, place names, anything a lookup table cannot know. That is
 *    the smallest possible surface to hand to a non-deterministic component.
 *  - Both run at EXPORT time, so every report already stored renders in Arabic
 *    with nothing to regenerate, and one approval still yields two editions
 *    (RIO-RPT-001 AC 2/AC 3).
 *
 * FAIL SOFT, LOUDLY. Every failure path here returns the document unchanged.
 * A missing API key, a rate limit, a malformed response — none of them may cost
 * the user their download. An Arabic report with some English in it is the
 * status quo; a 500 on export is a lost feature. The log is at error level so
 * an unconfigured key does not become invisible.
 */
@Injectable()
export class ReportTranslationService {
  private readonly logger = new Logger(ReportTranslationService.name);

  constructor(
    private readonly ai: AiService,
    private readonly tenant: TenantPrismaService,
  ) {}

  /**
   * `doc`, with its remaining English translated into `locale`.
   *
   * @param protectedNames Strings that must never be translated whatever the
   *   model thinks — the person and organisation names the export already knows
   *   by name (report author, confirming officer, reviewer, organisation,
   *   study title). The prompt also carries this rule, but a rule a model can
   *   misapply is not the same as a string it is never shown: a reviewer's name
   *   rendered into Arabic letters is a falsified audit trail, so this one is
   *   enforced here rather than asked for.
   */
  async translateDoc(
    doc: ReportDoc,
    locale: AppLocale,
    protectedNames: readonly string[] = [],
  ): Promise<ReportDoc> {
    if (locale !== "ar") return doc;

    const protect = new Set(protectedNames.map((n) => n.trim()).filter(Boolean));
    const pending = collectDocStrings(doc).filter((s) => needsTranslation(s, protect));
    if (pending.length === 0) return doc;

    let map: Map<string, string>;
    try {
      map = await this.resolve(pending, locale);
    } catch (err) {
      this.logger.error(
        `Report translation failed; the Arabic export will keep its English strings. ` +
          `Cause: ${err instanceof Error ? err.message : String(err)}`,
      );
      return doc;
    }
    if (map.size === 0) return doc;

    const translated = mapDocStrings(doc, (text) => map.get(text) ?? text);
    this.reportResidue(translated, protect);
    return translated;
  }

  /**
   * Logs whatever English survived the pass.
   *
   * The requirement is "no English anywhere in an Arabic report", and a
   * requirement nothing measures is a hope. Every layer here fails soft by
   * design — a missing key, an unreachable cache, a rejected answer all degrade
   * to English rather than to a failed download — which is right, and which
   * means the failure is INVISIBLE unless something says so. This is the thing
   * that says so.
   *
   * A warning rather than a throw: the reader still gets their report, and an
   * operator gets a line naming the exact strings to chase. Silence here is
   * what let an Arabic RPT10 ship with nine pages of English.
   */
  private reportResidue(doc: ReportDoc, protect: ReadonlySet<string>): void {
    const residue = unexplainedLatin(doc, protect);
    if (residue.length === 0) return;
    this.logger.warn(
      `Arabic export still contains English in ${residue.length} string(s): ` +
        residue.slice(0, 5).map(truncate).map((s) => `"${s}"`).join(", ") +
        (residue.length > 5 ? `, and ${residue.length - 5} more.` : ""),
    );
  }

  /** Cache first, model for the remainder, cache the accepted answers. */
  private async resolve(pending: string[], locale: AppLocale): Promise<Map<string, string>> {
    const cached = await this.readCacheOrEmpty(pending, locale);
    const missing = pending.filter((s) => !cached.has(s));
    if (missing.length === 0) return cached;

    const fresh = new Map<string, string>();
    // Chunked because one report can carry several hundred distinct strings and
    // a single request holding all of them is the one most likely to time out,
    // hit an output-token ceiling, or drop items from the tail. A failed chunk
    // costs that chunk, not the whole export.
    for (const chunk of chunksOf(missing, TRANSLATION_BATCH)) {
      const translated = await this.translateChunk(chunk, locale);
      for (const [source, ar] of translated) fresh.set(source, ar);
    }

    if (fresh.size > 0) await this.writeCache(fresh, locale);
    return new Map([...cached, ...fresh]);
  }

  private async translateChunk(chunk: string[], locale: AppLocale): Promise<Map<string, string>> {
    // Positional ids rather than the text itself: a source string can be long
    // and can contain anything, and making the model echo it back as a key
    // wastes output tokens on text we already hold, while giving it one more
    // chance to alter the very string we are keying on.
    const items = chunk.map((text, i) => ({ id: String(i), text }));
    const prompt = [
      `targetLanguage: ${locale}`,
      "",
      'Translate the "text" of every item below. Return one item per id.',
      "",
      JSON.stringify({ items }),
    ].join("\n");

    const { response } = await this.ai.run<ReportTranslationResponse>(
      REPORT_TRANSLATION_TASK,
      prompt,
    );

    const out = new Map<string, string>();
    for (const item of response.items ?? []) {
      const index = Number(item?.id);
      if (!Number.isInteger(index) || index < 0 || index >= chunk.length) continue;
      const source = chunk[index];
      if (source === undefined) continue;
      const ar = typeof item.ar === "string" ? item.ar.trim() : "";
      if (!ar) continue;
      const rejection = rejectionReason(source, ar);
      if (rejection) {
        // Kept OUT of the cache as well as out of the document: a bad
        // translation that got written would be served for every future export
        // of every report, and the cache is exactly what makes a wrong answer
        // permanent.
        this.logger.warn(`Rejected translation (${rejection}) for: ${truncate(source)}`);
        continue;
      }
      out.set(source, ar);
    }

    const dropped = chunk.length - out.size;
    if (dropped > 0) {
      this.logger.warn(`${dropped}/${chunk.length} strings came back unusable and stay in English.`);
    }
    return out;
  }

  /**
   * The cache read, downgraded to a miss on any failure.
   *
   * This is the difference between a slow export and an English one. If the
   * `report_translations` migration has not been deployed, the SELECT throws —
   * and letting that propagate abandons the whole pass, so the reader gets a
   * report whose chrome is Arabic and whose every finding, note and place name
   * is English. That is exactly the "mix of both" an Arabic RPT10 came back as.
   *
   * An unreachable cache means the model has to be asked. It does not mean the
   * report cannot be translated. Same reasoning as `reference-names.ts`: an
   * enhancement's storage failing must not take the feature down with it.
   */
  private async readCacheOrEmpty(sources: string[], locale: AppLocale): Promise<Map<string, string>> {
    try {
      return await this.readCache(sources, locale);
    } catch (err) {
      this.logger.error(
        `Translation cache unreadable; falling back to the model for all ${sources.length} strings. ` +
          `If this says the relation does not exist, the report_translations migration has not been ` +
          `deployed. Cause: ${err instanceof Error ? err.message : String(err)}`,
      );
      return new Map();
    }
  }

  private async readCache(sources: string[], locale: AppLocale): Promise<Map<string, string>> {
    const byHash = new Map(sources.map((s) => [hashOf(s), s]));
    const rows = await this.tenant.runAsSupervisor(async (tx) => {
      const t = tx as unknown as TranslationTx;
      return t.reportTranslation.findMany({
        where: { locale, sourceHash: { in: [...byHash.keys()] } },
        select: { sourceHash: true, translatedText: true },
      });
    });

    const out = new Map<string, string>();
    for (const row of rows) {
      const source = byHash.get(row.sourceHash);
      if (source && row.translatedText) out.set(source, row.translatedText);
    }
    return out;
  }

  private async writeCache(fresh: Map<string, string>, locale: AppLocale): Promise<void> {
    try {
      await this.tenant.runAsSupervisorWrite(async (tx) => {
        const t = tx as unknown as TranslationTx;
        for (const [sourceText, translatedText] of fresh) {
          const sourceHash = hashOf(sourceText);
          // Two statements rather than one upsert, because the rule is not
          // "write this row" but "write this row UNLESS a human owns it". A
          // row the client has corrected by hand is authoritative and must
          // survive both a re-export and a prompt change; an upsert's `update`
          // branch cannot express that condition, and `updateMany` can.
          await t.reportTranslation.updateMany({
            where: { sourceHash, locale, source: "ai" },
            data: {
              translatedText,
              promptVersion: REPORT_TRANSLATION_TASK.promptVersion,
              model: REPORT_TRANSLATION_TASK.model,
            },
          });
          await t.reportTranslation.createMany({
            data: [
              {
                sourceHash,
                sourceText,
                locale,
                translatedText,
                source: "ai",
                promptVersion: REPORT_TRANSLATION_TASK.promptVersion,
                model: REPORT_TRANSLATION_TASK.model,
              },
            ],
            // The row may already exist — either the update above just touched
            // it, or a human owns it. Both are correct outcomes, and neither is
            // an error worth failing an export over.
            skipDuplicates: true,
          });
        }
      });
    } catch (err) {
      // A cache that cannot be written is a performance problem, not a
      // correctness one — the translations in hand are still spliced into this
      // export. Losing the download over it would be the wrong trade.
      this.logger.error(
        `Could not persist ${fresh.size} report translations; this export still uses them. ` +
          `Cause: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Strings per model request. See the chunking note in `resolve`. */
const TRANSLATION_BATCH = 60;

type TranslationTx = {
  reportTranslation: {
    findMany: (args: unknown) => Promise<Array<{ sourceHash: string; translatedText: string }>>;
    createMany: (args: unknown) => Promise<unknown>;
    updateMany: (args: unknown) => Promise<unknown>;
  };
};

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Bare code-like tokens: report codes, version strings, ids.
 *
 * A DIGIT IS REQUIRED, and that requirement was learned the hard way. The first
 * version of this also treated any all-caps token as an identifier, which
 * silently exempted "DOMAIN", "SUB-DOMAIN", "SCORED", "ASSESSED", "SESSION",
 * "ABANDONED", "PUBLISHED" and "QUANTITATIVE" — every one of them an English
 * WORD that the report renders in capitals as a badge or a type column, and
 * every one of them still English on page 5 of an Arabic RPT10. Capitalisation
 * is a typographic choice, not evidence that a string is machine vocabulary.
 *
 * A digit is the honest signal: "RPT06", "v1.0" and "KSA-01" carry one, and no
 * English word does. Anything else goes to the translator, which is told to
 * copy identifiers verbatim anyway — and `rejectionReason` lets a verbatim copy
 * through while catching an invented word.
 */
const IDENTIFIER = /^(?=\S+$)[A-Za-z]{0,4}\d[A-Za-z0-9._\-/]*$/;

/**
 * Whether `s` still has English in it that we are allowed to translate.
 *
 * `latinRuns` with its default minimum of 2 is the same test the rest of the
 * platform uses for "is there English here": a single stray Latin letter is a
 * unit symbol or a list marker, not untranslated prose.
 */
function needsTranslation(s: string, protect: ReadonlySet<string>): boolean {
  const t = s.trim();
  if (!t) return false;
  if (protect.has(t)) return false;
  if (IDENTIFIER.test(t)) return false;
  return latinRuns(t).length > 0;
}

/**
 * Strings in `doc` that still hold English and have no excuse for it.
 *
 * Shares `needsTranslation`'s exemptions on purpose — a protected person's name
 * and a bare identifier are the only Latin an Arabic report is allowed to
 * carry, and defining "allowed" twice is how the two definitions drift. Exposed
 * so the end-to-end spec asserts on exactly what the service warns about.
 */
export function unexplainedLatin(doc: ReportDoc, protect: ReadonlySet<string> = new Set()): string[] {
  return collectDocStrings(doc).filter((text) => needsTranslation(text, protect));
}

/**
 * Why a returned translation must be thrown away, or null if it is usable.
 *
 * Two checks, both protecting things a translator has no business changing:
 *
 *  - THE DIGITS. Every figure in the Arabic edition must equal the English
 *    edition's, character for character. A model that converts to Arabic-Indic
 *    numerals, rounds, or drops a decimal has broken the one guarantee the
 *    whole export-time design exists for — and it would do so invisibly, since
 *    nothing downstream re-derives a rendered figure.
 *  - NEW LATIN. Latin in the output is fine when it was in the input: the
 *    prompt orders identifiers, URLs and people's names copied verbatim. Latin
 *    that was NOT in the input is the model inventing an English word, which is
 *    the exact failure this whole pass exists to remove.
 */
function rejectionReason(source: string, ar: string): string | null {
  const sourceDigits = (source.match(/\d/g) ?? []).join("");
  const arDigits = (ar.match(/\d/g) ?? []).join("");
  if (sourceDigits !== arDigits) return "digits changed";

  const allowed = new Set(latinRuns(source).map((r) => r.toLowerCase()));
  for (const run of latinRuns(ar)) {
    if (!allowed.has(run.toLowerCase())) return `introduced Latin "${run}"`;
  }
  return null;
}

function chunksOf<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function truncate(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
