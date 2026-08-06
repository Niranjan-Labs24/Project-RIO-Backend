import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import type { AiTask } from './ai.task';

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

  private async callOnce<TResponse>(
    task: AiTask<TResponse>,
    prompt: string,
  ): Promise<{ response: TResponse; raw: unknown }> {
    const apiKey = this.config.geminiApiKey;
    if (!apiKey) {
      this.logger.warn('GEMINI_API_KEY is not set. Falling back to manual mode.');
      throw new Error('Gemini API key is not configured');
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${task.model}:generateContent?key=${apiKey}`;

    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: task.systemPrompt }] },
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: task.responseSchema,
        temperature: task.temperature,
      },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), task.timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        this.logger.error(
          `[${task.name}] Gemini API call failed with status ${res.status}: ${errText}`,
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
                  'AI service is rate-limited (Gemini quota exceeded). Please try again in a minute.',
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
        throw new Error(`Gemini API returned status ${res.status}`);
      }

      const data = (await res.json()) as unknown as GeminiGenerateContentResponse;
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        this.logger.error(`[${task.name}] Invalid Gemini response format: ${JSON.stringify(data)}`);
        throw new Error('No content returned from Gemini');
      }

      const response = JSON.parse(text) as TResponse;
      return { response, raw: data };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        this.logger.error(`[${task.name}] Gemini call timed out after ${task.timeoutMs}ms`);
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
          `[${task.name}] Failed to call Gemini: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
