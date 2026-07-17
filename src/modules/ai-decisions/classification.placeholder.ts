// RIO-NFR-002: strip PII before anything is handed to a model (placeholder
// or real). Name/phone/email are redacted here, in code — never enforced
// via a schema column.
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const PHONE_RE = /(\+?\d[\d\-\s]{7,}\d)/g;

export interface ClassificationSubject {
  statement: string;
  village: string[];
}

// A single Need can classify into more than one domain/sub-domain at once
// (per Ganesh) — this is NOT multiple Needs, just multiple AI suggestions
// against the one Need. `domains`/`subDomains` are therefore always arrays,
// even though the placeholder below only ever populates one entry each.
export interface ClassificationSuggestion {
  domains: string[];
  subDomains: string[];
  rationale: string;
  redactedStatement: string;
  village: string;
}

export interface ClassificationResult {
  modelName: string;
  modelVersion: string;
  suggestion: ClassificationSuggestion;
  confidence: number;
}

function redactPii(text: string): string {
  return text.replace(EMAIL_RE, '[redacted-email]').replace(PHONE_RE, '[redacted-phone]');
}

// TODO(RIO-FR-003):
// Replace placeholder classification with actual AI classification
// after business rules and LLM integration are finalized.
export function classifyNeed(subject: ClassificationSubject): ClassificationResult {
  const redactedStatement = redactPii(subject.statement);
  return {
    modelName: 'placeholder-classifier',
    modelVersion: '0.1.0',
    suggestion: {
      domains: ['Uncategorized'],
      subDomains: ['Uncategorized'],
      rationale: 'Placeholder classification pending business rules and LLM integration.',
      redactedStatement,
      village: subject.village.join(', '),
    },
    confidence: 0,
  };
}
