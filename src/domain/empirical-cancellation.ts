/** Synthetic, version-pinned experiment executor. No network, storage or LLM.
 * These tool names are compatible with the experiment runner; this module does
 * not register or change the deployed MCP domain catalog.
 */
import rule from '../../fixtures/empirical-v1/rule.json';
import { deepFreeze } from './decision-context';
import type { EmpiricalTools, EmpiricalToolSchema, EmpiricalToolCall } from './empirical-experiment';

export const EMPIRICAL_CANCELLATION_CORPUS_VERSION = 'empirical-cancellation-v1' as const;
export const EMPIRICAL_CANCELLATION_RULE_VERSION = 'cancellation-v1' as const;
export const EMPIRICAL_CANCELLATION_SOURCE_ID = 'synthetic-cancellation-rule-v1' as const;
export const EMPIRICAL_CANCELLATION_RULE_TEXT = rule.ruleText;
const DOMAIN = 'synthetic-cancellation';
const FUNCTION = 'cancellation-fee';
const TARGET = Object.freeze({ domain: DOMAIN, version: EMPIRICAL_CANCELLATION_RULE_VERSION, function: FUNCTION,
  corpusVersion: EMPIRICAL_CANCELLATION_CORPUS_VERSION, sourceId: EMPIRICAL_CANCELLATION_SOURCE_ID });

export type EmpiricalCancellationErrorCode = 'INVALID_ARGUMENT' | 'VERSION_MISMATCH' | 'UNKNOWN_DOMAIN' | 'UNKNOWN_FUNCTION' | 'UNKNOWN_TOOL' | 'ABORTED';
export interface EmpiricalCancellationError {
  readonly status: 'error';
  readonly error: { readonly code: EmpiricalCancellationErrorCode; readonly message: string; readonly path: string };
}
export type EmpiricalCancellationResult =
  | (typeof TARGET & { readonly status: 'ok'; readonly decision: 'free' | 'half' | 'full'; readonly abstain: false; readonly value: string; readonly reason: string })
  | (typeof TARGET & { readonly status: 'needs_information'; readonly decision: null; readonly abstain: true; readonly missingFacts: readonly string[] })
  | EmpiricalCancellationError;

class InputError extends Error {
  constructor(readonly code: EmpiricalCancellationErrorCode, message: string, readonly path: string) { super(message); }
}
const fail = (message: string, path: string, code: EmpiricalCancellationErrorCode = 'INVALID_ARGUMENT'): never => { throw new InputError(code, message, path); };
function record(raw: unknown, allowed: readonly string[], path: string): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail('Expected a plain JSON object.', path);
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) return fail('Expected a plain JSON object.', path);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string' || !allowed.includes(key)) return fail('Unknown field.', path);
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) return fail('Only enumerable JSON data properties are supported.', `${path}.${key}`);
    result[key] = descriptor.value;
  }
  return result;
}
function request(raw: unknown, evaluate: boolean): Record<string, unknown> {
  const r = record(raw, evaluate ? ['domain', 'version', 'function', 'args'] : ['domain', 'version', 'function'], '$');
  if (r.domain !== DOMAIN) fail('Expected domain synthetic-cancellation.', '$.domain', 'UNKNOWN_DOMAIN');
  if (r.version !== EMPIRICAL_CANCELLATION_RULE_VERSION) fail('Explicit version cancellation-v1 is required; no fallback version is selected.', '$.version', 'VERSION_MISMATCH');
  if ((evaluate || Object.hasOwn(r, 'function')) && r.function !== FUNCTION) fail('Expected function cancellation-fee.', '$.function', 'UNKNOWN_FUNCTION');
  return r;
}
function boundary<T>(action: () => T): T | EmpiricalCancellationError {
  try { return deepFreeze(action()); }
  catch (error) {
    if (error instanceof InputError) return deepFreeze({ status: 'error' as const, error: { code: error.code, message: error.message, path: error.path } });
    // Runtime objects such as revoked proxies are outside JSON; fail closed.
    return deepFreeze({ status: 'error' as const, error: { code: 'INVALID_ARGUMENT' as const, message: 'Input could not be read as plain JSON.', path: '$' } });
  }
}

