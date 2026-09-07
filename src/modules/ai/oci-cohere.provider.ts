import type { AiTask } from './ai.task';

/**
 * Cohere Command A on OCI Generative AI.
 *
 * Two things differ from Gemini and are the reason this file exists:
 *
 *  1. **Schema dialect.** Every AiTask declares `responseSchema` in Gemini's
 *     dialect, which spells types in upper case (`OBJECT`, `STRING`). OCI
 *     wants a standard JSON Schema, which spells them in lower case. The
 *     tasks are the reviewed, stable part of the system, so the conversion
 *     happens here rather than by rewriting nine prompt files into a
 *     provider-specific dialect.
 *
 *  2. **Envelope.** OCI wraps the model call in a compartment + serving-mode
 *     envelope, and the system prompt is `preambleOverride` rather than a
 *     separate `systemInstruction` object.
 *
 * Auth is a plain bearer token — the `sk-...` service API key, not the key's
 * OCID, and not OCI request signing.
 */

/** Gemini's upper-case type names mapped to their JSON Schema equivalents. */
const TYPE_MAP: Record<string, string> = {
  OBJECT: 'object',
  STRING: 'string',
  NUMBER: 'number',
  INTEGER: 'integer',
  BOOLEAN: 'boolean',
  ARRAY: 'array',
  NULL: 'null',
};

/**
 * Rewrites a Gemini-dialect response schema as standard JSON Schema.
 *
 * Only the constructs the tasks actually use are translated — `type`,
 * `properties`, `items`, `required`, `description`, `enum`. An unrecognised
 * key is passed through untouched rather than dropped: silently discarding a
 * constraint would loosen the contract without anyone noticing, whereas
 * passing it through at worst makes OCI reject the request loudly.
 *
 * Gemini's `nullable: true` has no JSON Schema equivalent as a sibling key,
 * so it becomes a `["<type>", "null"]` union.
 */
export function toJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toJsonSchema);
  if (schema === null || typeof schema !== 'object') return schema;

  const source = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (key === 'type' && typeof value === 'string') {
      out.type = TYPE_MAP[value] ?? value.toLowerCase();
      continue;
    }
    if (key === 'nullable') continue; // folded into `type` below
    if (key === 'propertyOrdering') continue; // Gemini-only hint, not a constraint
    if (key === 'properties' && value !== null && typeof value === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, sub]) => [
          name,
          toJsonSchema(sub),
        ]),
      );
      continue;
    }
    out[key] = toJsonSchema(value);
  }

  if (source.nullable === true && typeof out.type === 'string') {
    out.type = [out.type, 'null'];
  }
  return out;
}

export interface OciCohereRequestOptions {
  compartmentId: string;
  modelId: string;
  servingType: 'ON_DEMAND' | 'DEDICATED';
  maxTokens: number;
}

/** The request body for POST /20231130/actions/chat. */
export function buildOciChatBody(
  task: AiTask<unknown>,
  prompt: string,
  options: OciCohereRequestOptions,
): Record<string, unknown> {
  return {
    compartmentId: options.compartmentId,
    servingMode: {
      servingType: options.servingType,
      modelId: options.modelId,
    },
    chatRequest: {
      apiFormat: 'COHERE',
      message: prompt,
      // Cohere's own name for a system prompt.
      preambleOverride: task.systemPrompt,
      temperature: task.temperature,
      maxTokens: options.maxTokens,
      // Cohere enforces the schema, so the model cannot return prose where
      // the task expects an object.
      responseFormat: {
        type: 'JSON_OBJECT',
        schema: toJsonSchema(task.responseSchema),
      },
    },
  };
}

/** The slice of OCI's ChatResult this code reads. */
interface OciChatResult {
  modelId?: string;
  modelVersion?: string;
  chatResponse?: {
    text?: string;
    finishReason?: string;
  };
  // Some OCI responses are not wrapped; see extractOciText.
  text?: string;
  finishReason?: string;
}

/**
 * Pulls the generated text out of an OCI chat result.
 *
 * The documented shape is `{ chatResponse: { text } }`, but the unwrapped
 * `{ text }` form is accepted too: an envelope change would otherwise turn
 * every AI feature off at once, and tolerating both costs one `??`.
 *
 * Returns null when there is no text, so the caller can raise its own error
 * with the task name attached.
 */
export function extractOciText(payload: unknown): string | null {
  const result = payload as OciChatResult | null | undefined;
  const text = result?.chatResponse?.text ?? result?.text;
  return typeof text === 'string' && text.length > 0 ? text : null;
}

/**
 * True when generation stopped for a reason that means the JSON is cut off.
 *
 * A truncated response still parses as a string but fails `JSON.parse`, and
 * "unexpected end of JSON input" gives no clue that the real cause was the
 * token cap. Checking the reason lets the caller say so.
 */
export function isTruncated(payload: unknown): boolean {
  const result = payload as OciChatResult | null | undefined;
  const reason = result?.chatResponse?.finishReason ?? result?.finishReason;
  return typeof reason === 'string' && reason.toUpperCase() === 'MAX_TOKENS';
}
