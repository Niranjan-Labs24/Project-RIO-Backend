import type { DocSection, ReportDoc } from '../report-doc';
import type { SupportedLocale } from '../../translation/translation.types';
import { label, localizeKnownLabel } from './report-labels';
import type { MasterDataAliases } from './master-data-names';
import type { Translator } from './translate-content';
import { hasArabic } from '../arabic-text';

/** A translator that can also answer "what do you already have?" in one query.
 *  Optional so the unit tests can pass a plain stub. */
export interface BulkTranslator extends Translator {
  cachedTranslations?(
    texts: readonly string[],
    targetLocale: SupportedLocale,
  ): Promise<Map<string, string>>;
}

/**
 * How long the sweep may spend calling the provider.
 *
 * An export is a download, and a download must return. Before this existed a
 * cold-cache Arabic export took 24s and hit the request timeout — the feature
 * looked broken even though it was working, just slowly. Past the deadline the
 * remaining strings keep their English and are reported in `stats.unresolved`;
 * the next export finds them cached and finishes the job. A slightly less
 * Arabic PDF beats a failed download, and it is the same trade the rest of this
 * path already makes when the provider is unavailable.
 */
const DEFAULT_BUDGET_MS = 12_000;

// The last layer before rendering: whatever is still English in the finished
// document, made Arabic.
//
// ## Why a sweep, and why here
//
// The three passes before this one are precise — the catalogue translates
// declared labels, the alias map declared master data, TranslationService
// declared prose paths. Precision is what keeps figures intact and the AI bill
// finite, but it can only cover what someone remembered to declare. Two things
// escape it by construction:
//
//   * strings pdf-builder.ts composes ITSELF, after the document is built
//     ("Contents", "Audit Trail", "Open >") — no content-level pass can see them
//   * anything added to a report later that nobody thinks to declare
//
// This runs on the finished ReportDoc, so it sees both. It is the only place a
// "no English in an Arabic export" guarantee can actually be made.
//
// ## Why translating here is safe when translating the report JSON is not
//
// By this point every structural decision is already made: section kinds are
// chosen, drill anchors resolved, figures formatted into strings. A translation
// here changes what a reader sees and nothing else. Translating the stored
// content JSON instead would put keys, enum values and anchor ids in front of a
// model, where a rename silently breaks rendering.
//
// ## Order matters for cost
//
// Catalogue, then master data, then AI. The first two are free and permanent,
// so every string they resolve is a string never paid for. On a report whose
// labels are all keyed, the AI sees only genuinely novel prose.

/** Kept in Latin script on purpose. */
const KEEP_AS_IS: readonly RegExp[] = [
  // Report and rejection codes, enum identifiers: RPT01, REJ_03, HLT-01.
  /^[A-Z]{2,5}[-_ ]?\d{1,3}$/,
  /^[A-Z][A-Z0-9_]{2,}$/,
  // Identifiers and hashes.
  /^[0-9a-f]{8}-[0-9a-f]{4}-/i,
  /^snap-[0-9a-f]+$/i,
  /^NR-[\w-]+$/i,
  // Version identifiers — "v5.0" alone. A version with a description after it
  // ("v5.0 - Approved methodology baseline") is NOT matched here: the
  // description is prose and should translate.
  /^v\d+(\.\d+)*$/i,
  // Units and formulae that are not words.
  /^[\d\s.,%+\-/×÷=()]+$/,
];

/** Latin words worth translating — four or more letters, so units, acronyms
 *  and codes do not trigger a call on their own. */
const HAS_ENGLISH = /[A-Za-z]{4,}/;

/** The partial-scope note (load-sector-scope-basis.ts): a fixed sentence with
 *  a survey title inside. The title is translated on its own and set into the
 *  catalogue's Arabic sentence, so neither half is left in English. */
const PARTIAL_SCOPE =
  /^This study contains (\d+) surveys\. These figures cover ONE of them — "(.+)" — not the study as a whole\. Domain scores from the other (\d+) survey\(s\) are not included in this report\.$/;

/** "06 Oct 2026" or "06 Oct 2026, 16:28" — the report builders' date stamp. */
const ENGLISH_STAMP = /^(\d{1,2} [A-Z][a-z]{2} \d{4})(?:, (\d{2}:\d{2}))?$/;

/** Digits in order, for the integrity guard. */
function digitsOf(s: string): string {
  return (s.match(/\d+(?:\.\d+)?/g) ?? []).join('|');
}

export interface SweepStats {
  /** Resolved from the label catalogue — free. */
  byCatalogue: number;
  /** Resolved from master data — free. */
  byMasterData: number;
  /** Already in the translation cache — one query for all of them. */
  byCache: number;
  /** Sent to the translation provider. */
  byTranslator: number;
  /** Left in English on purpose (codes, identifiers, versions). */
  keptAsIs: number;
  /** Sent, but the result was rejected because it altered a figure. */
  rejectedForDigits: string[];
  /** Left untranslated because the time budget ran out, not because they
   *  failed. The next export finds them cached. */
  timedOut: number;
  /** Still English after everything — the honest residue. */
  unresolved: string[];
}

