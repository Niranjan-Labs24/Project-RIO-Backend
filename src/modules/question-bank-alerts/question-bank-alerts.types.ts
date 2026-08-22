// "reactivated" isn't distinguishable from a plain "edited" from the pending
// row alone (both carry isActive:true, deactivatedAt:null) — not worth an
// extra lookup for a case nobody asked to be alerted on; it just reads as
// "edited", which is accurate as far as it goes.
export type QuestionBankAlertChangeKind = "created" | "edited" | "deactivated";

export interface QuestionBankAlert {
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
