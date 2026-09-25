import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { AiService } from '../ai/ai.service';
import { buildSummaryTranslationTask } from '../ai/prompts/summary-translation.task';
import { rejectTranslation } from './translation-quality';
import type { SupportedLocale } from './translation.types';

// A stored AI summary (AiPrioritySummary, CombinedReportSummary,
// EvidenceDocumentSummary) is written ONCE, in the language of whoever
// generated it — `outputLocale`. Anyone viewing it in the other language gets
// a translation of the WHOLE summary, made once and persisted on the row in
// `localizedOutputs`, instead of the old per-string, best-effort patching at
// render time that silently fell back to English.
//
// This module is pure orchestration: it never touches the database. The
// caller reads the row, calls `localizeSummaryOutput`, and persists
// `toPersist` when it is returned — so the three summary services can each
// keep writing through their own tenant context.

const logger = new Logger('SummaryLocalization');

/** Shape of the `localized_outputs` JSONB column. */
export type LocalizedOutputs = Partial<
  Record<SupportedLocale, { sourceHash: string; output: Record<string, unknown> }>
>;

export type LocalizationStatus =
  /** The summary was generated in the requested language. */
  | 'NATIVE'
  /** A translation persisted earlier, still matching the current source. */
  | 'CACHED'
  /** Translated now, every segment passed validation; `toPersist` is set. */
  | 'TRANSLATED'
  /** Translated now, but some segments failed validation and kept their
   *  source text. Not persisted, so the next request retries them. */
  | 'PARTIAL'
  /** The provider failed outright; the source is returned unchanged. */
  | 'FAILED';

export interface LocalizeSummaryResult {
  output: Record<string, unknown> | null;
  locale: SupportedLocale;
  status: LocalizationStatus;
  /** The new column value to write back, when there is something worth keeping. */
  toPersist?: LocalizedOutputs;
}

/**
 * Keys whose string values are codes, enums, identifiers or machine
 * metadata. Their values drive colour selection, lookups and audit — a
 * translated "HIGH" or a translated document reference would break those.
 */
const PROTECTED_KEYS = new Set([
  'confidence',
  'confidenceLevel',
  'severityBand',
  'priorityStatus',
  'priorityLevel',
  'status',
  'statusLabel',
  'priority',
  'domainCode',
  'domainKey',
  'kpiCode',
  'code',
  'id',
  'sourceReferenceId',
  'sourcePageOrSection',
  'pageOrSection',
  'documentType',
  'scoreSummaryId',
  'includedDocumentSummaryIds',
  'aiModel',
  'promptVersion',
  'generatedAt',
  'generatedTimestamp',
  'methodologyVersion',
]);

const ARABIC_SCRIPT = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

/** Whether a string value has anything to translate into `target`. */
function needsTranslation(text: string, target: SupportedLocale): boolean {
  const s = text.trim();
  if (s.length < 2) return false;
  // Codes, enum values, identifiers, timestamps: never prose.
  if (/^[A-Z0-9_\-.]+$/.test(s)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s)) return false;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return false;
  return target === 'ar' ? /[A-Za-z]{2,}/.test(s) : ARABIC_SCRIPT.test(s);
}

interface Slot {
  text: string;
  write: (value: string) => void;
}

/** Every translatable string leaf in `node`, with a writer back to its slot. */
function collectSlots(node: unknown, target: SupportedLocale, out: Slot[], key?: string): void {
  if (key !== undefined && PROTECTED_KEYS.has(key)) return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => {
      if (typeof item === 'string') {
        if (needsTranslation(item, target)) out.push({ text: item, write: (v) => (node[i] = v) });
      } else {
        collectSlots(item, target, out);
      }
    });
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  for (const [k, value] of Object.entries(obj)) {
    if (PROTECTED_KEYS.has(k)) continue;
    if (typeof value === 'string') {
      if (needsTranslation(value, target)) out.push({ text: value, write: (v) => (obj[k] = v) });
    } else {
      collectSlots(value, target, out, k);
    }
  }
}

/** Fingerprint of the source a translation was made from. Postgres JSONB
 *  returns keys in a stable order, so the same stored JSON hashes the same. */
export function summarySourceHash(source: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(source ?? null))
    .digest('hex');
}

/** Batches that stay well inside the provider's output-token cap — Arabic
 *  output runs noticeably longer than the English it translates. */
