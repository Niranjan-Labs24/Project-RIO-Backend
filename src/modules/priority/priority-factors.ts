import type {
  PriorityFactorScales,
  PriorityFactorWeight,
  StrategicAxis,
} from '../methodology-config/methodology-config.types';

/**
 * RIO-FR-003 — turning raw evidence into the explainable score breakdown the
 * ticket's AC 2 requires ("all score components are individually visible to
 * the reviewer, not just the final number").
 *
 * The split this file exists to keep straight:
 *
 *   WEIGHT — how much a factor is worth. Comes from methodology config
 *            (`priorityFactorWeights`), set once by the methodology owner.
 *   VALUE  — how much of that factor THIS need has, on 0-100. Derived here
 *            from the need's own evidence, using conversion rules that also
 *            come from config (`priorityFactorScales`).
 *
 * Nothing in this file hardcodes either half. That is the point: a threshold
 * baked into scoring code silently drifts from what the Config screen shows,
 * which is exactly the bug that had to be fixed on the confidence-flag side.
 *
 * A factor with no evidence is reported as `value: null` — NOT as zero. Zero
 * means "we measured it and it is nothing", which for an unset urgency would
 * be a false statement that also drags the whole score down. Null means "not
 * measured", is shown as such to the reviewer, and is excluded from the
 * weighted average so the remaining factors still rank needs consistently.
 */

export type FactorKey =
  | 'severity'
  | 'affected_population'
  | 'service_availability_gap'
  | 'urgency'
  | 'data_confidence'
  | 'frequency'
  | 'geographic_coverage'
  | 'vulnerable_groups'
  | 'strategic_alignment';

export interface FactorComponent {
  key: FactorKey;
  label: string;
  weight: number;
  /** 0-100, or null when the evidence for this factor does not exist yet. */
  value: number | null;
  /** value × weight, or null alongside a null value. */
  contribution: number | null;
  /** What the value was derived from, in the reviewer's terms — "450 people",
   *  "3 villages", "shares 8 themes". Rendered under the number so the
   *  breakdown explains itself without the reviewer opening the need. */
  basis: string | null;
}

export interface PriorityComputation {
  /** 0-100, higher = more urgent. Same polarity as the methodology's severity
   *  convention (AC 7), deliberately NOT PriorityV2's inverted performance
   *  scale. */
  score: number;
  components: FactorComponent[];
  /** Share of the total configured weight that had evidence behind it.
   *  Surfaced so a score built on half the factors is never mistaken for a
   *  complete one. */
  coverage: number;
}

/** Raw evidence for one need, gathered by the caller. Every field is nullable
 *  because every one of them can genuinely be absent. */
export interface FactorInputs {
  /** OVERALL ScoreRollup severity, 0-100. */
  severity: number | null;
  /** Average severity of access/availability-category questions, 0-100. */
  serviceGapSeverity: number | null;
  affectedPeople: number | null;
  /** The level key the reviewer chose, e.g. "immediate". */
  urgency: string | null;
  /** 0..1 — the share of answers that were "don't know". */
  dontKnowRate: number | null;
  /** How many OTHER needs in the org share at least one theme with this one. */
  themeMatchCount: number | null;
  /** Distinct villages this need covers. */
  villageCount: number | null;
  /** 0-100 spread between the best- and worst-served respondent segments. */
  equitySpread: number | null;
  domain: string | null;
  /** Question ids behind this need, for the workbook's individually-tagged
   *  strategic exceptions. */
  questionIds: string[];
}

/** Linear map onto 0-100, clamped at both ends — the same shape
 *  ScoringLookup's numericFloor/numericCeiling already uses for numeric
 *  survey answers, so a reviewer reads one rule, not two. */
export function scaleToPercent(
  raw: number,
  range: { floor: number; ceiling: number },
): number {
  if (!(range.ceiling > range.floor)) return 0;
  const clamped = Math.min(Math.max(raw, range.floor), range.ceiling);
  return ((clamped - range.floor) / (range.ceiling - range.floor)) * 100;
}

/**
 * Which strategic axis a need belongs to.
 *
 * An individually-tagged question wins over the domain match. The workbook's
 * safeguard 4 is explicit about why: sector-empowerment and economy KPIs sit
 * inside other domains, so linking whole domains alone would file them under
 * the wrong axis.
 */
export function resolveStrategicAxis(
  axes: StrategicAxis[],
  domain: string | null,
  questionIds: string[],
): StrategicAxis | null {
  const ids = new Set(questionIds);
  const tagged = axes.find((axis) => axis.questionIds.some((id) => ids.has(id)));
  if (tagged) return tagged;
  if (!domain) return null;
  return axes.find((axis) => axis.domains.includes(domain)) ?? null;
}

