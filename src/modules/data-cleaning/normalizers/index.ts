// RIO-FR-002 — the normalizer library.
//
// One pure function per standardization target confirmed in Q12, plus the
// folding they all share and the Q13 "Don't know" rule they all route through.
// No database, no Nest injection, no I/O: an adapter reads the rows and the
// question-bank context, calls these, and turns each returned flag into a
// `cleaning_flags` row.
//
// The single rule that holds across all of them: a normalizer PROPOSES and
// never writes (Q11).

export {
  foldText,
  foldsEqual,
  trigrams,
  trigramSimilarity,
} from "./fold-text";

export { FOLD_FIXTURES, type FoldFixture } from "./fold-text.fixtures";

export {
  isDontKnow,
  classifyPresence,
  type DontKnowTreatment,
  type PresenceVerdict,
} from "./dont-know";

export { normalizeDate, type DateNormalizerOptions } from "./normalize-date";

export { normalizePhone, type PhoneNormalizerOptions } from "./normalize-phone";

export {
  normalizeNumber,
  type NumberNormalizerOptions,
  type UnitKey,
} from "./normalize-number";

export {
  normalizeDomain,
  normalizeSubDomain,
  type ClassificationNormalizerOptions,
  type SubDomainNormalizerOptions,
  type MethodologyVocabulary,
} from "./normalize-classification";

export {
  matchPlace,
  type PlaceMatchOptions,
  type PlaceReference,
  type PlaceCandidate,
} from "./match-place";

export {
  clean,
  missing,
  proposed,
  unresolved,
  type CleaningRuleCode,
  type CleaningSeverity,
  type NormalizationResult,
  type NormalizerFlag,
} from "./types";
