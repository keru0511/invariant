/**
 * Conversation -> validated Domain Patch boundary.
 *
 * Providers only return structured data through this adapter. The returned
 * patch is parsed, source-checked, and dry-applied before it is exposed to a
 * caller. No provider or network implementation belongs in Domain Core.
 */

import {
  applyDomainPatch,
  parseDomainPatch,
  type DomainPatch,
  type DomainPatchModel,
  type DomainUnknown,
} from './patch';
import type { DomainParseError } from './runtime';

export interface ConversationTurn {
  readonly id: string;
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface ConversationToValidatedPatchInput {
  readonly conversation: readonly ConversationTurn[];
  /** The catalog or #12 domain model to dry-apply against. */
  readonly currentDomain: unknown;
  readonly currentDomainVersion: string;
  readonly unresolvedItems: readonly DomainUnknown[];
}

export interface ConversationPatchProviderRequest {
  readonly conversation: readonly ConversationTurn[];
  readonly currentDomainVersion: string;
  readonly unresolvedItems: readonly DomainUnknown[];
  readonly outputSchema: typeof CONVERSATION_PATCH_OUTPUT_SCHEMA;
}

/** One adapter boundary for a model/provider. Tests inject a deterministic fake. */
export interface ConversationPatchProvider {
  generate(request: ConversationPatchProviderRequest): Promise<unknown>;
}

/**
 * Stable error metadata used by infrastructure adapters without importing
 * network/secret handling into Domain Core.
 */
export const CONVERSATION_PATCH_PROVIDER_ERROR_NAME = 'ConversationPatchProviderError' as const;

export type ConversationPatchProviderErrorKind = 'timeout' | 'provider' | 'malformed-output';

export interface ConversationPatchProviderErrorShape {
  readonly name: typeof CONVERSATION_PATCH_PROVIDER_ERROR_NAME;
  readonly kind: ConversationPatchProviderErrorKind;
  readonly status?: number;
}

export interface ConversationPatchOperationEvidence {
  readonly operationIndex: number;
  readonly sourceReferences: readonly string[];
}

export interface ConversationPatchProviderOutput {
  readonly patch: unknown;
  readonly operationEvidence: readonly ConversationPatchOperationEvidence[];
}

export const CONVERSATION_PATCH_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['patch', 'operationEvidence'],
  properties: {
    patch: {
      type: 'object',
      additionalProperties: false,
      required: ['contractVersion', 'kind', 'baseVersion', 'provenance', 'operations'],
    },
    operationEvidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['operationIndex', 'sourceReferences'],
        properties: {
          operationIndex: { type: 'integer', minimum: 0 },
          sourceReferences: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
        },
      },
    },
  },
} as const);

export type ConversationPatchFailureCode =
  | 'INVALID_INPUT'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_ERROR'
  | 'MALFORMED_OUTPUT'
  | 'INVALID_SOURCE_REFERENCE'
  | 'DRY_APPLY_REJECTED';

export interface ConversationPatchFailure {
  readonly ok: false;
  readonly error: {
    readonly code: ConversationPatchFailureCode;
    readonly path: string;
    readonly message: string;
    readonly cause?: unknown;
    readonly domainError?: DomainParseError;
  };
}

export interface ValidatedConversationPatch {
  readonly ok: true;
  readonly patch: DomainPatch;
  readonly dryAppliedModel: DomainPatchModel;
  readonly operationEvidence: readonly ConversationPatchOperationEvidence[];
}

export type ConversationPatchResult = ValidatedConversationPatch | ConversationPatchFailure;

interface TimeoutMarker {
  readonly kind: 'timeout';
}

