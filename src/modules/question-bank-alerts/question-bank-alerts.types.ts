// "reactivated" isn't distinguishable from a plain "edited" from the pending
// row alone (both carry isActive:true, deactivatedAt:null) — not worth an
// extra lookup for a case nobody asked to be alerted on; it just reads as
// "edited", which is accurate as far as it goes.
export type QuestionBankAlertChangeKind = "created" | "edited" | "deactivated";

export interface QuestionBankPendingAlert {
  id: string;
  type: "question_pending_approval";
  changeKind: QuestionBankAlertChangeKind;
  questionRowId: string;
  questionId: string;
  questionText: string;
  domain: string;
  subDomain: string;
  submittedAt: string;
}

// The reverse direction — a System Admin's own submitted change has been
// resolved. Only shown to the admin who submitted it (submittedBy), so it
// reads as "your change was decided", not a general audit feed.
export interface QuestionBankResolvedAlert {
  id: string;
  type: "question_resolved";
  resolution: "approved" | "rejected";
  questionRowId: string;
  questionId: string;
  questionText: string;
  domain: string;
  subDomain: string;
  reviewedAt: string;
  rejectionReason: string | null;
}

export type QuestionBankAlert = QuestionBankPendingAlert | QuestionBankResolvedAlert;
