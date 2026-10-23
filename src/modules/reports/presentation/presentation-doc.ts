// The presentation block as export sections — the PDF/Excel twin of the
// frontend's report-presentation.tsx. Same blocks, same order, same wording
// (both read app.reports.content.presentation from the shared catalogue), so
// the in-app report and the exported one match the client's design.

import type { CalloutTone, CellTone, DocSection } from '../report-doc';
import { label as catalogueLabel, type ReportLabelKey } from '../i18n/report-labels';
import type { SupportedLocale } from '../../translation/translation.types';
import type { ConfidenceBand } from './presentation.config';
import type { ReportPresentation } from './build-presentation';

type Params = Record<string, string | number>;

function fmt(n: number, locale: SupportedLocale): string {
  return new Intl.NumberFormat(locale === 'ar' ? 'ar-SA-u-nu-latn' : 'en-US', {
    maximumFractionDigits: 1,
  }).format(n);
}

const CALLOUT_TONE: Record<ConfidenceBand, CalloutTone> = {
  VERY_LOW: 'danger',
  MEDIUM: 'medium',
  STRONG: 'ok',
};

/**
 * The design's cards, in its order: the summary panel, confidence bands,
 * participation per governorate, and language & governance.
 */
export function presentationDocSections(
  p: ReportPresentation | undefined | null,
  locale: SupportedLocale,
): DocSection[] {
  if (!p || p.version !== 1) return [];
  const t = (key: string, params?: Params) =>
    catalogueLabel(`presentation.${key}` as ReportLabelKey, locale, params);
  const show = (b: string) => p.blocks.includes(b as never);
  const out: DocSection[] = [];
  const c = p.confidence;
  const s = p.summary;

  if (show('summary') && s && c) {
    const parts: string[] = [];
    if (s.index != null) {
      const band = s.indexBand ? t(`indexBand.${s.indexBand}`) : '';
      parts.push(t('findIndex', { band, index: fmt(s.index, locale) }));
    }
    const kpis = s.topKpis
      .map((k) => t('kpiScore', { kpi: k.name, score: fmt(k.score, locale) }))
      .join(t('listAnd'));
    if (s.topDomain) {
      const args = { domain: s.topDomain.name, score: fmt(s.topDomain.score, locale) };
      parts.push(kpis ? t('findDomainKpis', { ...args, kpis }) : t('findDomain', args));
    } else if (s.topArea) {
      parts.push(t('findArea', { area: s.topArea.name, score: fmt(s.topArea.score, locale) }));
    } else if (kpis) {
      parts.push(t('findKpisOnly', { kpis }));
    } else if (s.quality) {
      parts.push(t('findQuality', { ...s.quality }));
    }
    out.push({
      kind: 'summaryPanel',
      title: t('summaryTitle'),
      columns: [
        { label: t('findLabel'), text: parts.join(' ') },
        { label: t('confidentLabel'), text: confidenceText(c, t) },
        { label: t('decisionLabel'), text: t(`decision.${s.decision}`) },
      ],
    });
  }

  if (show('confidence') && c) {
    const req = c.requiredSampleSize;
    const segments: Array<{ band: ConfidenceBand; label: string; grow: number }> = [
      {
        band: 'VERY_LOW',
        label: `${t('band.VERY_LOW')} ${t('bandRange.VERY_LOW', { min: c.mediumFrom })}`,
        grow: 1.8,
      },
      {
        band: 'MEDIUM',
        label: `${t('band.MEDIUM')} ${
          req != null
            ? t('bandRange.MEDIUM', { min: c.mediumFrom, max: req - 1 })
            : t('bandRange.MEDIUM_open', { min: c.mediumFrom })
        }`,
        grow: 4,
      },
      ...(req != null
        ? [
            {
              band: 'STRONG' as const,
              label: `${t('band.STRONG')} ${t('bandRange.STRONG', { required: req })}`,
              grow: 4,
            },
          ]
        : []),
    ];
    const scale: DocSection = {
      kind: 'bandScale',
      heading: '',
      segments: segments.map((g) => ({ ...g, active: g.band === c.band })),
      note: bandNote(c, locale),
    };
    out.push({ kind: 'card', heading: t('bandsTitle'), children: [scale] });
  }

  if (show('participation') && p.participation) {
    for (const g of p.participation) {
      out.push({
        kind: 'card',
        heading: t('participationTitle', { governorate: g.governorate }),
        hint: t('participationHint'),
        children: [
          {
            kind: 'table',
            heading: '',
            roomy: true,
            columns: [t('colVillage'), t('colResponses'), t('colShare'), t('colStatus')],
            // As the mockup: a last row for the governorate's villages that
            // are not part of the study (no village master data to name them).
            rows: [
              ...g.rows.map((r) => [
                r.village,
                fmt(r.responses, locale),
                `${fmt(r.sharePct, locale)}%`,
                r.status ? t(`status.${r.status}`) : '—',
              ]),
              [t('otherVillages'), t('noResponses'), '—', '—'],
            ],
            tones: [
              ...g.rows.map((r): Array<CellTone | null> => [
                null,
                null,
                r.responses ? 'strong' : null,
                r.status ? 'danger' : null,
              ]),
              [null, null, null, null],
            ],
          },
        ],
      });
    }
  }

  // Language & governance: adaptive wording, KPI rows, excluded responses and
  // the sign-off, together in one card as in the design.
  const gov: DocSection[] = [];
  const subject =
    s?.topKpis[0] ??
    (s?.topDomain ? { name: s.topDomain.name, score: s.topDomain.score } : null) ??
    (s?.topArea ? { name: s.topArea.name, score: s.topArea.score } : null);
  if (show('adaptiveWording') && c && subject) {
    const args = { subject: subject.name, score: fmt(subject.score, locale) };
    gov.push({ kind: 'caption', text: t('wordingTitle') });
    gov.push({
      kind: 'callouts',
      items: [
        { label: t('wordingIfStrong'), text: t('wording.strongText', args), tone: 'ok' },
        {
          label: t('wordingActual', { band: t(`band.${c.band}`) }),
          text: t(`wording.actual.${c.band}`, args),
          tone: CALLOUT_TONE[c.band],
        },
      ],
    });
  }

  if (show('kpis') && p.kpis) {
    gov.push({ kind: 'caption', text: t('kpisTitle') });
    gov.push({
      kind: 'table',
      heading: '',
      roomy: true,
      columns: [t('colKpi'), t('colSeverity'), t('colGapType'), t('colFit')],
      rows: p.kpis.map((k) => [
        k.kpi,
        k.severity == null ? '—' : fmt(k.severity, locale),
        k.gapType ? t(`gapType.${k.gapType}`) : '—',
        k.fitToPublish ? t('fitYes') : t('fitNo'),
      ]),
      tones: p.kpis.map((k) => [null, 'danger', null, k.fitToPublish ? 'ok' : 'danger']),
    });
  }

  if (show('excluded') && p.excluded) {
    const e = p.excluded;
    const reasons = (
      [
        ['duplicate', e.duplicate],
        ['lowConfidence', e.lowConfidence],
        ['other', e.other],
      ] as const
    )
      .filter(([, n]) => n > 0)
      .map(([k, n]) => t(`excludedReason.${k}`, { count: n }));
    gov.push({ kind: 'caption', text: t('excludedTitle') });
    gov.push({
      kind: 'panel',
      text:
        e.total === 0
          ? t('excludedNone')
          : reasons.length
            ? t('excludedSummary', { total: e.total, reasons: reasons.join(t('listSeparator')) })
            : t('excludedNoReason', { total: e.total }),
    });
  }

  if (show('signOff') && p.signOff) {
    const so = p.signOff;
    const org = so.organization ?? '—';
    gov.push({
      kind: 'footnote',
      text: so.reviewerName
        ? so.reviewerRole
          ? t('signOff', { name: so.reviewerName, role: so.reviewerRole, organization: org })
          : t('signOffNoRole', { name: so.reviewerName, organization: org })
        : t('signOffPending', { organization: org }),
    });
  }
  if (gov.length) out.push({ kind: 'card', heading: t('governanceTitle'), children: gov });
  return out;
}

