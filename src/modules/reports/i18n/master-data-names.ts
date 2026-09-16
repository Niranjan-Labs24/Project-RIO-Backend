import type { DocSection, ReportDoc } from '../report-doc';
import type { SupportedLocale } from '../../translation/translation.types';

// Arabic names for the master data a report prints — domains, sub-domains,
// indicators, KPIs, regions, governorates and centers.
//
// ## Why this happens at EXPORT time and not in the provider
//
// The obvious place to read `nameAr` is where the provider reads `name`. It
// does not work: a report's `content` is generated once, at CREATE time, and
// stored as JSONB. The export locale is only known later, when someone presses
// Download — possibly months later, possibly by a different user in a different
// language, and for an `archived` report whose content must not be regenerated
// at all. A locale-aware provider would need the locale before it exists.
//
// So the English names are already frozen in the stored content, and the
// translation has to be applied on the way out. This resolves them against the
// live master-data tables, which is authoritative rather than a guess: a cell
// reading "Health" is matched to the Domain row named "Health" and replaced
// with its `nameAr`.
//
// ## Why matching on text is safe HERE
//
// The label catalogue deliberately does not translate value positions, because
// its English keys collide with data (the severity band "CRITICAL" against the
// "Critical" column heading). This map has the opposite property: its keys ARE
// the data. A cell equal to "Water & Sanitation" is that domain, because that
// string came out of that row in the first place.
//
// Rows with no `nameAr` are simply absent from the map and keep their English —
// the same ladder the plan describes, minus the AI step, which belongs to the
// free-text pass rather than here.

/** Lowercased English name -> Arabic name. */
export type MasterDataAliases = ReadonlyMap<string, string>;

export const NO_ALIASES: MasterDataAliases = new Map();

/** The subset of Prisma this needs — kept structural so the loader can be
 *  called with either an org-scoped transaction or a supervisor one, and
 *  unit-tested without a database. */
export interface MasterDataTx {
  domain: { findMany(args: unknown): Promise<Array<{ name: string; nameAr: string | null }>> };
  subDomain: { findMany(args: unknown): Promise<Array<{ name: string; nameAr: string | null }>> };
  region: { findMany(args: unknown): Promise<Array<{ name: string; nameAr: string | null }>> };
  governorate: { findMany(args: unknown): Promise<Array<{ name: string; nameAr: string | null }>> };
  center: { findMany(args: unknown): Promise<Array<{ name: string; nameAr: string | null }>> };
  question: {
    findMany(args: unknown): Promise<
      Array<{
        indicator: string | null;
        indicatorAr: string | null;
        kpi: string | null;
        kpiAr: string | null;
      }>
    >;
  };
}

/**
 * Build the alias map for `locale`.
 *
 * Returns an empty map for English, so the caller can hand the result straight
 * to `localizeDataValues` without branching and the English path stays a no-op.
 */
export async function loadMasterDataAliases(
  tx: MasterDataTx,
  locale: SupportedLocale,
): Promise<MasterDataAliases> {
  if (locale === 'en') return NO_ALIASES;

  const nameSelect = { select: { name: true, nameAr: true } };
  const [domains, subDomains, regions, governorates, centers, questions] = await Promise.all([
    tx.domain.findMany(nameSelect),
    tx.subDomain.findMany(nameSelect),
    tx.region.findMany(nameSelect),
    tx.governorate.findMany(nameSelect),
    tx.center.findMany(nameSelect),
    tx.question.findMany({
      select: { indicator: true, indicatorAr: true, kpi: true, kpiAr: true },
    }),
  ]);

  const aliases = new Map<string, string>();
  const add = (en: string | null, ar: string | null): void => {
    if (!en || !ar) return;
    const key = en.trim().toLowerCase();
    // First writer wins. Two tables can carry the same English name (a Center
    // and a Governorate often share one), and their Arabic is the same too, so
    // the collision is real but harmless. Keeping the first makes the result
    // deterministic instead of dependent on Promise.all ordering.
    if (!key || aliases.has(key)) return;
    aliases.set(key, ar.trim());
  };

  for (const r of [...domains, ...subDomains, ...regions, ...governorates, ...centers]) {
    add(r.name, r.nameAr);
  }
  for (const q of questions) {
    add(q.indicator, q.indicatorAr);
    add(q.kpi, q.kpiAr);
  }
  return aliases;
}

