export type NeedStatus =
  | 'draft'
  | 'pending_ai_classification'
  | 'evidence_submitted'
  | 'ai_classified'
  | 'ai_classification_failed'
  | 'reviewer_approved'
  | 'survey_created'
  | 'survey_published';

// RIO-FR-001: system-assigned only — see NeedsService.create /
// NeedsImportService, never accepted from the client (not in
// CreateNeedPayload/UpdateNeedPayload below).
export type NeedSource = 'manual_entry' | 'file_upload' | 'citizen_input' | 'field_survey';

export interface NeedRow {
  id: string;
  studyId: string;
  orgId: string;
  title: string;
  statement: string;
  village: string[];
  governorateIds: string[];
  centerIds: string[];
  source: NeedSource;
  referenceId: string | null;
  status: NeedStatus;
  domain: string | null;
  subDomain: string | null;
  aiSuggestedDomain: string | null;
  aiSuggestedSubDomain: string | null;
  classifiedAt: Date | null;
  classificationError: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Need {
  id: string;
  studyId: string;
  title: string;
  statement: string;
  village: string[];
  // Optional link into the KSA Geographic Reference master data — additive
  // alongside `village`, not a replacement. Multi-select Governorates and
  // Centers (see NeedGovernorate/NeedCenter join tables) — a single Need
  // can span multiple geographic areas. Both must be a subset of the
  // owning Study's own selected governorateIds/centerIds — checked in
  // NeedsService, not enforceable by the FK alone. No Region field —
  // derived live from the owning Organization's own single regionId.
  governorateIds: string[];
  centerIds: string[];
  source: NeedSource;
  referenceId: string | null;
  status: NeedStatus;
  // No longer set at creation — AI Classification runs automatically right
  // after a Need is saved (see NeedsService.create /
  // AiDecisionsService.classifyAutomatically). domain/subDomain are the
  // Approver's final ("Approved") decision, written only by
  // AiDecisionsService.review — never equal to aiSuggestedDomain by
  // construction once an override happens.
  domain: string | null;
  subDomain: string | null;
  // AI Classification's own original suggestion — written once when
  // classification completes and never overwritten again, including on
  // Approver override, so it always reflects what the AI actually
  // predicted. See AiDecisionsService.classifyAutomatically/review.
  aiSuggestedDomain: string | null;
  aiSuggestedSubDomain: string | null;
  classifiedAt: string | null;
  classificationError: string | null;
  createdBy: string;
  // Resolved display name for Entered By — null if the creating user has
  // since been removed (e.g. no self-org lookup for a deleted account).
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateNeedPayload {
  // Optional — see NeedsService.create()'s fallback-title derivation.
  title?: string;
  statement: string;
  village?: string[];
  governorateIds?: string[];
  centerIds?: string[];
  referenceId?: string;
}

export interface UpdateNeedPayload {
  title?: string;
  statement?: string;
  village?: string[];
  governorateIds?: string[];
  centerIds?: string[];
  referenceId?: string | null;
}

// A Need is editable up through classification being attempted, but NOT
// once ai_classified — editing the Statement/Governorates/Centers after a
// classification has run would leave that classification stale against
// changed input. To edit an ai_classified (or later) Need, an Approver
// must first Reject it on the AI Review screen, which resets status back
// to pending_ai_classification (see AiDecisionsService's reject handling)
// so a fresh classification runs against the edited Need.
export const NEED_EDITABLE_STATUSES: readonly NeedStatus[] = [
  'draft',
  'pending_ai_classification',
  'ai_classification_failed',
];

// Evidence gets its own, slightly wider window than the Need's own
// Statement/Governorates/Centers: classification never reads evidence
// content (the Statement is always the sole classification input — see
// AiDecisionsService), so attaching/removing a file after classification
// completes doesn't invalidate anything already computed, unlike editing
// the Need itself. Also closes a real race: classification is triggered
// automatically, server-side, the instant a Need is created — if evidence
// upload were gated on NEED_EDITABLE_STATUSES (which excludes
// ai_classified), a fast classification could flip the Need to
// ai_classified before the frontend's post-create evidence upload calls
// even land, silently rejecting them. Locks only once reviewer_approved+ —
// once an Approver has actually acted on this Need.
export const EVIDENCE_EDITABLE_STATUSES: readonly NeedStatus[] = [
  ...NEED_EDITABLE_STATUSES,
  'ai_classified',
];
