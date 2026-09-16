import type { SummaryWarning } from './need-summary.verify';

/**
 * Which entry point produced the Need being summarised (RIO-AI-003 covers all
 * of them, per the client's 25 Aug 2026 answer).
 *
 * The first four mirror NeedSource's vocabulary so a report can group on this
 * column without a translation table. `manual_regenerate` is the fifth and is
 * deliberately NOT a NeedSource value: it records that a human asked for this
 * particular summary, which is a different fact from where the Need came from.
 */
export type NeedSummaryTriggerSource =
  | "manual_entry"
  | "bulk_import"
  | "pdf_import"
  | "citizen_input"
  | "manual_regenerate";

/** DRAFT awaits review · CONFIRMED is the live one · SUPERSEDED was replaced by
 *  a newer summary · STALE means the underlying statement changed after it was
 *  decided. Only CONFIRMED reaches reports. */
export type NeedSummaryStatus = "DRAFT" | "CONFIRMED" | "SUPERSEDED" | "STALE";

export interface NeedSummary {
  id: string;
  needId: string;
  studyId: string;
  /** Populated only by the reviewer-queue read, which joins it for display. */
  needTitle: string | null;
  status: NeedSummaryStatus;
  promptVersion: string;
  modelName: string;
  /** The AC's "original full text remains accessible alongside the summary" —
   *  returned on every read rather than behind a second request. */
  sourceStatement: string;
  sourceLength: number;
  /** The model's own output. Never overwritten by an edit. */
  aiSummaryText: string;
  /** Null means the reviewer never edited it — which is itself a decision, and
   *  must stay distinguishable from an edit that produced the same string. */
  reviewerEditedText: string | null;
  /** What a consumer should display. Resolved server-side so every caller
   *  applies the same AI-vs-edited precedence. */
  effectiveText: string;
  wasEdited: boolean;
  triggerSource: NeedSummaryTriggerSource;
  /** AC 5's mechanical checks — see need-summary.verify.ts. Empty is normal.
   *  Non-empty means the reviewer should read this one against its source
   *  before confirming, not that the summary is necessarily wrong. */
  verificationWarnings: SummaryWarning[];
  generatedAt: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
}
