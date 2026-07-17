export interface SurveyDefinitionQuestion {
  code: string;
  text: string;
  type: 'text' | 'single_choice' | 'multi_choice' | 'scale';
  options?: string[];
  required: boolean;
}

export interface SurveyDefinition {
  studyId: string;
  title: string;
  version: string;
  questions: SurveyDefinitionQuestion[];
}

// TODO(RIO-Add-Survey-Builder): Survey Builder doesn't exist yet — this
// placeholder is the Survey Definition Service's only implementation until
// it ships. Publish Survey/QR and the citizen submission flow are its only
// consumers; once Survey Builder lands, only this function's body changes
// (real per-Study questions instead of this fixed seed set) — no contract
// change, no caller change. Deliberately NOT sourced from
// question-bank-v1.json — that dataset belongs to the separately-owned
// Question Bank/Survey Builder module, not this temporary stand-in (see
// the plan's "Question Bank baseline" scoping rule).
export function getSurveyDefinition(studyId: string): SurveyDefinition {
  return {
    studyId,
    title: 'Community Needs Survey (placeholder)',
    version: 'placeholder-0.1.0',
    questions: [
      { code: 'Q1', text: 'What is the most pressing need in your community right now?', type: 'text', required: true },
      {
        code: 'Q2',
        text: 'How would you rate access to this service today?',
        type: 'scale',
        options: ['1', '2', '3', '4', '5'],
        required: true,
      },
      {
        code: 'Q3',
        text: 'Which of the following best describes the affected area?',
        type: 'single_choice',
        options: ['Urban', 'Peri-urban', 'Rural'],
        required: false,
      },
      { code: 'Q4', text: 'Any additional comments?', type: 'text', required: false },
    ],
  };
}
