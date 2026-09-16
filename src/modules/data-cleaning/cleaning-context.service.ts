import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import {
  DEFAULT_SETTINGS,
  type DataCleaningSettings,
} from "./data-cleaning.types";
import type { MethodologyVocabulary, PlaceReference } from "./normalizers";
import {
  deriveExpectedUnit,
  type NumericQuestionSpec,
} from "./rules/response-answer.rules";

/**
 * RIO-FR-002 — everything the rules need that is NOT the record being cleaned:
 * the rule set, the approved methodology vocabulary, and the geographic
 * reference.
 *
 * All three are global reference data with no org_id and no RLS
 * (methodology_configs, domains/sub_domains, centers), so this reads them with
 * the plain app client rather than through a tenant transaction, and caches
 * them: the geographic reference alone is ~1,400 rows and cleaning runs on
 * every Need save. A cold read per need would make the cost of cleaning scale
 * with the size of the country.
 *
 * The TTL is short on purpose. These tables change when a System Admin edits
 * methodology configuration or a reference import runs — rare, but the window
 * where cleaning uses a stale vocabulary has to be minutes, not the process
 * lifetime.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface CleaningContext {
  settings: Required<
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
  >;
  vocabulary: MethodologyVocabulary[];
  places: PlaceReference[];
  /**
   * Numeric questions, keyed `${methodologyVersionId}:${questionCode}`.
   * Version-scoped because a question's identity IS (methodologyVersionId,
   * questionId) — see the Question model's comment about two banks producing
   * near-duplicate codes.
   */
  numericQuestions: Map<string, NumericQuestionSpec>;
}

@Injectable()
export class CleaningContextService {
  private readonly logger = new Logger(CleaningContextService.name);
  private cached: { context: CleaningContext; loadedAt: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async load(): Promise<CleaningContext> {
    const now = Date.now();
    if (this.cached && now - this.cached.loadedAt < CACHE_TTL_MS) {
      return this.cached.context;
    }

    const [config, domains, subDomains, centers, numericQuestionRows, numericLookups] =
      await Promise.all([
      this.prisma.methodologyConfig.findFirst({
        select: { dataCleaningSettings: true },
      }),
      this.prisma.domain.findMany({ select: { id: true, name: true } }),
      this.prisma.subDomain.findMany({
        select: { name: true, domainId: true },
      }),
      this.prisma.center.findMany({
        select: { code: true, name: true, governorate: { select: { name: true } } },
      }),
      // Only the version of a question that actually governs new surveys.
      this.prisma.question.findMany({
        where: {
          measurementMode: "NUMERIC",
          isCurrentVersion: true,
          approvalStatus: "approved",
        },
        select: {
          questionId: true,
          questionText: true,
          methodologyVersionId: true,
        },
      }),
      this.prisma.scoringLookup.findMany({
        where: { lookupType: "NUMERIC", isActive: true },
        select: {
          questionId: true,
          methodologyVersionId: true,
          numericFloor: true,
          numericCeiling: true,
        },
      }),
    ]);

    const stored = (config?.dataCleaningSettings ?? {}) as DataCleaningSettings;
    const settings: CleaningContext["settings"] = {
      ruleSetVersion: stored.ruleSetVersion ?? DEFAULT_SETTINGS.ruleSetVersion,
      dontKnowTreatment: stored.dontKnowTreatment ?? DEFAULT_SETTINGS.dontKnowTreatment,
      requiredNeedFields: stored.requiredNeedFields ?? DEFAULT_SETTINGS.requiredNeedFields,
      softNeedFields: stored.softNeedFields ?? DEFAULT_SETTINGS.softNeedFields,
      requiredSurveyResponseFields:
        stored.requiredSurveyResponseFields ?? DEFAULT_SETTINGS.requiredSurveyResponseFields,
      piiFields: stored.piiFields ?? DEFAULT_SETTINGS.piiFields,
      phoneDefaultRegion: stored.phoneDefaultRegion ?? DEFAULT_SETTINGS.phoneDefaultRegion,
      villageMatchAcceptThreshold:
        stored.villageMatchAcceptThreshold ?? DEFAULT_SETTINGS.villageMatchAcceptThreshold,
      villageMatchProposeThreshold:
        stored.villageMatchProposeThreshold ?? DEFAULT_SETTINGS.villageMatchProposeThreshold,
      villageMatchMaxCandidates:
        stored.villageMatchMaxCandidates ?? DEFAULT_SETTINGS.villageMatchMaxCandidates,
      classificationNearMatchThreshold:
        stored.classificationNearMatchThreshold ??
        DEFAULT_SETTINGS.classificationNearMatchThreshold,
      semanticDuplicateThreshold:
        stored.semanticDuplicateThreshold ?? DEFAULT_SETTINGS.semanticDuplicateThreshold,
      literalDuplicateThreshold:
        stored.literalDuplicateThreshold ?? DEFAULT_SETTINGS.literalDuplicateThreshold,
      duplicateScopes: stored.duplicateScopes ?? DEFAULT_SETTINGS.duplicateScopes,
    };

    const vocabulary: MethodologyVocabulary[] = domains.map((d) => ({
      domain: d.name,
      subDomains: subDomains.filter((s) => s.domainId === d.id).map((s) => s.name),
    }));

    const places: PlaceReference[] = centers.map((c) => ({
      code: c.code,
      name: c.name,
      governorate: c.governorate?.name,
    }));

    if (vocabulary.length === 0) {
      // Not fatal — the vocabulary rules simply have nothing to check against
      // and stay silent, rather than flagging every need as out-of-vocabulary
      // because reference data has not been imported yet.
      this.logger.warn(
        "No methodology domains found — domain/sub-domain cleaning rules will not run.",
      );
    }

    const lookupByKey = new Map(
      numericLookups.map((l) => [`${l.methodologyVersionId}:${l.questionId}`, l]),
    );
    const numericQuestions = new Map<string, NumericQuestionSpec>();
    for (const q of numericQuestionRows) {
      const key = `${q.methodologyVersionId}:${q.questionId}`;
      const lookup = lookupByKey.get(key);
      numericQuestions.set(key, {
        questionCode: q.questionId,
        questionText: q.questionText,
        expectedUnit: deriveExpectedUnit(q.questionText),
        // Carried for the reviewer's context only — NOT used as a validity
        // range. See response-answer.rules.ts for why that distinction matters.
        scoringFloor: lookup?.numericFloor === null || lookup?.numericFloor === undefined
          ? null
          : Number(lookup.numericFloor),
        scoringCeiling: lookup?.numericCeiling === null || lookup?.numericCeiling === undefined
          ? null
          : Number(lookup.numericCeiling),
      });
    }

    const context: CleaningContext = { settings, vocabulary, places, numericQuestions };
    this.cached = { context, loadedAt: now };
    return context;
  }

  /** Drop the cache — for tests, and for reference-data imports to call. */
  invalidate(): void {
    this.cached = null;
  }
}
