// The client's design applied to a report's EXISTING sections (report types in
// DESIGN_STYLE_REPORT_TYPES): the methodology's LOW / STANDARD wording becomes
// the plain confidence bands, priority tables get the design's table and band
// badges, and the demographic pies become the design's rings. The PDF also
// frames every section as a card (pdf-builder.ts, ReportDoc.design).
//
// Runs on the English-labelled sections before localisation, so it can find a
// section by its builder heading; what it writes is already in `locale`.

import type { CellTone, DocSection } from '../report-doc';
import { label, localizeKnownLabel, type ReportLabelKey } from '../i18n/report-labels';
import type { SupportedLocale } from '../../translation/translation.types';
import { confidenceBandOf, type ReportPresentation } from './build-presentation';
import { bandLabel, bandNote, confidenceSentence } from './presentation-doc';
import type { ConfidenceBand } from './presentation.config';

const BAND_TONE: Record<ConfidenceBand, CellTone> = {
  VERY_LOW: 'danger',
  MEDIUM: 'medium',
  STRONG: 'ok',
};

const DEMOGRAPHIC_PIES: Record<string, 'gender' | 'rural'> = {
  'Gender Breakdown': 'gender',
  'Rural / Urban Breakdown': 'rural',
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Valid responses per domain/KPI name, for tables that print a confidence
 *  without its count (the domain tables). */
function validByName(content: Record<string, unknown>): Map<string, number> {
  const out = new Map<string, number>();
  const visit = (arr: unknown) => {
    if (!Array.isArray(arr)) return;
    for (const r of arr) {
      if (!isObj(r) || typeof r.validResponseCount !== 'number') continue;
      for (const k of ['name', 'domain', 'kpiName', 'kpi']) {
        if (typeof r[k] === 'string') out.set(r[k].trim(), r.validResponseCount);
      }
    }
  };
  if (isObj(content.severity)) visit(content.severity.domains);
  visit(content.domains);
  visit(content.domainRollup);
  visit(content.domainConfidence);
  visit(content.topPriorities);
  if (isObj(content.priorityNeeds)) visit(content.priorityNeeds.needs);
  return out;
}

export function applyDesign(
  sections: DocSection[],
  p: ReportPresentation,
  locale: SupportedLocale,
  content: Record<string, unknown> = {},
): DocSection[] {
  const c = p.confidence;
  const counts = validByName(content);
  const rq = isObj(content.responseQuality) ? content.responseQuality : {};
  const oldLevel = typeof rq.overallConfidence === 'string' ? rq.overallConfidence : null;
  const oldReason = typeof rq.confidenceReason === 'string' ? rq.confidenceReason : null;
  /** The methodology's "LOW … STANDARD" sentence, wherever the report
   *  composed it, becomes the band explanation. */
  const rewordProse = (text: string): string => {
    if (!c) return text;
    let out = text;
    if (oldLevel && oldReason) {
      out = out
        .split(`Overall confidence is ${oldLevel}. ${oldReason}`)
        .join(confidenceSentence(c, locale));
    }
    if (oldReason) out = out.split(oldReason).join(bandNote(c, locale));
    return out;
  };
  // Repeated sections held in full by another report: a one-line reference.
  const refs = new Set(p.referenced.map((r) => r.key));
  const reference = (key: 'aiSummary' | 'demographics' | 'dataQualityNote'): string =>
    label(
      (key === 'dataQualityNote'
        ? 'presentation.reference.dataQuality'
        : 'presentation.reference.executiveSummary'),
      locale,
    );
  let demographicsReferenced = false;
  const bandFor = (n: number | null): ConfidenceBand =>
    n != null && c ? confidenceBandOf(n, c.requiredSampleSize) : (c?.band ?? 'VERY_LOW');
  const out: DocSection[] = [];
  const rings: Extract<DocSection, { kind: 'rings' }> = {
    kind: 'rings',
    heading: 'Demographic Breakdown',
    items: [],
  };

  for (const raw of sections) {
    // Side-by-side layouts (the Needs Index gauge beside Response Quality)
    // hold sections too.
    if (raw.kind === 'columns') {
      out.push({ ...raw, children: applyDesign(raw.children, p, locale, content) });
      continue;
    }
    const s = raw;
    if (refs.has('aiSummary') && s.kind === 'keyvalue' && s.heading === 'AI Summary') {
      out.push({ kind: 'note', heading: s.heading, text: reference('aiSummary') });
      continue;
    }
    if (refs.has('dataQualityNote') && s.kind === 'note' && s.heading === 'Data Quality Note') {
      out.push({ kind: 'note', heading: s.heading, text: reference('dataQualityNote') });
      continue;
    }
    if (
      refs.has('demographics') &&
      ((s.kind === 'pie' && DEMOGRAPHIC_PIES[s.heading]) ||
        (s.kind === 'note' && s.heading === 'Demographic Breakdown'))
    ) {
      if (!demographicsReferenced) {
        out.push({ kind: 'note', heading: 'Demographic Breakdown', text: reference('demographics') });
        demographicsReferenced = true;
      }
      continue;
    }
    // Response Quality / Completeness: the band and its explanation, not
    // LOW / STANDARD.
    if (s.kind === 'keyvalue' && c) {
      out.push({
        ...s,
        rows: s.rows.map((r) =>
          /^overall confidence$/i.test(r.label)
            ? {
                ...r,
                // A long value carried the reason too; the band's sentence
                // already opens with the band ("Very low — only 3 of …").
                value:
                  r.value.length > 12 ? confidenceSentence(c, locale) : bandLabel(c.band, locale),
              }
            : r.label === 'Why this band'
              ? { ...r, value: bandNote(c, locale) }
              : { ...r, value: rewordProse(r.value) },
        ),
      });
      continue;
    }

    // Headline tiles: the confidence tile shows the band and the sample
    // against the size strong confidence needs.
    if (s.kind === 'stats' && c) {
      out.push({
        ...s,
        tiles: s.tiles.map((x) =>
          /^confidence$/i.test(x.label)
            ? {
                ...x,
                value: bandLabel(c.band, locale),
                sub: `${c.validResponses} / ${c.requiredSampleSize ?? '—'}`,
              }
            : x,
        ),
      });
      continue;
    }

    if (s.kind === 'note') {
      out.push({ ...s, text: rewordProse(s.text) });
      continue;
    }

    // A priority table: per-row band from its own valid responses, as a badge;
    // severity in the design's emphasis.
    if (raw.kind === 'table') {
      const trimmed = dropEmptyColumns(raw);
      // Columns named from field keys read "Kpi"; the design writes "KPI".
      const s = {
        ...trimmed,
        columns: trimmed.columns.map((col) => (col === 'Kpi' ? 'KPI' : col)),
      };
      const conf = s.columns.indexOf('Confidence');
      const valid = s.columns.indexOf('Valid Response Count');
      const sev = s.columns.findIndex((col) => /^severity/i.test(col));
      // Very wide tables (the domain table) stay compact so they still fit.
      const roomy = s.columns.length <= 8;
      const why = s.columns.indexOf('Why this band');
      if (conf >= 0 && c) {
        const bands = s.rows.map((row) => {
          const n = Number(row[valid]);
          if (valid >= 0 && Number.isFinite(n)) return bandFor(n);
          return bandFor(counts.get((row[0] ?? '').trim()) ?? null);
        });
        out.push(liftConstantColumns({
          ...s,
          roomy,
          rows: s.rows.map((row, i) =>
            row.map((cell, j) =>
              j === conf
                ? bandLabel(bands[i]!, locale)
                : j === why
                  ? confidenceSentence({ ...c, band: bands[i]! }, locale)
                  : cell,
            ),
          ),
          tones: s.rows.map((row, i) =>
            row.map((_, j) => (j === conf ? BAND_TONE[bands[i]!] : j === sev ? 'danger' : null)),
          ),
        }));
        continue;
      }
      out.push(liftConstantColumns({ ...s, roomy }));
      continue;
    }

    // Demographic pies → one card of rings, where the first of them stood.
    if (s.kind === 'pie' && DEMOGRAPHIC_PIES[s.heading]) {
      if (!rings.items.length) out.push(rings);
      rings.items.push({
        label: label(DEMOGRAPHIC_PIES[s.heading]!, locale),
        slices: s.slices.map((x) => ({ ...x, label: localizeKnownLabel(x.label, locale) })),
      });
      continue;
    }

    out.push(s);
  }
  // The report holding the demographics also shows respondents by age band.
  if (p.ageBands && rings.items.length) {
    rings.items.push({
      label: label('presentation.ageLabel', locale),
      slices: p.ageBands
        .filter((b) => b.count > 0)
        .map((b) => ({ label: label(`presentation.age.${b.band}` as ReportLabelKey, locale), value: b.count })),
    });
  }
  return out;
}

const EMPTY = new Set(['', '-', '—', 'null', 'undefined']);

/** A column with nothing in any row ("Not Measured Reason" when every KPI was
 *  measured) only takes width from the ones that carry the findings. */
function dropEmptyColumns(
  s: Extract<DocSection, { kind: 'table' }>,
): Extract<DocSection, { kind: 'table' }> {
  if (!s.rows.length) return s;
  const keep = s.columns.map((_, j) => s.rows.some((row) => !EMPTY.has((row[j] ?? '').trim())));
  if (keep.every(Boolean)) return s;
  const pick = <T>(arr: T[]): T[] => arr.filter((_, j) => keep[j]);
  return {
    ...s,
    columns: pick(s.columns),
    rows: s.rows.map(pick),
    ...(s.tones ? { tones: s.tones.map(pick) } : {}),
  };
}

/**
 * A table too wide for the page (more than 8 columns) loses the columns whose
 * value is the same in every row — they move to one line above it
 * ("Domain: Health · Location: Ad-Dilam +5"), so nothing is dropped and the
 * columns that differ stay readable.
 */
function liftConstantColumns(
  s: Extract<DocSection, { kind: 'table' }>,
): Extract<DocSection, { kind: 'table' }> {
  if (s.columns.length <= 8 || s.rows.length < 2 || s.rowLinks?.length === 0) return s;
  const constant = s.columns.map((_, j) => {
    const first = (s.rows[0]![j] ?? '').trim();
    return !!first && s.rows.every((row) => (row[j] ?? '').trim() === first);
  });
  if (!constant.some(Boolean)) return s;
  const lifted = s.columns
    .map((col, j) => (constant[j] ? `${col}: ${s.rows[0]![j]}` : null))
    .filter((x): x is string => !!x)
    .join(' · ');
  const keep = (_: unknown, j: number) => !constant[j];
  return {
    ...s,
    subheading: s.subheading ? `${s.subheading} — ${lifted}` : lifted,
    columns: s.columns.filter(keep),
    rows: s.rows.map((row) => row.filter(keep)),
    ...(s.tones ? { tones: s.tones.map((row) => row.filter(keep)) } : {}),
  };
}