function confidenceText(
  c: NonNullable<ReportPresentation['confidence']>,
  t: (key: string, params?: Params) => string,
): string {
  if (c.requiredSampleSize != null) {
    return t(`confidence.${c.band}`, { valid: c.validResponses, required: c.requiredSampleSize });
  }
  const key =
    c.band === 'STRONG' ? 'confidence.MEDIUM_noRequired' : `confidence.${c.band}_noRequired`;
  return t(key, { valid: c.validResponses, min: c.mediumFrom });
}

/** "Very low" / "Medium" / "Strong" in `locale`. */
export function bandLabel(band: ConfidenceBand, locale: SupportedLocale): string {
  return catalogueLabel(`presentation.band.${band}` as ReportLabelKey, locale);
}

/** The line under the confidence scale: the current sample, its band, and
 *  what strong confidence would take. */
export function bandNote(
  c: NonNullable<ReportPresentation['confidence']>,
  locale: SupportedLocale,
): string {
  const t = (key: string, params?: Params) =>
    catalogueLabel(`presentation.${key}` as ReportLabelKey, locale, params);
  const req = c.requiredSampleSize;
  const band = bandLabel(c.band, locale);
  if (req == null) return t('bandNoteNoRequired', { valid: c.validResponses, band });
  return c.population != null
    ? t('bandNote', { valid: c.validResponses, band, required: req, population: c.population })
    : t('bandNoteNoPopulation', { valid: c.validResponses, band, required: req });
}

/** "Very low — only 3 of the 70 responses required…" for `valid` responses. */
export function confidenceSentence(
  c: NonNullable<ReportPresentation['confidence']>,
  locale: SupportedLocale,
): string {
  const t = (key: string, params?: Params) =>
    catalogueLabel(`presentation.${key}` as ReportLabelKey, locale, params);
  return confidenceText(c, t);
}
