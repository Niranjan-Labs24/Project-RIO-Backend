// NCNP report (client, 7 Oct 2026, point 2): the Core Needs Report's layout,
// sections and rules, built from several studies from different organisations.
//
// Combining rule (client, 15 Oct 2026): scores are pooled at response level,
// so each study counts in proportion to its valid responses; the sample size
// is the sum of valid responses; confidence is recalculated on the pooled data
// with the v5.0 rules, against a required sample recalculated from the
// combined population; and each study's share and own result are shown.

import { BadRequestException } from "@nestjs/common";
import { calculateSampleSize } from "../../studies/sample-size";
import type { ConfidenceResult } from "./core-needs.config";
import type { AreaFigures } from "./core-needs.types";
import { villageLabels, type CoreInputs } from "./load-core-needs";

export interface NcnpStudyReliability {
  studyId: string;
  title: string;
  organization: string | null;
  valid: number;
  required: number | null;
  villagesWithData: number;
  unitsWithData: number;
  unitsTotal: number;
  /** The study's share of the pooled valid responses (set once pooled). */
  sharePct: number | null;
  sampleResult: ConfidenceResult;
  completenessResult: ConfidenceResult;
  overall: ConfidenceResult;
  methodologyVersion: string;
}

/** One set of inputs from several studies' inputs, pooled. */
export function mergeCoreInputs(list: CoreInputs[]): CoreInputs {
  if (!list.length) throw new BadRequestException({ error: { code: "NCNP_STUDIES_REQUIRED", message: "Select at least one study." } });
  const [first] = list as [CoreInputs, ...CoreInputs[]];
  if (list.length === 1) return first;

  // Questions and answers of every study, pooled. Studies on another
  // methodology version than the first combine a KPI only where its codes,
  // answer options and severities are unchanged; a changed KPI is kept apart
  // under its version and listed in a note (client, 15 Oct 2026).
  // One village across studies is one village (same governorate and name):
  // its label is set again over all the studies, so a name used in two
  // governorates carries its governorate in every study's rows.
  const villageByKey = new Map(list.flatMap((i) => i.villages).map((v) => [v.key, v]));
  const labels = villageLabels([...villageByKey.values()]);
  const relabel = (i: CoreInputs) => {
    const byOldLabel = new Map(i.villages.map((v) => [v.name, labels.get(v.key) ?? v.name]));
    return (name: string | null) => (name == null ? null : (byOldLabel.get(name) ?? name));
  };
  const relabelled = list.map((i) => {
    const to = relabel(i);
    return {
      ...i,
      answers: i.answers.map((a) => ({ ...a, village: to(a.village) })),
      responses: i.responses.map((r) => ({ ...r, villages: [...new Set(r.villages.map((v) => to(v)!))] })),
    };
  });
  const firstAnswers = relabelled[0]!.answers;
  const questions = new Map(first.questions);
  const answers = [...firstAnswers];
  const split = new Map<string, Set<string>>();
  const tag = (i: CoreInputs) => i.study.methodologyVersionLabel.split(/\s+/)[0] || i.study.methodologyVersionLabel;
  for (const inp of relabelled.slice(1)) {
    const sameVersion = inp.study.methodologyVersionId === first.study.methodologyVersionId;
    const changed = new Set<string>();
    if (!sameVersion) {
      for (const q of inp.questions.values()) {
        if (q.kpi && first.kpiSignature.get(q.kpi) !== inp.kpiSignature.get(q.kpi)) changed.add(q.kpi);
      }
    }
    const keyOf = (code: string) => `${code}@${inp.study.methodologyVersionId}`;
    for (const [code, q] of inp.questions) {
      if (q.kpi && changed.has(q.kpi)) questions.set(keyOf(code), { ...q, questionId: keyOf(code), kpi: `${q.kpi} (${tag(inp)})` });
      else if (!questions.has(code)) questions.set(code, q);
    }
    for (const a of inp.answers) {
      const kpi = inp.questions.get(a.questionId)?.kpi;
      answers.push(kpi && changed.has(kpi) ? { ...a, questionId: keyOf(a.questionId) } : a);
    }
    // Noted only where the KPI was actually answered in this study.
    const answered = new Set(inp.answers.map((a) => inp.questions.get(a.questionId)?.kpi).filter(Boolean) as string[]);
    for (const kpi of changed) {
      if (!answered.has(kpi)) continue;
      const versions = split.get(kpi) ?? new Set([tag(first)]);
      versions.add(tag(inp));
      split.set(kpi, versions);
    }
  }

  const sum = (xs: Array<number | null>): number | null => (xs.every((x) => x == null) ? null : xs.reduce<number>((a, b) => a + (b ?? 0), 0));
  const uniqBy = <T>(xs: T[], key: (x: T) => string): T[] => [...new Map(xs.map((x) => [key(x), x])).values()];
  const dates = (pick: (i: CoreInputs) => Date | null) => list.map(pick).filter((d): d is Date => !!d).map((d) => d.getTime());

  const profiles = new Map<string, AreaFigures>();
  for (const i of list) for (const [k, v] of i.profiles) if (!profiles.has(k)) profiles.set(k, v);

  const gapTypeBySurvey = new Map<string, string | null>();
  for (const i of list) for (const [k, v] of i.gapTypeBySurvey) gapTypeBySurvey.set(k, v);

  const from = dates((i) => i.collectedFrom);
  const to = dates((i) => i.collectedTo);
  const orgs = [...new Set(list.map((i) => i.study.organizationName).filter((x): x is string => !!x))];

  return {
    ...first,
    unit: first.unit.level === "VILLAGE" ? { ...first.unit, name: relabel(first)(first.unit.name) } : first.unit,
    outsideGeography: list.reduce((a, i) => a + i.outsideGeography, 0),
    study: {
      ...first.study,
      id: list.map((i) => i.study.id).join(","),
      title: list.map((i) => i.study.title).join(" · "),
      organizationName: orgs.join(" · ") || null,
      methodologyVersionLabel: [...new Set(list.map((i) => i.study.methodologyVersionLabel))].join(" · "),
      // The required sample of the pooled data, from the combined population
      // (same Cochran + finite-population rule as a single study).
      population: sum(list.map((i) => i.study.population)),
      requiredSampleSize: pooledRequired(list),
      minimumDetectableEffect: null,
    },
    survey: {
      ...first.survey,
      targetGroup: [...new Set(list.map((i) => i.survey.targetGroup).filter(Boolean))].join(" · ") || null,
      selectionApproach: [...new Set(list.map((i) => i.survey.selectionApproach).filter(Boolean))].join(" · ") || null,
    },
    surveyIds: [...new Set(list.flatMap((i) => i.surveyIds))],
    villages: [...villageByKey.values()]
      .map((v) => ({ ...v, name: labels.get(v.key) ?? v.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    governorates: uniqBy(list.flatMap((i) => i.governorates), (g) => g.id).sort((a, b) => a.name.localeCompare(b.name)),
    questions,
    answers,
    methodologySplit: [...split].map(([kpi, versions]) => ({ kpi, versions: [...versions] })),
    targetGroupBySurvey: new Map(list.flatMap((i) => [...i.targetGroupBySurvey])),
    gapTypeBySurvey,
    responses: uniqBy(relabelled.flatMap((i) => i.responses), (r) => r.id),
    needSources: [...new Set(list.flatMap((i) => i.needSources))],
    collectedFrom: from.length ? new Date(Math.min(...from)) : null,
    collectedTo: to.length ? new Date(Math.max(...to)) : null,
    profiles,
    // Initiatives on the same need across organisations are all "other
    // organisations" from NCNP's point of view.
    otherOrganisations: [...new Set(list.flatMap((i) => i.otherOrganisations))],
  };
}

function pooledRequired(list: CoreInputs[]): number | null {
  const pop = list.reduce<number | null>((a, i) => (i.study.population == null ? a : (a ?? 0) + i.study.population), null);
  if (!pop || !Number.isInteger(pop) || pop <= 0) {
    // No population on any study: fall back to the studies' own targets.
    const own = list.map((i) => i.study.requiredSampleSize).filter((x): x is number => x != null);
    return own.length ? own.reduce((a, b) => a + b, 0) : null;
  }
  const margin = list.find((i) => i.study.marginOfError != null)?.study.marginOfError ?? undefined;
  try {
    return calculateSampleSize(pop, margin).requiredSampleSize;
  } catch {
    return null;
  }
}
