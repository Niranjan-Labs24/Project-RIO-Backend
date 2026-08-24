import { Injectable, Logger } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { Prisma, type Question, type ScoringLookup } from '../../generated/prisma';

// Shared with parseRawAnswerValue/evaluateConditionalRule/calculateSeverity
// below — one raw survey answer, normalized to whichever of these four
// shapes its question's measurementMode implies. Only ever one of
// optionId/optionIds/numericValue/text is non-null for a given answer.
export interface ParsedAnswer {
  optionId: string | null;
  optionIds: string[] | null;
  numericValue: number | null;
  text: string | null;
}

@Injectable()
export class DeterministicScoringService {
  private readonly logger = new Logger(DeterministicScoringService.name);

  constructor(private readonly tenant: TenantPrismaService) {}

  /**
   * Normalize raw response display labels into stable option IDs.
   */
  toOptionId(label: string): string {
    if (!label) return '';
    return label
      .toUpperCase()
      .trim()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  /**
   * Order-independent key for a COMPOSITE option — a set of selected items
   * scored as one state rather than summed per option (Change Summary v5.0
   * item 8: "Checklist items are scored on the composite state"). INF-14 scores
   * "Ventilation; Roof; Walls" = 90 as a whole, and the workbook enumerates the
   * same set in several orders, so the key must not depend on order.
   *
   * MUST stay byte-identical to composite_option_id() in
   * scripts/extract-methodology-v5.py, which builds the stored `optionId`.
   */
  compositeOptionId(optionIds: string[]): string {
    return [...optionIds].filter(Boolean).sort().join('__');
  }

  /**
   * Measurement modes that never produce a severity score: the 7
   * questionnaire-structure, roster and template-pattern modules (XDM-01..07)
   * are instrument scaffolding, and open text has nothing to look up.
   */
  private static readonly NON_SCORING_MODES = new Set([
    'TEMPLATE_PATTERN',
    'METADATA_MODULE',
    'PERSON_ROSTER_MODULE',
    'OPEN_TEXT',
    'DIAGNOSTIC',
  ]);

  /**
   * Score a SurveyResponse submission:
   * 1. Extract and validate answers against SurveyQuestions and Question Bank.
   * 2. Save ResponseAnswer records.
   * 3. Evaluate conditional rules (applicability) and scoreability.
   * 4. Resolve lookups and compute individual severity scores (0 - 100).
   * 5. Save ResponseSeverityScore records.
   *
   * `orgId` must be passed explicitly when there's no authenticated request
   * to derive ambient org context from — the citizen survey-submission flow
   * is unauthenticated (OTP-verified, not logged in), so `requireOrgId()`
   * has nothing to read and throws `MissingOrgContextError` if this falls
   * back to the ambient path. Authenticated callers (if any are added
   * later) can omit it and rely on the ambient org context as before.
   */
  async scoreResponse(surveyResponseId: string, orgId?: string): Promise<void> {
    const run = orgId
      ? <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => this.tenant.runAsOrg(orgId, fn)
      : <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => this.tenant.runInOrgContext(fn);
    await run(async (tx) => {
      // 1. Fetch SurveyResponse
      const response = await tx.surveyResponse.findUnique({
        where: { id: surveyResponseId },
        include: {
          surveyLink: true,
          need: true,
        }
      });
      if (!response) {
        throw new Error(`SurveyResponse not found: ${surveyResponseId}`);
      }

      // Idempotency (GAP-04): a durable job may redeliver this after a crash/retry.
      // Clear any prior answers/scores for this response before recomputing, so a
      // re-run replaces rather than duplicates (no unique constraint guards these).
      // Mirrors the delete-first pattern in rollup.service.ts (recalculateStudyScores).
      await tx.responseAnswer.deleteMany({ where: { surveyResponseId } });
      await tx.responseSeverityScore.deleteMany({ where: { surveyResponseId } });

      const { needId, studyId, orgId } = response;
      const villageId = response.need.village?.[0] || null;
      const respondentId = response.contact;

      // Find the published survey for this Need
      const survey = await tx.survey.findFirst({
        where: { needId, status: 'PUBLISHED' },
        include: {
          surveyQuestions: {
            include: {
              question: true
            }
          }
        }
      });
      if (!survey) {
        throw new Error(`No published survey found for need: ${needId}`);
      }

      // Determine Methodology Version
      // If the survey has a snapshot version, find it, otherwise fall back to latest published version
      const methodologyVersion = await tx.methodologyVersion.findFirst({
        where: survey.methodologyVersion ? { version: survey.methodologyVersion } : { status: 'PUBLISHED' },
        orderBy: { createdAt: 'desc' }
      });
      if (!methodologyVersion) {
        throw new Error(`No published methodology version found`);
      }

      // Read raw answers from response JSON
      // Answers is a Record of surveyQuestionId -> answerValue
      const rawAnswers = (response.answers || {}) as Record<string, unknown>;

      // Load all scoring lookups for this methodology version
      const lookups = await tx.scoringLookup.findMany({
        where: { methodologyVersionId: methodologyVersion.id, isActive: true }
      });

      // Map raw answers to a structured map for rule evaluation
      // Key: questionId (e.g. H01), Value: { optionId, optionIds, numericValue, text }
      const answersMapByQuestionId = new Map<string, ParsedAnswer>();

      const questionMappings: Array<{
        surveyQuestionId: string;
        question: Question;
        rawAnswer: unknown;
      }> = [];

      for (const sq of survey.surveyQuestions) {
        const rawAnswer = rawAnswers[sq.id];
        if (sq.question) {
          const q = sq.question;
          const parsed = this.parseRawAnswerValue(rawAnswer, q.measurementMode);
          answersMapByQuestionId.set(q.questionId, parsed);
          questionMappings.push({ surveyQuestionId: sq.id, question: q, rawAnswer });
        }
      }

      // Process each question
      for (const { question, rawAnswer } of questionMappings) {
        const qId = question.questionId;
        const parsed = answersMapByQuestionId.get(qId)!;

        // Save ResponseAnswer record
        const answerRecord = await tx.responseAnswer.create({
          data: {
            orgId,
            surveyResponseId,
            surveyId: survey.id,
            studyId,
            villageId,
            respondentId,
            questionId: qId,
            answerOptionId: parsed.optionId,
            answerNumericValue: parsed.numericValue !== null ? new Prisma.Decimal(parsed.numericValue) : null,
            answerText: parsed.text,
            answerOptionIds: parsed.optionIds ? JSON.parse(JSON.stringify(parsed.optionIds)) : null,
            isApplicable: true, // Default to true, will update if conditional rule fails
            submittedAt: response.submittedAt,
          }
        });

        // Evaluate applicability (conditional rule)
        const isApplicable = this.evaluateConditionalRule(question, answersMapByQuestionId);
        if (!isApplicable) {
          await tx.responseAnswer.update({
            where: { id: answerRecord.id },
            data: { isApplicable: false }
          });

          await tx.responseSeverityScore.create({
            data: {
              orgId,
              responseAnswerId: answerRecord.id,
              surveyResponseId,
              surveyId: survey.id,
              studyId,
              villageId,
              questionId: qId,
              methodologyVersionId: methodologyVersion.id,
              rawAnswerSnapshot: JSON.parse(JSON.stringify({ rawAnswer })),
              severityScore: null,
              scoreStatus: 'NOT_APPLICABLE',
              calculationVersion: 'v1',
            }
          });
          continue;
        }

        // Evaluate scoreability
        if (!question.isScoreable) {
          await tx.responseSeverityScore.create({
            data: {
              orgId,
              responseAnswerId: answerRecord.id,
              surveyResponseId,
              surveyId: survey.id,
              studyId,
              villageId,
              questionId: qId,
              methodologyVersionId: methodologyVersion.id,
              rawAnswerSnapshot: JSON.parse(JSON.stringify({ rawAnswer })),
              severityScore: null,
              scoreStatus: 'NOT_SCOREABLE',
              calculationVersion: 'v1',
            }
          });
          continue;
        }

        // Handle missing answer
        if (
          parsed.optionId === null &&
          (parsed.optionIds === null || parsed.optionIds.length === 0) &&
          parsed.numericValue === null &&
          parsed.text === null
        ) {
          await tx.responseSeverityScore.create({
            data: {
              orgId,
              responseAnswerId: answerRecord.id,
              surveyResponseId,
              surveyId: survey.id,
              studyId,
              villageId,
              questionId: qId,
              methodologyVersionId: methodologyVersion.id,
              rawAnswerSnapshot: JSON.parse(JSON.stringify({ rawAnswer })),
              severityScore: null,
              scoreStatus: 'EXCLUDED',
              exclusionReason: 'MISSING_ANSWER',
              calculationVersion: 'v1',
            }
          });
          continue;
        }

        // Handle Don't Know / Not Applicable options directly
        const checkExclusion = this.getOptionExclusion(parsed.optionId, lookups, qId);
        if (checkExclusion) {
          await tx.responseSeverityScore.create({
            data: {
              orgId,
              responseAnswerId: answerRecord.id,
              surveyResponseId,
              surveyId: survey.id,
              studyId,
              villageId,
              questionId: qId,
              methodologyVersionId: methodologyVersion.id,
              scoringLookupId: checkExclusion.lookupId,
              rawAnswerSnapshot: JSON.parse(JSON.stringify({ rawAnswer })),
              severityScore: null,
              scoreStatus: 'EXCLUDED',
              exclusionReason: checkExclusion.exclusionReason,
              calculationVersion: 'v1',
            }
          });
          continue;
        }

        // Compute Severity Score based on measurement mode
        try {
          const scoreResult = this.calculateSeverity(question, parsed, lookups);
          await tx.responseSeverityScore.create({
            data: {
              orgId,
              responseAnswerId: answerRecord.id,
              surveyResponseId,
              surveyId: survey.id,
              studyId,
              villageId,
              questionId: qId,
              methodologyVersionId: methodologyVersion.id,
              scoringLookupId: scoreResult.scoringLookupId,
              rawAnswerSnapshot: JSON.parse(JSON.stringify({ rawAnswer })),
              severityScore: scoreResult.score !== null ? new Prisma.Decimal(scoreResult.score) : null,
              scoreStatus: scoreResult.status,
              exclusionReason: scoreResult.exclusionReason,
              calculationVersion: 'v1',
            }
          });
        } catch (e) {
          this.logger.error(`Error scoring question ${qId}: ${e instanceof Error ? e.message : String(e)}`);
          await tx.responseSeverityScore.create({
            data: {
              orgId,
              responseAnswerId: answerRecord.id,
              surveyResponseId,
              surveyId: survey.id,
              studyId,
              villageId,
              questionId: qId,
              methodologyVersionId: methodologyVersion.id,
              rawAnswerSnapshot: JSON.parse(JSON.stringify({ rawAnswer })),
              severityScore: null,
              scoreStatus: 'ERROR',
              exclusionReason: 'MISSING_LOOKUP',
              calculationVersion: 'v1',
            }
          });
        }
      }
    });
  }

  parseRawAnswerValue(
    raw: unknown,
    mode: string
  ): ParsedAnswer {
    const res = { optionId: null as string | null, optionIds: null as string[] | null, numericValue: null as number | null, text: null as string | null };
    if (raw === null || raw === undefined || raw === '') return res;

    if (mode === 'NUMERIC') {
      const val = Number(raw);
      if (!Number.isNaN(val)) res.numericValue = val;
    } else if (mode === 'MULTI_SELECT' || mode === 'CHECKLIST_MATRIX') {
      // A checklist matrix is a set of items confirmed present/absent — the same
      // "several values at once" shape as a multi-select, differing only in how
      // it is scored (see calculateSeverity).
      if (Array.isArray(raw)) {
        res.optionIds = raw.map(o => this.toOptionId(String(o)));
      } else if (typeof raw === 'string') {
        // ';' as well as ',': v5.0 composite option labels are ';'-joined, and a
        // client echoing a composite label back as one string must still parse
        // into its parts rather than becoming a single unmatchable option.
        res.optionIds = raw.split(/[;,]/).map(o => this.toOptionId(o.trim())).filter(Boolean);
      }
    } else if (DeterministicScoringService.NON_SCORING_MODES.has(mode)) {
      res.text = String(raw);
    } else {
      // SINGLE_SELECT, LIKERT_5
      res.optionId = this.toOptionId(String(raw));
    }
    return res;
  }

  /**
   * Is this question applicable to this respondent, given their other answers?
   *
   * Supports both rule shapes:
   *   v5.0 — { dependsOn, operator: 'IN' | 'NOT_IN' | 'PROSE', values?, description? }
   *   v1.0 — { dependsOn, value }   (legacy single-value equality)
   *
   * A `PROSE` rule is a real branching condition the methodology states in words
   * rather than as a question-to-question comparison ("asked only if a birth
   * occurred in the past 24 months" — 19 of the 25 v5.0 rules). It is treated as
   * APPLICABLE: the alternative is marking the question not-applicable for
   * everyone, which would silently discard every answer to it. The survey
   * instrument is what enforces prose branching in the field; scoring only needs
   * to avoid inventing an exclusion it cannot justify.
   *
   * Rule values are the methodology's human labels ("Yes, once"), while answers
   * are normalized option ids ("YES_ONCE"), so both sides are normalized here.
   */
  evaluateConditionalRule(question: Question, answersMap: Map<string, ParsedAnswer>): boolean {
    if (!question.conditionalRule) return true;
    try {
      const rule = (typeof question.conditionalRule === 'string'
        ? JSON.parse(question.conditionalRule)
        : question.conditionalRule) as
        | { dependsOn?: string | null; operator?: string; values?: string[]; value?: string }
        | null;
      if (!rule?.dependsOn) return true;
      if (rule.operator === 'PROSE') return true;

      const parent = answersMap.get(rule.dependsOn);
      // The gating question was not asked or not answered — nothing to branch on.
      if (!parent) return false;

      const raw = rule.values ?? (rule.value !== undefined ? [rule.value] : []);
      if (raw.length === 0) return true;
      const wanted = new Set(raw.map((v) => this.toOptionId(v)));

      const given = parent.optionIds?.length
        ? parent.optionIds
        : parent.optionId
          ? [parent.optionId]
          : [];
      const hit = given.some((g) => wanted.has(g));

      // NOT_IN is the "Skipped if X = Y" form (WSH-02 is skipped when water is
      // piped into the dwelling): applicable precisely when the parent answer is
      // NOT one of the listed values.
      return rule.operator === 'NOT_IN' ? !hit : hit;
    } catch (e) {
      this.logger.error(`Error parsing conditional rule on question ${question.questionId}`, e as Error);
    }
    return true;
  }

  getOptionExclusion(optionId: string | null, lookups: ScoringLookup[], questionId: string) {
    if (!optionId) return null;
    const lookup = lookups.find(l => l.questionId === questionId && l.optionId === optionId);
    if (lookup && lookup.isExcluded) {
      return {
        lookupId: lookup.id,
        exclusionReason: lookup.exclusionReason || 'DONT_KNOW',
      };
    }
    return null;
  }

  calculateSeverity(
    question: Question,
    parsed: ParsedAnswer,
    lookups: ScoringLookup[]
  ): {
    score: number | null;
    status: string;
    scoringLookupId: string | null;
    exclusionReason?: string;
  } {
    const qId = question.questionId;
    const mode = question.measurementMode;

    // Instrument scaffolding and diagnostic-only items carry no severity by
    // design. Reached before any lookup so a missing lookup is never mistaken
    // for a configuration error (the 18 diagnostic items DO have coded option
    // rows — they just never enter aggregation).
    if (DeterministicScoringService.NON_SCORING_MODES.has(mode) || !question.isScoreable) {
      return { score: null, status: 'NOT_SCOREABLE', scoringLookupId: null };
    }

    if (mode === 'NUMERIC') {
      const lookup = lookups.find(l => l.questionId === qId && l.lookupType === 'NUMERIC');
      if (!lookup) {
        throw new Error(`No numeric lookup config found for question: ${qId}`);
      }

      const floor = lookup.numericFloor !== null ? Number(lookup.numericFloor) : 0;
      const ceiling = lookup.numericCeiling !== null ? Number(lookup.numericCeiling) : 100;
      const direction = lookup.severityDirection || 'WORSENING_HIGHER';
      const answerVal = parsed.numericValue ?? floor;

      let score = 0;
      if (direction === 'WORSENING_HIGHER') {
        const ratio = (answerVal - floor) / (ceiling - floor);
        score = 100 * Math.max(0, Math.min(1, ratio));
      } else {
        const ratio = (ceiling - answerVal) / (ceiling - floor);
        score = 100 * Math.max(0, Math.min(1, ratio));
      }

      return { score, status: 'SCORED', scoringLookupId: lookup.id };
    }

    if (mode === 'MULTI_SELECT' || mode === 'CHECKLIST_MATRIX') {
      const selected = parsed.optionIds || [];
      const lookupType = mode === 'CHECKLIST_MATRIX' ? 'CHECKLIST' : 'MULTI_SELECT';
      const relevantLookups = lookups.filter(l => l.questionId === qId && l.lookupType === lookupType);
      if (relevantLookups.length === 0) {
        throw new Error(`No ${lookupType} lookups found for question: ${qId}`);
      }

      // A DK/NA escape wins outright — "Prefer not to answer" on HLT-21 is not a
      // zero-severity selection, it leaves the denominator entirely.
      for (const opt of selected) {
        const esc = relevantLookups.find(l => l.optionId === opt && l.isExcluded);
        if (esc) {
          return {
            score: null,
            status: 'EXCLUDED',
            scoringLookupId: esc.id,
            exclusionReason: esc.exclusionReason || 'NOT_APPLICABLE',
          };
        }
      }

      // ── 1. Composite state ────────────────────────────────────────────────
      // Some questions score the SET as one state rather than summing options
      // (INF-14: "Ventilation; Roof; Walls" = 90, which is LESS than the sum of
      // its parts would be). Per Change Summary v5.0 item 8, checklist items are
      // "scored on the composite state", so an exact set match must win over the
      // per-option sum below. Order-independent — see compositeOptionId.
      if (selected.length > 0) {
        const compositeKey = this.compositeOptionId(selected);
        const composite = relevantLookups.find(
          l => l.optionId === compositeKey && l.severityScore !== null,
        );
        if (composite) {
          return {
            score: Number(composite.severityScore),
            status: 'SCORED',
            scoringLookupId: composite.id,
          };
        }
      }

      // ── 2. Weighted sum of the selected options, capped at 100 ─────────────
      // METH — Answer Type Defs: multi-select is "a weighted sum of the
      // severities of the selected options, capped at 100".
      let sum = 0;
      let matchedLookupId: string | null = null;
      for (const opt of selected) {
        const match = relevantLookups.find(l => l.optionId === opt);
        if (match) {
          sum += Number(match.severityScore || 0);
          matchedLookupId ??= match.id;
        }
      }
      // Nothing resolved: an answer was given but not one option matched this
      // question's lookup, which means the option set and the stored lookup have
      // drifted. Surfacing ERROR is correct — scoring it 0 would read as "no
      // unmet need", the exact opposite of "we don't know".
      if (selected.length > 0 && matchedLookupId === null) {
        return { score: null, status: 'ERROR', scoringLookupId: null };
      }
      return {
        score: Math.min(sum, 100),
        status: 'SCORED',
        scoringLookupId: matchedLookupId ?? relevantLookups[0]?.id ?? null,
      };
    }

    // SINGLE_SELECT or LIKERT_5
    const lookupType = mode === 'LIKERT_5' ? 'LIKERT' : 'OPTION';
    const match = lookups.find(l => l.questionId === qId && l.lookupType === lookupType && l.optionId === parsed.optionId);
    if (!match) {
      throw new Error(`No lookup found for question: ${qId}, optionId: ${parsed.optionId}`);
    }

    if (match.isExcluded) {
      return {
        score: null,
        status: 'EXCLUDED',
        scoringLookupId: match.id,
        exclusionReason: match.exclusionReason || 'DONT_KNOW'
      };
    }

    return {
      score: match.severityScore !== null ? Number(match.severityScore) : null,
      status: 'SCORED',
      scoringLookupId: match.id
    };
  }
}
