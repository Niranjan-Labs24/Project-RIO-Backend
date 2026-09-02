import type { DocSection, ReportDoc } from "./report-doc";

/**
 * One walk over every human-readable string in a `ReportDoc`, applied through
 * `fn`.
 *
 * WHY ONE WALKER AND NOT TWO
 *
 * The AI translation pass needs the document's strings twice: once to collect
 * what must be sent to the model, and once to splice the answers back. Written
 * as two walks they drift — a section kind added to the collector but not the
 * applier silently sends text to the model and then throws the translation
 * away, which costs tokens and looks like a translation failure. Written as one
 * mapping walk, collection is `fn = (s) => { seen.add(s); return s; }` and
 * application is `fn = (s) => map.get(s) ?? s`, and neither can forget a field
 * the other remembers.
 *
 * WHAT IS DELIBERATELY NOT VISITED
 *
 * Anchor ids, `to` link targets and `anchorId` are machine identifiers, not
 * text. Rewriting one produces a PDF whose internal links point nowhere, which
 * is worse than an untranslated label because it looks actionable and is not.
 * Numeric fields (`value`, `max`, `values`, `weights`) are never visited either
 * — a number that survived a language pass by luck is not a design.
 *
 * This is a SUPERSET of what `localise-doc.ts` touches, on purpose. That module
 * is a dictionary and must not rewrite data it cannot recognise; this one feeds
 * a translator that is meant to see everything, including the list items and
 * note prose the dictionary refuses.
 */
export function mapDocStrings(doc: ReportDoc, fn: (text: string) => string): ReportDoc {
  return {
    ...doc,
    title: fn(doc.title),
    headerBand: doc.headerBand.map((r) => ({ ...r, label: fn(r.label), value: fn(r.value) })),
    sections: doc.sections.map((s) => mapSection(s, fn)),
    audit: doc.audit.map((r) => ({ ...r, label: fn(r.label), value: fn(r.value) })),
    chapters: doc.chapters?.map((c) => ({
      ...c,
      name: fn(c.name),
      summary: fn(c.summary),
      sections: c.sections.map((s) => mapSection(s, fn)),
    })),
  };
}

/** Every distinct string in the document, in first-seen order.
 *
 *  Distinct, because a report repeats "Severity" in forty cells and a
 *  translator should be asked once. First-seen order, because a stable request
 *  order makes two runs of the same report comparable in a log. */
export function collectDocStrings(doc: ReportDoc): string[] {
  const seen = new Set<string>();
  mapDocStrings(doc, (text) => {
    if (text) seen.add(text);
    return text;
  });
  return [...seen];
}

function mapSection(section: DocSection, fn: (text: string) => string): DocSection {
  switch (section.kind) {
    case "anchor":
      return section;

    case "keyvalue":
      return {
        ...section,
        heading: fn(section.heading),
        rows: section.rows.map((r) => ({ ...r, label: fn(r.label), value: fn(r.value) })),
      };

    case "table":
      return {
        ...section,
        heading: fn(section.heading),
        columns: section.columns.map(fn),
        rows: section.rows.map((r) => r.map(fn)),
        // rowLinks is deliberately untouched: anchor ids, not text.
      };

    case "navGrid":
      return {
        ...section,
        heading: fn(section.heading),
        // `sub` IS visited here, unlike in localise-doc: it is a generated
        // descriptor, which a dictionary cannot match but a translator can.
        tiles: section.tiles.map((t) => ({ ...t, label: fn(t.label), sub: fn(t.sub) })),
      };

    case "pageBreak":
      return { ...section, heading: section.heading === undefined ? section.heading : fn(section.heading) };

    case "breadcrumb":
      return { ...section, trail: section.trail.map((c) => ({ ...c, label: fn(c.label) })) };

    case "bars":
      return { ...section, heading: fn(section.heading), bars: section.bars.map((b) => ({ ...b, label: fn(b.label) })) };

    case "pie":
      return { ...section, heading: fn(section.heading), slices: section.slices.map((s) => ({ ...s, label: fn(s.label) })) };

    case "gauge":
      return { ...section, heading: fn(section.heading), sub: section.sub === undefined ? section.sub : fn(section.sub) };

    case "radar":
      return {
        ...section,
        heading: fn(section.heading),
        axes: section.axes.map(fn),
        series: section.series.map((se) => ({ ...se, name: fn(se.name) })),
      };

    case "groupedBars":
      return {
        ...section,
        heading: fn(section.heading),
        groups: section.groups.map(fn),
        series: section.series.map((se) => ({ ...se, name: fn(se.name) })),
      };

    // The two the dictionary refuses. Narrative prose is precisely what the
    // model is for, and leaving these out was the single largest block of
    // English left in an Arabic report.
    case "list":
      return { ...section, heading: fn(section.heading), items: section.items.map(fn) };

    case "note":
      return { ...section, heading: fn(section.heading), text: fn(section.text) };

    case "stats":
      return {
        ...section,
        heading: fn(section.heading),
        tiles: section.tiles.map((t) => ({
          ...t,
          label: fn(t.label),
          value: fn(t.value),
          sub: t.sub === undefined ? t.sub : fn(t.sub),
        })),
      };

    case "columns":
      return { ...section, children: section.children.map((c) => mapSection(c, fn)) };

    default: {
      // A new DocSection kind must be considered here, or its text silently
      // never reaches the translator.
      const _never: never = section;
      return _never;
    }
  }
}
