// Core Needs Report — the stored content resolved into ONE language.
//
// The PDF, the Excel export and the in-app view all render from this view
// model, so a sentence is composed once and reads the same everywhere. Every
// fixed wording comes from the shared label catalogue (app.reports.content
// .core); names go through the master-data aliases; free text (village names,
// the study title) through a lookup the caller fills from the translation
// service. Numbers keep Latin digits in both languages, as every other report.

import { label as catalogueLabel, type ReportLabelKey } from '../i18n/report-labels';
import type { MasterDataAliases } from '../i18n/master-data-names';
import type { SupportedLocale } from '../../translation/translation.types';
import type { SeverityBand } from '../need-record.types';
import type { ConfidenceResult } from './core-needs.config';
import { ROLE_MATRIX } from '../../../rbac/role-matrix';
import { splitKpi, tierOf } from './build-core-needs';
import type { ActualValue, CoreNeedsContent, UnitKind } from './core-needs.types';

type Params = Record<string, string | number>;

export interface CoreAudit {
  generatedBy: string | null;
  generatedAt: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  reviewedBy: string | null;
  reviewedRole: string | null;
  reviewedAt: string | null;
  reviewerNotes: string | null;
  version: number;
}

export type Tone = 'critical' | 'high' | 'medium' | 'low' | 'none';
export interface Cell {
  text: string;
  sub?: string;
  tone?: Tone;
  badge?: boolean;
  bold?: boolean;
  muted?: boolean;
  /** 0–1: a small bar under the text, e.g. households collected of required. */
  progress?: number;
}

export interface CoreView {
  locale: SupportedLocale;
  dir: 'ltr' | 'rtl';
  output: 'FULL' | 'SUMMARY';
  overall: ConfidenceResult;
  watermark: string | null;
  running: { left: string; usage: string };
  /** `pageOf` keeps "{page}" and "{count}" placeholders for the renderer. */
  footer: { left: string; pageOf: string; methodology: string };
  header: {
    kicker: string;
    title: string;
    study: string;
    organization: string;
    platformOwner: string;
    chips: string[];
  };
  profile: {
    title: string;
    source: string;
    tiles: Array<{ label: string; value: string }>;
    inStudy: string;
  };
  /** Shown only when the overall result is Low ("otherwise no warning
   *  label", structure v2.1). */
  usage: { show: boolean; label: string; band: ConfidenceResult; text: string };
  decision: {
    title: string;
    issuedAlone: string;
    find: { q: string; text: string };
    confident: { q: string; text: string };
    decide: { q: string; text: string };
  };
  confidence: {
    title: string;
    rule: string;
    /** `band` null = shown for information (no approved threshold). */
    rows: Array<{
      label: string;
      sub: string;
      value: string;
      band: ConfidenceResult | null;
      bandLabel: string;
      ratio: number;
    }>;
  };
  /** Reader guide. `part` names the section a PDF box links to; `pageLabel`
   *  is the localized "{name} · p.{pages}" the PDF fills with real pages
   *  (the app shows `title` alone — it has no pages). */
  guide: Array<{ title: string; q: string; part: 'summary' | 'programmes' | 'research' | 'donors'; pageLabel: string }>;
  approval: string;
  where: {
    show: boolean;
    title: string;
    lead: string;
    map: {
      title: string;
      legend: string;
      level: 'REGION' | 'GOVERNORATE' | 'CENTRE' | null;
      units: Array<{
        id: string;
        code: string | null;
        name: string;
        caption: string;
        households: number;
        severity: number | null;
        status: 'SHOWN' | 'NOT_SHOWN' | 'NO_DATA';
      }>;
      /** Units at the map level inside the scope that are not in the study. */
      context: Array<{ code: string; name: string }>;
      legendItems: Array<{ kind: Tone | 'hatched' | 'nodata' | 'outside'; label: string }>;
    } | null;
    units: {
      title: string;
      columns: string[];
      rows: Cell[][];
      note: string;
      ranking: string;
    } | null;
    villages: { title: string; columns: string[]; rows: Cell[][]; note: string } | null;
    needs: {
      title: string;
      provisional: string | null;
      rankedBy: string;
      columns: string[];
      rows: Cell[][];
      empty: string;
    };
  };
  design: {
    title: string;
    lead: string;
    domains: {
      title: string;
      legend: Array<{ label: string; tone: Tone }>;
      rows: Array<{
        name: string;
        severity: number | null;
        value: string;
        weight: string;
        tone: Tone;
        /** Fit to publish for the domain (Jagan, 19 Oct 2026). */
        fit: string;
        fitTone: Tone;
        /** "Critical need present" (v5.0 no-masking rule); null when none. */
        flag?: string | null;
      }>;
      others: string | null;
    };
    hierarchy: {
      title: string;
      columns: string[];
      groups: Array<{ title: string; severity: string; tone: Tone; rows: Cell[][] }>;
      note: string;
    };
    reading: { title: string; lines: Array<{ lead: string; text: string }> };
    /** Hidden while no indicator pairs are configured. */
    links: { show: boolean; title: string; tag: string; lines: string[] };
  };
  evidence: {
    title: string;
    lead: string;
    distribution: {
      title: string;
      columns: string[];
      rows: Cell[][];
      flag: string | null;
      note: string;
    };
    responses: {
      title: string;
      rows: Array<{ label: string; value: string }>;
      gender: Array<{ label: string; count: number }>;
      age: string;
      ageBars: Array<{ label: string; count: number }>;
      /** What each exclusion reason means ("each counted and explained"). */
      note: string;
    };
    fit: { title: string; columns: string[]; rows: Cell[][] };
    next: { title: string; items: string[] };
    /** NCNP report only. */
    studies: { title: string; columns: string[]; rows: Cell[][]; rule: string } | null;
    cards: Array<{
      title: string;
      forWhom: string;
      status: string;
      eligible: boolean;
      fields: Array<{ label: string; value: string }>;
      footer: string;
    }>;
    audit: Array<{ label: string; value: string }>;
  };
}

export interface CoreViewInput {
  content: CoreNeedsContent;
  locale: SupportedLocale;
  aliases: MasterDataAliases;
  /** Free text (village names, study title …) in `locale`; missing = as typed. */
  freeText?: ReadonlyMap<string, string>;
  audit: CoreAudit;
}

