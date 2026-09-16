/**
 * Runs every production AiTask through the configured provider.
 *
 *   npm run ai:oci-tasks
 *
 * The smoke test proves the tenancy works with a toy schema. This proves
 * the real tasks work: their own prompts, their own converted schemas,
 * their own temperatures, through AiService itself — so a schema the
 * converter mangles, or a prompt the model answers in prose, shows up here
 * rather than in front of a user.
 *
 * Coverage matters most for the four score-summary scopes and the combined
 * report, because their schemas use Gemini's `nullable: true`, which has no
 * JSON Schema equivalent as a sibling key and is rewritten into a
 * `["number","null"]` type union. That rewrite is only really proven by the
 * model accepting it.
 *
 * Read-only: no database, no writes. Costs a handful of short on-demand
 * calls.
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { ConfigService } from '../src/config/config.service';
import { AiService } from '../src/modules/ai/ai.service';
import { COMBINED_REPORT_SUMMARY_TASK } from '../src/modules/ai/prompts/combined-report-summary.task';
import { EVIDENCE_DOCUMENT_SUMMARY_TASK } from '../src/modules/ai/prompts/evidence-document-summary.task';
import { NEED_CLASSIFICATION_TASK } from '../src/modules/ai/prompts/need-classification.task';
import { NEED_STATEMENT_SUMMARY_TASK } from '../src/modules/ai/prompts/need-statement-summary.task';
import { NEED_THEME_EXTRACTION_TASK } from '../src/modules/ai/prompts/need-theme-extraction.task';
import { PDF_NEEDS_EXTRACTION_TASK } from '../src/modules/ai/prompts/pdf-needs-extraction.task';
import { SCORE_SUMMARY_TASKS } from '../src/modules/ai/prompts/score-summary.task';
import { SURVEY_NEEDS_EXTRACTION_TASK } from '../src/modules/ai/prompts/survey-needs-extraction.task';
import { SURVEY_QUESTION_RECOMMENDATION_TASK } from '../src/modules/ai/prompts/survey-question-recommendation.task';
import {
  INDIVIDUAL_SURVEY_SUMMARY_RESPONSE_SCHEMA,
  INDIVIDUAL_SURVEY_SUMMARY_SYSTEM_PROMPT,
} from '../src/modules/ai/prompts/individual-survey-summary.system';
import type { AiTask } from '../src/modules/ai/ai.task';

const DOMAINS = JSON.stringify([
  {
    name: 'Health',
    subDomains: [{ name: 'Access to Basic Healthcare' }, { name: 'Maternal Health' }],
  },
  { name: 'Water & Sanitation', subDomains: [{ name: 'Drinking Water' }] },
  { name: 'Education', subDomains: [{ name: 'School Infrastructure' }] },
]);

const WATER_NEED =
  'The village has no clean drinking water during the summer months; families walk 4km ' +
  'to the next well.';

// Stands in for the task report-summary.service.ts builds inline for a
// single survey — same system prompt and schema, so the conversion path is
// identical to production.
const INDIVIDUAL_SURVEY_SUMMARY_TASK: AiTask<Record<string, unknown>> = {
  name: 'individual-survey-summary',
  promptVersion: 'probe',
  systemPrompt: INDIVIDUAL_SURVEY_SUMMARY_SYSTEM_PROMPT,
  model: 'gemini-2.5-flash',
  modelVersion: 'v1',
  temperature: 0.2,
  timeoutMs: 90_000,
  maxRetries: 1,
  responseSchema: INDIVIDUAL_SURVEY_SUMMARY_RESPONSE_SCHEMA as Record<string, unknown>,
};

const SCORE_CONTEXT = JSON.stringify({
  scope: 'VILLAGE',
  villageName: 'Al Rawdah',
  cycleNumber: 1,
  domains: [
    { domain: 'Water & Sanitation', kpi: 'Drinking water availability', severityScore: 78, performanceScore: 22 },
    { domain: 'Education', kpi: 'School infrastructure', severityScore: 54, performanceScore: 46 },
    { domain: 'Health', kpi: 'Access to basic healthcare', severityScore: 66, performanceScore: 34 },
  ],
  priorityLevel: 'HIGH',
  criticalPerformanceThreshold: 20,
});

/** A check is a task, an input, and what a usable answer looks like. */
interface Check {
  task: AiTask<unknown>;
  label?: string;
  prompt: string;
  expect: (r: unknown) => string;
}