/**
 * Replace master-data names in a document's VALUE positions.
 *
 * Label positions are untouched: they were already translated from the
 * catalogue by `localizeReportDoc`, and a label that happens to equal a domain
 * name ("Domains", "Severity") must keep the catalogue's wording rather than
 * being rewritten by a master-data row.
 */
export function localizeDataValues<T extends ReportDoc>(doc: T, aliases: MasterDataAliases): T {
  if (aliases.size === 0) return doc;
  const t = (s: string): string => aliases.get(s.trim().toLowerCase()) ?? s;

  const section = (s: DocSection): DocSection => {
    switch (s.kind) {
      case 'anchor':
      case 'note':
      case 'gauge':
        // note.text is prose, not a name; gauge.sub is a computed phrase.
        return s;
      case 'keyvalue':
        return { ...s, rows: s.rows.map((r) => ({ ...r, value: t(r.value) })) };
      case 'table':
        return { ...s, rows: s.rows.map((row) => row.map(t)) };
      case 'list':
        // Items are frequently "Domain: 81.00 (mean of 1 sub-domain)" — a name
        // glued to a computed clause, so an exact match usually misses. Left to
        // the parameterised-sentence work rather than part-matched here, which
        // would mean substring surgery on prose.
        return s;
      case 'bars':
        return { ...s, bars: s.bars.map((b) => ({ ...b, label: t(b.label) })) };
      case 'pie':
        return { ...s, slices: s.slices.map((x) => ({ ...x, label: t(x.label) })) };
      case 'radar':
        return { ...s, axes: s.axes.map(t) };
      case 'groupedBars':
        // `groups` are the categories (domain names); `series` are "This survey"
        // / "Organisation", which the catalogue already handled.
        return { ...s, groups: s.groups.map(t) };
      case 'stats':
        // A stat tile's label carries a domain name in the per-domain strips.
        return { ...s, tiles: s.tiles.map((x) => ({ ...x, label: t(x.label) })) };
      case 'navGrid':
        return { ...s, tiles: s.tiles.map((x) => ({ ...x, label: t(x.label), sub: t(x.sub) })) };
      case 'breadcrumb':
        return { ...s, trail: s.trail.map((x) => ({ ...x, label: t(x.label) })) };
      case 'pageBreak':
        // The drill-down page heading is "{name} — Domain Detail": the fixed
        // half is already Arabic from the catalogue, and the name in front of
        // it is master data.
        return s.heading === undefined ? s : { ...s, heading: localizeComposedName(s.heading, t) };
      case 'columns':
        return { ...s, children: s.children.map(section) };
    }
  };

  return {
    ...doc,
    // The title is "{fixed phrase} — {name}" or "{name} — {fixed phrase}"
    // depending on the report type. The fixed half is already Arabic from the
    // catalogue; this resolves the name half, whichever side it sits on.
    title: localizeComposedName(doc.title, t),
    headerBand: doc.headerBand.map((r) => ({ ...r, value: t(r.value) })),
    sections: doc.sections.map(section),
    ...(doc.chapters
      ? { chapters: doc.chapters.map((c) => ({ ...c, sections: c.sections.map(section) })) }
      : {}),
  };
}

/**
 * "Health — تفاصيل المجال" -> "الصحة — تفاصيل المجال".
 *
 * Every em-dash-separated segment is offered to the alias map, not just the
 * first: drill-down headings put the data name in front, report titles put it
 * on either side depending on the report type. Offering all of them is safe
 * because the map only contains master-data names — a segment that is not one
 * (an already-translated catalogue phrase, a free-text survey title) simply
 * does not match and comes back unchanged.
 */
function localizeComposedName(text: string, t: (s: string) => string): string {
  if (!text.includes(' — ')) return t(text);
  return text
    .split(' — ')
    .map((part) => t(part))
    .join(' — ');
}
