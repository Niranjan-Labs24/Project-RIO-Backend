import { describe, expect, it } from 'vitest';
import {
  buildOciChatBody,
  extractOciText,
  isTruncated,
  toJsonSchema,
} from './oci-cohere.provider';
import { NEED_CLASSIFICATION_TASK } from './prompts/need-classification.task';
import { PDF_NEEDS_EXTRACTION_TASK } from './prompts/pdf-needs-extraction.task';
import type { AiTask } from './ai.task';

const OPTIONS = {
  compartmentId: 'ocid1.compartment.oc1..aaaa',
  modelId: 'cohere.command-a-03-2025',
  servingType: 'ON_DEMAND' as const,
  maxTokens: 4000,
};

describe('toJsonSchema', () => {
  it('lower-cases Gemini type names', () => {
    expect(toJsonSchema({ type: 'OBJECT' })).toEqual({ type: 'object' });
    expect(toJsonSchema({ type: 'STRING' })).toEqual({ type: 'string' });
    expect(toJsonSchema({ type: 'NUMBER' })).toEqual({ type: 'number' });
    expect(toJsonSchema({ type: 'BOOLEAN' })).toEqual({ type: 'boolean' });
    expect(toJsonSchema({ type: 'ARRAY' })).toEqual({ type: 'array' });
    expect(toJsonSchema({ type: 'INTEGER' })).toEqual({ type: 'integer' });
  });

  it('converts nested properties and array items', () => {
    expect(
      toJsonSchema({
        type: 'OBJECT',
        properties: {
          needs: {
            type: 'ARRAY',
            items: { type: 'OBJECT', properties: { title: { type: 'STRING' } } },
          },
        },
        required: ['needs'],
      }),
    ).toEqual({
      type: 'object',
      properties: {
        needs: {
          type: 'array',
          items: { type: 'object', properties: { title: { type: 'string' } } },
        },
      },
      required: ['needs'],
    });
  });

  it('keeps required and description untouched', () => {
    const out = toJsonSchema({
      type: 'OBJECT',
      description: 'A need',
      properties: { a: { type: 'STRING' } },
      required: ['a'],
    }) as Record<string, unknown>;
    expect(out.description).toBe('A need');
    expect(out.required).toEqual(['a']);
  });

  it('folds Gemini nullable into a JSON Schema type union', () => {
    expect(toJsonSchema({ type: 'STRING', nullable: true })).toEqual({
      type: ['string', 'null'],
    });
  });

  it('drops propertyOrdering, which is a Gemini-only hint', () => {
    const out = toJsonSchema({
      type: 'OBJECT',
      properties: { a: { type: 'STRING' } },
      propertyOrdering: ['a'],
    }) as Record<string, unknown>;
    expect(out).not.toHaveProperty('propertyOrdering');
  });

  it('passes unknown constraints through rather than silently dropping them', () => {
    // Dropping a constraint would loosen the contract with nobody noticing;
    // passing it through at worst makes OCI reject the request loudly.
    const out = toJsonSchema({ type: 'NUMBER', minimum: 0, maximum: 1 }) as Record<string, unknown>;
    expect(out).toEqual({ type: 'number', minimum: 0, maximum: 1 });
  });

  it('leaves an already lower-case schema alone', () => {
    expect(toJsonSchema({ type: 'object', properties: { a: { type: 'string' } } })).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
    });
  });

  it('handles primitives and arrays at the top level', () => {
    expect(toJsonSchema(null)).toBeNull();
    expect(toJsonSchema('x')).toBe('x');
    expect(toJsonSchema([{ type: 'STRING' }])).toEqual([{ type: 'string' }]);
  });
});

describe('toJsonSchema against the real task schemas', () => {
  // Every task schema must come out with no upper-case type left anywhere,
  // otherwise OCI rejects the request at run time and only that one AI
  // feature breaks — the kind of thing a unit test should catch first.
  const TASKS: Array<AiTask<unknown>> = [NEED_CLASSIFICATION_TASK, PDF_NEEDS_EXTRACTION_TASK];

  it.each(TASKS.map((t) => [t.name, t] as const))(
    'leaves no upper-case type in %s',
    (_name, task) => {
      const json = JSON.stringify(toJsonSchema(task.responseSchema));
      expect(json).not.toMatch(/"type":"(OBJECT|STRING|NUMBER|BOOLEAN|ARRAY|INTEGER)"/);
      expect(json).toMatch(/"type":"object"/);
    },
  );
});

describe('buildOciChatBody', () => {
  it('wraps the prompt in the compartment and serving-mode envelope', () => {
    const body = buildOciChatBody(NEED_CLASSIFICATION_TASK, 'a need statement', OPTIONS);

    expect(body.compartmentId).toBe(OPTIONS.compartmentId);
    expect(body.servingMode).toEqual({
      servingType: 'ON_DEMAND',
      modelId: 'cohere.command-a-03-2025',
    });
  });

  it('sends the system prompt as preambleOverride and the user text as message', () => {
    const body = buildOciChatBody(NEED_CLASSIFICATION_TASK, 'a need statement', OPTIONS);
    const chat = body.chatRequest as Record<string, unknown>;

    expect(chat.apiFormat).toBe('COHERE');
    expect(chat.message).toBe('a need statement');
    expect(chat.preambleOverride).toBe(NEED_CLASSIFICATION_TASK.systemPrompt);
  });

  it("carries the task's temperature through, so a deterministic task stays deterministic", () => {
    const body = buildOciChatBody(NEED_CLASSIFICATION_TASK, 'x', OPTIONS);
    const chat = body.chatRequest as Record<string, unknown>;
    expect(NEED_CLASSIFICATION_TASK.temperature).toBe(0);
    expect(chat.temperature).toBe(0);
  });

  it('asks Cohere to enforce the converted schema', () => {
    const body = buildOciChatBody(NEED_CLASSIFICATION_TASK, 'x', OPTIONS);
    const chat = body.chatRequest as Record<string, unknown>;
    const responseFormat = chat.responseFormat as Record<string, unknown>;

    expect(responseFormat.type).toBe('JSON_OBJECT');
    expect(responseFormat.schema).toEqual(toJsonSchema(NEED_CLASSIFICATION_TASK.responseSchema));
  });
});

describe('extractOciText', () => {
  it('reads the documented chatResponse.text shape', () => {
    expect(extractOciText({ chatResponse: { text: '{"ok":true}' } })).toBe('{"ok":true}');
  });

  it('also accepts an unwrapped text field', () => {
    // Tolerating both shapes costs one `??` and stops an envelope change
    // from turning every AI feature off at once.
    expect(extractOciText({ text: '{"ok":true}' })).toBe('{"ok":true}');
  });

  it('returns null when there is no usable text', () => {
    expect(extractOciText({})).toBeNull();
    expect(extractOciText({ chatResponse: {} })).toBeNull();
    expect(extractOciText({ chatResponse: { text: '' } })).toBeNull();
    expect(extractOciText(null)).toBeNull();
    expect(extractOciText({ chatResponse: { text: 42 } })).toBeNull();
  });
});

describe('isTruncated', () => {
  it('flags a response cut off at the token cap', () => {
    expect(isTruncated({ chatResponse: { finishReason: 'MAX_TOKENS' } })).toBe(true);
    expect(isTruncated({ finishReason: 'max_tokens' })).toBe(true);
  });

  it('does not flag a complete response', () => {
    expect(isTruncated({ chatResponse: { finishReason: 'COMPLETE' } })).toBe(false);
    expect(isTruncated({})).toBe(false);
    expect(isTruncated(null)).toBe(false);
  });
});
