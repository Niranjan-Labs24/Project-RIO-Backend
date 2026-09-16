import type { NormalizerFlag } from "./normalizers";

/**
 * RIO-FR-002 Q14 — the three sources cleaning applies to, under ONE rule set.
 * Deliberately the same vocabulary as NeedSource so a per-source report reads
 * against need counts without a translation table.
 */
export type CleaningSource = "manual_entry" | "survey_response" | "file_upload";

export type CleaningScopeType = "org" | "study" | "import_batch" | "record";

export type CleaningEntityType =
  | "need"
  | "survey_response"
  | "response_answer"
  | "import_row";

/**
 * One finding, ready to become a `cleaning_flags` row. A rule returns these;
 * DataCleaningService is the only thing that turns them into rows.
 */
export interface PendingFlag extends NormalizerFlag {
  entityType: CleaningEntityType;
  /** Null only for entityType "import_row", which has no persisted record. */
  entityId: string | null;
  /** 1-based file row. Set only for "import_row". */
  rowNumber: number | null;
  field: string;
}

/** A row the import rejected before it ever became a Need. */
export interface RejectedImportRow {
  rowNumber: number;
  field: string;
  message: string;
  kind: "validation" | "duplicate";
  originalValue: string | null;
}

/**
 * The cleaning rule set, as stored in
 * methodology_configs.data_cleaning_settings. Every field is optional here
 * because the column is JSONB and an older row may predate a key — the
 * service supplies defaults rather than trusting the shape.
 */
export interface DataCleaningSettings {
  ruleSetVersion?: string;
  dontKnowTreatment?: "excluded_answer" | "missing_value";
  requiredNeedFields?: string[];
  softNeedFields?: string[];
  requiredSurveyResponseFields?: string[];
  /**
   * Fields whose value is respondent PII. A flag on one of these carries a
   * MASKED original and NO proposal — see DataCleaningService for why.
   */
  piiFields?: string[];
  dateOutputFormat?: string;
  phoneDefaultRegion?: string;
  phoneOutputFormat?: string;
  villageMatchAcceptThreshold?: number;
  villageMatchProposeThreshold?: number;
  villageMatchMaxCandidates?: number;
  literalDuplicateThreshold?: number;
  classificationNearMatchThreshold?: number;
  /**
   * RIO-AI-004 — cosine similarity a semantic pair must reach to be proposed.
   *
   * Higher than the literal threshold on purpose, and the number is measured
   * rather than picked. Calibrated against gemini-embedding-001 at 768
   * dimensions on 17 synthetic pairs shaped like real needs:
   *
   *   true duplicates     0.923 .. 0.985   (including Arabic/English pairs)
   *   unrelated needs     0.678 .. 0.886
   *
   * A clean gap sits between 0.886 and 0.923, and 0.90 falls inside it: on that
   * sample it caught 8 of 8 duplicates with one false alarm. Embeddings do not
   * spread out the way trigrams do — unrelated Saudi community needs still
   * score ~0.77 because they are all community needs — so a threshold that
   * looks lenient by trigram standards is strict here.
   *
   * The one false alarm no threshold can remove: the SAME need stated for two
   * different years scores 0.983, above most genuine duplicates. Meaning-based
   * matching cannot tell 2026 from 2025. That is the standing argument for
   * Q11 propose-only, not a tuning problem.
   */
  semanticDuplicateThreshold?: number;
  duplicateScopes?: {
    withinStudy?: boolean;
    withinOrg?: boolean;
    crossOrg?: boolean;
  };
}

export const DEFAULT_SETTINGS: Required<
  Pick<
    DataCleaningSettings,
    | "ruleSetVersion"
    | "dontKnowTreatment"
    | "requiredNeedFields"
    | "softNeedFields"
    | "requiredSurveyResponseFields"
    | "piiFields"
    | "phoneDefaultRegion"
    | "villageMatchAcceptThreshold"
    | "villageMatchProposeThreshold"
    | "villageMatchMaxCandidates"
    | "classificationNearMatchThreshold"
    | "semanticDuplicateThreshold"
    | "literalDuplicateThreshold"
    | "duplicateScopes"
  >
> = {
  ruleSetVersion: "fr002-v1",
  dontKnowTreatment: "excluded_answer",
  requiredNeedFields: ["title", "statement", "domain", "geography", "source"],
  softNeedFields: [],
  requiredSurveyResponseFields: ["contact"],
  piiFields: ["contact", "mobile", "contactName"],
  phoneDefaultRegion: "SA",
  villageMatchAcceptThreshold: 0.92,
  villageMatchProposeThreshold: 0.75,
  villageMatchMaxCandidates: 5,
  classificationNearMatchThreshold: 0.5,
  semanticDuplicateThreshold: 0.9,
  // Q23 — start conservative so reviewers see few false alarms, tune once
  // real field data exists.
  literalDuplicateThreshold: 0.85,
  // crossOrg stays off: cross-entity comparison is RIO-AI-004's, and Q9
  // confines it to the Center/NCNP Supervisor role.
  duplicateScopes: { withinStudy: true, withinOrg: true, crossOrg: false },
};

export interface CleaningRunSummary {
  runId: string;
  recordsScanned: number;
  recordsFlagged: number;
  flagsRaised: number;
  flagsSuperseded: number;
}
