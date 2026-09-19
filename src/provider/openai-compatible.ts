import {
  CONVERSATION_PATCH_OUTPUT_SCHEMA,
  CONVERSATION_PATCH_PROVIDER_ERROR_NAME,
  type ConversationPatchProvider,
  type ConversationPatchProviderErrorKind,
  type ConversationPatchProviderRequest,
} from '../domain/conversation-patch';

export interface OpenAICompatibleProviderConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface OpenAICompatibleProviderEnv {
  readonly OPENAI_API_KEY?: string;
  readonly OPENAI_BASE_URL?: string;
  readonly OPENAI_MODEL?: string;
  readonly OPENAI_TIMEOUT_MS?: string;
}

export class OpenAICompatibleProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenAICompatibleProviderConfigError';
  }
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 30_000;

function providerError(kind: ConversationPatchProviderErrorKind, message: string, status?: number): Error {
  const error = new Error(message);
  error.name = CONVERSATION_PATCH_PROVIDER_ERROR_NAME;
  Object.assign(error, { kind, ...(status === undefined ? {} : { status }) });
  return error;
}

function requireNonEmpty(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0 || value.trim() !== value) {
    throw new OpenAICompatibleProviderConfigError(name + ' must be a non-empty environment value.');
  }
  return value;
}

function parseTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new OpenAICompatibleProviderConfigError('OPENAI_TIMEOUT_MS must be a positive finite number.');
  }
  return timeoutMs;
}

function endpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.length === 0) throw new OpenAICompatibleProviderConfigError('baseUrl must not be empty.');
  return trimmed + '/chat/completions';
}

function requestBody(request: ConversationPatchProviderRequest, model: string): Record<string, unknown> {
  return {
    model,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: 'Generate a validated Domain Patch. Preserve unknowns and conflicts instead of inventing definitions. Return only the requested structured object.',
      },
      ...request.conversation.map((turn) => ({ role: turn.role, content: turn.content })),
      {
        role: 'user',
        content: JSON.stringify({
          currentDomainVersion: request.currentDomainVersion,
          unresolvedItems: request.unresolvedItems,
        }),
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'conversation_domain_patch',
        strict: true,
        schema: request.outputSchema,
      },
    },
  };
}

function extractStructuredOutput(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw providerError('malformed-output', 'Provider response envelope is not an object.');
  }
  const response = payload as Record<string, unknown>;
  if (response.error !== undefined) {
    throw providerError('provider', 'Provider returned an error response.');
  }
  const choices = response.choices;
  if (!Array.isArray(choices) || choices.length === 0 || choices[0] === null || typeof choices[0] !== 'object') {
    throw providerError('malformed-output', 'Provider response did not contain a choice.');
  }
  const message = (choices[0] as Record<string, unknown>).message;
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw providerError('malformed-output', 'Provider response did not contain a message.');
  }
  const messageRecord = message as Record<string, unknown>;
  if (messageRecord.parsed !== undefined) return messageRecord.parsed;
  const content = messageRecord.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw providerError('malformed-output', 'Provider message content was empty or not text.');
  }
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    throw providerError('malformed-output', 'Provider message content was not valid JSON.');
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function createOpenAICompatibleProvider(config: OpenAICompatibleProviderConfig): ConversationPatchProvider {
  const apiKey = requireNonEmpty(config.apiKey, 'apiKey');
  const model = requireNonEmpty(config.model, 'model');
  const baseUrl = requireNonEmpty(config.baseUrl, 'baseUrl');
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new OpenAICompatibleProviderConfigError('timeoutMs must be a positive finite number.');
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const url = endpoint(baseUrl);

  return {
    async generate(request): Promise<unknown> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let response: Response;
        try {
          response = await fetchImpl(url, {
            method: 'POST',
            headers: {
              authorization: 'Bearer ' + apiKey,
              'content-type': 'application/json',
            },
            body: JSON.stringify(requestBody({ ...request, outputSchema: CONVERSATION_PATCH_OUTPUT_SCHEMA }, model), null, 0),
            signal: controller.signal,
          });
        } catch (error) {
          if (controller.signal.aborted || isAbortError(error)) {
            throw providerError('timeout', 'Provider request timed out.');
          }
          throw providerError('provider', 'Provider request failed.');
        }
        if (!response.ok) {
          throw providerError('provider', 'Provider returned a non-success HTTP status.', response.status);
        }
        let payload: unknown;
        try {
          payload = await response.json();
        } catch (error) {
          throw providerError('malformed-output', 'Provider response was not valid JSON.');
        }
        return extractStructuredOutput(payload);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function createOpenAICompatibleProviderFromEnv(
  env: OpenAICompatibleProviderEnv,
  fetchImpl?: typeof fetch,
): ConversationPatchProvider {
  return createOpenAICompatibleProvider({
    apiKey: requireNonEmpty(env.OPENAI_API_KEY, 'OPENAI_API_KEY'),
    baseUrl: env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL,
    model: requireNonEmpty(env.OPENAI_MODEL, 'OPENAI_MODEL'),
    timeoutMs: parseTimeout(env.OPENAI_TIMEOUT_MS),
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
}
