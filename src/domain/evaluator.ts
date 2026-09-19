/**
 * Pure, deterministic evaluation for the Domain v0 contract.
 *
 * The evaluator accepts either raw JSON or a parsed Domain catalog. It has no
 * access to time, I/O, storage, network, Worker APIs, or an LLM. Invalid
 * inputs are represented as an `error` result; callers never need to catch an
 * evaluator exception for normal domain failures.
 */

import {
  type DomainConditionResult,
  type DomainDecision,
  type DomainError,
  type DomainExpression,
  type DomainFunction,
  type DomainJsonObject,
  type DomainJsonValue,
  type DomainOperator,
  type DomainProvenance,
  type DomainResultStatus,
  type DomainRule,
  type DomainTraceEvent,
} from './contract';
import { parseDomain, type Domain } from './runtime';

export const MAX_EVALUATION_DEPTH = 128 as const;

export const EVALUATION_ERROR_CODES = [
  'INVALID_DOMAIN',
  'INVALID_FUNCTION',
  'INVALID_ARGS',
  'TYPE_MISMATCH',
  'MISSING_INPUT',
  'RULE_CONFLICT',
  'AMBIGUOUS_MATCH',
  'CYCLE_DETECTED',
  'RECURSION_LIMIT',
] as const;

export type EvaluationErrorCode = (typeof EVALUATION_ERROR_CODES)[number];

export interface EvaluationError {
  readonly code: EvaluationErrorCode;
  readonly message: string;
  readonly path?: string;
  readonly nodeId?: string;
  readonly ruleIds?: readonly string[];
}

export interface EvaluationResult {
  readonly status: DomainResultStatus;
  readonly value: boolean | null;
  /**
   * Function IDs selected by the name lookup. Duplicate-name ambiguity keeps
   * all IDs here in deterministic lexical order.
   */
  readonly matchedFunctionIds: readonly string[];
  readonly matchedRuleIds: readonly string[];
  readonly unresolvedPaths: readonly string[];
  readonly errors: readonly EvaluationError[];
  readonly trace: readonly DomainTraceEvent[];
  readonly provenance: DomainProvenance;
}

type Scalar = boolean | number | string | null;
type ExpressionState = 'value' | 'unresolved' | 'error';

interface ExpressionEvaluation {
  readonly state: ExpressionState;
  readonly value?: Scalar;
  readonly unresolvedPaths: readonly string[];
  readonly missingNodeIds: ReadonlyMap<string, string>;
  readonly errors: readonly EvaluationError[];
  readonly trace: readonly DomainTraceEvent[];
}

interface ArgumentValidation {
  readonly errors: readonly EvaluationError[];
}

interface EvaluationContext {
  readonly domainFunction: DomainFunction;
  readonly args: DomainJsonObject;
}

function freeze<T extends object>(value: T): T {
  return Object.freeze(value);
}

function uniqueInOrder(values: readonly string[]): readonly string[] {
  return freeze([...new Set(values)]);
}

function error(
  code: EvaluationErrorCode,
  message: string,
  details: Omit<EvaluationError, 'code' | 'message'> = {},
): EvaluationError {
  return freeze({ code, message, ...details });
}

function traceId(domainFunction: DomainFunction, suffix: string): string {
  return 'trace.' + domainFunction.id + '.' + suffix;
}

function event(
  domainFunction: DomainFunction,
  suffix: string,
  value: Omit<DomainTraceEvent, 'id'>,
): DomainTraceEvent {
  return freeze({ id: traceId(domainFunction, suffix), ...value });
}

function provenance(domainFunction?: DomainFunction, ruleIds: readonly string[] = []): DomainProvenance {
  return freeze({
    // A direct evaluation has no fixture identity. This stable sentinel keeps
    // the result shape identical to the #23 golden-result contract.
    fixtureId: 'evaluation',
    functionId: domainFunction?.id ?? '',
    policyId: domainFunction?.policy.id ?? '',
    inputPaths: freeze(domainFunction?.inputs.map((input) => input.path) ?? []),
    ruleIds: freeze([...ruleIds]),
  });
}

