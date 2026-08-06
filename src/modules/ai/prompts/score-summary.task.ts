import type { AiTask } from '../ai.task';
import { PRIORITY_DASHBOARD_SUMMARY_RESPONSE_SCHEMA } from './priority-dashboard-summary.system';
import {
  VILLAGE_REPORT_SUMMARY_PROMPT_VERSION,
  VILLAGE_REPORT_SUMMARY_SYSTEM_PROMPT,
} from './village-report-summary.system';
import {
  SECTOR_REPORT_SUMMARY_PROMPT_VERSION,
  SECTOR_REPORT_SUMMARY_SYSTEM_PROMPT,
} from './sector-report-summary.system';
import {
  REGION_REPORT_SUMMARY_PROMPT_VERSION,
  REGION_REPORT_SUMMARY_SYSTEM_PROMPT,
} from './region-report-summary.system';
import {
  EXECUTIVE_REPORT_SUMMARY_PROMPT_VERSION,
  EXECUTIVE_REPORT_SUMMARY_SYSTEM_PROMPT,
} from './executive-report-summary.system';

export type ScoreSummaryScope = 'VILLAGE' | 'SECTOR' | 'REGION' | 'EXECUTIVE';

/**
 * Shared model settings for the four score-based summary scopes.
 *
 * These prompts carry an entire ReportData snapshot, so they need a far longer
 * timeout than classification. Temperature stays low: the narrative must restate
 * supplied figures, never reinterpret them, and a low setting keeps it close to
 * the source. Only one retry — a caller is waiting on a slow request already.
 */
const SCORE_SUMMARY_MODEL_SETTINGS = {
  model: 'gemini-2.5-flash',
  modelVersion: 'v1',
  temperature: 0.2,
  timeoutMs: 90_000,
  maxRetries: 1,
  responseSchema: PRIORITY_DASHBOARD_SUMMARY_RESPONSE_SCHEMA as Record<string, unknown>,
} as const;

/**
 * One task per reporting scope. The scopes differ only in prompt text and
 * version — the narrative each produces is scoped differently (a single village
 * versus a whole region), so they must stay separately versioned.
 */
export const SCORE_SUMMARY_TASKS: Record<ScoreSummaryScope, AiTask<Record<string, unknown>>> = {
  VILLAGE: {
    ...SCORE_SUMMARY_MODEL_SETTINGS,
    name: 'score-summary-village',
    promptVersion: VILLAGE_REPORT_SUMMARY_PROMPT_VERSION,
    systemPrompt: VILLAGE_REPORT_SUMMARY_SYSTEM_PROMPT,
  },
  SECTOR: {
    ...SCORE_SUMMARY_MODEL_SETTINGS,
    name: 'score-summary-sector',
    promptVersion: SECTOR_REPORT_SUMMARY_PROMPT_VERSION,
    systemPrompt: SECTOR_REPORT_SUMMARY_SYSTEM_PROMPT,
  },
  REGION: {
    ...SCORE_SUMMARY_MODEL_SETTINGS,
    name: 'score-summary-region',
    promptVersion: REGION_REPORT_SUMMARY_PROMPT_VERSION,
    systemPrompt: REGION_REPORT_SUMMARY_SYSTEM_PROMPT,
  },
  EXECUTIVE: {
    ...SCORE_SUMMARY_MODEL_SETTINGS,
    name: 'score-summary-executive',
    promptVersion: EXECUTIVE_REPORT_SUMMARY_PROMPT_VERSION,
    systemPrompt: EXECUTIVE_REPORT_SUMMARY_SYSTEM_PROMPT,
  },
};
