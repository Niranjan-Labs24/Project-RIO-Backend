import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiService } from './ai.service';

const task = {
  name: 'test-task',
  promptVersion: 'v1',
  systemPrompt: 'sys',
  model: 'gemini-x',
  temperature: 0.1,
  maxRetries: 2,
  timeoutMs: 1000,
  responseSchema: { type: 'object' },
} as never;

function config(over: Record<string, unknown> = {}) {
  return {
    aiProvider: 'gemini',
    geminiApiKey: 'gk',
    ociGenAiApiKey: 'ok',
    ociGenAiCompartmentId: 'comp',
    ociGenAiChatUrl: 'https://oci.test/chat',
    ociGenAiModelId: 'cohere.x',
    ociGenAiServingType: 'ON_DEMAND',
    ociGenAiMaxTokens: 100,
    ...over,
  } as never;
}

const geminiOk = (text: string) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
    status: 200,
  });
const ociOk = (text: string, finishReason?: string) =>
  new Response(JSON.stringify({ chatResponse: { text, finishReason } }), { status: 200 });

describe('AiService', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('names the model from the task for Gemini and from configuration for OCI', () => {
    expect(new AiService(config()).resolveModelName(task)).toBe('gemini-x');
    expect(new AiService(config({ aiProvider: 'oci_cohere' })).resolveModelName(task)).toBe(
      'cohere.x',
    );
  });

  it('calls Gemini and parses the JSON answer', async () => {
    fetchMock.mockResolvedValue(geminiOk('{"a":1}'));
    const result = await new AiService(config()).run<{ a: number }>(task, 'prompt');
    expect(result.response).toEqual({ a: 1 });
    expect(fetchMock.mock.calls[0]![0]).toContain('gemini-x:generateContent');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).contents[0].parts[0].text).toBe('prompt');
  });

  it('calls OCI Cohere with a bearer token and parses the JSON answer', async () => {
    fetchMock.mockResolvedValue(ociOk('{"b":2}'));
    const result = await new AiService(config({ aiProvider: 'oci_cohere' })).run<{ b: number }>(
      task,
      'p',
    );
    expect(result.response).toEqual({ b: 2 });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://oci.test/chat');
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe('Bearer ok');
  });

  it('refuses to call a provider that has no credentials', async () => {
    await expect(new AiService(config({ geminiApiKey: undefined })).run(task, 'p')).rejects.toThrow(
      'Gemini API key is not configured',
    );
    await expect(
      new AiService(config({ aiProvider: 'oci_cohere', ociGenAiApiKey: undefined })).run(task, 'p'),
    ).rejects.toThrow('API key is not configured');
    await expect(
      new AiService(config({ aiProvider: 'oci_cohere', ociGenAiCompartmentId: undefined })).run(
        task,
        'p',
      ),
    ).rejects.toThrow('compartment id is not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries a rate limit and then succeeds', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
      .mockResolvedValueOnce(geminiOk('{"ok":true}'));
    const promise = new AiService(config()).run(task, 'p');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toMatchObject({ response: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retries with the matching error code', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => new Response('busy', { status: 429 }));
    const promise = new AiService(config()).run(task, 'p').catch((e) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await promise;
    expect(error.getResponse().error.code).toBe('AI_RATE_LIMITED');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('treats a server error as temporary', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => new Response('oops', { status: 503 }));
    const promise = new AiService(config())
      .run({ ...(task as object), maxRetries: 0 } as never, 'p')
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(100);
    expect((await promise).getResponse().error.code).toBe('AI_UNAVAILABLE');
  });

  it('does not retry a rejected credential or another client error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('no', { status: 401 }));
    await expect(new AiService(config()).run(task, 'p')).rejects.toThrow('rejected the credential');
    fetchMock.mockResolvedValueOnce(new Response('bad', { status: 400 }));
    await expect(new AiService(config()).run(task, 'p')).rejects.toThrow('returned status 400');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails when the answer has no content or is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ candidates: [] }), { status: 200 }),
    );
    await expect(new AiService(config()).run(task, 'p')).rejects.toThrow('No content returned');
    fetchMock.mockResolvedValueOnce(geminiOk('not json'));
    await expect(new AiService(config()).run(task, 'p')).rejects.toBeInstanceOf(SyntaxError);
  });

  it('explains a response cut off at the token limit', async () => {
    fetchMock.mockResolvedValue(ociOk('{"partial', 'MAX_TOKENS'));
    await expect(
      new AiService(config({ aiProvider: 'oci_cohere' })).run(task, 'p'),
    ).rejects.toThrow('truncated');
  });

  it('turns a timeout into a temporary error', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_res, reject) => {
          init.signal!.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    const promise = new AiService(config())
      .run({ ...(task as object), maxRetries: 0 } as never, 'p')
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(1_500);
    expect((await promise).getResponse().error.code).toBe('AI_TIMEOUT');
  });

  it('reports a network failure as-is', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    await expect(new AiService(config()).run(task, 'p')).rejects.toThrow('offline');
    fetchMock.mockRejectedValue('weird');
    await expect(new AiService(config()).run(task, 'p')).rejects.toBe('weird');
  });
});