function result(
  status: DomainResultStatus,
  domainFunction?: DomainFunction,
  details: {
    value?: boolean | null;
    matchedFunctionIds?: readonly string[];
    matchedRuleIds?: readonly string[];
    unresolvedPaths?: readonly string[];
    errors?: readonly EvaluationError[];
    trace?: readonly DomainTraceEvent[];
  } = {},
): EvaluationResult {
  const matchedFunctionIds = freeze([
    ...(details.matchedFunctionIds
      ?? (domainFunction === undefined ? [] : [domainFunction.id])),
  ]);
  const matchedRuleIds = freeze([...(details.matchedRuleIds ?? [])]);
  const unresolvedPaths = freeze([...(details.unresolvedPaths ?? [])]);
  const errors = freeze([...(details.errors ?? [])]);
  const trace = freeze([...(details.trace ?? [])]);
  const value = details.value ?? (status === 'allow' ? true : status === 'deny' ? false : null);
  return freeze({
    status,
    value,
    matchedFunctionIds,
    matchedRuleIds,
    unresolvedPaths,
    errors,
    trace,
    provenance: provenance(domainFunction, status === 'unresolved' ? details.matchedRuleIds : matchedRuleIds),
  });
}

function scalarType(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return typeof value;
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readPath(args: DomainJsonObject, path: string): { readonly found: boolean; readonly value?: unknown } {
  let current: unknown = args;
  for (const segment of path.split('.')) {
    if (!isPlainRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false };
    }
    current = current[segment];
  }
  return { found: true, value: current };
}

function argumentErrors(domainFunction: DomainFunction, args: unknown): ArgumentValidation {
  const declared = new Map(domainFunction.inputs.map((input) => [input.path, input]));
  const declaredPaths = [...declared.keys()];
  const errors: EvaluationError[] = [];

  if (!isPlainRecord(args)) {
    return { errors: [error('INVALID_ARGS', 'Arguments must be a plain object.', { path: '$' })] };
  }

  const active = new WeakSet<object>();
  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > MAX_EVALUATION_DEPTH) {
      errors.push(error('RECURSION_LIMIT', 'Argument nesting exceeds the evaluation limit.', { path }));
      return;
    }
    if (value === null || typeof value !== 'object') {
      const declaration = declared.get(path);
      if (!declaration) {
        errors.push(error('INVALID_ARGS', "Unknown argument path '" + path + "'.", { path }));
        return;
      }
      const actual = scalarType(value);
      if (actual !== declaration.type) {
        errors.push(error(
          'TYPE_MISMATCH',
          "Expected " + declaration.type + " at '" + path + "', got " + actual + '.',
          { path, nodeId: domainFunction.policy.rules.map((rule) => findInputNode(rule.when, path)).find((nodeId) => nodeId !== undefined) },
        ));
      }
      return;
    }
    if (Array.isArray(value) || !isPlainRecord(value)) {
      errors.push(error('INVALID_ARGS', "Argument at '" + path + "' must be a plain JSON object or scalar.", { path }));
      return;
    }
    if (active.has(value)) {
      errors.push(error('CYCLE_DETECTED', "Cyclic arguments detected at '" + path + "'.", { path }));
      return;
    }
    if (declared.has(path)) {
      errors.push(error('INVALID_ARGS', "Argument path '" + path + "' must contain a scalar value.", { path }));
      return;
    }
    const isPrefix = path === '$'
      ? true
      : declaredPaths.some((declaredPath) => declaredPath.startsWith(path + '.'));
    if (!isPrefix) {
      errors.push(error('INVALID_ARGS', "Unknown argument path '" + path + "'.", { path }));
      return;
    }
    active.add(value);
    for (const key of Object.keys(value).sort()) {
      walk(value[key], path === '$' ? key : path + '.' + key, depth + 1);
    }
    active.delete(value);
  };

  walk(args, '$', 0);
  return { errors: freeze(errors) };
}

function appendEvent(
  domainFunction: DomainFunction,
  trace: readonly DomainTraceEvent[],
  next: DomainTraceEvent,
): readonly DomainTraceEvent[] {
  return [...trace, next];
}

function mergeMissing(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const merged = new Map(left);
  for (const [path, nodeId] of right) if (!merged.has(path)) merged.set(path, nodeId);
  return merged;
}

function withOperatorError(
  context: EvaluationContext,
  expression: DomainExpression,
  trace: readonly DomainTraceEvent[],
  errors: readonly EvaluationError[],
): ExpressionEvaluation {
  const operator = expression.kind === 'compare' || expression.kind === 'logical' ? expression.operator : 'not';
  return {
    state: 'error',
    unresolvedPaths: [],
    missingNodeIds: new Map(),
    errors,
    trace: appendEvent(context.domainFunction, trace, event(context.domainFunction, expression.id + '.operator', {
      stage: 'operator',
      nodeId: expression.id,
      operator,
      outcome: 'error',
    })),
  };
}

