import type { AppLocale } from "../../i18n/locale";
import { chromeKey, reportChrome, reportValueVocabulary } from "../../i18n/report-chrome";
import type { DocSection, ReportDoc } from "./report-doc";

/**
 * Translates a built ReportDoc's CHROME into `locale`, leaving its data alone.
 *
 * This runs at export time on the document `buildReportDoc` just produced, so
 * it covers every report type at once — including already-stored reports, whose
 * chrome is rebuilt from stored data on every export rather than baked in at
 * generation. See report-chrome.ts for why this is a string map rather than
 * message keys at each of the ~200 emission sites.
 *
 * TWO DICTIONARIES, TWO RULES — this is the safety argument:
 *
 *  - LABEL positions (headings, row labels, column headers, tile labels,
 *    breadcrumbs, chapter names) are looked up in the full chrome map, after
 *    whitespace normalisation. These positions structurally hold chrome, so a
 *    generous dictionary is safe.
 *
 *  - VALUE positions (cell values, key/value values, stat-tile values) are
 *    matched WHOLE-STRING against a much smaller closed vocabulary — severity
 *    bands, confidence flags, Yes/No, report status. Those are the platform's
 *    own rendering of an enum, not data. Anything else in a value position is
 *    data and passes through untouched, so a village named "Summary" or a
 *    domain named "Domain" is never rewritten.
 *
 * NEVER TRANSLATED: list items, note text, and chart point/axis/series labels.
 * Those are narrative prose and reference-data names respectively — the first
 * needs the prompt work (RIO-I18N-003 §3), the second needs `nameAr` columns
 * (§6 rows 6-8). A lookup table must not invent either.
 *
 * A string with no dictionary entry passes through unchanged, so an
 * untranslated label degrades to English rather than to a blank or a crash.
 */
export function localiseReportDoc(
  doc: ReportDoc,
  locale: AppLocale,
  /**
   * The client's Arabic wording for reference names — domains, sub-domains,
   * regions, governorates, centres — loaded from the catalogue at export time
   * (see reference-names.ts).
   *
   * Passed in rather than read here because this module is pure and the names
   * live in the database. Empty until the vocabulary is supplied, in which case
   * those names simply render in English.
   */
  referenceNames: Record<string, string> = {},
): ReportDoc {
  const dict = reportChrome(locale);
  // English (or any locale with no dictionary) is a no-op — return the very
  // same object so the default export path is not even shallow-copied.
  if (Object.keys(dict).length === 0 && Object.keys(referenceNames).length === 0) return doc;

  // Chrome first, then reference names: a column header called "Domain" is our
  // label, while a CELL containing a domain's name is their data. The two live
  // in different positions, so they cannot collide.
  const tr = (s: string): string => dict[chromeKey(s)] ?? referenceNames[s.trim()] ?? s;

  /**
   * Titles and detail headings are composed around an em-dash, and the chrome
   * can sit on either side of it:
   *
   *   "Domain-wise Needs Report — <study name>"   chrome leads
   *   "<domain name> — Domain Detail"             chrome trails
   *
   * The other half is a study, village, domain or indicator name written in
   * whatever language its author used, and must survive verbatim. So: try the
   * whole string, then each half, and translate only the half that is
   * recognised. An unrecognised heading returns unchanged.
   *
   * Only one separator is considered, so a subject containing its own em-dash
   * cannot be partially rewritten.
   */
  const trComposed = (s: string): string => {
    const whole = dict[chromeKey(s)];
    if (whole) return whole;
    const sep = s.indexOf(" — ");
    if (sep === -1) return s;
    const head = s.slice(0, sep);
    const tail = s.slice(sep + 3);
    const headHit = dict[chromeKey(head)];
    if (headHit) return `${headHit} — ${tail}`;
    const tailHit = dict[chromeKey(tail)];
    return tailHit ? `${head} — ${tailHit}` : s;
  };

  // Values get a SEPARATE, much smaller dictionary, matched whole-cell only.
  // "LOW", "No" and "YES — read Max, not Avg" are the platform's own rendering
  // of an enum, not data — leaving them English is the most visible remaining
  // leak in an otherwise-Arabic report. Anything not an exact match is data and
  // passes through untouched.
  const vocab = reportValueVocabulary(locale);

  /**
   * Chart SERIES names and stat labels.
   *
   * These sit between the two dictionaries: a radar's axes are domain names
   * (their data), but its series are "Severity" and "Performance" (our chrome).
   * A chart label therefore consults reference names, then chrome, then the
   * value vocabulary — unlike a table CELL, which must never reach the chrome
   * dictionary or a cell reading "Domain" would be rewritten.
   */
  const chartLabel = (s: string): string => {
    const key = s.trim();
    return referenceNames[key] ?? dict[chromeKey(key)] ?? vocab[key] ?? s;
  };
  // Reference names are checked FIRST: they are the client's authoritative
  // terminology, and if a domain were ever named the same as one of our band
  // words, theirs is the meaning that belongs in their report.
  const val = (s: string): string => {
    const key = s.trim();
    return referenceNames[key] ?? vocab[key] ?? s;
  };

  return {
    ...doc,
    title: trComposed(doc.title),
    headerBand: doc.headerBand.map((r) => ({ ...r, label: tr(r.label), value: val(r.value) })),
    sections: doc.sections.map((s) => localiseSection(s, tr, val, trComposed, chartLabel)),
    audit: doc.audit.map((r) => ({ ...r, label: tr(r.label), value: val(r.value) })),
    chapters: doc.chapters?.map((c) => ({
      ...c,
      name: tr(c.name),
      // A chapter's `summary` is a one-line descriptor written as chrome, not
      // generated prose, so it is safe to look up — and it falls through
      // unchanged when it is not in the dictionary.
      summary: tr(c.summary),
      sections: c.sections.map((s) => localiseSection(s, tr, val, trComposed, chartLabel)),
    })),
  };
}