const TONE: Record<SeverityBand, Tone> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
};
const RESULT_TONE: Record<ConfidenceResult, Tone> = { LOW: 'critical', MEETS: 'low' };

export function buildCoreView(input: CoreViewInput): CoreView {
  const { content: c, locale, aliases } = input;
  const ar = locale === 'ar';
  const t = (key: string, params?: Params): string =>
    catalogueLabel(`core.${key}` as ReportLabelKey, locale, params);
  const nf = new Intl.NumberFormat(ar ? 'ar-SA-u-nu-latn' : 'en-US', { maximumFractionDigits: 1 });
  const n = (x: number | null | undefined): string => (x == null ? t('noValue') : nf.format(x));
  // In Arabic a date or audit line opens with a right-to-left mark: next to a
  // name in Latin letters its digits otherwise join the Latin run and the
  // date reads "22 08:10 2026 أكتوبر".
  const rl = (s: string): string => (ar ? `\u200F${s}` : s);
  const comma = ar ? '، ' : ', ';
  const date = (iso: string | null): string => {
    if (!iso) return t('noValue');
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return rl(new Intl.DateTimeFormat(ar ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(d));
  };
  const time = (iso: string | null): string => {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ''
      : new Intl.DateTimeFormat(ar ? 'ar-SA-u-nu-latn' : 'en-GB', {
          hour: '2-digit',
          minute: '2-digit',
        }).format(d);
  };
  const name = (s: string | null | undefined): string => {
    if (!s) return t('noValue');
    const exact = aliases.get(s.trim().toLowerCase());
    if (exact) return exact;
    // "Village — Governorate": the village is typed text, the governorate
    // master data with its official name in the reader's language.
    const parts = / — (.+)$/.exec(s);
    const gov = parts ? aliases.get(parts[1]!.trim().toLowerCase()) : undefined;
    if (parts && gov) {
      const village = s.slice(0, parts.index);
      return `${input.freeText?.get(village) ?? village} — ${gov}`;
    }
    return input.freeText?.get(s) ?? s;
  };
  // "Domain › Sub-domain". In Arabic a slash, which needs no mirroring.
  const sep = ar ? ' / ' : ' › ';
  const kpiName = (full: string): string => splitKpi(name(full))[1] || splitKpi(full)[1];
  const list = (items: string[]): string =>
    items.length <= 1
      ? (items[0] ?? '')
      : `${items.slice(0, -1).join(t('listSep'))}${t('listAnd')}${items[items.length - 1]}`;
  const bandLabel = (b: ConfidenceResult | null) => t(b ? `band.${b}` : 'band.INFO');
  const units = (k: UnitKind) => t(`units.${k}`);
  // "62% of households (40% No), n = 25" — the share whose need is not fully
  // met, the "No" share in brackets and the base (client, 15 Oct 2026).
  const actual = (a: ActualValue | null, short = false): string =>
    !a
      ? t('noValue')
      : a.kind === 'PCT'
        ? a.hasNo === false
          ? short
            ? t('actual.pctShortNoNo', { notMet: n(a.notMetPct), n: n(a.n) })
            : t('actual.pctNoNo', { notMet: n(a.notMetPct), n: n(a.n), unit: t(`actual.unit.${a.unit ?? 'HOUSEHOLDS'}`) })
          : short
            ? t('actual.pctShort', { notMet: n(a.notMetPct), no: n(a.noPct), n: n(a.n) })
            : t('actual.pct', { notMet: n(a.notMetPct), no: n(a.noPct), n: n(a.n), unit: t(`actual.unit.${a.unit ?? 'HOUSEHOLDS'}`) })
        : t('actual.median', { value: n(a.value), n: n(a.n) });
  const tone = (b: SeverityBand | null): Tone => (b ? TONE[b] : 'none');
  const tiers = c.tiers ?? { critical: 80, high: 70, medium: 40 };
  const severityBand = (score: number | null) => tierOf(score, tiers);
  // "Critical (provisional)" at Low confidence, at every level (client).
  const indexBand = (score: number): string =>
    severityBand(score) === 'CRITICAL' && c.confidence.overall === 'LOW'
      ? t('indexBandCriticalProvisional')
      : catalogueLabel(
          `presentation.indexBand.${severityBand(score) ?? 'LOW'}` as ReportLabelKey,
          locale,
        ).toLowerCase();

  const h = c.header;
  // "Riyadh Region", "Ad-Dawadmi Governorate" as the mockup titles it — unless
  // the name already says so ("Eastern Province", "المنطقة الشرقية").
  const areaName = (() => {
    if (h.scopeLevel === 'KINGDOM') return t('kingdom');
    const base = name(h.unitName);
    if (h.scopeLevel === 'VILLAGE') return base;
    const already = ar
      ? /^(ال)?(منطقة|المنطقة|محافظة|مركز)/.test(base)
      : /\b(Region|Province|Governorate|Centre|Center)$/i.test(base);
    return already ? base : t(`areaTitle.${h.scopeLevel}`, { name: base });
  })();
  // The v5.0 flag is LOW: confidence-adaptive wording (client, 4b).
  const below = c.confidence.overall === 'LOW';
  const tierLabel = (b: SeverityBand): string =>
    b === 'CRITICAL' && below ? t('tier.CRITICAL_PROVISIONAL') : t(`tier.${b}`);

  // ── Header ──
  const scopeValue =
    h.scopeLevel === 'KINGDOM'
      ? t('level.KINGDOM')
      : `${t(`level.${h.scopeLevel}`)}${sep}${areaName}`;
  const domainsValue = h.allDomains
    ? t('allDomains')
    : h.domains.map((d) => name(d.name)).join(t('listSep'));
  const sources = h.collectionSources.map((s) => t(`source.${s}`));
  // "Data source and collection method" (client, 15 Oct 2026).
  const dataSource =
    [sources.join(t('listSep')), h.selectionApproach ? name(h.selectionApproach) : null]
      .filter((x): x is string => !!x)
      .join(' · ') || t('noValue');
  const collected =
    // One day of collection reads as one date, not "18 Oct – 18 Oct".
    `${h.collectedFrom ? (date(h.collectedFrom) === date(h.collectedTo) ? date(h.collectedFrom) : `${date(h.collectedFrom)} – ${date(h.collectedTo)}`) : t('notRecorded')}` +
    (sources.length ? ` · ${sources.join(t('listSep'))}` : '');

  // ── Area profile ──
  const f = c.profile.figures;
  const pctOf = (x: number | null) => (x == null ? t('noValue') : `${n(x)}%`);
  const tiles = [
    { label: t('profile.population'), value: n(f?.population ?? null) },
    { label: t('profile.growth'), value: pctOf(f?.growthRatePct ?? null) },
    { label: t('profile.density'), value: n(f?.densityPerKm2 ?? null) },
    {
      label: t('profile.maleFemale'),
      value:
        f?.malePct != null || f?.femalePct != null
          ? `${n(f?.malePct ?? null)} / ${pctOf(f?.femalePct ?? null)}`
          : t('noValue'),
    },
    { label: t('profile.saudi'), value: pctOf(f?.saudiPct ?? null) },
    { label: t('profile.rural'), value: pctOf(f?.ruralPct ?? null) },
  ];
  const g = c.profile.governorates;
  // A study with no villages named says nothing about villages at all.
  const noVillages = c.profile.villages.named === 0;
  const inStudy = g && noVillages
    ? t('profile.inStudyGovs', { govs: n(g.inStudy), govTotal: n(g.total) })
    : g
    ? t('profile.inStudy', {
        govs: n(g.inStudy),
        govTotal: n(g.total),
        villages: n(c.profile.villages.withData),
        villagesNamed: n(c.profile.villages.named),
      })
    : noVillages && c.profile.centres
    ? t('profile.inStudyCentres', {
        centres: n(c.profile.centres.withData),
        centresTotal: n(c.profile.centres.total ?? c.profile.centres.withData),
      })
    : noVillages
    ? ''
    : t('profile.inStudyVillages', {
        villages: n(c.profile.villages.withData),
        villagesNamed: n(c.profile.villages.named),
      });

  // ── Decision summary ──
  const s = c.summary;
  const where =
    s.villagesWithData.length === 1
      ? name(s.villagesWithData[0])
      : s.villagesWithData.length > 1
        ? t('find.whereMany', { count: n(s.villagesWithData.length) })
        : areaName;
  let findText: string;
  if (!s.topDomain) findText = t('find.none');
  else {
    const parts = [
      t(below ? 'find.lead.preliminary' : 'find.lead.results', {
        where,
        domain: name(s.topDomain.name),
        score: n(s.topDomain.score),
      }),
      ...s.findings.map((x) =>
        x.actual
          ? t('find.finding', {
              kpi: kpiName(x.kpi),
              actual: actual(x.actual),
              severity: n(x.severity),
            })
          : t('find.findingNoActual', { kpi: kpiName(x.kpi), severity: n(x.severity) }),
      ),
      ...s.otherDomains.map((d) =>
        t('find.other', { domain: name(d.name), band: indexBand(d.score), score: n(d.score) }),
      ),
    ];
    findText = parts.join(' ');
  }

  const conf = c.confidence;
  const confParts = [
    conf.sample.required != null
      ? t(conf.sample.valid >= conf.sample.required ? 'confident.sampleMet' : 'confident.sample', {
          valid: n(conf.sample.valid),
          required: n(conf.sample.required),
        })
      : t('confident.sampleNoRequired', {
          valid: n(conf.sample.valid),
          minimum: n(conf.sample.minimum),
        }),
    conf.coverage.total > 1
      ? t('confident.coverage', {
          withData: n(conf.coverage.withData),
          total: n(conf.coverage.total),
          units: units(conf.coverage.unitKind),
        })
      : null,
    conf.coverage.largest && conf.coverage.total > 1
      ? t('confident.largest', {
          unit: name(conf.coverage.largest.unit),
          pct: n(conf.coverage.largest.sharePct),
        })
      : null,
    t('confident.completeness', {
      dk: n(conf.completeness.dontKnowPct),
      limit: n(conf.completeness.dontKnowLimitPct),
    }),
  ].filter((x): x is string => !!x);
  const lowBecause = [
    conf.sample.result === 'LOW' ? t('confident.lowSample') : null,
    conf.completeness.result === 'LOW' ? t('confident.lowCompleteness') : null,
    conf.coverage.result === 'LOW' ? t('confident.lowCoverage') : null,
  ].filter((x): x is string => !!x);
  const confidentText =
    `${t(below ? 'confident.leadLow' : 'confident.leadMeets', { because: list(lowBecause) })} ${confParts.join(t('actionSep'))}` +
    (below ? `${t('listSep')}${t('confident.notWhole', { area: areaName })}` : '.');

  const actions: string[] = [];
  for (const a of c.evidence.collectNext) {
    if (a.kind === 'MORE_HOUSEHOLDS')
      actions.push(t('action.moreHouseholds', { count: n(a.count), where: name(a.where) }));
    else if (a.kind === 'UNITS_WITHOUT_DATA')
      actions.push(t('action.unitsWithoutData', { units: list(a.units.map(name)) }));
    else if (a.kind === 'MORE_VILLAGES')
      actions.push(t('action.moreVillages', { where: name(a.where) }));
  }
  const topDomainName = s.topDomain ? name(s.topDomain.name) : '';
  const decideText =
    s.decision === 'collectMore'
      ? s.topDomain
        ? t('decide.collectMore', {
            actions: actions.length ? actions.join(t('actionSep')) : t('action.fallback'),
            domain: topDomainName,
          })
        : t('decide.collectMoreNoDomain', {
            actions: actions.length ? actions.join(t('actionSep')) : t('action.fallback'),
          })
      : t(`decide.${s.decision}`, { domain: topDomainName || areaName });

  // ── Confidence rows ──
  const sampleTarget = conf.sample.required ?? conf.sample.minimum;
  const confRows: CoreView['confidence']['rows'] = [
    {
      label: t('confidence.sample'),
      sub:
        conf.sample.required != null
          ? t('confidence.sampleSub')
          : t('confidence.sampleSubMinimum', { minimum: n(conf.sample.minimum) }),
      value: `${n(conf.sample.valid)} / ${n(sampleTarget)}`,
      band: conf.sample.result,
      ratio: sampleTarget ? Math.min(1, conf.sample.valid / sampleTarget) : 0,
    },
    {
      label: t('confidence.completeness'),
      sub: t('confidence.completenessSub', { limit: n(conf.completeness.dontKnowLimitPct) }),
      value: t('confidence.completenessValue', { dk: n(conf.completeness.dontKnowPct) }),
      band: conf.completeness.result,
      ratio: Math.max(0, 1 - conf.completeness.dontKnowPct / 100),
    },
    {
      label: t('confidence.coverage'),
      sub:
        conf.coverage.thresholdPct != null
          ? t('confidence.coverageSubThreshold', { pct: n(conf.coverage.thresholdPct) })
          : t('confidence.coverageSub'),
      value:
        t('confidence.coverageValue', {
          withData: n(conf.coverage.withData),
          total: n(conf.coverage.total),
          units: units(conf.coverage.unitKind),
        }) +
        (conf.coverage.largest
          ? ` · ${t('confidence.largestShare', { pct: n(conf.coverage.largest.sharePct) })}`
          : ''),
      band: conf.coverage.result,
      ratio: conf.coverage.total ? conf.coverage.withData / conf.coverage.total : 0,
    },
  ].map((r) => ({ ...r, bandLabel: bandLabel(r.band) }));

  // ── Approval line ──
  const a = input.audit;
  const org = h.isNcnp ? t('ncnpName') : name(h.organizationName);
  // Role names are fixed wording: the approved name in the reader's language.
  const role = (s: string | null): string | null => {
    const key = ROLE_MATRIX.find((r) => r.name === s)?.key;
    return key ? t(`role.${key}`) : s;
  };
  const approval = rl(a.reviewedBy
    ? t('approvedBy', {
        name: a.reviewedBy,
        title: role(a.reviewedRole) ?? t('noValue'),
        organization: org,
        date: date(a.reviewedAt),
      })
    : t('approvedByPending', { organization: org }));

  // ── Page 2: where and what to intervene ──
  const geo = c.geography;
  const kind = geo.unitKind;
  const unitColumn = t(`level.${kind === 'CENTRE' ? 'CENTRE' : kind}`);
  // Many units without data (the Kingdom's regions outside the study): one
  // grey line under the table instead of a row each — they are grey on the
  // map and never ranked (client, 15 Oct 2026), and the table stays on one page.
  const noDataUnits = geo.units.filter((u) => u.scoreStatus === 'NO_DATA');
  const hatched = geo.units.some((u) => u.scoreStatus === 'NOT_SHOWN');
  const collapseNoData = noDataUnits.length >= 4;
  const tableUnits = collapseNoData ? geo.units.filter((u) => u.scoreStatus !== 'NO_DATA') : geo.units;
  const villagesColumn = kind === 'GOVERNORATE' || !noVillages;
  const unitsTable = geo.show
    ? {
        title:
          h.scopeLevel === 'KINGDOM'
            ? t('units.titleKingdom')
            : t('units.title', { units: capital(units(kind)) }),
        // A study that names no villages has no villages column: it would
        // only ever read "—" (governorates still show their centres).
        columns: [
          unitColumn,
          ...(villagesColumn ? [kind === 'GOVERNORATE' ? t('units.colCentres') : t('units.colVillages')] : []),
          t('units.colHouseholds'),
          t('units.colScore'),
        ],
        rows: tableUnits.map((u): Cell[] => [
          { text: name(u.name), bold: true },
          ...(villagesColumn ? [{
            text:
              kind === 'VILLAGE'
                ? t('noValue')
                : u.centresTotal != null
                  ? u.scoreStatus === 'NO_DATA'
                    ? t('units.centresOf', { n: n(0), total: n(u.centresTotal) })
                    : t('units.basedOn', {
                        n: n(u.centresWithData ?? 0),
                        total: n(u.centresTotal),
                        unit: name(u.name),
                      })
                  : u.villagesNamed === 0
                    ? t('noValue')
                    : t('units.ofN', { n: n(u.villagesWithData), total: n(u.villagesNamed) }),
          }] : []),
          {
            text:
              u.required != null
                ? t('units.ofRequired', { n: n(u.households), total: n(u.required) })
                : n(u.households),
            // Collected against required, per area (client comment 43). The
            // area's required sample is from its own official population, so
            // it differs from the study's; "required" says what it is.
            progress: u.required ? Math.min(1, u.households / u.required) : undefined,
          },
          u.scoreStatus === 'SHOWN'
            ? { text: n(u.needsIndex), tone: tone(severityBand(u.needsIndex)), badge: true }
            : u.scoreStatus === 'NOT_SHOWN'
              ? { text: t('units.notShown'), tone: 'critical' }
              : { text: t('units.noData'), muted: true },
        ]),
        note:
          (collapseNoData
            ? `${t('units.noDataList', { units: noDataUnits.map((u) => name(u.name)).join(t('listSep')) })} `
            : '') +
          (geo.scoreThresholdPct != null
            ? t('units.thresholdNote', {
                unit: t(`level.${kind}`).toLowerCase(),
                pct: n(geo.scoreThresholdPct),
              })
            : t('units.coverageNote')),
        ranking: geo.ranking.ranked
          ? t('ranking.ranked', {
              order: geo.ranking.order
                .map((id) => name(geo.units.find((u) => u.id === id)?.name))
                .join(sep),
            }) +
            (geo.ranking.excludedLow?.length
              ? ` ${t('ranking.excludedLow', {
                  units: geo.ranking.excludedLow
                    .map((id) => name(geo.units.find((u) => u.id === id)?.name))
                    .join(t('listSep')),
                })}`
              : '')
          : t('ranking.notRanked'),
      }
    : null;

  const villagesTable =
    (c.villages.length || c.villagesBelowMinimum) && h.scopeLevel !== 'VILLAGE'
      ? {
          title: t('villages.title'),
          columns: [
            t('villages.colVillage'),
            t('villages.colGovernorate'),
            t('villages.colIndex'),
            t('villages.colPriority'),
            t('villages.colConfidence'),
          ],
          rows: c.villages.map((v): Cell[] => [
            {
              text: name(v.name),
              bold: true,
              sub:
                v.population != null ? t('villages.population', { n: n(v.population) }) : undefined,
            },
            { text: name(v.governorate) },
            {
              text:
                v.needsIndex != null
                  ? `${n(v.needsIndex)} · ${capital(indexBand(v.needsIndex))}`
                  : t('noValue'),
            },
            {
              text:
                v.priorityScore != null
                  ? `${n(v.priorityScore)} · ${t(`tier.${v.priorityStatus ?? 'LOW'}`)}`
                  : t('noValue'),
            },
            { text: bandLabel(v.confidence), tone: RESULT_TONE[v.confidence] },
          ]),
          // Every village below the minimum: no table, only the reason.
          note: c.villages.length
            ? t('villages.note') +
              (c.villagesBelowMinimum
                ? ` ${t('villages.belowMinimum', { count: n(c.villagesBelowMinimum), minimum: n(conf.sample.minimum) })}`
                : '')
            : t('villages.noneYet', {
                count: n(c.villagesBelowMinimum),
                minimum: n(conf.sample.minimum),
              }),
        }
      : null;

  const showWhere = h.scopeLevel !== 'VILLAGE';
  const needsRows = c.rankedNeeds.map((r): Cell[] => [
    { text: n(r.rank), muted: true },
    { text: kpiName(r.kpi), bold: true, sub: `${name(r.domain)}${sep}${name(r.subDomain)}` },
    ...(showWhere
      ? [
          {
            text: r.where.length
              ? r.where.slice(0, 2).map(name).join(t('listSep')) +
                (r.where.length > 2 ? ` +${r.where.length - 2}` : '')
              : t('noValue'),
          },
        ]
      : []),
    { text: actual(r.actual) },
    {
      text: r.gapType
        ? catalogueLabel(`presentation.gapType.${r.gapType}` as ReportLabelKey, locale)
        : t('noValue'),
    },
    {
      text: n(r.severity),
      tone: tone(r.band),
      badge: true,
      sub: r.band ? tierLabel(r.band) : undefined,
    },
  ]);

  // ── Page 3 ──
  // Fit to publish per domain and per KPI, so a reader can use the domains
  // that meet the standard even when others are Low (Jagan, 19 Oct 2026).
  const fitOf = (key: string) => c.evidence.fitToPublish.find((f) => f.key === key)?.status ?? 'NOT_MEASURED';
  const fitShort = (s: 'FIT' | 'PRELIMINARY' | 'NOT_MEASURED' | null) =>
    s === 'FIT' ? t('fitShort.FIT') : s === 'PRELIMINARY' ? t('fitShort.PRELIMINARY') : t('noValue');
  const measured = c.domains.filter((d) => d.severity !== null);
  const unmeasured = c.domains.filter((d) => d.severity === null);
  const hierarchyGroups = c.hierarchy.flatMap((d) =>
    d.subDomains.map((sd) => ({
      title: `${name(d.name)}${sep}${name(sd.name)}`,
      severity: n(sd.severity),
      tone: tone(severityBand(sd.severity)),
      rows: sd.indicators.flatMap((ind) =>
        ind.kpis.map((k): Cell[] => [
          { text: kpiName(k.name), bold: true, sub: name(ind.name) },
          { text: actual(k.actual, true) },
          { text: n(k.severity), tone: tone(k.band), badge: true },
          { text: k.band ? tierLabel(k.band) : t('noValue'), tone: tone(k.band) },
          { text: fitShort(k.fit), tone: k.fit === 'FIT' ? 'low' : k.fit ? 'critical' : undefined },
          {
            text: k.gapType
              ? catalogueLabel(`presentation.gapType.${k.gapType}` as ReportLabelKey, locale)
              : t('noValue'),
          },
          {
            text:
              (k.targetGroup ?? c.targetGroup)
                ? name(k.targetGroup ?? c.targetGroup)
                : t('noValue'),
          },
          { text: t('hierarchy.baselineNotYet'), muted: true },
        ]),
      ),
    })),
  );

  const r = c.reading;
  // The priority score appears only in the villages table, so it is
  // explained only when that table shows one.
  const showsPriority = !!villagesTable && c.villages.some((v) => v.priorityScore != null);
  const readingLines = [
    { lead: '', text: t('reading.severity') },
    ...(showsPriority ? [{ lead: '', text: t('reading.priority') }] : []),
    {
      lead: '',
      text:
        r.requiredSample != null && r.population != null
          ? t('reading.required', {
              required: n(r.requiredSample),
              population: n(r.population),
              margin: n(r.marginOfErrorPct ?? 10),
            })
          : t('reading.requiredUnknown'),
    },
    ...(r.minimumDetectableEffect != null
      ? [{ lead: '', text: t('reading.mde', { mde: n(r.minimumDetectableEffect) }) }]
      : []),
    ...(showsPriority ? [{ lead: '', text: t('reading.formula') }] : []),
  ];

  // Only the pairs held in the methodology configuration (client, 15 Oct).
  const L = c.links;
  const linkLines = L.items.length
    ? [
        ...L.items.map((it) =>
          it.sufficient
            ? t('links.item', {
                pctA: n(it.pctWithA),
                a: kpiName(it.kpiA),
                b: kpiName(it.kpiB),
                pctNot: n(it.pctWithoutA),
                // The percentage-point gap between the two groups, signed
                // (client, 23 Oct 2026: show group sizes and the gap).
                gap: `${it.pctWithA - it.pctWithoutA >= 0 ? '+' : '−'}${n(Math.abs(Math.round((it.pctWithA - it.pctWithoutA) * 10) / 10))}`,
                n: n(it.nA),
                nNot: n(it.nWithoutA),
              })
            : t('links.insufficient', {
                a: kpiName(it.kpiA),
                b: kpiName(it.kpiB),
                min: n(L.minPerGroup),
              }),
        ),
        t('links.caveat'),
      ]
    : [];

  // ── Page 4 ──
  const e = c.evidence;
  const distRows = e.distribution.map((d): Cell[] => [
    { text: d.parent ? `${name(d.parent)}${sep}${name(d.unit)}` : name(d.unit), bold: d.n > 0 },
    { text: n(d.n) },
    { text: `${n(d.sharePct)}%`, bold: d.n > 0 },
  ]);
  const resp = e.responses;
  const answersPct = resp.totalAnswers
    ? Math.round((resp.answersExcluded / resp.totalAnswers) * 1000) / 10
    : 0;
  const ageMap = new Map(e.age.map((x) => [x.band, x.count]));
  const ageText = e.age.length
    ? `${t('age.label')}: ${e.age.map((x) => `${catalogueLabel(`presentation.age.${x.band}` as ReportLabelKey, locale)} ${n(x.count)}`).join(' · ')}`
    : t('age.pending');

  const fitRows = e.fitToPublish.map((fr): Cell[] => [
    { text: name(fr.name), bold: true },
    {
      text: t(`fit.${fr.status}`),
      tone: fr.status === 'FIT' ? 'low' : fr.status === 'PRELIMINARY' ? 'medium' : 'none',
      muted: fr.status === 'NOT_MEASURED',
    },
    {
      text:
        fr.status === 'NOT_MEASURED'
          ? t('fit.reasonNotMeasured')
          : fr.required != null
            ? t(fr.valid >= fr.required ? 'fit.reasonMet' : 'fit.reason', {
                valid: n(fr.valid),
                required: n(fr.required),
                withData: n(fr.unitsWithData),
                total: n(fr.unitsTotal),
                units: units(conf.coverage.unitKind),
              })
            : t('fit.reasonNoRequired', {
                valid: n(fr.valid),
                withData: n(fr.unitsWithData),
                total: n(fr.unitsTotal),
                units: units(conf.coverage.unitKind),
              }),
      muted: true,
    },
  ]);

  const nextItems = e.collectNext.map((x) => {
    switch (x.kind) {
      case 'MORE_HOUSEHOLDS':
        return t('next.moreHouseholds', { count: n(x.count), where: name(x.where) });
      case 'UNITS_WITHOUT_DATA':
        return t('next.unitsWithoutDataLead', { units: list(x.units.map(name)) });
      case 'MORE_VILLAGES':
        return t('next.moreVillages', { where: name(x.where) });
      case 'UNMEASURED_DOMAINS':
        return t('next.unmeasuredDomains', { count: n(x.count) });
      case 'AGE_BANDS':
        return t('next.ageBands');
    }
  });

  const cards = c.needCards.map((card) => ({
    title: t('card.title'),
    forWhom: t('card.for'),
    status: card.eligible ? t('card.eligible') : t('card.notEligible'),
    eligible: card.eligible,
    fields: [
      { label: t('card.need'), value: kpiName(card.kpi) },
      {
        label: t('card.location'),
        value: card.location.map(name).join(t('listSep')) || t('noValue'),
      },
      {
        label: t('card.beneficiaries'),
        value: card.beneficiaries
          ? t('card.beneficiariesValue', {
              pct: n(card.beneficiaries.pct),
              population: n(card.beneficiaries.population),
              people: n(card.beneficiaries.people),
            })
          : t('noValue'),
      },
      {
        label: t('card.evidence'),
        value:
          // No villages in the study: leave the count out rather than say "villages: 0".
          card.evidence.villages === 0
            ? card.evidence.required != null
              ? t('card.evidenceValueNoVillages', {
                  valid: n(card.evidence.valid),
                  required: n(card.evidence.required),
                  band: bandLabel(card.evidence.result),
                })
              : t('card.evidenceValueNoRequiredNoVillages', {
                  valid: n(card.evidence.valid),
                  band: bandLabel(card.evidence.result),
                })
            : card.evidence.required != null
            ? t('card.evidenceValue', {
                valid: n(card.evidence.valid),
                required: n(card.evidence.required),
                villages: n(card.evidence.villages),
                band: bandLabel(card.evidence.result),
              })
            : t('card.evidenceValueNoRequired', {
                valid: n(card.evidence.valid),
                villages: n(card.evidence.villages),
                band: bandLabel(card.evidence.result),
              }),
      },
      { label: t('card.baseline'), value: t('card.baselineValue') },
      { label: t('card.sdg'), value: t('noValue') },
      {
        label: t('card.others'),
        value: card.otherOrganisations.length
          ? card.otherOrganisations.join(t('listSep'))
          : t('card.othersNone'),
      },
      {
        label: t('card.approvedBy'),
        value: a.reviewedBy
          ? rl(`${a.reviewedBy}${comma}${role(a.reviewedRole) ?? ''} · ${date(a.reviewedAt)}`)
          : t('audit.pending'),
      },
    ],
    // The mockup's "One card per need…" line describes the card format rather
    // than the need; the eligibility badge says what the reader needs.
    footer: '',
  }));

  const audit = (
    [
    {
      label: t('audit.generated'),
      value: [a.generatedBy, `${date(a.generatedAt)} ${time(a.generatedAt)}`]
        .filter(Boolean)
        .join(' · '),
    },
    {
      label: t('audit.confirmed'),
      value: a.confirmedBy
        ? `${a.confirmedBy} · ${date(a.confirmedAt)} ${time(a.confirmedAt)}`
        : t('audit.pending'),
    },
    {
      label: t('audit.reviewed'),
      value: a.reviewedBy
        ? `${a.reviewedBy}${a.reviewedRole ? `${comma}${role(a.reviewedRole)}` : ''} · ${date(a.reviewedAt)} ${time(a.reviewedAt)}`
        : t('audit.pending'),
    },
    {
      label: t('audit.comments'),
      value: `${a.reviewerNotes ? name(a.reviewerNotes) : t('noValue')} · ${t('version', { version: n(a.version) })}`,
    },
    ] as Array<{ label: string; value: string }>
  ).map((row) => ({ ...row, value: rl(row.value) }));

  const usageText = t(`usage.text.${conf.overall}`, { area: areaName });
  // A combined (NCNP) report names its studies one by one, each in the
  // reader's language — the joined title is not itself a translatable text.
  const studyName = c.studies && c.studies.length > 1 ? c.studies.map((st) => name(st.title)).join(' · ') : name(h.studyName);
  const running = `${areaName} · ${t('reportTitle')} · ${studyName}`;

  const view: CoreView = {
    locale,
    dir: ar ? 'rtl' : 'ltr',
    output: c.output,
    overall: conf.overall,
    watermark: conf.overall === 'LOW' ? t('watermark.LOW') : null,
    // The running header names the usage status only when it is a warning.
    running: { left: running, usage: conf.overall === 'LOW' ? t(`usage.${conf.overall}`).toUpperCase() : '' },
    footer: {
      left: `${org} · ${t('platformShort')}`,
      pageOf: t('pageOf', { page: '{page}', count: '{count}' }),
      methodology: t('methodology', { version: name(h.methodologyVersion) }),
    },
    header: {
      kicker: (c.output === 'SUMMARY' ? t('executiveTitle') : t('reportTitle')).toUpperCase(),
      title: areaName,
      study: studyName,
      organization: org,
      platformOwner: t('platformOwner'),
      chips: [
        `${t('chip.scope')} ${scopeValue}`,
        `${t('chip.domains')} ${domainsValue}`,
        `${t('chip.collected')} ${collected}`,
        `${t('chip.issued')} ${date(h.generatedAt)} · ${t('version', { version: n(a.version) })}`,
      ],
    },
    profile: {
      title: t('profile.title', { area: areaName }),
      source: f
        ? t('profile.source', { source: name(f.source), year: n(f.year).replace(/,/g, '') })
        : t('profile.notEntered'),
      tiles,
      inStudy,
    },
    usage: { show: conf.overall === 'LOW', label: t('usage.label'), band: conf.overall, text: usageText },
    decision: {
      title: t('decision.title'),
      // Said on the full report only; on the Executive Summary it is the summary.
      issuedAlone: c.output === 'SUMMARY' ? '' : t('decision.issuedAlone'),
      find: { q: t('decision.find'), text: findText },
      confident: { q: t('decision.confident'), text: confidentText },
      decide: { q: t('decision.needed'), text: decideText },
    },
    confidence: {
      title: t('confidence.title', { band: bandLabel(conf.overall) }),
      rule: t('confidence.overallRule'),
      rows: confRows,
    },
    guide: [
      { title: t('guide.management'), q: t('guide.managementQ'), part: 'summary', pageLabel: t('guide.page', { name: t('guide.management'), pages: '{pages}' }) },
      { title: t('guide.programmes'), q: t('guide.programmesQ'), part: 'programmes', pageLabel: t('guide.page', { name: t('guide.programmes'), pages: '{pages}' }) },
      { title: t('guide.research'), q: t('guide.researchQ'), part: 'research', pageLabel: t('guide.page', { name: t('guide.research'), pages: '{pages}' }) },
      { title: t('guide.donors'), q: t('guide.donorsQ'), part: 'donors', pageLabel: t('guide.page', { name: t('guide.donors'), pages: '{pages}' }) },
    ],
    approval,
    where: {
      show: geo.show,
      title: t('where.title'),
      lead: geo.show ? t('where.lead') : t('where.leadSingle'),
      map:
        geo.show && geo.mapLevel
          ? {
              title: t('map.title', { area: areaName }),
              // "Hatched" marks a score held back for too little coverage;
              // it is explained only when a unit is drawn that way, and in
              // the study's own terms (villages, or centres when it names none).
              legend: !hatched
                ? t('map.legendNoHatched')
                : noVillages
                  ? t('map.legendCentres')
                  : t('map.legend'),
              level: geo.mapLevel,
              legendItems: [
                { kind: 'critical', label: t('tier.CRITICAL') },
                { kind: 'high', label: t('tier.HIGH') },
                { kind: 'medium', label: t('tier.MEDIUM') },
                { kind: 'low', label: t('tier.LOW') },
                ...(hatched
                  ? [{ kind: 'hatched' as const, label: noVillages ? t('map.legendHatchedCentres') : t('map.legendHatched') }]
                  : []),
                { kind: 'nodata', label: t('map.legendNoData') },
                { kind: 'outside', label: t('map.legendOutside') },
              ],
              context: geo.mapContext
                .filter((m) => !geo.units.some((u) => u.code === m.code))
                .map((m) => ({ code: m.code, name: name(m.name) })),
              units: geo.units.map((u) => ({
                id: u.id,
                code: u.code,
                name: name(u.name),
                caption:
                  u.scoreStatus === 'NO_DATA'
                    ? t('map.noData')
                    : !noVillages
                      ? u.villagesWithData === 1
                        ? t('map.oneVillage')
                        : t('map.villages', { count: n(u.villagesWithData) })
                      : u.centresWithData != null
                        ? u.centresWithData === 1
                          ? t('map.oneCentre')
                          : t('map.centres', { count: n(u.centresWithData) })
                        : t('map.households', { count: n(u.households) }),
                households: u.households,
                severity: u.scoreStatus === 'SHOWN' ? u.needsIndex : null,
                status: u.scoreStatus,
              })),
            }
          : null,
      units: unitsTable,
      villages: villagesTable,
      needs: {
        title: t('needs.title'),
        provisional: below ? t('needs.provisional') : null,
        rankedBy: t('needs.rankedBy'),
        columns: [
          t('needs.colRank'),
          t('needs.colNeed'),
          ...(showWhere ? [t('needs.colWhere')] : []),
          t('needs.colActual'),
          t('needs.colGapType'),
          t('needs.colSeverity'),
        ],
        rows: needsRows,
        empty: t('needs.none'),
      },
    },
    design: {
      title: t('design.title'),
      lead: t('design.lead'),
      domains: {
        title: t('domains.title'),
        legend: [
          { label: t('tier.CRITICAL'), tone: 'critical' },
          { label: t('tier.HIGH'), tone: 'high' },
          { label: t('tier.MEDIUM'), tone: 'medium' },
          { label: t('tier.LOW'), tone: 'low' },
          { label: t('domains.notMeasured'), tone: 'none' },
        ],
        rows: [
          ...measured.map((d) => ({
            name: name(d.name),
            severity: d.severity,
            value: n(d.severity),
            weight:
              d.weight != null
                ? t('domains.weight', { weight: n(d.weight) })
                : t('domains.weight', { weight: t('noValue') }),
            tone: tone(d.band),
            fit: fitShort(fitOf(d.key)),
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- the type check needs it: without it the literal widens to string
            fitTone: (fitOf(d.key) === 'FIT' ? 'low' : 'critical') as Tone,
            flag: d.criticalNeedPresent
              ? below
                ? t('domains.criticalNeedPresentProvisional')
                : t('domains.criticalNeedPresent')
              : null,
          })),
          // Unmeasured domains stay in the chart, in grey, so a reader sees
          // they were not assessed rather than assuming no need (client
          // comments 24 and 52).
          ...unmeasured.map((d) => ({
            name: name(d.name),
            severity: null,
            value: t('domains.notMeasured'),
            weight:
              d.weight != null
                ? t('domains.weight', { weight: n(d.weight) })
                : t('domains.weight', { weight: t('noValue') }),
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- the type check needs it: without it the literal widens to string
            tone: 'none' as Tone,
            fit: t('noValue'),
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- the type check needs it: without it the literal widens to string
            fitTone: 'none' as Tone,
          })),
        ],
        others: unmeasured.length ? `${t('domains.notMeasured')} — ${t('domains.notInSurvey')}` : null,
      },
      hierarchy: {
        title: t('hierarchy.title'),
        columns: [
          t('hierarchy.colKpi'),
          t('hierarchy.colActual'),
          t('hierarchy.colSeverity'),
          t('hierarchy.colPriority'),
          t('hierarchy.colFit'),
          t('hierarchy.colGapType'),
          t('hierarchy.colTarget'),
          t('hierarchy.colBaseline'),
        ],
        groups: hierarchyGroups,
        note:
          t('hierarchy.note') +
          (c.methodologySplit?.length
            ? ` ${t('hierarchy.versionNote', { kpis: c.methodologySplit.map((x) => `${kpiName(x.kpi)} (${x.versions.join(t('listSep'))})`).join(t('listSep')) })}`
            : ''),
      },
      reading: { title: t('reading.title'), lines: readingLines },
      links: {
        // Only when pairs are configured and the overall result meets the
        // standard (Jagan, 19 Oct 2026); hidden when it is Low.
        show: L.pairsConfigured > 0 && conf.overall === 'MEETS',
        title: t('links.title'),
        tag: t('links.hypotheses'),
        lines: linkLines,
      },
    },
    evidence: {
      title: t('evidence.title'),
      lead: t('evidence.lead'),
      distribution: {
        title: t('distribution.title'),
        columns: [t('distribution.colUnit'), t('distribution.colN'), t('distribution.colShare')],
        rows: distRows,
        flag: e.concentration ? t(`concentration.${e.concentration}`) : null,
        note:
          e.concentratedFromPct != null
            ? t('distribution.note', { pct: n(e.concentratedFromPct) })
            : t('distribution.noteNoThreshold'),
      },
      responses: {
        title: t('responses.title'),
        note: t('responses.reasonsNote'),
        rows: [
          {
            label: t('responses.submittedValid'),
            value: `${n(resp.submitted)} / ${n(resp.valid)}`,
          },
          {
            label: t('responses.excludedReasons'),
            value: `${n(resp.duplicate)} · ${n(resp.lowConfidence)} · ${n(resp.incomplete)}`,
          },
          // "Outside these areas" at registration: kept, excluded, with its
          // reason (client, 19 Oct 2026).
          ...(resp.outsideGeography
            ? [{ label: t('responses.outsideGeography'), value: t('responses.outsideGeographyValue', { n: n(resp.outsideGeography) }) }]
            : []),
          {
            label: t('responses.answersExcluded'),
            value: t('responses.answersExcludedValue', {
              n: n(resp.answersExcluded),
              total: n(resp.totalAnswers),
              pct: n(answersPct),
            }),
          },
          {
            label: t('responses.dontKnow'),
            value: t('responses.dontKnowValue', {
              pct: n(resp.dontKnowPct),
              limit: n(resp.dontKnowLimitPct),
            }),
          },
          { label: t('responses.dataSource'), value: dataSource },
        ],
        gender: [
          { label: t('gender.male'), count: e.gender.male },
          { label: t('gender.female'), count: e.gender.female },
          { label: t('gender.unspecified'), count: e.gender.unspecified },
        ],
        age: ageText,
        ageBars: [...ageMap].map(([b, count]) => ({
          label: catalogueLabel(`presentation.age.${b}` as ReportLabelKey, locale),
          count,
        })),
      },
      fit: {
        title: t('fit.title'),
        columns: [t('fit.colDomain'), t('fit.colStatus'), t('fit.colReason')],
        rows: fitRows,
      },
      studies: c.studies?.length
        ? {
            title: t('studies.title'),
            columns: [
              t('studies.colStudy'),
              t('studies.colOrg'),
              t('studies.colResponses'),
              t('studies.colShare'),
              t('studies.colConfidence'),
            ],
            rows: c.studies.map((st): Cell[] => [
              { text: name(st.title), bold: true },
              { text: st.organization ? name(st.organization) : t('noValue') },
              {
                text:
                  st.required != null
                    ? t('units.ofN', { n: n(st.valid), total: n(st.required) })
                    : n(st.valid),
              },
              { text: st.sharePct != null ? `${n(st.sharePct)}%` : t('noValue') },
              { text: bandLabel(st.overall), tone: RESULT_TONE[st.overall] },
            ]),
            rule: t('studies.rule'),
          }
        : null,
      next: { title: t('next.title'), items: nextItems.length ? nextItems : [t('next.none')] },
      cards,
      audit,
    },
  };
  // Arabic: keep figures in their order inside right-to-left text — "62%" and
  // "12 / 81" isolated left to right, as the in-app reports do (lib/bidi).
  return ar ? isolateFigures(view) : view;
}

const LRI = '\u2066';
const PDI = '\u2069';
const FIGURE =
  /(?<![\p{L}\d\u2066])(\d[\d,.]*\s?%|\d[\d,.]*\s?\/\s?\d[\d,.]*|\d[\d,.]*[–-]\d[\d,.]*%?|\d[\d,.]*\s[–-]\s\d[\d,.]*(?![\d,.])(?!\s\p{L})|[+−±-]\d[\d,.]*%?)(?![\d\u2069])/gu;
function isolateFigures<T>(value: T): T {
  if (typeof value === 'string') return value.replace(FIGURE, `${LRI}$1${PDI}`) as T;
  if (Array.isArray(value)) return value.map(isolateFigures) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = k === 'pageOf' ? v : isolateFigures(v);
    return out as T;
  }
  return value;
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