const TIMEOUT_MARKER: TimeoutMarker = Object.freeze({ kind: 'timeout' });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function failure(
  code: ConversationPatchFailureCode,
  path: string,
  message: string,
  extra: Pick<ConversationPatchFailure['error'], 'cause' | 'domainError'> = {},
): ConversationPatchFailure {
  return { ok: false, error: { code, path, message, ...extra } };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isWrappedDomainModel(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (hasOwn(value, 'domain') || value.kind === 'domain-model');
}

function providerFailureCode(error: unknown): ConversationPatchFailureCode {
  if (isRecord(error) && error.name === CONVERSATION_PATCH_PROVIDER_ERROR_NAME) {
    if (error.kind === 'timeout') return 'PROVIDER_TIMEOUT';
    if (error.kind === 'malformed-output') return 'MALFORMED_OUTPUT';
  }
  return 'PROVIDER_ERROR';
}

function validateInput(input: ConversationToValidatedPatchInput): ConversationPatchFailure | undefined {
  if (!Array.isArray(input.conversation) || input.conversation.length === 0) {
    return failure('INVALID_INPUT', '$.conversation', 'Conversation must contain at least one turn.');
  }
  if (!nonEmptyString(input.currentDomainVersion)) {
    return failure('INVALID_INPUT', '$.currentDomainVersion', 'Current Domain version must be a non-empty string.');
  }
  if (!Array.isArray(input.unresolvedItems)) {
    return failure('INVALID_INPUT', '$.unresolvedItems', 'Unresolved items must be an array.');
  }
  const turnIds = new Set<string>();
  for (let index = 0; index < input.conversation.length; index += 1) {
    const turn = input.conversation[index];
    if (!isRecord(turn) || !nonEmptyString(turn.id)) return failure('INVALID_INPUT', '$.conversation[' + index + '].id', 'Conversation turn id must be a non-empty string.');
    if (turnIds.has(turn.id)) return failure('INVALID_INPUT', '$.conversation[' + index + '].id', "Duplicate conversation turn id '" + turn.id + "'.");
    if (turn.role !== 'system' && turn.role !== 'user' && turn.role !== 'assistant') return failure('INVALID_INPUT', '$.conversation[' + index + '].role', 'Unsupported conversation role.');
    if (!nonEmptyString(turn.content)) return failure('INVALID_INPUT', '$.conversation[' + index + '].content', 'Conversation turn content must be a non-empty string.');
    turnIds.add(turn.id);
  }
  const unresolvedIds = new Set<string>();
  for (let index = 0; index < input.unresolvedItems.length; index += 1) {
    const item = input.unresolvedItems[index];
    if (!isRecord(item) || !nonEmptyString(item.id)) return failure('INVALID_INPUT', '$.unresolvedItems[' + index + '].id', 'Unresolved item id must be a non-empty string.');
    if (unresolvedIds.has(item.id)) return failure('INVALID_INPUT', '$.unresolvedItems[' + index + '].id', "Duplicate unresolved item id '" + item.id + "'.");
    unresolvedIds.add(item.id);
  }
  if (isWrappedDomainModel(input.currentDomain) && input.currentDomain.version !== input.currentDomainVersion) {
    return failure('INVALID_INPUT', '$.currentDomainVersion', 'Current Domain version does not match the supplied Domain model.');
  }
  return undefined;
}

function validateOutput(
  value: unknown,
  input: ConversationToValidatedPatchInput,
): { ok: true; patch: DomainPatch; operationEvidence: readonly ConversationPatchOperationEvidence[] } | ConversationPatchFailure {
  if (!isRecord(value)) return failure('MALFORMED_OUTPUT', '$', 'Provider output must be an object.');
  const allowed = new Set(['patch', 'operationEvidence']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return failure('MALFORMED_OUTPUT', '$', 'Provider output contains unsupported fields.');
  if (!hasOwn(value, 'patch') || !hasOwn(value, 'operationEvidence')) return failure('MALFORMED_OUTPUT', '$', 'Provider output must contain patch and operationEvidence.');
  const parsedPatch = parseDomainPatch(value.patch);
  if (!parsedPatch.ok) return failure('MALFORMED_OUTPUT', '$.patch', parsedPatch.error.message, { domainError: parsedPatch.error });
  const patch = parsedPatch.value;
  if (patch.baseVersion !== input.currentDomainVersion) return failure('INVALID_SOURCE_REFERENCE', '$.patch.baseVersion', 'Patch baseVersion must match currentDomainVersion.');
  if (patch.provenance.source !== 'conversation') return failure('INVALID_SOURCE_REFERENCE', '$.patch.provenance.source', "Patch provenance source must be 'conversation'.");
  const turnIds = new Set(input.conversation.map((turn) => turn.id));
  if (!patch.provenance.reference || !turnIds.has(patch.provenance.reference)) {
    return failure('INVALID_SOURCE_REFERENCE', '$.patch.provenance.reference', 'Patch provenance reference must identify a conversation turn.');
  }
  if (!Array.isArray(value.operationEvidence) || value.operationEvidence.length !== patch.operations.length) {
    return failure('MALFORMED_OUTPUT', '$.operationEvidence', 'There must be exactly one evidence entry per patch operation.');
  }
  const evidence: ConversationPatchOperationEvidence[] = [];
  const seenIndexes = new Set<number>();
  for (let index = 0; index < value.operationEvidence.length; index += 1) {
    const item = value.operationEvidence[index];
    if (!isRecord(item) || !Number.isInteger(item.operationIndex) || (item.operationIndex as number) < 0 || (item.operationIndex as number) >= patch.operations.length) {
      return failure('MALFORMED_OUTPUT', '$.operationEvidence[' + index + '].operationIndex', 'Evidence operationIndex must point to a patch operation.');
    }
    const operationIndex = item.operationIndex as number;
    const sourceReferences = item.sourceReferences;
    if (seenIndexes.has(operationIndex)) return failure('MALFORMED_OUTPUT', '$.operationEvidence[' + index + '].operationIndex', 'Operation evidence indexes must be unique.');
    if (!Array.isArray(sourceReferences) || sourceReferences.length === 0 || !sourceReferences.every((reference): reference is string => nonEmptyString(reference) && turnIds.has(reference))) {
      return failure('INVALID_SOURCE_REFERENCE', '$.operationEvidence[' + index + '].sourceReferences', 'Every operation source reference must identify a conversation turn.');
    }
    seenIndexes.add(operationIndex);
    evidence.push(Object.freeze({ operationIndex, sourceReferences: Object.freeze([...sourceReferences]) }));
  }
  for (let index = 0; index < patch.operations.length; index += 1) {
    if (!seenIndexes.has(index)) return failure('MALFORMED_OUTPUT', '$.operationEvidence', 'Operation evidence must cover every operation.');
  }
  return { ok: true, patch, operationEvidence: Object.freeze(evidence) };
}

function dryApplyBase(input: ConversationToValidatedPatchInput): unknown {
  if (isWrappedDomainModel(input.currentDomain)) return input.currentDomain;
  return {
    contractVersion: 'domain-v0',
    kind: 'domain-model',
    version: input.currentDomainVersion,
    domain: input.currentDomain,
    types: [],
    examples: [],
    unknowns: input.unresolvedItems,
    conflicts: [],
  };
}

async function generateWithTimeout(
  provider: ConversationPatchProvider,
  request: ConversationPatchProviderRequest,
  timeoutMs: number,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(TIMEOUT_MARKER), timeoutMs);
  });
  try {
    return await Promise.race([provider.generate(request), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function generateValidatedDomainPatch(
  input: ConversationToValidatedPatchInput,
  provider: ConversationPatchProvider,
  options: { readonly timeoutMs?: number } = {},
): Promise<ConversationPatchResult> {
  const inputFailure = validateInput(input);
  if (inputFailure) return inputFailure;
  const timeoutMs = options.timeoutMs ?? 1_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return failure('INVALID_INPUT', '$.timeoutMs', 'timeoutMs must be a positive finite number.');
  let output: unknown;
  try {
    output = await generateWithTimeout(provider, {
      conversation: input.conversation,
      currentDomainVersion: input.currentDomainVersion,
      unresolvedItems: input.unresolvedItems,
      outputSchema: CONVERSATION_PATCH_OUTPUT_SCHEMA,
    }, timeoutMs);
  } catch (error) {
    if (error === TIMEOUT_MARKER) return failure('PROVIDER_TIMEOUT', '$.provider', 'Conversation patch provider timed out.');
    const code = providerFailureCode(error);
    const path = code === 'MALFORMED_OUTPUT' ? '$.provider.response' : '$.provider';
    const message = code === 'PROVIDER_TIMEOUT'
      ? 'Conversation patch provider timed out.'
      : code === 'MALFORMED_OUTPUT'
        ? 'Conversation patch provider returned malformed output.'
        : 'Conversation patch provider failed.';
    return failure(code, path, message, { cause: error });
  }
  const validated = validateOutput(output, input);
  if (!validated.ok) return validated;
  const dryApplied = applyDomainPatch(dryApplyBase(input), validated.patch);
  if (!dryApplied.ok) return failure('DRY_APPLY_REJECTED', '$.patch', 'Validated patch could not be dry-applied.', { domainError: dryApplied.error });
  return {
    ok: true,
    patch: validated.patch,
    dryAppliedModel: dryApplied.value,
    operationEvidence: validated.operationEvidence,
  };
}