export interface SweepResult {
  doc: ReportDoc;
  stats: SweepStats;
}

/** Apply `fn` to every string a document prints, returning a new document. */
function mapDocStrings(doc: ReportDoc, fn: (text: string) => string): ReportDoc {
  const s = (v: string): string => fn(v);
  const opt = (v: string | undefined): string | undefined => (v === undefined ? undefined : fn(v));

  const section = (x: DocSection): DocSection => {
    switch (x.kind) {
      case 'anchor':
        return x;
      case 'keyvalue':
        return { ...x, heading: s(x.heading), rows: x.rows.map((r) => ({ label: s(r.label), value: s(r.value) })) };
      case 'table':
        return {
          ...x,
          heading: s(x.heading),
          subheading: opt(x.subheading),
          columns: x.columns.map(s),
          rows: x.rows.map((r) => r.map(s)),
        };
      case 'list':
        return { ...x, heading: s(x.heading), items: x.items.map(s) };
      case 'note':
        return { ...x, heading: s(x.heading), text: s(x.text) };
      case 'stats':
        return {
          ...x,
          heading: s(x.heading),
          tiles: x.tiles.map((t) => ({ ...t, label: s(t.label), value: s(t.value), sub: opt(t.sub) })),
        };
      case 'bars':
        return { ...x, heading: s(x.heading), bars: x.bars.map((b) => ({ ...b, label: s(b.label) })) };
      case 'pie':
        return { ...x, heading: s(x.heading), slices: x.slices.map((y) => ({ ...y, label: s(y.label) })) };
      case 'radar':
        return {
          ...x,
          heading: s(x.heading),
          axes: x.axes.map(s),
          series: x.series.map((y) => ({ ...y, name: s(y.name) })),
        };
      case 'groupedBars':
        return {
          ...x,
          heading: s(x.heading),
          groups: x.groups.map(s),
          series: x.series.map((y) => ({ ...y, name: s(y.name) })),
        };
      case 'gauge':
        return { ...x, heading: s(x.heading), sub: opt(x.sub) };
      case 'navGrid':
        return { ...x, heading: s(x.heading), tiles: x.tiles.map((t) => ({ ...t, label: s(t.label), sub: s(t.sub) })) };
      case 'breadcrumb':
        return { ...x, trail: x.trail.map((t) => ({ ...t, label: s(t.label) })) };
      case 'pageBreak':
        return { ...x, heading: opt(x.heading) };
      case 'columns':
        return { ...x, children: x.children.map(section) };
      case 'summaryPanel':
        return {
          ...x,
          title: s(x.title),
          columns: x.columns.map((col) => ({
            label: s(col.label),
            text: s(col.text),
            lead: opt(col.lead),
            caveat: opt(col.caveat),
          })),
        };
      case 'bandScale':
        return {
          ...x,
          heading: s(x.heading),
          note: s(x.note),
          segments: x.segments.map((g) => ({ ...g, label: s(g.label) })),
        };
      case 'card':
        return { ...x, heading: s(x.heading), hint: opt(x.hint), children: x.children.map(section) };
      case 'caption':
      case 'panel':
      case 'footnote':
        return { ...x, text: s(x.text) };
      case 'rings':
        return {
          ...x,
          heading: s(x.heading),
          items: x.items.map((it) => ({
            label: s(it.label),
            slices: it.slices.map((y) => ({ ...y, label: s(y.label) })),
          })),
        };
      case 'callouts':
        return { ...x, items: x.items.map((it) => ({ ...it, label: s(it.label), text: s(it.text) })) };
    }
  };

  return {
    ...doc,
    title: s(doc.title),
    headerBand: doc.headerBand.map((r) => ({ label: s(r.label), value: s(r.value) })),
    audit: doc.audit.map((r) => ({ label: s(r.label), value: s(r.value) })),
    sections: doc.sections.map(section),
    ...(doc.chapters
      ? {
          chapters: doc.chapters.map((c) => ({
            ...c,
            name: s(c.name),
            summary: s(c.summary),
            sections: c.sections.map(section),
          })),
        }
      : {}),
    ...(doc.lead ? { lead: doc.lead.map(section) } : {}),
  };
}

/**
 * Translate everything still in English, cheapest source first.
 *
 * For an English export, the reverse: Arabic data is translated to English.
 * Never throws: a provider failure leaves the source text,
 * reported in `stats.unresolved` rather than failing the download.
 */
