import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(private readonly config: ConfigService) {}

  async generateJson<T>(
    prompt: string,
    systemInstruction: string,
    responseSchema?: Record<string, unknown>,
  ): Promise<{ response: T; raw: unknown }> {
    const apiKey = this.config.geminiApiKey;
    if (!apiKey) {
      this.logger.warn('GEMINI_API_KEY is not set. Falling back to manual mode.');
      throw new Error('Gemini API key is not configured');
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    const body = {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
      systemInstruction: {
        parts: [{ text: systemInstruction }],
      },
      generationConfig: {
        responseMimeType: 'application/json',
        ...(responseSchema ? { responseSchema } : {}),
      },
    };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        this.logger.error(`Gemini API call failed with status ${res.status}: ${errText}`);
        // Surface a clean, actionable error instead of a generic 500. 429 =
        // quota/rate-limit; 5xx = upstream outage — both are "try again later".
        if (res.status === 429) {
          throw new ServiceUnavailableException({
            error: { code: "AI_RATE_LIMITED", message: "AI service is rate-limited (Gemini quota exceeded). Please try again in a minute." },
          });
        }
        if (res.status >= 500) {
          throw new ServiceUnavailableException({
            error: { code: "AI_UNAVAILABLE", message: "AI service is temporarily unavailable. Please try again shortly." },
          });
        }
        throw new Error(`Gemini API returned status ${res.status}`);
      }

      const data = await res.json() as any;
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        this.logger.error(`Invalid Gemini response format: ${JSON.stringify(data)}`);
        throw new Error('No content returned from Gemini');
      }

      const response = JSON.parse(text) as T;
      return { response, raw: data };
    } catch (err: any) {
      this.logger.error(`Failed to call Gemini: ${err.message}`);
      throw err;
    }
  }
}
