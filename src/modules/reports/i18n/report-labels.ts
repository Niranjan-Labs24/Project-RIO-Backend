import type { DocSection, ReportDoc } from '../report-doc';
import type { SupportedLocale } from '../../translation/translation.types';
import {
  REPORT_LABELS_AR,
  REPORT_LABELS_EN,
  type ReportLabelKey,
} from './report-labels.generated';

// Locale-aware labels for the report exports.
//
// The wording comes from the SAME catalogue the on-screen report viewer reads
// (Project-RIO-Frontend/messages/{en,ar}.json -> app.reports.content), vendored
// in by `pnpm sync:report-labels`. That is the whole point: a section called
// "الشدة حسب المجال" on screen must not become "Severity by Domain" the moment
// the reader downloads the PDF.
//
// What belongs here: fixed report vocabulary — section headings, column names,
// enum labels, and the handful of sentences the backend prints when a figure
// genuinely does not exist. What does NOT: anything a user typed or an AI wrote
// (Need statements, narrative, evidence summaries, names). Those have no
// pre-existing translation and go through TranslationService instead.

export type { ReportLabelKey };

/** Values a message placeholder may take. Numbers stay Latin digits — see
 *  `format` below. */
export type LabelParams = Record<string, string | number>;

const CATALOGUE: Record<SupportedLocale, Record<string, string>> = {
  en: REPORT_LABELS_EN,
  ar: REPORT_LABELS_AR,
};

/** ICU constructs this deliberately does not implement. */
const COMPLEX_ICU = /\{[^}]*,\s*(plural|select|selectordinal|number|date|time)\s*[,}]/;

const SIMPLE_PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Substitutes `{name}` placeholders.
 *
 * Only simple named placeholders are supported. next-intl also allows full ICU
 * (`{count, plural, one {# finding} other {# findings}}`), and a few catalogue
 * entries use it — but implementing plural rules for Arabic here would mean a
 * second, subtly different implementation of something next-intl already does
 * correctly on the frontend, and Arabic has six plural categories, not two.
 * Rather than half-implement it and emit quietly-wrong grammar into a document
 * that gets approved and archived, `label()` refuses those keys outright and
 * says which one it choked on.
 */
function format(template: string, params: LabelParams | undefined, key: string): string {
  if (COMPLEX_ICU.test(template)) {
    throw new Error(
      `report label "${key}" uses full ICU syntax, which the export path does not ` +
        `implement (Arabic has six plural categories; a partial implementation would ` +
        `emit wrong grammar into an archived document). Either give the export a ` +
        `plain-placeholder variant of this key, or format the value before passing it in.`,
    );
  }
  // Deliberately NOT `if (!params) return template` — that shortcut would let a
  // caller that forgot its params ship "Ranked by {basis}." straight into a
  // released PDF, which is the exact failure the check below exists to catch.
  return template.replace(SIMPLE_PLACEHOLDER, (_whole, name: string) => {
    const value = params?.[name];
    // A missing param is a bug in the caller, not something to paper over: a
    // heading reading "Ranked by {basis}." in a released PDF is worse than a
    // loud failure during generation.
    if (value === undefined) {
      throw new Error(`report label "${key}" needs a "${name}" parameter, which was not supplied`);
    }
    return String(value);
  });
}

/**
 * The label for `key` in `locale`.
 *
 * Falls back to the English wording when a key has no Arabic entry. That cannot
 * happen through the sync — it refuses to generate when en.json has a key
 * ar.json lacks — but the fallback keeps a report rendering rather than throwing
 * if the generated file is ever hand-edited.
 */
export function label(key: ReportLabelKey, locale: SupportedLocale, params?: LabelParams): string {
  const template = CATALOGUE[locale][key] ?? REPORT_LABELS_EN[key];
  return format(template, params, key);
}

/** Whether a key exists — for the incremental migration of report-doc.ts, where
 *  a heading not yet in the catalogue must keep its hardcoded English. */
export function hasLabel(key: string): key is ReportLabelKey {
  return key in REPORT_LABELS_EN;
}

/**
 * Resolve an English string the codebase still hardcodes to its catalogue key.
 *
 * A migration aid, not the destination. report-doc.ts carries 64 literal
 * `heading:` strings; 40 of them are already word-for-word identical to a
 * catalogue entry, so they can be switched over mechanically and verifiably
 * rather than by someone eyeballing 64 call sites. Once every heading is a key
 * this function should be deleted along with its lookup table.
 */
const KEY_BY_ENGLISH: ReadonlyMap<string, ReportLabelKey> = new Map(
  (Object.entries(REPORT_LABELS_EN) as Array<[ReportLabelKey, string]>).map(([k, v]) => [
    v.trim().toLowerCase(),
    k,
  ]),
);

export function keyForEnglish(text: string): ReportLabelKey | null {
  return KEY_BY_ENGLISH.get(text.trim().toLowerCase()) ?? null;
}