function evaluateExpression(
  context: EvaluationContext,
  expression: DomainExpression,
  depth: number,
): ExpressionEvaluation {
  if (depth > MAX_EVALUATION_DEPTH) {
    return {
      state: 'error',
      unresolvedPaths: [],
      missingNodeIds: new Map(),
      errors: [error('RECURSION_LIMIT', 'Expression nesting exceeds the evaluation limit.', { nodeId: expression.id })],
      trace: [],
    };
  }

  if (expression.kind === 'literal') {
    return { state: 'value', value: expression.value, unresolvedPaths: [], missingNodeIds: new Map(), errors: [], trace: [] };
  }

  if (expression.kind === 'input') {
    const observed = readPath(context.args, expression.path);
    if (!observed.found) {
      const missingNodeIds = new Map([[expression.path, expression.id]]);
      return {
        state: 'unresolved',
        unresolvedPaths: [expression.path],
        missingNodeIds,
        errors: [],
        trace: [event(context.domainFunction, expression.id + '.input', {
          stage: 'input',
          nodeId: expression.id,
          outcome: 'unresolved',
        })],
      };
    }
    const declaration = context.domainFunction.inputs.find((input) => input.path === expression.path);
    const actual = scalarType(observed.value);
    if (declaration !== undefined && actual !== declaration.type) {
      return {
        state: 'error',
        unresolvedPaths: [],
        missingNodeIds: new Map(),
        errors: [error(
          'TYPE_MISMATCH',
          "Expected " + declaration.type + " at '" + expression.path + "', got " + actual + '.',
          { path: expression.path, nodeId: expression.id },
        )],
        trace: [event(context.domainFunction, expression.id + '.input', {
          stage: 'input',
          nodeId: expression.id,
          outcome: 'error',
          observed: observed.value as DomainJsonValue,
        })],
      };
    }
    return {
      state: 'value',
      value: observed.value as Scalar,
      unresolvedPaths: [],
      missingNodeIds: new Map(),
      errors: [],
      trace: [event(context.domainFunction, expression.id + '.input', {
        stage: 'input',
        nodeId: expression.id,
        outcome: true,
        observed: observed.value as DomainJsonValue,
      })],
    };
  }

  if (expression.kind === 'not') {
    const operand = evaluateExpression(context, expression.operand, depth + 1);
    if (operand.state === 'error') return operand;
    if (operand.state === 'unresolved') return operand;
    if (typeof operand.value !== 'boolean') {
      return withOperatorError(context, expression, operand.trace, [error(
        'TYPE_MISMATCH',
        "Expected boolean for 'not' at '" + expression.id + "'.",
        { nodeId: expression.id },
      )]);
    }
    return {
      state: 'value',
      value: !operand.value,
      unresolvedPaths: [],
      missingNodeIds: new Map(),
      errors: [],
      trace: appendEvent(context.domainFunction, operand.trace, event(context.domainFunction, expression.id + '.operator', {
        stage: 'operator',
        nodeId: expression.id,
        operator: 'not',
        outcome: !operand.value,
        observed: !operand.value,
      })),
    };
  }

  if (expression.kind === 'compare') {
    const left = evaluateExpression(context, expression.left, depth + 1);
    const right = evaluateExpression(context, expression.right, depth + 1);
    const trace = [...left.trace, ...right.trace];
    if (left.state === 'error') return { ...left, trace };
    if (right.state === 'error') return { ...right, trace };
    const missingNodeIds = mergeMissing(left.missingNodeIds, right.missingNodeIds);
    const unresolvedPaths = uniqueInOrder([...left.unresolvedPaths, ...right.unresolvedPaths]);
    if (left.state === 'unresolved' || right.state === 'unresolved') {
      return { state: 'unresolved', unresolvedPaths, missingNodeIds, errors: [], trace };
    }
    const leftType = scalarType(left.value);
    const rightType = scalarType(right.value);
    const comparable = expression.operator === 'eq'
      ? leftType === rightType || leftType === 'null' || rightType === 'null'
      : leftType === 'number' && rightType === 'number';
    if (!comparable) {
      return withOperatorError(context, expression, trace, [error(
        'TYPE_MISMATCH',
        "Operands for '" + expression.operator + "' at '" + expression.id + "' have incompatible types.",
        { nodeId: expression.id },
      )]);
    }
    const leftValue = left.value as number | string | boolean | null;
    const rightValue = right.value as number | string | boolean | null;
    let comparison: boolean;
    if (expression.operator === 'eq') comparison = leftValue === rightValue;
    else if (expression.operator === 'lt') comparison = (leftValue as number) < (rightValue as number);
    else if (expression.operator === 'lte') comparison = (leftValue as number) <= (rightValue as number);
    else if (expression.operator === 'gt') comparison = (leftValue as number) > (rightValue as number);
    else comparison = (leftValue as number) >= (rightValue as number);
    return {
      state: 'value',
      value: comparison,
      unresolvedPaths: [],
      missingNodeIds: new Map(),
      errors: [],
      trace: appendEvent(context.domainFunction, trace, event(context.domainFunction, expression.id + '.operator', {
        stage: 'operator',
        nodeId: expression.id,
        operator: expression.operator,
        outcome: comparison,
        observed: comparison,
      })),
    };
  }

  const traces: DomainTraceEvent[] = [];
  const unresolvedPaths: string[] = [];
  let missingNodeIds: ReadonlyMap<string, string> = new Map();
  let sawUnresolved = false;
  for (const operand of expression.operands) {
    const evaluated = evaluateExpression(context, operand, depth + 1);
    traces.push(...evaluated.trace);
    if (evaluated.state === 'error') return { ...evaluated, trace: traces };
    missingNodeIds = mergeMissing(missingNodeIds, evaluated.missingNodeIds);
    unresolvedPaths.push(...evaluated.unresolvedPaths);
    if (evaluated.state === 'unresolved') sawUnresolved = true;
    if (expression.operator === 'and' && evaluated.state === 'value' && evaluated.value === false) {
      return {
        state: 'value',
        value: false,
        unresolvedPaths: [],
        missingNodeIds: new Map(),
        errors: [],
        trace: appendEvent(context.domainFunction, traces, event(context.domainFunction, expression.id + '.operator', {
          stage: 'operator',
          nodeId: expression.id,
          operator: expression.operator,
          outcome: false,
          observed: false,
        })),
      };
    }
    if (expression.operator === 'or' && evaluated.state === 'value' && evaluated.value === true) {
      return {
        state: 'value',
        value: true,
        unresolvedPaths: [],
        missingNodeIds: new Map(),
        errors: [],
        trace: appendEvent(context.domainFunction, traces, event(context.domainFunction, expression.id + '.operator', {
          stage: 'operator',
          nodeId: expression.id,
          operator: expression.operator,
          outcome: true,
          observed: true,
        })),
      };
    }
  }
  if (sawUnresolved) {
    return {
      state: 'unresolved',
      unresolvedPaths: uniqueInOrder(unresolvedPaths),
      missingNodeIds,
      errors: [],
      trace: traces,
    };
  }
  const logicalValue = expression.operator === 'and';
  return {
    state: 'value',
    value: logicalValue,
    unresolvedPaths: [],
    missingNodeIds: new Map(),
    errors: [],
    trace: appendEvent(context.domainFunction, traces, event(context.domainFunction, expression.id + '.operator', {
      stage: 'operator',
      nodeId: expression.id,
      operator: expression.operator,
      outcome: logicalValue,
      observed: logicalValue,
    })),
  };
}

