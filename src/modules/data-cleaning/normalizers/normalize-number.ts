// RIO-FR-002 / Q12 — "numeric units as defined in the question bank".
//
// A numeric answer arrives as free text and carries everything a person types
// around a number: the unit ("5 km", "٥ كم", "5km"), thousands separators
// ("1,200"), a European decimal comma ("12,5"), Arabic separators ("1٬200",
// "12٫5"), a currency word, an approximation marker ("~5", "about 5"), or a
// range ("5-7"). The stored value has to be a bare number, and the unit has to
// be the one the question bank declares for that question.
//
// The question-bank context is PASSED IN rather than looked up here: the
// expected unit and the numeric floor/ceiling live on Question and
// ScoringLookup, which are the adapter's business. Keeping this function pure
// is what makes the whole unit table testable without a database.
//
// The one thing this must never do is guess. A value outside the question's
// declared range is flagged, never clamped; a range ("5-7") is flagged, never
// averaged. Both would write a number nobody measured.

import { classifyPresence, type DontKnowTreatment } from "./dont-know";
import { foldText } from "./fold-text";
import {
  clean,
  missing,
  proposed,
  unresolved,
  type NormalizationResult,
} from "./types";

/** The unit vocabulary the question bank actually uses, in both languages. */
export type UnitKey =
  | "km"
  | "m"
  | "minutes"
  | "hours"
  | "days"
  | "months"
  | "percent"
  | "sar"
  | "count";

interface UnitDefinition {
  /** Spellings a person might write, matched folded. */
  aliases: string[];
  /** Units this one can be converted to, with the multiplier to apply. */
  convertsTo?: Partial<Record<UnitKey, number>>;
}

const UNITS: Record<UnitKey, UnitDefinition> = {
  km: {
    aliases: ["km", "kms", "kilometre", "kilometres", "kilometer", "kilometers", "كم", "كيلو", "كيلومتر", "كيلومترات"],
    convertsTo: { m: 1000 },
  },
  m: {
    aliases: ["m", "metre", "metres", "meter", "meters", "متر", "امتار", "مترا"],
    convertsTo: { km: 0.001 },
  },
  minutes: {
    aliases: ["min", "mins", "minute", "minutes", "دقيقه", "دقائق", "دقيقة"],
    convertsTo: { hours: 1 / 60 },
  },
  hours: {
    aliases: ["h", "hr", "hrs", "hour", "hours", "ساعه", "ساعات", "ساعة"],
    convertsTo: { minutes: 60 },
  },
  days: { aliases: ["d", "day", "days", "يوم", "ايام", "أيام"] },
  // No convertsTo: a month is not a fixed number of days, and converting one
  // to the other would fabricate precision the respondent never gave.
  months: { aliases: ["month", "months", "شهر", "شهور", "اشهر", "أشهر"] },
  percent: { aliases: ["%", "percent", "pct", "بالمئه", "بالمائه", "نسبه"] },
  sar: { aliases: ["sar", "sr", "riyal", "riyals", "ريال", "ريالات"] },
  count: { aliases: ["persons", "person", "people", "شخص", "اشخاص", "فرد", "افراد", "اسره", "اسر"] },
};

/** Folded alias -> unit key, built once. */
const ALIAS_INDEX: ReadonlyMap<string, UnitKey> = (() => {
  const index = new Map<string, UnitKey>();
  for (const [key, def] of Object.entries(UNITS) as [UnitKey, UnitDefinition][]) {
    for (const alias of def.aliases) {
      const folded = foldText(alias);
      // "%" folds to empty — it is punctuation, not a letter. Handled by the
      // literal strip in extractUnit instead.
      if (folded) index.set(folded, key);
    }
  }
  return index;
})();

export interface NumberNormalizerOptions {
  field: string;
  required: boolean;
  dontKnowTreatment: DontKnowTreatment;
  /**
   * The unit the question bank declares for this question, or null when the
   * question is a bare count with no unit. Supplied by the adapter from the
   * Question row.
   */
  expectedUnit: UnitKey | null;
  /** ScoringLookup.numericFloor / numericCeiling, when the question has them. */
  floor?: number | null;
  ceiling?: number | null;
}

const ARABIC_INDIC_ZERO = 0x0660;
const EASTERN_ARABIC_ZERO = 0x06f0;
const ARABIC_DECIMAL_SEPARATOR = "٫";
const ARABIC_THOUSANDS_SEPARATOR = "٬";

/** Arabic digits and separators to their ASCII equivalents. */
function asciifyDigits(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    if (code >= ARABIC_INDIC_ZERO && code <= ARABIC_INDIC_ZERO + 9) {
      out += String(code - ARABIC_INDIC_ZERO);
    } else if (code >= EASTERN_ARABIC_ZERO && code <= EASTERN_ARABIC_ZERO + 9) {
      out += String(code - EASTERN_ARABIC_ZERO);
    } else if (ch === ARABIC_DECIMAL_SEPARATOR) {
      out += ".";
    } else if (ch === ARABIC_THOUSANDS_SEPARATOR) {
      out += ",";
    } else {
      out += ch;
    }
  }
  return out;
}

/** A hyphen between two numbers means a range, which is not one measurement. */
const RANGE = /^\d+(?:[.,]\d+)?\s*[-–—]\s*\d+(?:[.,]\d+)?$/;

