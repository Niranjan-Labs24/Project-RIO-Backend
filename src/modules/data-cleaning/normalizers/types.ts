// RIO-FR-002 — the shape every normalizer returns.
//
// Client-confirmed (Q11, and the "AI & Human Review" principle behind it): a
// normalizer NEVER writes. It reports what it would change, and a reviewer
// decides. So the result is deliberately not a value — it is a value plus the
// flag that has to be raised about it, and the flag's fields map one-to-one
// onto the columns of `cleaning_flags`. An adapter copies them across; it
// never has to interpret or reshape anything.

export type CleaningSeverity =
  // The field is required by the rule set and has no usable value.
  | "missing"
  // There is a value and we understand it, but it is not written in the
  // standard form (Q12's five targets).
  | "non_standard"
  // There is a value and it is not one the methodology or the geographic
  // reference recognises at all.
  | "out_of_vocabulary";

/**
 * Stable machine codes. These are API contract — the frontend looks up an
 * Arabic/English label per code — so a code is never renamed once shipped,
 * and the human-readable text lives in `messages/`, never here.
 */
export type CleaningRuleCode =
  | "MISSING_REQUIRED"
  // Dates (Q12)
  | "DATE_FORMAT"
  | "DATE_AMBIGUOUS"
  | "DATE_UNPARSEABLE"
  // Mobile numbers (Q12)
  | "PHONE_FORMAT"
  | "PHONE_UNPARSEABLE"
  // Numeric units per the question bank (Q12)
  | "NUMBER_FORMAT"
  | "NUMBER_UNPARSEABLE"
  | "NUMBER_OUT_OF_RANGE"
  | "UNIT_MISMATCH"
  // Domain/sub-domain restricted to the approved methodology list (Q12)
  | "DOMAIN_NOT_IN_METHODOLOGY"
  | "SUBDOMAIN_NOT_IN_METHODOLOGY"
  | "SUBDOMAIN_WRONG_DOMAIN"
  // Village/place names against the geographic reference (Q12)
  | "VILLAGE_NEAR_MATCH"
  | "VILLAGE_AMBIGUOUS"
  | "VILLAGE_UNMATCHED"
  // A spreadsheet row the import could not turn into a Need. Distinct from
  // the field-level codes above because the subject is a ROW in a file, not a
  // value in a record — and because the uploader, not a reviewer, is the one
  // who can fix it.
  | "IMPORT_ROW_REJECTED"
  // A spreadsheet row that matches a Need already in the Study. Deliberately
  // NOT a duplicate_candidates row: nothing was persisted, so there is no
  // second Need to pair with. It is a note to the uploader that their file
  // repeats something already recorded.
  | "IMPORT_DUPLICATE_ROW";

export interface NormalizerFlag {
  ruleCode: CleaningRuleCode;
  severity: CleaningSeverity;
  /** What is stored today. Null only when the field is absent entirely. */
  originalValue: string | null;
  /**
   * What the reviewer would be accepting. ALWAYS null when severity is
   * "missing" — a rule that reports a field as absent and also supplies a
   * value for it is inventing data, which is the one thing cleaning must not
   * do. The `cleaning_flags_missing_has_no_proposal` CHECK constraint enforces
   * the same rule at the database.
   */
  proposedValue: string | null;
  /**
   * 0..1 for a proposal that involved a judgement (a near-matched village
   * name, a day-first reading of an ambiguous date). Null when the proposal is
   * deterministic — reformatting 05/03/2026 to 2026-03-05 is not a guess.
   */
  confidence: number | null;
  /** Rule-specific context for the reviewer, e.g. the candidate shortlist. */
  detail?: Record<string, unknown>;
}

export interface NormalizationResult<T> {
  /**
   * The standardized value, when one could be produced. Null when the input
   * was missing or could not be understood. NOT yet written anywhere —
   * `changed` says whether it differs from what is stored.
   */
  value: T | null;
  /** True when `value` differs from the input and should be PROPOSED. */
  changed: boolean;
  /** Null when there is nothing to tell a reviewer about. */
  flag: NormalizerFlag | null;
}

/**
 * Nothing to propose and nothing to flag. Either the input was already
 * standard (`value` is it), or there is legitimately nothing there — an
 * optional field left blank, or a "Don't know" answer, which Q13 makes a real
 * excluded answer rather than a gap.
 */
export function clean<T>(value: T | null): NormalizationResult<T> {
  return { value, changed: false, flag: null };
}

/** A standard value was produced and differs from the input. */
export function proposed<T>(
  value: T,
  flag: Omit<NormalizerFlag, "proposedValue"> & { proposedValue: string },
): NormalizationResult<T> {
  return { value, changed: true, flag };
}

/** Something is wrong and no replacement can be offered honestly. */
export function unresolved<T>(
  flag: Omit<NormalizerFlag, "proposedValue">,
): NormalizationResult<T> {
  return { value: null, changed: false, flag: { ...flag, proposedValue: null } };
}

/** The field is required by the rule set and empty. */
export function missing<T>(field: string): NormalizationResult<T> {
  return {
    value: null,
    changed: false,
    flag: {
      ruleCode: "MISSING_REQUIRED",
      severity: "missing",
      originalValue: null,
      proposedValue: null,
      confidence: null,
      detail: { field },
    },
  };
}
