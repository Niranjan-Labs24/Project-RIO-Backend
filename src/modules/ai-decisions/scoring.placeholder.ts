import type { ScoringStubResponse } from './ai-decisions.types';

// TODO(RIO-FR-003):
// Replace scoring stub with rule-based scoring engine once
// methodology formulas are approved.
export function scoreStub(): ScoringStubResponse {
  return {
    status: 'pending',
    message: 'Scoring engine will be implemented after business rules are finalized.',
  };
}