/** Leading approximation markers people write and mean nothing numeric by. */
const APPROXIMATION = /^(?:~|about|approx\.?|approximately|around|حوالي|تقريبا|نحو)\s*/i;

interface Parsed {
  amount: number;
  unit: UnitKey | null;
}

function parseAmountAndUnit(value: string): Parsed | null {
  // Split the leading numeric run from whatever trails it. A leading minus is
  // PARSED rather than rejected: "-3" is a real data-entry error on a count or
  // a duration, and telling a reviewer "negative value" is more actionable
  // than "not a number". The caller decides what a negative means for its own
  // question (see response-answer.rules.ts).
  const match = /^(-?\d[\d,]*(?:\.\d+)?)\s*(.*)$/.exec(value);
  if (!match) return null;
  const [, numeric, trailing] = match;

  // Thousands separators only ever sit between digit groups; a comma anywhere
  // else was a decimal point.
  let cleanedNumeric = numeric!;
  if (/^-?\d{1,3}(?:,\d{3})+$/.test(cleanedNumeric)) {
    cleanedNumeric = cleanedNumeric.replace(/,/g, "");
  } else if (/^-?\d+,\d+$/.test(cleanedNumeric)) {
    cleanedNumeric = cleanedNumeric.replace(",", ".");
  } else if (cleanedNumeric.includes(",")) {
    return null;
  }

  const amount = Number(cleanedNumeric);
  if (!Number.isFinite(amount)) return null;

  const rest = (trailing ?? "").trim();
  if (!rest) return { amount, unit: null };
  if (rest === "%") return { amount, unit: "percent" };

  const unit = ALIAS_INDEX.get(foldText(rest));
  return unit ? { amount, unit } : null;
}

/** Trim trailing zeros so 5.0 proposes as "5", matching how it is stored. */
function format(amount: number): string {
  return String(Number(amount.toFixed(4)));
}

/**
 * Normalize one raw numeric answer to a bare number in the question's own
 * unit.
 */
export function normalizeNumber(
  raw: string | null | undefined,
  options: NumberNormalizerOptions,
): NormalizationResult<number> {
  const presence = classifyPresence(raw, options.dontKnowTreatment);
  if (presence === "excluded") return clean<number>(null);
  if (presence === "absent") {
    return options.required ? missing<number>(options.field) : clean<number>(null);
  }

  const original = raw!.trim();
  const value = asciifyDigits(original).replace(APPROXIMATION, "").trim();

  if (RANGE.test(value)) {
    return unresolved<number>({
      ruleCode: "NUMBER_UNPARSEABLE",
      severity: "non_standard",
      originalValue: original,
      confidence: null,
      detail: {
        field: options.field,
        reason: "range_not_a_measurement",
        explanation: "A range has no single value; averaging it would record a number nobody measured.",
      },
    });
  }

  const parsed = parseAmountAndUnit(value);
  if (!parsed) {
    return unresolved<number>({
      ruleCode: "NUMBER_UNPARSEABLE",
      severity: "non_standard",
      originalValue: original,
      confidence: null,
      detail: { field: options.field, reason: "not_a_number" },
    });
  }

  let { amount } = parsed;
  const { unit } = parsed;
  let convertedFrom: UnitKey | null = null;

  if (unit && options.expectedUnit && unit !== options.expectedUnit) {
    const factor = UNITS[unit].convertsTo?.[options.expectedUnit];
    if (factor === undefined) {
      // No honest conversion exists — minutes to riyals is not a thing.
      return unresolved<number>({
        ruleCode: "UNIT_MISMATCH",
        severity: "non_standard",
        originalValue: original,
        confidence: null,
        detail: {
          field: options.field,
          writtenUnit: unit,
          expectedUnit: options.expectedUnit,
          reason: "no_conversion_defined",
        },
      });
    }
    amount = amount * factor;
    convertedFrom = unit;
  }

  const outOfRange =
    (options.floor !== null && options.floor !== undefined && amount < options.floor) ||
    (options.ceiling !== null && options.ceiling !== undefined && amount > options.ceiling);

  if (outOfRange) {
    // Deliberately no proposal: clamping to the ceiling would replace a
    // measurement with a boundary and report it as cleaned data.
    return unresolved<number>({
      ruleCode: "NUMBER_OUT_OF_RANGE",
      severity: "non_standard",
      originalValue: original,
      confidence: null,
      detail: {
        field: options.field,
        parsedValue: amount,
        floor: options.floor ?? null,
        ceiling: options.ceiling ?? null,
      },
    });
  }

  const standard = format(amount);

  if (convertedFrom) {
    return proposed(amount, {
      ruleCode: "UNIT_MISMATCH",
      severity: "non_standard",
      originalValue: original,
      proposedValue: standard,
      // A conversion is arithmetic, not a judgement, but it changes the number
      // a reader sees — so it is surfaced with the units named rather than
      // applied quietly.
      confidence: null,
      detail: {
        field: options.field,
        writtenUnit: convertedFrom,
        expectedUnit: options.expectedUnit,
      },
    });
  }

  if (standard === original) return clean(amount);

  return proposed(amount, {
    ruleCode: "NUMBER_FORMAT",
    severity: "non_standard",
    originalValue: original,
    proposedValue: standard,
    confidence: null,
    detail: { field: options.field, unit: options.expectedUnit ?? null },
  });
}