/**
 * Translate an English label to `locale` when the catalogue knows it, otherwise
 * return it untouched.
 *
 * This is the bridge that lets the export go locale-aware in one step instead of
 * 64: every heading and column name already flowing through report-doc.ts gets
 * looked up by its own text. It is deliberately NOT the long-term shape — text
 * is a fragile key, and a reworded heading silently stops matching — but it
 * makes the switch verifiable now, and `report-labels.spec.ts` pins exactly how
 * many of the real headings resolve, so the number cannot quietly drop.
 */
export function localizeKnownLabel(text: string, locale: SupportedLocale): string {
  if (locale === 'en') return text;
  const key = keyForEnglish(text);
  if (key) return label(key, locale);
  return localizeComposed(text, locale) ?? localizeNumericPhrase(text, locale) ?? text;
}

// A figure followed by the thing it counts — "38 valid", "12% don't-know",
// "24 asked · 0 not measurable". The report builders compose these by gluing a
// computed number to a fixed unit phrase, and the unit phrase is already in the
// catalogue (cov.valid, cov.dontKnow, ...) because the on-screen viewer renders
// the same figures.
//
// One rule rather than a pattern per phrase: split the number off the front,
// translate the remainder through the catalogue, put the number back. The
// number is never touched, which is the point — these are counts and
// percentages in a document that gets approved and archived, and Latin digits
// are the project's convention regardless of locale.
const NUMERIC_PREFIX = /^([\d.,]+%?)\s+(.+)$/;
const COMPOUND_SEPARATOR = ' · ';

function localizeNumericPhrase(text: string, locale: SupportedLocale): string | null {
  if (text.includes(COMPOUND_SEPARATOR)) {
    const parts = text.split(COMPOUND_SEPARATOR);
    const done = parts.map((p) => localizeNumericPhrase(p, locale));
    // Only rewrite when at least one half resolved; a half-translated compound
    // is worse than leaving it alone for the audit to report.
    if (done.every((d) => d === null)) return null;
    return done.map((d, i) => d ?? parts[i]!).join(COMPOUND_SEPARATOR);
  }

  const m = NUMERIC_PREFIX.exec(text);
  if (!m) return null;
  const key = keyForEnglish(m[2]!);
  return key ? `${m[1]} ${label(key, locale)}` : null;
}

/**
 * Headings report-doc.ts builds at runtime from a DATA value plus a fixed
 * suffix — "Health — Domain Detail", "Water & Sanitation Indicator 3 —
 * Indicator Detail". There is one of these per domain and per indicator, so
 * they are the single largest group of untranslated headings in the export, and
 * no amount of catalogue entries can reach them: the text is different every
 * time.
 *
 * Each pattern peels the data off, translates only the fixed half through the
 * catalogue's parameterised key, and puts the data back untouched. The domain
 * or indicator NAME stays as the generator produced it — localising that is the
 * provider's job (Domain.nameAr / SubDomain.nameAr), not the label layer's, and
 * doing it here would mean translating master data by string match.
 */
const COMPOSED: ReadonlyArray<{ pattern: RegExp; key: ReportLabelKey; param?: string }> = [
  { pattern: /^(.+?) — Domain Detail$/, key: 'drill.domainDetail' },
  { pattern: /^(.+?) — Indicator Detail$/, key: 'drill.indicatorDetail' },

  // Report titles. Each generator composes one as a fixed English phrase plus
  // the study, survey or village it covers, and the result is written to
  // Report.title when the report is CREATED — long before an export locale
  // exists. Storing a titleKey + titleParams pair alongside it would be the
  // tidier shape, but it needs a migration and would still not help the reports
  // already in the database, which have to be matched on their frozen text
  // anyway. So the same patterns serve both.
  //
  // RPT16/RPT17 put the name first and the rest put it last; `label()`
  // substitutes {name} wherever the template places it, so one mechanism covers
  // both orders.
  { pattern: /^Individual Survey Report — (.+)$/, key: 'reportTitle.individualSurvey' },
  { pattern: /^Village Report — (.+)$/, key: 'reportTitle.village' },
  { pattern: /^Executive Summary — (.+)$/, key: 'reportTitle.executive' },
  { pattern: /^Domain-wise Needs Report — (.+)$/, key: 'reportTitle.sector' },
  { pattern: /^Regional Needs Report — (.+)$/, key: 'reportTitle.region' },
  { pattern: /^Top-Priority Report — (.+)$/, key: 'reportTitle.topPriority' },
  { pattern: /^Data-Quality Report — (.+)$/, key: 'reportTitle.dataQuality' },
  { pattern: /^Collective Report — (.+)$/, key: 'reportTitle.collective' },
  { pattern: /^Survey & Dashboard Report — (.+)$/, key: 'reportTitle.combinedSurvey' },
  { pattern: /^(.+?) — Combined Quantitative & Evidence Report$/, key: 'reportTitle.combinedEvidence' },
  { pattern: /^(.+?) — Evidence Document Report$/, key: 'reportTitle.evidenceDocument' },

  // A figure in the middle rather than at either end, so the numeric-prefix
  // rule below cannot reach it.
  { pattern: /^of (\d+) in the methodology$/, key: 'ofNInMethodology', param: 'n' },
];

