// RIO-FR-002 / Q12 — "village and place names matched to the official
// geographic reference".
//
// Village names are stored as free text (Need.village is a String[]), and the
// same village is spelled several ways — the client said so themselves in Q2,
// when explaining why they could not hand us a coordinate file keyed on names.
// This resolver is what connects that free text to the seeded Center /
// Governorate master data.
//
// It never writes. A confident match becomes a PROPOSED center code on a flag;
// an unconfident one becomes a shortlist; nothing at all becomes
// VILLAGE_UNMATCHED. That last case is deliberately a visible flag rather than
// a silent drop, for the reason the client gave in Q4 about the map: no need
// should disappear from the totals because its village did not match.
//
// The reference list is passed in — it comes from the Center table, which the
// adapter reads. Pure function, no database, fully testable.

import { foldText, trigramSimilarity } from "./fold-text";
import { classifyPresence, type DontKnowTreatment } from "./dont-know";
import {
  clean,
  missing,
  unresolved,
  proposed,
  type NormalizationResult,
} from "./types";

export interface PlaceReference {
  /** Center.code — the stable identifier, e.g. "0101-001". */
  code: string;
  /** Center.name as seeded. */
  name: string;
  /**
   * Center.nameAr — the official Arabic name. UAT DQ-03: matched as well as
   * `name`, so a village typed in Arabic is compared with Arabic, not only
   * with the English transliteration it can never resemble.
   */
  nameAr?: string | null;
  /** Governorate name, shown to the reviewer to tell same-named places apart. */
  governorate?: string;
  /**
   * The governorate's official Arabic name, so the Arabic review screen names
   * it in Arabic instead of sending the English one to AI translation (UAT
   * DQ-01, found on the merged branch 10 Nov).
   */
  governorateAr?: string | null;
}

export interface PlaceMatchOptions {
  field: string;
  required: boolean;
  dontKnowTreatment: DontKnowTreatment;
  reference: PlaceReference[];
  /**
   * At or above this, a single best match is proposed. Below it but at or
   * above proposeThreshold, a shortlist is offered instead.
   */
  acceptThreshold: number;
  proposeThreshold: number;
  maxCandidates: number;
}

export interface PlaceCandidate {
  code: string;
  name: string;
  nameAr?: string | null;
  governorate: string | null;
  governorateAr?: string | null;
  score: number;
}

/**
 * Two candidates this close together are not distinguishable by score, and
 * picking the higher one would be arbitrary. Real Saudi center names collide
 * often enough (several "الفرعة", several "الخالدية") that this is a routine
 * case, not an edge one.
 */
const AMBIGUITY_MARGIN = 0.02;

/** Standalone words that carry no identity in a place name. */
const FILLER_WORDS = new Set(["al", "el", "و"]);

/**
 * UAT DQ-03 — the key place names are compared on. On top of foldText (case,
 * accents, tashkeel, أإآ→ا, ى→ي, ة→ه), it ignores what varies between two
 * spellings of the same place without changing which place is meant:
 * - the definite article: «العيينة» = «عيينة», "Al-Uyaynah" = "Uyaynah";
 * - a conjunction written attached or apart: «والجبيلة» = «و الجبيلة».
 * Scoring-only. foldText itself is unchanged, because it mirrors the
 * database's rio_fold_text used by the duplicate queries.
 */
export function placeKey(input: string): string {
  return foldText(input)
    .split(" ")
    .map((word) => (word.length > 4 && word.startsWith("وال") ? word.slice(1) : word))
    .map((word) => (word.length > 3 && word.startsWith("ال") ? word.slice(2) : word))
    .filter((word) => word && !FILLER_WORDS.has(word))
    .join(" ");
}

/** The same key with spaces removed, for "is this the same name" checks. */
const compactKey = (input: string): string => placeKey(input).replace(/ /g, "");

const namesOf = (ref: PlaceReference): string[] =>
  ref.nameAr ? [ref.name, ref.nameAr] : [ref.name];

function rank(raw: string, reference: PlaceReference[], limit: number): PlaceCandidate[] {
  const key = placeKey(raw);
  if (!key) return [];
  return reference
    .map((ref) => ({
      code: ref.code,
      name: ref.name,
      nameAr: ref.nameAr ?? null,
      governorate: ref.governorate ?? null,
      governorateAr: ref.governorateAr ?? null,
      // The better of the two official names: Arabic input is scored against
      // the Arabic name, Latin input against the English one.
      score: Math.max(...namesOf(ref).map((n) => trigramSimilarity(key, placeKey(n)))),
    }))
    .filter((c) => c.score > 0)
    .sort((a, b) => (b.score - a.score) || a.code.localeCompare(b.code))
    .slice(0, limit);
}