function findInputNode(expression: DomainExpression, path: string): string | undefined {
  if (expression.kind === 'input') return expression.path === path ? expression.id : undefined;
  if (expression.kind === 'not') return findInputNode(expression.operand, path);
  if (expression.kind === 'compare') return findInputNode(expression.left, path) ?? findInputNode(expression.right, path);
  if (expression.kind === 'logical') {
    for (const operand of expression.operands) {
      const found = findInputNode(operand, path);
      if (found) return found;
    }
  }
  return undefined;
}

function evaluateFunction(context: EvaluationContext): EvaluationResult {
  const { domainFunction } = context;
  const candidates: Array<{ readonly rule: DomainRule; readonly evaluated: ExpressionEvaluation }> = [];
  const trace: DomainTraceEvent[] = [];

  for (const rule of domainFunction.policy.rules) {
    const evaluated = evaluateExpression(context, rule.when, 0);
    trace.push(...evaluated.trace);
    if (evaluated.state === 'error') {
      const policyTrace = event(domainFunction, domainFunction.policy.id + '.policy', {
        stage: 'policy',
        outcome: 'error',
      });
      return result('error', domainFunction, {
        errors: evaluated.errors,
        trace: [...trace, policyTrace],
      });
    }
    if (evaluated.state === 'value' && evaluated.value === true) {
      candidates.push({ rule, evaluated });
      trace.push(event(domainFunction, rule.id + '.rule', {
        stage: 'rule',
        ruleId: rule.id,
        outcome: rule.then,
      }));
    } else if (evaluated.state === 'unresolved') {
      candidates.push({ rule, evaluated });
      trace.push(event(domainFunction, rule.id + '.rule', {
        stage: 'rule',
        ruleId: rule.id,
        outcome: 'unresolved',
      }));
    }
  }

  if (candidates.length === 0) {
    const status = domainFunction.policy.defaultStatus;
    return result(status, domainFunction, {
      trace: [...trace, event(domainFunction, domainFunction.policy.id + '.policy', {
        stage: 'policy',
        outcome: status,
      })],
    });
  }

  const highestPriority = Math.max(...candidates.map((candidate) => candidate.rule.priority));
  const highest = candidates.filter((candidate) => candidate.rule.priority === highestPriority);
  const unresolved = highest.filter((candidate) => candidate.evaluated.state === 'unresolved');
  if (unresolved.length > 0) {
    const unresolvedPaths = uniqueInOrder(unresolved.flatMap((candidate) => candidate.evaluated.unresolvedPaths));
    const errors = unresolvedPaths.map((path) => error(
      'MISSING_INPUT',
      "Input '" + path + "' is absent.",
      {
        path,
        nodeId: unresolved.find((candidate) => candidate.evaluated.missingNodeIds.has(path))?.evaluated.missingNodeIds.get(path)
          ?? findInputNode(unresolved[0].rule.when, path),
      },
    ));
    return result('unresolved', domainFunction, {
      unresolvedPaths,
      errors,
      trace: [...trace, event(domainFunction, domainFunction.policy.id + '.policy', {
        stage: 'policy',
        outcome: 'unresolved',
      })],
    });
  }

  const decisions = new Set(highest.map((candidate) => candidate.rule.then));
  const matchedRuleIds = highest
    .map((candidate) => candidate.rule.id)
    .sort((left, right) => decisions.size === 1 ? left.localeCompare(right) : 0);
  if (decisions.size > 1) {
    const conflict = error(
      'RULE_CONFLICT',
      'Rules at the highest priority disagree.',
      { ruleIds: matchedRuleIds },
    );
    return result('conflict', domainFunction, {
      matchedRuleIds,
      errors: [conflict],
      trace: [...trace, event(domainFunction, domainFunction.policy.id + '.policy', {
        stage: 'policy',
        outcome: 'conflict',
      })],
    });
  }

  if (highest.length > 1) {
    const ambiguous = error(
      'AMBIGUOUS_MATCH',
      'Multiple highest-priority rules agree but do not identify a unique decision.',
      { ruleIds: matchedRuleIds },
    );
    return result('ambiguous', domainFunction, {
      matchedRuleIds,
      errors: [ambiguous],
      trace: [...trace, event(domainFunction, domainFunction.policy.id + '.policy', {
        stage: 'policy',
        outcome: 'ambiguous',
      })],
    });
  }

  const status = highest[0].rule.then;
  return result(status, domainFunction, { matchedRuleIds, trace });
}

