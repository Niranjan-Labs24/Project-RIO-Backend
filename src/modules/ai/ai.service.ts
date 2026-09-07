import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import type { AiTask } from './ai.task';
import { buildOciChatBody, extractOciText, isTruncated } from './oci-cohere.provider';

/** One provider's HTTP call, before it is sent. */
interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** Names the provider in logs and error messages. */
  providerLabel: string;
}

// The subset of Gemini's generateContent response this method actually
// reads — everything else in the real payload (safetyRatings,
// usageMetadata, ...) is genuinely unknown/unvalidated here, hence
// `unknown` rather than a full response type.
interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

/** Upstream failures that are worth retrying, as opposed to a bad request. */
class TransientAiError extends Error {
  constructor(
    message: string,
    readonly httpError: ServiceUnavailableException,
  ) {
    super(message);
  }
}

const RETRY_BASE_DELAY_MS = 500;

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Runs one declared AI task. Model, temperature, timeout and retry budget all
   * come from the task, so each use case is tuned independently rather than
   * sharing one global profile.
   */
  async run<TResponse>(
    task: AiTask<TResponse>,
    prompt: string,
  ): Promise<{ response: TResponse; raw: unknown }> {
    let lastTransient: TransientAiError | undefined;

    for (let attempt = 0; attempt <= task.maxRetries; attempt++) {
      try {
        return await this.callOnce<TResponse>(task, prompt);
      } catch (err) {
        if (!(err instanceof TransientAiError)) throw err;
        lastTransient = err;
        if (attempt === task.maxRetries) break;
        // Exponential backoff. Rate limits in particular clear on their own,
        // and retrying instantly just burns the remaining quota.
        const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
        this.logger.warn(
          `[${task.name}] ${err.message} — retrying in ${delay}ms (attempt ${attempt + 1}/${task.maxRetries})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // Retries exhausted: surface the upstream-shaped error the caller expects.
    throw lastTransient!.httpError;
  }

  /**
   * Cohere Command A on OCI Generative AI, in the configured region.
   *
   * `task.model` is ignored on this path: every task names a Gemini model,
   * and on OCI the model is a deployment choice (which tenancy, which
   * region, on-demand or a dedicated cluster) rather than a per-task one.
   */
  private buildOciRequest(task: AiTask<unknown>, prompt: string): ProviderRequest {
    const apiKey = this.config.ociGenAiApiKey;
    const compartmentId = this.config.ociGenAiCompartmentId;
    // Both are checked here rather than at boot so a missing value degrades
    // to manual mode for AI features only, exactly as an absent
    // GEMINI_API_KEY always has, instead of refusing to start the API.
    if (!apiKey) {
      this.logger.warn('OCI_GENAI_API_KEY is not set. Falling back to manual mode.');
      throw new Error('OCI Generative AI API key is not configured');
    }
    if (!compartmentId) {
      this.logger.warn('OCI_GENAI_COMPARTMENT_ID is not set. Falling back to manual mode.');
      throw new Error('OCI Generative AI compartment id is not configured');
    }

    return {
      url: this.config.ociGenAiChatUrl,
      headers: { Authorization: `Bearer ${apiKey}` },
      body: buildOciChatBody(task, prompt, {
        compartmentId,
        modelId: this.config.ociGenAiModelId,
        servingType: this.config.ociGenAiServingType,
        maxTokens: this.config.ociGenAiMaxTokens,
      }),
      providerLabel: `OCI ${this.config.ociGenAiModelId}`,
    };
  }

  private buildGeminiRequest(task: AiTask<unknown>, prompt: string): ProviderRequest {
    const apiKey = this.config.geminiApiKey;
    if (!apiKey) {
      this.logger.warn('GEMINI_API_KEY is not set. Falling back to manual mode.');
      throw new Error('Gemini API key is not configured');
    }

    return {
      // The key stays in the query string because that is the only auth
      // Gemini's generateContent accepts.
      url: `https://generativelanguage.googleapis.com/v1beta/models/${task.model}:generateContent?key=${apiKey}`,
      headers: {},
      body: {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: task.systemPrompt }] },
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: task.responseSchema,
          temperature: task.temperature,
        },
      },
      providerLabel: 'Gemini',
    };
  }

  private async callOnce<TResponse>(
    task: AiTask<TResponse>,
    prompt: string,
  ): Promise<{ response: TResponse; raw: unknown }> {
    // Both providers speak JSON over HTTPS with a bearer-ish credential, so
    // only the URL, headers and body differ. Timeout, retry classification
    // and error envelopes below are shared deliberately: callers such as
    // AiDecisionsService branch on AI_RATE_LIMITED / AI_UNAVAILABLE /
    // AI_TIMEOUT, and those must not change meaning with the provider.
    const request =
      this.config.aiProvider === 'oci_cohere'
        ? this.buildOciRequest(task, prompt)
        : this.buildGeminiRequest(task, prompt);
    const { url, headers, body, providerLabel } = request;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), task.timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        this.logger.error(
          `[${task.name}] ${providerLabel} call failed with status ${res.status}: ${errText}`,
        );
        // 429 = quota/rate-limit; 5xx = upstream outage — both are "try again
        // later", so both are retryable and both surface as 503 if retries run
        // out. Anything else is our own bad request and must not be retried.
        if (res.status === 429) {
          throw new TransientAiError(
            'rate-limited',
            new ServiceUnavailableException({
              error: {
                code: 'AI_RATE_LIMITED',
                message:
                  'AI service is rate-limited (model quota exceeded). Please try again in a minute.',
              },
            }),
          );
        }
        if (res.status >= 500) {
          throw new TransientAiError(
            `upstream ${res.status}`,
            new ServiceUnavailableException({
              error: {
                code: 'AI_UNAVAILABLE',
                message: 'AI service is temporarily unavailable. Please try again shortly.',
              },
            }),
          );
        }
        // 401/403/404 all mean the credential or its IAM policy is wrong
        // rather than the prompt — OCI answers an unauthorized caller with
        // 404 on purpose, so a generic "bad request" would send whoever
        // reads the log hunting through the payload instead of the policy.
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          throw new Error(
            `${providerLabel} rejected the credential (status ${res.status}). ` +
              'Check the API key, its region, the compartment id and the IAM policy.',
          );
        }
        throw new Error(`${providerLabel} returned status ${res.status}`);
      }

      const data: unknown = await res.json();
      const text =
        this.config.aiProvider === 'oci_cohere'
          ? extractOciText(data)
          : ((data as GeminiGenerateContentResponse).candidates?.[0]?.content?.parts?.[0]?.text ??
            null);

      if (!text) {
        this.logger.error(
          `[${task.name}] Invalid ${providerLabel} response format: ${JSON.stringify(data)}`,
        );
        throw new Error(`No content returned from ${providerLabel}`);
      }

      // A response cut off at the token cap parses as a string but not as
      // JSON, and "unexpected end of JSON input" hides the real cause.
      if (this.config.aiProvider === 'oci_cohere' && isTruncated(data)) {
        this.logger.error(
          `[${task.name}] ${providerLabel} hit the output token cap — response is truncated.`,
        );
        throw new Error(
          `${providerLabel} response was truncated at the output token limit ` +
            '(OCI_GENAI_MAX_TOKENS). Narrow the request or raise the limit.',
        );
      }

      const response = JSON.parse(text) as TResponse;
      return { response, raw: data };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        this.logger.error(
          `[${task.name}] ${providerLabel} call timed out after ${task.timeoutMs}ms`,
        );
        throw new TransientAiError(
          'timed out',
          new ServiceUnavailableException({
            error: {
              code: 'AI_TIMEOUT',
              message:
                'AI service took too long to respond. Please try again — a narrower scope (e.g. one village) usually completes faster.',
            },
          }),
        );
      }
      // Anything else (a bad status, an unparsable response, ...) keeps its own
      // specific message — callers such as
      // AiDecisionsService.runAndPersistClassification store this verbatim as
      // the classification failure reason, so collapsing it to a generic string
      // here would throw away real diagnostic detail.
      if (!(err instanceof TransientAiError)) {
        this.logger.error(
          `[${task.name}] Failed to call ${providerLabel}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