/**
 * Resolve one free-text village name to a Center code.
 *
 * The returned `value` is the CENTER CODE, not the name: the code is what
 * every downstream join needs, and it is stable where the name is not.
 * `proposedValue` on the flag is the code too, so accepting a flag is a
 * single unambiguous write.
 */
export function matchPlace(
  raw: string | null | undefined,
  options: PlaceMatchOptions,
): NormalizationResult<string> {
  const presence = classifyPresence(raw, options.dontKnowTreatment);
  if (presence === "excluded") return clean<string>(null);
  if (presence === "absent") {
    return options.required ? missing<string>(options.field) : clean<string>(null);
  }

  const original = raw!.trim();
  const inputKey = compactKey(original);

  // An exact match on the place key against a single reference entry is not
  // a guess — it is the same name written differently (UAT DQ-03: «العيينه»,
  // «عيينة» and «العيينة» are all the official «العيينة»).
  const exactMatches = inputKey
    ? options.reference.filter((ref) => namesOf(ref).some((n) => compactKey(n) === inputKey))
    : [];
  if (exactMatches.length === 1) {
    const match = exactMatches[0]!;
    // ...but if the stored text is ALREADY the reference spelling, there is
    // nothing to standardize. Proposing it anyway puts a no-op in the
    // reviewer's queue: original and proposed are the same string, accepting
    // changes nothing, and the reviewer learns to distrust the queue. Caught
    // by fr002:verify-review against real data, where center 0707-001 is
    // itself named "Qiyal".
    // An official name in either language is already standard.
    if (match.name === original || match.nameAr === original) return clean(match.code);
    return proposed(match.code, {
      ruleCode: "VILLAGE_NEAR_MATCH",
      severity: "non_standard",
      originalValue: original,
      proposedValue: match.code,
      confidence: 1,
      detail: {
        field: options.field,
        matchedName: match.name,
        matchedNameAr: match.nameAr ?? null,
        governorate: match.governorate ?? null,
        governorateAr: match.governorateAr ?? null,
        reason: "exact_match_after_folding",
        // Shown so the one choice is selectable like any other suggestion.
        candidates: [
          {
            code: match.code,
            name: match.name,
            nameAr: match.nameAr ?? null,
            governorate: match.governorate ?? null,
            governorateAr: match.governorateAr ?? null,
            score: 1,
          },
        ],
      },
    });
  }

  const candidates = rank(original, options.reference, options.maxCandidates);
  const top = candidates[0];

  // Several reference entries share this name — a real and common case, and
  // one only a person with local knowledge can settle.
  if (exactMatches.length > 1) {
    return unresolved<string>({
      ruleCode: "VILLAGE_AMBIGUOUS",
      severity: "out_of_vocabulary",
      originalValue: original,
      confidence: null,
      detail: {
        field: options.field,
        reason: "same_name_in_several_governorates",
        candidates: exactMatches.slice(0, options.maxCandidates).map((ref) => ({
          code: ref.code,
          name: ref.name,
          nameAr: ref.nameAr ?? null,
          governorate: ref.governorate ?? null,
          governorateAr: ref.governorateAr ?? null,
          score: 1,
        })),
      },
    });
  }

  if (!top || top.score < options.proposeThreshold) {
    return unresolved<string>({
      ruleCode: "VILLAGE_UNMATCHED",
      severity: "out_of_vocabulary",
      originalValue: original,
      confidence: null,
      detail: { field: options.field, candidates },
    });
  }

  const runnerUp = candidates[1];
  if (runnerUp && top.score - runnerUp.score < AMBIGUITY_MARGIN) {
    return unresolved<string>({
      ruleCode: "VILLAGE_AMBIGUOUS",
      severity: "out_of_vocabulary",
      originalValue: original,
      confidence: null,
      detail: {
        field: options.field,
        reason: "candidates_too_close_to_separate",
        candidates,
      },
    });
  }

  if (top.score >= options.acceptThreshold) {
    return proposed(top.code, {
      ruleCode: "VILLAGE_NEAR_MATCH",
      severity: "non_standard",
      originalValue: original,
      proposedValue: top.code,
      confidence: Number(top.score.toFixed(4)),
      detail: {
        field: options.field,
        matchedName: top.name,
        governorate: top.governorate,
        governorateAr: top.governorateAr ?? null,
        candidates,
      },
    });
  }

  // Above propose, below accept: there is something to show, but not enough to
  // put a single answer in front of the reviewer as though it were settled.
  return unresolved<string>({
    ruleCode: "VILLAGE_NEAR_MATCH",
    severity: "out_of_vocabulary",
    originalValue: original,
    confidence: Number(top.score.toFixed(4)),
    detail: { field: options.field, candidates },
  });
}
