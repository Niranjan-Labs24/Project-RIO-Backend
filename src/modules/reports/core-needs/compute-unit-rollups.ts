// The methodology's five-level rollup, computed for an arbitrary geographic
// unit (a region, governorate, centre or village) instead of one survey and
// one village key.
//
// Why not read the stored rollups: ScoreRollup holds one row per survey per
// village key, and a response is stored once for EVERY village its Need
// names. Summing village rows double-counts responses, and averaging them
// weights a two-village need twice. Recomputing from the answers, deduplicated
// per response, gives the unit the same figures the scoring engine would give
// it — the arithmetic below mirrors RollupService exactly (question mean →
// KPI → indicator → sub-domain → domain → overall, each the mean of its
// scored children; counts averaged the same way).

export interface UnitAnswer {
  responseId: string;
  questionId: string;
  status: string; // SCORED | EXCLUDED | NOT_APPLICABLE | NOT_SCOREABLE | ERROR
  exclusionReason: string | null;
  severity: number | null;
  numericValue: number | null;
}

export interface QuestionMeta {
  questionId: string;
  domain: string;
  subDomain: string;
  indicator: string | null;
  kpi: string | null;
  numeric: boolean;
  /** The methodology's access / availability analytical dimension — the only
   *  items that can be Critical (v5.0 priority tiers). */
  accessDimension?: boolean;
  /** Who the figure counts: households unless the question is a person-level
   *  roster (v5.0 roster scope). */
  unit?: RespondentUnit;
  /** The answer options include a plain "No" — the actual value's bracketed
   *  "No" share applies only then (client, 15 Oct 2026). */
  hasNo?: boolean;
}

export type RespondentUnit = "HOUSEHOLDS" | "RESPONDENTS" | "MEMBERS" | "CHILDREN" | "YOUTH" | "WOMEN";

export interface ConfidenceSettings {
  minRespondents: number;
  dontKnowRatio: number;
  requiredSampleSize: number | null;
}

export interface UnitRollup {
  entityId: string;
  severityScore: number | null;
  validResponseCount: number;
  excludedResponseCount: number;
  dontKnowCount: number;
  notApplicableCount: number;
  dontKnowRate: number;
  confidenceLevel: "LOW" | "STANDARD";
}

export interface UnitRollups {
  question: Map<string, UnitRollup>;
  kpi: Map<string, UnitRollup>;
  indicator: Map<string, UnitRollup>;
  subDomain: Map<string, UnitRollup>;
  domain: Map<string, UnitRollup>;
  overall: UnitRollup | null;
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

function lowConfidence(valid: number, dkRate: number, s: ConfidenceSettings): boolean {
  return (
    valid < s.minRespondents ||
    (s.requiredSampleSize != null && valid < s.requiredSampleSize) ||
    dkRate > s.dontKnowRatio
  );
}

/** A parent level from its children: mean of scored children, counts averaged. */
function parentOf(id: string, children: UnitRollup[], s: ConfidenceSettings): UnitRollup | null {
  if (!children.length) return null;
  const scored = children.filter((c) => c.severityScore !== null);
  const severity = scored.length ? mean(scored.map((c) => c.severityScore!)) : null;
  const valid = Math.round(mean(children.map((c) => c.validResponseCount)));
  const dkRate = mean(children.map((c) => c.dontKnowRate));
  return {
    entityId: id,
    severityScore: severity,
    validResponseCount: valid,
    excludedResponseCount: Math.round(mean(children.map((c) => c.excludedResponseCount))),
    dontKnowCount: Math.round(mean(children.map((c) => c.dontKnowCount))),
    notApplicableCount: Math.round(mean(children.map((c) => c.notApplicableCount))),
    dontKnowRate: dkRate,
    confidenceLevel: lowConfidence(valid, dkRate, s) ? "LOW" : "STANDARD",
  };
}

export function computeUnitRollups(
  answers: UnitAnswer[],
  questions: Map<string, QuestionMeta>,
  settings: ConfidenceSettings,
): UnitRollups {
  // One answer per response per question: a response duplicated across its
  // need's villages contributes once.
  const seen = new Set<string>();
  const byQuestion = new Map<string, UnitAnswer[]>();
  for (const a of answers) {
    const key = `${a.responseId}\u0000${a.questionId}`;
    if (seen.has(key) || !questions.has(a.questionId)) continue;
    seen.add(key);
    const list = byQuestion.get(a.questionId) ?? [];
    list.push(a);
    byQuestion.set(a.questionId, list);
  }

  const question = new Map<string, UnitRollup>();
  for (const [qId, rows] of byQuestion) {
    const scored = rows.filter((r) => r.status === "SCORED" && r.severity !== null);
    const valid = scored.length;
    const dk = rows.filter((r) => r.exclusionReason === "DONT_KNOW").length;
    const dkRate = valid + dk > 0 ? dk / (valid + dk) : 0;
    question.set(qId, {
      entityId: qId,
      severityScore: valid ? mean(scored.map((r) => r.severity!)) : null,
      validResponseCount: valid,
      excludedResponseCount: rows.filter((r) => r.status === "EXCLUDED").length,
      dontKnowCount: dk,
      notApplicableCount: rows.filter((r) => r.status === "NOT_APPLICABLE").length,
      dontKnowRate: dkRate,
      confidenceLevel: lowConfidence(valid, dkRate, settings) ? "LOW" : "STANDARD",
    });
  }

  // The hierarchy, from the methodology's own Question rows (first-seen order).
  const group = (pick: (q: QuestionMeta) => [string | null, string | null]): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    for (const q of questions.values()) {
      const [parent, child] = pick(q);
      if (!parent || !child) continue;
      const list = out.get(parent) ?? [];
      if (!list.includes(child)) list.push(child);
      out.set(parent, list);
    }
    return out;
  };

  const level = (
    parents: Map<string, string[]>,
    childMap: Map<string, UnitRollup>,
  ): Map<string, UnitRollup> => {
    const out = new Map<string, UnitRollup>();
    for (const [id, children] of parents) {
      const rows = children.map((c) => childMap.get(c)).filter((r): r is UnitRollup => !!r);
      const parent = parentOf(id, rows, settings);
      if (parent) out.set(id, parent);
    }
    return out;
  };

  const kpi = level(group((q) => [q.kpi, q.questionId]), question);
  const indicator = level(group((q) => [q.indicator, q.kpi]), kpi);
  const subDomain = level(group((q) => [q.subDomain, q.indicator]), indicator);
  const domain = level(group((q) => [q.domain, q.subDomain]), subDomain);
  const overall = parentOf("OVERALL", [...domain.values()], settings);

  return { question, kpi, indicator, subDomain, domain, overall };
}