function chunk(texts: string[], maxItems = 20, maxChars = 4_000): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const t of texts) {
    if (current.length > 0 && (current.length >= maxItems || size + t.length > maxChars)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(t);
    size += t.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Translate a batch; returns a map of source → accepted translation.
 * Segments whose answer fails validation are simply absent from the map.
 */
async function translateBatch(
  ai: AiService,
  batch: string[],
  source: SupportedLocale,
  target: SupportedLocale,
): Promise<Map<string, string>> {
  const task = buildSummaryTranslationTask(source, target);
  const { response } = await ai.run(task, JSON.stringify(batch));
  const accepted = new Map<string, string>();
  const translations = Array.isArray(response?.translations) ? response.translations : [];
  // Position is the contract. A reply of the wrong length cannot be matched
  // back to its segments with any confidence, so none of it is used.
  if (translations.length !== batch.length) {
    logger.warn(
      `Summary translation returned ${translations.length} segment(s) for ${batch.length}; discarding the batch.`,
    );
    return accepted;
  }
  batch.forEach((text, i) => {
    const candidate = translations[i];
    if (typeof candidate !== 'string') return;
    const rejection = rejectTranslation(text, candidate, target);
    if (rejection) {
      logger.warn(`Summary translation segment rejected (${rejection}).`);
      return;
    }
    accepted.set(text, candidate);
  });
  return accepted;
}

/**
 * The stored summary output in `targetLocale` WITHOUT calling the provider:
 * the native output, or a persisted translation that still matches the
 * source, else null. For list endpoints, where translating every row on read
 * would put one AI call per row in front of the page.
 */
export function cachedSummaryOutput(args: {
  source: Record<string, unknown> | null;
  sourceLocale: SupportedLocale;
  targetLocale: SupportedLocale;
  stored: unknown;
}): LocalizeSummaryResult | null {
  const { source, sourceLocale, targetLocale } = args;
  if (!source || sourceLocale === targetLocale) {
    return { output: source, locale: sourceLocale, status: 'NATIVE' };
  }
  const hit = ((args.stored ?? {}) as LocalizedOutputs)[targetLocale];
  if (hit && hit.sourceHash === summarySourceHash(source)) {
    return { output: hit.output, locale: targetLocale, status: 'CACHED' };
  }
  return null;
}

/**
 * The stored summary output in `targetLocale`.
 *
 * Never throws: every failure path returns the source output, labelled with
 * the language it is actually in, so the caller can show it and say so.
 */
export async function localizeSummaryOutput(
  ai: AiService,
  args: {
    source: Record<string, unknown> | null;
    sourceLocale: SupportedLocale;
    targetLocale: SupportedLocale;
    stored: unknown;
  },
): Promise<LocalizeSummaryResult> {
  const { source, sourceLocale, targetLocale } = args;
  if (!source || sourceLocale === targetLocale) {
    return { output: source, locale: sourceLocale, status: 'NATIVE' };
  }

  const stored = (args.stored ?? {}) as LocalizedOutputs;
  const sourceHash = summarySourceHash(source);
  const hit = stored[targetLocale];
  // A hash mismatch means the officer edited the summary after it was
  // translated: the stored translation describes text that no longer exists.
  if (hit && hit.sourceHash === sourceHash) {
    return { output: hit.output, locale: targetLocale, status: 'CACHED' };
  }

  const copy = structuredClone(source);
  const slots: Slot[] = [];
  collectSlots(copy, targetLocale, slots);
  const distinct = [...new Set(slots.map((s) => s.text))];

  const toPersistFor = (output: Record<string, unknown>): LocalizedOutputs => ({
    ...stored,
    [targetLocale]: { sourceHash, output },
  });

  if (distinct.length === 0) {
    return {
      output: copy,
      locale: targetLocale,
      status: 'TRANSLATED',
      toPersist: toPersistFor(copy),
    };
  }

  const accepted = new Map<string, string>();
  try {
    for (const batch of chunk(distinct)) {
      for (const [k, v] of await translateBatch(ai, batch, sourceLocale, targetLocale))
        accepted.set(k, v);
    }
    // One retry for whatever was rejected — a single bad segment usually
    // translates cleanly on its own, away from the rest of its batch.
    const missing = distinct.filter((t) => !accepted.has(t));
    if (missing.length > 0) {
      for (const batch of chunk(missing, 5)) {
        for (const [k, v] of await translateBatch(ai, batch, sourceLocale, targetLocale))
          accepted.set(k, v);
      }
    }
  } catch (err) {
    logger.warn(
      `Summary translation ${sourceLocale}->${targetLocale} failed, returning source: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    if (accepted.size === 0) return { output: source, locale: sourceLocale, status: 'FAILED' };
  }

  for (const slot of slots) {
    const translated = accepted.get(slot.text);
    if (translated !== undefined) slot.write(translated);
  }

  if (accepted.size === distinct.length) {
    return {
      output: copy,
      locale: targetLocale,
      status: 'TRANSLATED',
      toPersist: toPersistFor(copy),
    };
  }
  return { output: copy, locale: targetLocale, status: 'PARTIAL' };
}