const LABEL_FALLBACK: Record<FactorKey, string> = {
  severity: 'Need severity',
  affected_population: 'Affected population',
  service_availability_gap: 'Service availability gap',
  urgency: 'Urgency',
  data_confidence: 'Data confidence',
  frequency: 'Frequency of similar needs',
  geographic_coverage: 'Geographic coverage',
  vulnerable_groups: 'Vulnerable groups (equity)',
  strategic_alignment: 'Strategic alignment',
};

/** Derives one factor's value and the plain-language basis shown beneath it. */
function valueFor(
  key: FactorKey,
  inputs: FactorInputs,
  scales: PriorityFactorScales,
): { value: number | null; basis: string | null } {
  switch (key) {
    case 'severity':
      return inputs.severity === null
        ? { value: null, basis: null }
        : { value: inputs.severity, basis: `Severity ${inputs.severity.toFixed(1)}` };

    case 'service_availability_gap':
      return inputs.serviceGapSeverity === null
        ? { value: null, basis: null }
        : {
            value: inputs.serviceGapSeverity,
            basis: `Access/availability severity ${inputs.serviceGapSeverity.toFixed(1)}`,
          };

    case 'affected_population':
      return inputs.affectedPeople === null
        ? { value: null, basis: null }
        : {
            value: scaleToPercent(inputs.affectedPeople, scales.affectedPopulation),
            basis: `${inputs.affectedPeople} people affected`,
          };

    case 'urgency': {
      if (!inputs.urgency) return { value: null, basis: null };
      const mapped = scales.urgency[inputs.urgency];
      // An urgency level with no entry in the config map is a configuration
      // gap, not a zero — treat it as unmeasured rather than "not urgent".
      if (typeof mapped !== 'number') return { value: null, basis: null };
      return { value: mapped, basis: inputs.urgency.replace(/_/g, ' ') };
    }

    case 'data_confidence': {
      if (inputs.dontKnowRate === null) return { value: null, basis: null };
      // Inverted on purpose. Every other factor scores "more is more urgent";
      // confident data is not itself a reason to prioritise, so what counts
      // here is how much the evidence is NOT to be trusted.
      const pct = Math.min(Math.max(inputs.dontKnowRate, 0), 1) * 100;
      return {
        value: pct,
        basis: `${pct.toFixed(1)}% answered "don't know"`,
      };
    }

    case 'frequency':
      return inputs.themeMatchCount === null
        ? { value: null, basis: null }
        : {
            value: scaleToPercent(inputs.themeMatchCount, scales.frequency),
            basis:
              inputs.themeMatchCount === 0
                ? 'No other need shares its themes'
                : `${inputs.themeMatchCount} other need(s) share its themes`,
          };

    case 'geographic_coverage':
      return inputs.villageCount === null
        ? { value: null, basis: null }
        : {
            value: scaleToPercent(inputs.villageCount, scales.geographicCoverage),
            basis: `${inputs.villageCount} village(s)`,
          };

    case 'vulnerable_groups':
      return inputs.equitySpread === null
        ? { value: null, basis: null }
        : {
            value: inputs.equitySpread,
            basis: `${inputs.equitySpread.toFixed(1)} point spread between respondent groups`,
          };

    case 'strategic_alignment': {
      const axis = resolveStrategicAxis(scales.strategicAxes, inputs.domain, inputs.questionIds);
      return axis ? { value: axis.value, basis: axis.label } : { value: null, basis: null };
    }
  }
}

/**
 * The model, in one line: **weighted mean of the factors that have evidence.**
 *
 * Normalising over the weight that actually had evidence — rather than over
 * the full 1.00 — is what keeps needs comparable while factors are still being
 * filled in. Dividing by the full weight instead would make every need with an
 * unset urgency score 12% lower than a need with one, which reads as "less
 * urgent" when it only means "less recorded".
 */
export function computePriority(
  weights: PriorityFactorWeight[],
  scales: PriorityFactorScales,
  inputs: FactorInputs,
): PriorityComputation {
  const components: FactorComponent[] = weights.map((w) => {
    const key = w.key as FactorKey;
    const { value, basis } = valueFor(key, inputs, scales);
    return {
      key,
      label: w.label || LABEL_FALLBACK[key] || w.key,
      weight: w.weight,
      value,
      contribution: value === null ? null : value * w.weight,
      basis,
    };
  });

  const measured = components.filter((c) => c.value !== null);
  const weightWithEvidence = measured.reduce((sum, c) => sum + c.weight, 0);
  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);

  const score =
    weightWithEvidence > 0
      ? measured.reduce((sum, c) => sum + (c.contribution ?? 0), 0) / weightWithEvidence
      : 0;

  return {
    score: Math.round(score * 10) / 10,
    components,
    coverage: totalWeight > 0 ? weightWithEvidence / totalWeight : 0,
  };
}