function localizeComposed(text: string, locale: SupportedLocale): string | null {
  for (const { pattern, key, param } of COMPOSED) {
    const m = pattern.exec(text);
    if (m) return label(key, locale, { [param ?? 'name']: m[1]! });
  }
  return null;
}

// ── Document localisation ────────────────────────────────────────────────────

/**
 * Return a copy of `doc` with its LABEL positions rendered in `locale`.
 *
 * Applied once, to the finished ReportDoc, rather than at the ~64 places
 * report-doc.ts writes a heading. Same result, one seam to reason about, and it
 * picks up column names and key/value labels in the same pass.
 *
 * ## Why only some positions
 *
 * `localizeKnownLabel` matches on English text, so it cannot tell a heading
 * from a cell that happens to read the same. Four real collisions exist today
 * between catalogue labels and values reports actually print:
 *
 *   value "CRITICAL" (severity band)  vs  label col.critical ("Critical")
 *   value "Severity" / "Priority" / "Domains" (domain and column data)
 *
 * A blanket walk would rewrite those cells — turning a severity band into a
 * column heading's translation — and the corruption would be invisible in the
 * export. So this walks label positions ONLY:
 *
 *   translated: section headings, table column names, key/value row labels,
 *               stat-tile labels and captions, grouped-bar series names,
 *               chapter names and summaries, header-band and audit row labels
 *   left alone: every value, table cell, list item, nav-grid tile, bar/pie/
 *               radar category (those are domain and village names — data)
 *
 * Severity bands and other enum values that SHOULD be translated need their own
 * explicit value-position mapping; they are deliberately not swept up here by
 * a text match that would also catch real data.
 */
export function localizeReportDoc<T extends ReportDocShape>(doc: T, locale: SupportedLocale): T {
  if (locale === 'en') return doc;
  const t = (s: string) => localizeKnownLabel(s, locale);

  // Exhaustive over the DocSection union on purpose. Probing for `heading` /
  // `columns` on the union was the first attempt; it does not typecheck (an
  // anchor has no heading), and more importantly it would silently skip a new
  // section kind. A switch makes adding one a compile error here, which is the
  // reminder a future author needs — an untranslated heading is invisible in
  // the export.
  const section = (s: DocSection): DocSection => {
    switch (s.kind) {
      case 'anchor':
        return s;
      case 'keyvalue':
        // Row label is vocabulary; row value is data.
        return {
          ...s,
          heading: t(s.heading),
          rows: s.rows.map((r) => ({ ...r, label: t(r.label) })),
        };
      case 'table':
        // Column names are vocabulary; every cell in `rows` is data.
        return { ...s, heading: t(s.heading), columns: s.columns.map(t) };
      case 'stats':
        return {
          ...s,
          heading: t(s.heading),
          tiles: s.tiles.map((x) => ({
            ...x,
            label: t(x.label),
            ...(x.sub === undefined ? {} : { sub: t(x.sub) }),
          })),
        };
      case 'groupedBars':
        // Series are "This survey" / "Organisation" — vocabulary. `groups` are
        // domain names — data, left alone.
        return { ...s, heading: t(s.heading), series: s.series.map((x) => ({ ...x, name: t(x.name) })) };
      case 'note':
        return { ...s, heading: t(s.heading), text: t(s.text) };
      case 'columns':
        return { ...s, children: s.children.map(section) };
      case 'pageBreak':
        return s.heading === undefined ? s : { ...s, heading: t(s.heading) };
      case 'breadcrumb':
        return { ...s, trail: s.trail.map((x) => ({ ...x, label: t(x.label) })) };
      // Headings only. Their categories — bar/slice labels, radar axes, nav
      // tiles — are domain, indicator and village names: data.
      case 'navGrid':
      case 'bars':
      case 'pie':
      case 'gauge':
      case 'radar':
      case 'list':
        return { ...s, heading: t(s.heading) };
    }
  };

  return {
    ...doc,
    // The title is a composed label ("Village Report — Ad-Dilam"): the fixed
    // phrase comes from the catalogue, the name after it is data and is left
    // for the master-data pass.
    title: t(doc.title),
    headerBand: doc.headerBand.map((r) => ({ ...r, label: t(r.label) })),
    audit: doc.audit.map((r) => ({ ...r, label: t(r.label) })),
    sections: doc.sections.map(section),
    ...(doc.chapters
      ? {
          chapters: doc.chapters.map((c) => ({
            ...c,
            name: t(c.name),
            summary: t(c.summary),
            sections: c.sections.map(section),
          })),
        }
      : {}),
  };
}

// report-doc.ts imports localizeReportDoc from here, so this direction is a
// cycle — but a TYPE-ONLY one, which TypeScript erases entirely. There is no
// runtime import back into report-doc.ts and therefore no initialisation
// hazard. Modelling these shapes locally instead was the first attempt and was
// worse: the hand-written shapes drifted from the real union immediately
// (DocAnchor has no index signature), and a structural near-copy of a
// discriminated union is exactly the thing that rots silently.
type ReportDocShape = ReportDoc;
type DocSectionShape = DocSection;
