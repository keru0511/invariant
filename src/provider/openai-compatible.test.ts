import { describe, expect, it, vi } from 'vitest';
import functionCatalog from '../../fixtures/domain-v0/functions.json';
import {
  CONVERSATION_PATCH_OUTPUT_SCHEMA,
  generateValidatedDomainPatch,
  type ConversationPatchProviderRequest,
} from '../domain/conversation-patch';
import { DOMAIN_PATCH_CONTRACT_VERSION } from '../domain/patch';
import {
  createOpenAICompatibleProvider,
  createOpenAICompatibleProviderFromEnv,
  OpenAICompatibleProviderConfigError,
} from './openai-compatible';

const conversation = [{ id: 'turn-1', role: 'user' as const, content: 'Members under 18 are denied.' }];
const patch = {
  contractVersion: DOMAIN_PATCH_CONTRACT_VERSION,
  kind: 'domain-patch' as const,
  baseVersion: 'domain-v0',
  provenance: { source: 'conversation', reference: 'turn-1' },
  operations: [],
};
const output = { patch, operationEvidence: [] };

function request(): ConversationPatchProviderRequest {
  return {
    conversation,
    currentDomainVersion: 'domain-v0',
    unresolvedItems: [],
    outputSchema: CONVERSATION_PATCH_OUTPUT_SCHEMA,
  };
}

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OpenAI-compatible conversation patch adapter', () => {
  it('posts a deterministic structured-output request without requiring a live provider', async () => {
    let receivedUrl = '';
    let receivedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      receivedUrl = String(input);
      receivedInit = init;
      return response({ choices: [{ message: { content: JSON.stringify(output) } }] });
    });
    const provider = createOpenAICompatibleProvider({
      baseUrl: 'https://example.invalid/v1/',
      apiKey: 'test-secret',
      model: 'test-model',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(provider.generate(request())).resolves.toEqual(output);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(receivedUrl).toBe('https://example.invalid/v1/chat/completions');
    expect(receivedInit?.method).toBe('POST');
    expect(receivedInit?.headers).toEqual({
      authorization: 'Bearer test-secret',
      'content-type': 'application/json',
    });
    const body = JSON.parse(String(receivedInit?.body)) as Record<string, any>;
    expect(body.model).toBe('test-model');
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'conversation_domain_patch',
        strict: false,
        schema: CONVERSATION_PATCH_OUTPUT_SCHEMA,
      },
    });
    expect(body.messages).toEqual([
      expect.objectContaining({ role: 'system' }),
      { role: 'user', content: JSON.stringify({ conversation, currentDomainVersion: 'domain-v0', unresolvedItems: [] }) },
    ]);
  });

  it('builds the concrete provider from environment config', async () => {
    const fetchMock = vi.fn(async () => response({ choices: [{ message: { parsed: output } }] }));
    const provider = createOpenAICompatibleProviderFromEnv({
      OPENAI_API_KEY: 'env-secret',
      OPENAI_BASE_URL: 'https://example.invalid/compatible',
      OPENAI_MODEL: 'env-model',
    }, fetchMock as unknown as typeof fetch);

    await expect(provider.generate(request())).resolves.toEqual(output);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects missing credentials before any network call', () => {
    expect(() => createOpenAICompatibleProviderFromEnv({ OPENAI_MODEL: 'test-model' })).toThrow(OpenAICompatibleProviderConfigError);
  });

  it('tags non-2xx responses as provider failures and the domain maps them to PROVIDER_ERROR', async () => {
    const fetchMock = vi.fn(async () => response({ error: { message: 'nope' } }, 503));
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://example.invalid/v1', apiKey: 'secret', model: 'model', fetchImpl: fetchMock as unknown as typeof fetch });
    const result = await generateValidatedDomainPatch({ conversation, currentDomain: functionCatalog, currentDomainVersion: 'domain-v0', unresolvedItems: [] }, provider);
    expect(result).toMatchObject({ ok: false, error: { code: 'PROVIDER_ERROR' } });
  });

  it('tags malformed JSON and the domain maps it to MALFORMED_OUTPUT', async () => {
    const fetchMock = vi.fn(async () => new Response('{not-json', { status: 200 }));
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://example.invalid/v1', apiKey: 'secret', model: 'model', fetchImpl: fetchMock as unknown as typeof fetch });
    const result = await generateValidatedDomainPatch({ conversation, currentDomain: functionCatalog, currentDomainVersion: 'domain-v0', unresolvedItems: [] }, provider);
    expect(result).toMatchObject({ ok: false, error: { code: 'MALFORMED_OUTPUT' } });
  });

  it('tags an aborted request as timeout and the domain maps it to PROVIDER_TIMEOUT', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted by test')), { once: true });
    }));
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://example.invalid/v1', apiKey: 'secret', model: 'model', timeoutMs: 5, fetchImpl: fetchMock as unknown as typeof fetch });
    const result = await generateValidatedDomainPatch({ conversation, currentDomain: functionCatalog, currentDomainVersion: 'domain-v0', unresolvedItems: [] }, provider, { timeoutMs: 100 });
    expect(result).toMatchObject({ ok: false, error: { code: 'PROVIDER_TIMEOUT' } });
  });
  it('forwards bounded-repair metadata without changing the structured schema', async () => {
    let receivedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      receivedInit = init;
      return response({ choices: [{ message: { parsed: output } }] });
    });
    const provider = createOpenAICompatibleProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'secret',
      model: 'model',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const signal = new AbortController().signal;
    const repair = {
      previousAttempt: 1 as const,
      diagnostics: [{ code: 'MALFORMED_OUTPUT', path: '$.patch', message: 'invalid candidate' }],
    };
    await expect(provider.generate({ ...request(), signal, attempt: 2, repair })).resolves.toEqual(output);

    const body = JSON.parse(String(receivedInit?.body)) as Record<string, any>;
    const metadata = JSON.parse(String((body.messages as Array<{ content: string }>).at(-1)?.content)) as Record<string, unknown>;
    expect(metadata).toEqual({
      conversation,
      currentDomainVersion: 'domain-v0',
      unresolvedItems: [],
      attempt: 2,
      repair,
    });
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'conversation_domain_patch',
        strict: false,
        schema: CONVERSATION_PATCH_OUTPUT_SCHEMA,
      },
    });
    expect(receivedInit?.signal).toBeInstanceOf(AbortSignal);
  });

});