function invalidDomainResult(parsed: ReturnType<typeof parseDomain>): EvaluationResult {
  if (parsed.ok) return result('error');
  const code: EvaluationErrorCode = parsed.error.code === 'CIRCULAR_REFERENCE' ? 'CYCLE_DETECTED' : 'INVALID_DOMAIN';
  return result('error', undefined, {
    errors: [error(code, parsed.error.message, { path: parsed.error.path })],
  });
}

/**
 * Evaluate a named Domain function against a JSON-like argument object.
 * Missing facts remain unresolved; they are never coerced to false.
 */
export function evaluate(domain: Domain | unknown, functionName: string, args: unknown): EvaluationResult {
  const parsed = parseDomain(domain);
  if (!parsed.ok) return invalidDomainResult(parsed);
  if (typeof functionName !== 'string' || functionName.length === 0 || functionName.trim() !== functionName) {
    return result('error', undefined, {
      errors: [error('INVALID_FUNCTION', 'Function name must be a non-empty, trimmed string.', { path: 'functionName' })],
    });
  }
  const matches = parsed.value.functions.filter((domainFunction) => domainFunction.name === functionName);
  if (matches.length === 0) {
    return result('error', undefined, {
      errors: [error('INVALID_FUNCTION', "Function '" + functionName + "' is not declared.", { path: 'functionName' })],
    });
  }
  if (matches.length > 1) {
    const matchedFunctionIds = matches
      .map((domainFunction) => domainFunction.id)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    return result('ambiguous', undefined, {
      matchedFunctionIds,
      errors: [error(
        'AMBIGUOUS_MATCH',
        "Function name '" + functionName + "' matches multiple declared functions.",
        { path: 'functionName' },
      )],
    });
  }
  const domainFunction = matches[0];
  const checkedArgs = argumentErrors(domainFunction, args);
  if (checkedArgs.errors.length > 0) {
    return result('error', domainFunction, { errors: checkedArgs.errors });
  }
  return evaluateFunction({ domainFunction, args: args as DomainJsonObject });
}

export type { DomainConditionResult, DomainDecision, DomainError, DomainOperator };