function localiseSection(
  section: DocSection,
  tr: (s: string) => string,
  val: (s: string) => string,
  trComposed: (s: string) => string,
  chartLabel: (s: string) => string,
): DocSection {
  switch (section.kind) {
    // Carries no user-visible text at all.
    case "anchor":
      return section;

    case "keyvalue":
      return {
        ...section,
        heading: trComposed(section.heading),
        rows: section.rows.map((r) => ({ ...r, label: tr(r.label), value: val(r.value) })),
      };

    case "table":
      return {
        ...section,
        heading: trComposed(section.heading),
        // Column headers are chrome. Cells are data, and only an EXACT match
        // against the closed value vocabulary is substituted — a village or
        // domain name never is.
        columns: section.columns.map(tr),
        rows: section.rows.map((r) => r.map(val)),
      };

    case "navGrid":
      return {
        ...section,
        heading: trComposed(section.heading),
        // `sub` is a generated one-line descriptor of the target's contents,
        // not a fixed label, so it is left alone.
        tiles: section.tiles.map((t) => ({ ...t, label: tr(t.label) })),
      };

    case "pageBreak":
      return { ...section, heading: section.heading ? trComposed(section.heading) : section.heading };

    case "breadcrumb":
      return { ...section, trail: section.trail.map((c) => ({ ...c, label: tr(c.label) })) };

    case "stats":
      return {
        ...section,
        heading: trComposed(section.heading),
        tiles: section.tiles.map((t) => ({ ...t, label: tr(t.label), value: val(t.value) })),
      };

    // Chart point labels are DATA — usually a domain, village or KPI name, which
    // only `nameAr` may translate. But some are the platform's own rendering of
    // an enum ("Male", "Rural"), and those were the most visible remaining
    // English inside an Arabic chart. The whole-string value vocabulary is safe
    // here for exactly the reason it is safe in a table cell: it matches a tiny
    // closed set and leaves everything else untouched.
    case "bars":
      return {
        ...section,
        heading: trComposed(section.heading),
        bars: section.bars.map((b) => ({ ...b, label: val(b.label) })),
      };

    case "pie":
      return {
        ...section,
        heading: trComposed(section.heading),
        slices: section.slices.map((sl) => ({ ...sl, label: val(sl.label) })),
      };

    case "radar":
      return {
        ...section,
        heading: trComposed(section.heading),
        axes: section.axes.map(val),
        series: section.series.map((se) => ({ ...se, name: chartLabel(se.name) })),
      };

    case "groupedBars":
      return {
        ...section,
        heading: trComposed(section.heading),
        groups: section.groups.map(val),
        series: section.series.map((se) => ({ ...se, name: chartLabel(se.name) })),
      };

    // A gauge's `sub` is a formatted figure carrying its own band word.
    case "gauge":
      return {
        ...section,
        heading: trComposed(section.heading),
        sub: section.sub ? val(section.sub) : section.sub,
      };

    // Heading only: `items` and `text` are content (recommendations, notes,
    // narrative), which cannot be substituted and must come from the model or
    // the catalogue at the point it is composed.
    case "list":
    case "note":
      return { ...section, heading: trComposed(section.heading) };

    case "columns":
      return { ...section, children: section.children.map((c) => localiseSection(c, tr, val, trComposed, chartLabel)) };

    default: {
      // Exhaustiveness guard: a new DocSection kind must be considered here
      // rather than silently shipping untranslated.
      const _never: never = section;
      return _never;
    }
  }
}