describe('provider completion integrity', () => {
  it.each(['length', 'content_filter', 'tool_calls', null])('does not accept JSON-shaped content from an incomplete completion (%s)', async (finish_reason) => {
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://example.invalid/v1', apiKey: 'test', model: 'test',
      fetchImpl: (async () => response({ choices: [{ finish_reason, message: { parsed: output } }] })) as typeof fetch });
    await expect(provider.generate(request())).rejects.toMatchObject({ kind: 'malformed-output' });
  });

  it('does not prefer parsed content over an explicit refusal', async () => {
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://example.invalid/v1', apiKey: 'test', model: 'test',
      fetchImpl: (async () => response({ choices: [{ finish_reason: 'stop', message: { refusal: 'Refused', parsed: output } }] })) as typeof fetch });
    await expect(provider.generate(request())).rejects.toMatchObject({ kind: 'malformed-output' });
  });

  it('rejects ambiguous multiple candidates rather than silently selecting the first', async () => {
    const choice = { finish_reason: 'stop', message: { parsed: output } };
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://example.invalid/v1', apiKey: 'test', model: 'test',
      fetchImpl: (async () => response({ choices: [choice, choice] })) as typeof fetch });
    await expect(provider.generate(request())).rejects.toMatchObject({ kind: 'malformed-output' });
  });
});

it('accepts a single normal completion with a null refusal', async () => {
  const provider = createOpenAICompatibleProvider({ baseUrl: 'https://example.invalid/v1', apiKey: 'test', model: 'test',
    fetchImpl: (async () => response({ choices: [{ finish_reason: 'stop', message: { refusal: null, parsed: output } }] })) as typeof fetch });
  await expect(provider.generate(request())).resolves.toEqual(output);
});

describe('provider response-body deadlines', () => {
  it('does not accept a late JSON body after the provider timeout', async () => {
    const payload = response({});
    vi.spyOn(payload, 'json').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { choices: [{ message: { parsed: output } }] };
    });
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://example.invalid/v1', apiKey: 'test', model: 'test', timeoutMs: 5,
      fetchImpl: (async () => payload) as typeof fetch });
    await expect(provider.generate(request())).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('does not accept a JSON body after cancellation', async () => {
    const controller = new AbortController();
    const payload = response({});
    vi.spyOn(payload, 'json').mockImplementation(async () => {
      controller.abort();
      return { choices: [{ message: { parsed: output } }] };
    });
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://example.invalid/v1', apiKey: 'test', model: 'test',
      fetchImpl: (async () => payload) as typeof fetch });
    await expect(provider.generate({ ...request(), signal: controller.signal })).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('classifies an aborted response-body read as cancellation rather than malformed JSON', async () => {
    const controller = new AbortController();
    const payload = response({});
    vi.spyOn(payload, 'json').mockImplementation(async () => { controller.abort(); throw new Error('body aborted'); });
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://example.invalid/v1', apiKey: 'test', model: 'test',
      fetchImpl: (async () => payload) as typeof fetch });
    await expect(provider.generate({ ...request(), signal: controller.signal })).rejects.toMatchObject({ kind: 'cancelled' });
  });
});