export async function sweepRemainingEnglish(
  doc: ReportDoc,
  locale: SupportedLocale,
  deps: {
    aliases: MasterDataAliases;
    translator: BulkTranslator;
    concurrency?: number;
    budgetMs?: number;
  },
): Promise<SweepResult> {
  const stats: SweepStats = {
    byCatalogue: 0,
    byMasterData: 0,
    byCache: 0,
    byTranslator: 0,
    timedOut: 0,
    keptAsIs: 0,
    rejectedForDigits: [],
    unresolved: [],
  };
  const resolved = new Map<string, string>();
  const needsAi = new Set<string>();
  const scopeNotes = new Map<string, RegExpExecArray>();

  // Pass 1 — classify every distinct string without changing anything.
  mapDocStrings(doc, (text) => {
    const t = text.trim();
    if (!t || resolved.has(text) || needsAi.has(text)) return text;
    // An English export runs the same sweep the other way: data entered in
    // Arabic (a study name, a village) is translated for the English reader,
    // so the document is in one language. Labels are already English there.
    if (locale === 'en') {
      if (hasArabic(t)) needsAi.add(text);
      return text;
    }
    const scope = PARTIAL_SCOPE.exec(t);
    if (scope) {
      scopeNotes.set(text, scope);
      if (HAS_ENGLISH.test(scope[2]!)) needsAi.add(scope[2]!);
      return text;
    }
    if (!HAS_ENGLISH.test(t)) {
      // Short vocabulary ("LOW", "No", "Yes") is below the length that
      // triggers a provider call, but the catalogue still knows it.
      // Dates the builders stamp in English ("06 Oct 2026, 16:28").
      const stamp = ENGLISH_STAMP.exec(t);
      if (stamp) {
        const d = new Date(`${stamp[1]} ${stamp[2] ?? ''}`.trim());
        if (!Number.isNaN(d.getTime())) {
          resolved.set(
            text,
            d.toLocaleString('ar-SA-u-ca-gregory-nu-latn', {
              day: '2-digit',
              month: 'long',
              year: 'numeric',
              ...(stamp[2] ? { hour: '2-digit', minute: '2-digit' } : {}),
            }),
          );
          stats.byCatalogue++;
          return text;
        }
      }
      if (/[A-Za-z]{2,}/.test(t)) {
        const known = localizeKnownLabel(t, locale);
        if (known !== t) {
          resolved.set(text, known);
          stats.byCatalogue++;
        }
      }
      return text;
    }

    // Catalogue and master data are consulted BEFORE the keep-list, not after.
    // Order matters here and getting it wrong is silent: enum VALUES a reader
    // sees — CRITICAL, MEDIUM, PUBLISHED, DOMAIN_NOT_ASSESSED — look exactly
    // like identifiers to the keep-list patterns, so checking those first left
    // every severity band and status in English while reporting them as
    // "deliberately kept". The keep-list is the LAST resort before the model,
    // not the first filter.
    const viaCatalogue = localizeKnownLabel(t, locale);
    if (viaCatalogue !== t) {
      resolved.set(text, viaCatalogue);
      stats.byCatalogue++;
      return text;
    }

    const viaMaster = deps.aliases.get(t.toLowerCase());
    if (viaMaster) {
      resolved.set(text, viaMaster);
      stats.byMasterData++;
      return text;
    }

    if (KEEP_AS_IS.some((re) => re.test(t))) {
      stats.keptAsIs++;
      return text;
    }

    needsAi.add(text);
    return text;
  });

  // Pass 2a — ask the cache about everything at once. On a warm cache this is
  // the whole job in one query instead of one round trip per string.
  let pending = [...needsAi];
  if (pending.length > 0 && deps.translator.cachedTranslations) {
    const cached = await deps.translator.cachedTranslations(pending, locale);
    const misses: string[] = [];
    for (const source of pending) {
      const hit = cached.get(source);
      if (hit === undefined || hit === source) {
        misses.push(source);
        continue;
      }
      if (digitsOf(hit) !== digitsOf(source)) {
        stats.rejectedForDigits.push(source);
        continue;
      }
      resolved.set(source, hit);
      stats.byCache++;
    }
    pending = misses;
  }

  // Pass 2b — translate what the cache did not have, bounded by both
  // concurrency and a wall-clock budget.
  if (pending.length > 0) {
    const limit = Math.max(1, deps.concurrency ?? 12);
    const deadline = Date.now() + (deps.budgetMs ?? DEFAULT_BUDGET_MS);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = cursor++;
        if (i >= pending.length) return;
        const source = pending[i]!;
        if (Date.now() > deadline) {
          stats.timedOut++;
          stats.unresolved.push(source);
          continue;
        }
        const { translatedText } = await deps.translator.translate(source, locale);

        if (translatedText === source) {
          stats.unresolved.push(source);
          continue;
        }
        // Figure integrity. These documents are approved and archived, and their
        // numbers have to reconcile with the Priority Dashboard — so a
        // translation that moved, dropped or reformatted a digit is discarded
        // and the English kept. This is what makes it safe to hand the
        // deterministic methodology sentences to a model at all: the guard is
        // mechanical, not a promise.
        if (digitsOf(translatedText) !== digitsOf(source)) {
          stats.rejectedForDigits.push(source);
          continue;
        }
        resolved.set(source, translatedText);
        stats.byTranslator++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, pending.length) }, worker));
  }

  for (const [text, m] of scopeNotes) {
    resolved.set(
      text,
      label('fixedText.partialScope', locale, {
        count: m[1]!,
        title: resolved.get(m[2]!) ?? m[2]!,
        other: m[3]!,
      }),
    );
  }

  // Pass 3 — rewrite (nothing to rewrite is the common English case).
  if (resolved.size === 0) return { doc, stats };
  const out = mapDocStrings(doc, (text) => resolved.get(text) ?? text);
  return { doc: out, stats };
}