/** Evaluate only supplied facts. No extraction, default facts or rule mutation. */
export function evaluateEmpiricalCancellation(raw: unknown): EmpiricalCancellationResult {
  return boundary(() => {
    const r = request(raw, true);
    const facts = record(r.args, ['organizerCancelled', 'secondsUntilStart', 'bookingPriceYen'], '$.args');
    const has = (key: string) => Object.hasOwn(facts, key);
    if (has('organizerCancelled') && typeof facts.organizerCancelled !== 'boolean') fail('Expected boolean, or omit an unknown fact.', '$.args.organizerCancelled');
    if (has('secondsUntilStart') && (typeof facts.secondsUntilStart !== 'number' || !Number.isSafeInteger(facts.secondsUntilStart) || facts.secondsUntilStart < 0 || Object.is(facts.secondsUntilStart, -0))) {
      fail('Expected nonnegative safe integer seconds before start (no negative zero).', '$.args.secondsUntilStart');
    }
    if (has('bookingPriceYen') && (typeof facts.bookingPriceYen !== 'string' || facts.bookingPriceYen.length > 100 || !/^[1-9][0-9]*$/.test(facts.bookingPriceYen))) {
      fail('Expected a canonical positive integer yen string of at most 100 digits.', '$.args.bookingPriceYen');
    }
    // Validate even irrelevant supplied fields before using the organizer exception.
    const ask = (...missingFacts: string[]) => ({ ...TARGET, status: 'needs_information' as const, decision: null, abstain: true as const, missingFacts });
    const answer = (decision: 'free' | 'half' | 'full', value: string, reason: string) => ({ ...TARGET, status: 'ok' as const, decision, abstain: false as const, value, reason });
    if (facts.organizerCancelled === true) return answer('free', '0', 'organizer_exception');
    if (has('secondsUntilStart') && (facts.secondsUntilStart as number) >= 172800) return answer('free', '0', 'at_least_48_hours');
    if (!has('organizerCancelled')) return ask('organizerCancelled');
    if (!has('secondsUntilStart')) return ask('secondsUntilStart');
    const seconds = facts.secondsUntilStart as number;
    if (!has('bookingPriceYen')) return ask('bookingPriceYen');
    const yen = BigInt(facts.bookingPriceYen as string);
    if (seconds >= 86400) return answer('half', (yen / 2n).toString(), 'at_least_24_below_48_hours_floor_yen');
    return answer('full', yen.toString(), 'below_24_hours');
  });
}

const targetProperties = { domain: { type: 'string', const: DOMAIN }, version: { type: 'string', const: EMPIRICAL_CANCELLATION_RULE_VERSION }, function: { type: 'string', const: FUNCTION } };
export const EMPIRICAL_CANCELLATION_TOOLS: readonly EmpiricalToolSchema[] = deepFreeze([
  { name: 'domain.describe', description: '架空のキャンセル規則 cancellation-v1 の対象・入力形式・ルールを読む。変更・承認・実装はしない。', readOnly: true,
    inputSchema: { type: 'object', additionalProperties: false, required: ['domain', 'version'], properties: targetProperties } },
  { name: 'domain.evaluate', description: '架空のキャンセル規則 cancellation-v1 を供給された事実だけで決定論的に評価する。欠測を補わず、不正な入力と版の不一致を明示する。', readOnly: true,
    inputSchema: { type: 'object', additionalProperties: false, required: ['domain', 'version', 'function', 'args'], properties: { ...targetProperties,
      args: { type: 'object', additionalProperties: false, properties: {
        organizerCancelled: { type: 'boolean', description: '確認済みの主催者都合の中止フラグ。未確認なら省略する。' },
        secondsUntilStart: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: 'キャンセル受付から利用開始までの非負整数秒。負のゼロは不可。' },
        bookingPriceYen: { type: 'string', pattern: '^[1-9][0-9]*$', maxLength: 100, description: '税込予約料金。円単位の正の整数十進文字列。0円予約は本実験の対象外。' },
      } },
    } } },
]);

export function describeEmpiricalCancellation(raw: unknown) {
  return boundary(() => {
    request(raw, false);
    return { ...TARGET, status: 'ok' as const, scope: 'synthetic_experiment_only', ruleText: EMPIRICAL_CANCELLATION_RULE_TEXT,
      inputSchema: EMPIRICAL_CANCELLATION_TOOLS[1].inputSchema, tools: EMPIRICAL_CANCELLATION_TOOLS,
      limitations: rule.scopeLimitations };
  });
}

export function executeEmpiricalCancellationTool(name: string, args: unknown) {
  if (name === 'domain.evaluate') return evaluateEmpiricalCancellation(args);
  if (name === 'domain.describe') return describeEmpiricalCancellation(args);
  return boundary(() => fail('Only domain.describe and domain.evaluate are available.', '$.name', 'UNKNOWN_TOOL'));
}

/** In-process experiment transport, not a claim of MCP registration. */
export const EMPIRICAL_CANCELLATION_TOOL_EXECUTOR: EmpiricalTools = Object.freeze({
  schemas: EMPIRICAL_CANCELLATION_TOOLS,
  async execute(call: EmpiricalToolCall, context: { readonly signal: AbortSignal }) {
    if (context.signal.aborted) return boundary(() => fail('Experiment call aborted.', '$', 'ABORTED'));
    return executeEmpiricalCancellationTool(call.name, call.arguments);
  },
});