/** Passes when at least one non-empty string field came back. */
function hasProse(r: unknown): string {
  const values = Object.values((r ?? {}) as Record<string, unknown>);
  const text = values.find((v) => typeof v === 'string' && v.trim().length > 10);
  if (typeof text === 'string') return `"${text.replace(/\s+/g, ' ').slice(0, 80)}…"`;
  const nested = values.find((v) => Array.isArray(v) && v.length > 0);
  if (Array.isArray(nested)) return `${nested.length} item(s) returned`;
  return `FAIL — no usable text: ${JSON.stringify(r).slice(0, 140)}`;
}

/** Passes when the named field is an array, reporting its length. */
function hasArray(field: string): (r: unknown) => string {
  return (r) => {
    const v = (r as Record<string, unknown> | null)?.[field];
    return Array.isArray(v)
      ? `${field}: ${v.length} item(s)`
      : `FAIL — ${field} is not an array: ${JSON.stringify(v)}`;
  };
}

const CHECKS: Check[] = [
  {
    task: NEED_CLASSIFICATION_TASK,
    label: 'classify a real need',
    prompt: `Available domains: ${DOMAINS}\n\nNeed statement: "${WATER_NEED}"`,
    expect: (r) => {
      const v = r as { classified?: boolean; domain?: string; confidence?: number };
      if (v.classified !== true) return `FAIL — expected classified=true, got ${String(v.classified)}`;
      if (typeof v.confidence !== 'number') return 'FAIL — confidence missing';
      return `domain=${v.domain} confidence=${v.confidence}`;
    },
  },
  {
    task: NEED_CLASSIFICATION_TASK,
    label: 'decline gibberish',
    prompt: `Available domains: ${DOMAINS}\n\nNeed statement: "asdkjh qwe zzz"`,
    expect: (r) => {
      const v = r as { classified?: boolean };
      return v.classified === false
        ? 'declined, as required'
        : `FAIL — should have declined, got classified=${String(v.classified)}`;
    },
  },
  {
    task: NEED_THEME_EXTRACTION_TASK,
    prompt: `Need: "${WATER_NEED} Children miss school carrying water."`,
    expect: hasArray('themes'),
  },
  {
    task: NEED_STATEMENT_SUMMARY_TASK,
    prompt:
      'Need statement: "During the summer months the village water supply becomes ' +
      'unreliable. Families, mostly women and children, walk about 4km each way to the ' +
      'nearest functioning well. Children frequently miss school as a result, and there ' +
      'have been several cases of heat exhaustion reported by the local clinic."',
    expect: hasProse,
  },
  {
    task: PDF_NEEDS_EXTRACTION_TASK,
    prompt:
      'MANDATORY REQUIREMENT: EXTRACT EACH PROBLEM STATEMENT AS A SEPARATE STANDALONE NEED ITEM. ' +
      'NEVER COMBINE PROBLEMS.\n\nDocument Content:\n' +
      'Village Assessment — Al Rawdah, 2022\n\n' +
      '1. Drinking water is unavailable for three months each summer.\n' +
      '2. The primary school roof leaks during rain and two classrooms are unusable.\n' +
      '3. The nearest clinic is 40km away and there is no ambulance service.\n',
    expect: hasArray('needs'),
  },
  {
    task: SURVEY_NEEDS_EXTRACTION_TASK,
    prompt:
      'Survey results for Al Rawdah:\n' +
      'Q: Is drinking water available year round? — 42 of 50 households answered No.\n' +
      'Q: Distance to nearest water point? — average 3.8km.\n' +
      'Q: Do children miss school to collect water? — 31 of 50 answered Yes.\n' +
      'Q: Is there a functioning clinic within 10km? — 48 of 50 answered No.\n',
    expect: hasArray('needs'),
  },
  {
    task: SURVEY_QUESTION_RECOMMENDATION_TASK,
    prompt:
      'Need: "' + WATER_NEED + '"\nDomain: Water & Sanitation\n\n' +
      'Eligible questions:\n' +
      '[{"id":"q-101","text":"How many months per year is drinking water unavailable?"},' +
      '{"id":"q-102","text":"What is the distance to the nearest water point?"},' +
      '{"id":"q-103","text":"How many teachers are employed at the school?"},' +
      '{"id":"q-104","text":"Who collects water for the household?"}]',
    expect: (r) => {
      const v = r as { recommendedQuestionIds?: unknown; confidence?: number };
      if (!Array.isArray(v.recommendedQuestionIds)) {
        return `FAIL — recommendedQuestionIds is not an array: ${JSON.stringify(v.recommendedQuestionIds)}`;
      }
      const ids = v.recommendedQuestionIds as string[];
      const invented = ids.filter((id) => !['q-101', 'q-102', 'q-103', 'q-104'].includes(id));
      if (invented.length > 0) return `FAIL — invented question ids: ${invented.join(', ')}`;
      return `picked ${ids.join(', ')} (confidence ${v.confidence})`;
    },
  },
  {
    task: EVIDENCE_DOCUMENT_SUMMARY_TASK,
    prompt:
      'Document: "Al Rawdah Water Assessment, ref WA-2022-014, collected March 2022.\n' +
      'Section 2: 84% of surveyed households reported no piped water during June-August.\n' +
      'Section 3: The single functioning well serves an estimated 1,200 people.\n' +
      'Section 4: The clinic recorded 23 heat-exhaustion cases in summer 2021."',
    expect: hasProse,
  },
  {
    // nullable: true in the schema — the type-union rewrite is exercised here.
    task: COMBINED_REPORT_SUMMARY_TASK,
    prompt: `Report context:\n${SCORE_CONTEXT}`,
    expect: hasProse,
  },
  {
    task: INDIVIDUAL_SURVEY_SUMMARY_TASK,
    prompt: `Survey context:\n${SCORE_CONTEXT}`,
    expect: hasProse,
  },
  // All four score-summary scopes share the nullable-heavy priority
  // dashboard schema but have different system prompts, so each is its own
  // check rather than one standing in for the rest.
  ...(['VILLAGE', 'SECTOR', 'REGION', 'EXECUTIVE'] as const).map((scope) => ({
    task: SCORE_SUMMARY_TASKS[scope],
    prompt: `Scoring context:\n${SCORE_CONTEXT}`,
    expect: hasProse,
  })),
];

async function main(): Promise<void> {
  const config = new ConfigService();
  const ai = new AiService(config);

  console.log(`provider: ${config.aiProvider}`);
  console.log(
    config.aiProvider === 'oci_cohere'
      ? `model:    ${config.ociGenAiModelId} @ ${config.ociGenAiRegion}\n`
      : 'model:    gemini (per task)\n',
  );

  let failures = 0;
  for (const { task, label, prompt, expect } of CHECKS) {
    const name = label ? `${task.name} (${label})` : task.name;
    const started = Date.now();
    try {
      const { response } = await ai.run(task, prompt);
      const verdict = expect(response);
      const failed = verdict.startsWith('FAIL');
      if (failed) failures++;
      console.log(
        `${failed ? '✗' : '✓'} ${name.padEnd(42)} ${String(Date.now() - started).padStart(6)}ms  ${verdict}`,
      );
    } catch (err) {
      failures++;
      console.log(
        `✗ ${name.padEnd(42)} ${String(Date.now() - started).padStart(6)}ms  ERROR ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  console.log(
    `\n${failures === 0 ? `✓ all ${CHECKS.length} task checks passed` : `✗ ${failures} of ${CHECKS.length} failed`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
