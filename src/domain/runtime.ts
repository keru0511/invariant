/**
 * Runtime validation for the dependency-free Domain v0 JSON contract.
 *
 * This module is the boundary for unknown JSON. It validates the contract,
 * creates fresh values, and freezes the resulting graph. It intentionally
 * has no Worker, MCP, storage, network, or LLM dependency.
 */

import {
  DOMAIN_CONTRACT_VERSION,
  SUPPORTED_ERROR_CODES,
  SUPPORTED_NODE_KINDS,
  SUPPORTED_OPERATORS,
  SUPPORTED_RESULT_STATUSES,
  type DomainDecision,
  type DomainError,
  type DomainExpectedResult,
  type DomainExpression,
  type DomainFixtureCategory,
  type DomainFixtureManifest,
  type DomainFunction,
  type DomainGoldenFixture,
  type DomainInputDefinition,
  type DomainInputType,
  type DomainJsonObject,
  type DomainJsonValue,
  type DomainPolicy,
  type DomainProvenance,
  type DomainResolutionPolicy,
  type DomainResultStatus,
  type DomainRule,
  type DomainScalar,
  type DomainTraceEvent,
  type DomainTraceOutcome,
  type DomainTraceStage,
} from './contract';

export interface DomainCatalog {
  readonly contractVersion: typeof DOMAIN_CONTRACT_VERSION;
  readonly kind: 'function-catalog';
  readonly functions: readonly DomainFunction[];
}

export type Domain = DomainCatalog;

export const DOMAIN_PARSE_ERROR_CODES = [
  'INVALID_SHAPE',
  'MISSING_FIELD',
  'INVALID_DISCRIMINATOR',
  'UNSUPPORTED_VERSION',
  'UNSUPPORTED_OPERATOR',
  'UNSUPPORTED_FIELD',
  'INVALID_VALUE',
  'DUPLICATE_ID',
  'INVALID_REFERENCE',
  'TYPE_MISMATCH',
  'CIRCULAR_REFERENCE',
] as const;

export type DomainParseErrorCode = (typeof DOMAIN_PARSE_ERROR_CODES)[number];

export interface DomainParseError {
  readonly code: DomainParseErrorCode;
  readonly path: string;
  readonly message: string;
  readonly expected?: string;
  readonly actual?: string;
}

export type DomainParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DomainParseError };

export class DomainValidationError extends Error {
  readonly name = 'DomainValidationError';
  readonly code: DomainParseErrorCode;
  readonly path: string;
  readonly error: DomainParseError;

  constructor(error: DomainParseError) {
    super(error.code + ' at ' + error.path + ': ' + error.message);
    this.code = error.code;
    this.path = error.path;
    this.error = error;
  }
}

type ExpressionType = DomainInputType | 'unknown';
type CompareOperator = 'eq' | 'lt' | 'lte' | 'gt' | 'gte';

interface ParsedExpression {
  readonly node: DomainExpression;
  readonly type: ExpressionType;
}

interface ParseContext {
  readonly identifiers: Set<string>;
  readonly inputTypes?: Map<string, DomainInputType>;
}

interface InternalParser {
  readonly context: ParseContext;
  readonly activeObjects: WeakSet<object>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function actualType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function quoted(value: unknown): string {
  if (typeof value === 'string') return "'" + value + "'";
  if (value === null) return 'null';
  return actualType(value);
}

function makeError(
  code: DomainParseErrorCode,
  path: string,
  message: string,
  expected?: string,
  actual?: string,
): DomainParseError {
  const error: {
    code: DomainParseErrorCode;
    path: string;
    message: string;
    expected?: string;
    actual?: string;
  } = { code, path, message };
  if (expected !== undefined) error.expected = expected;
  if (actual !== undefined) error.actual = actual;
  return Object.freeze(error);
}

function failure<T = never>(error: DomainParseError): DomainParseResult<T> {
  return Object.freeze({ ok: false as const, error });
}

function success<T>(value: T): DomainParseResult<T> {
  return Object.freeze({ ok: true as const, value });
}

function isFailure<T>(
  result: DomainParseResult<T>,
): result is { readonly ok: false; readonly error: DomainParseError } {
  return !result.ok;
}

function childPath(path: string, key: string): string {
  return path === '$' ? key : path + '.' + key;
}

function indexPath(path: string, index: number): string {
  return path + '[' + index + ']';
}

function readRecord(value: unknown, path: string): DomainParseResult<Record<string, unknown>> {
  if (!isRecord(value)) {
    return failure(
      makeError(
        'INVALID_SHAPE',
        path,
        "Expected an object at '" + path + "', got " + actualType(value) + '.',
        'object',
        actualType(value),
      ),
    );
  }
  return success(value);
}

function readField(
  record: Record<string, unknown>,
  key: string,
  path: string,
): DomainParseResult<unknown> {
  const fieldPath = childPath(path, key);
  if (!hasOwn(record, key)) {
    return failure(makeError('MISSING_FIELD', fieldPath, "Missing required field '" + fieldPath + "'."));
  }
  return success(record[key]);
}

function readString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): DomainParseResult<string> {
  const value = readField(record, key, path);
  if (isFailure(value)) return failure(value.error);
  if (typeof value.value !== 'string') {
    const fieldPath = childPath(path, key);
    return failure(
      makeError(
        'INVALID_SHAPE',
        fieldPath,
        "Expected string at '" + fieldPath + "', got " + actualType(value.value) + '.',
        'string',
        actualType(value.value),
      ),
    );
  }
  return success(value.value);
}

function readBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
): DomainParseResult<boolean> {
  const value = readField(record, key, path);
  if (isFailure(value)) return failure(value.error);
  if (typeof value.value !== 'boolean') {
    const fieldPath = childPath(path, key);
    return failure(
      makeError(
        'INVALID_SHAPE',
        fieldPath,
        "Expected boolean at '" + fieldPath + "', got " + actualType(value.value) + '.',
        'boolean',
        actualType(value.value),
      ),
    );
  }
  return success(value.value);
}

function readFiniteNumber(
  record: Record<string, unknown>,
  key: string,
  path: string,
): DomainParseResult<number> {
  const value = readField(record, key, path);
  if (isFailure(value)) return failure(value.error);
  if (typeof value.value !== 'number' || !Number.isFinite(value.value)) {
    const fieldPath = childPath(path, key);
    return failure(
      makeError(
        'INVALID_VALUE',
        fieldPath,
        "Expected a finite number at '" + fieldPath + "', got " + actualType(value.value) + '.',
        'finite number',
        actualType(value.value),
      ),
    );
  }
  return success(value.value);
}

function readArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
): DomainParseResult<readonly unknown[]> {
  const value = readField(record, key, path);
  if (isFailure(value)) return failure(value.error);
  if (!Array.isArray(value.value)) {
    const fieldPath = childPath(path, key);
    return failure(
      makeError(
        'INVALID_SHAPE',
        fieldPath,
        "Expected an array at '" + fieldPath + "', got " + actualType(value.value) + '.',
        'array',
        actualType(value.value),
      ),
    );
  }
  return success(value.value);
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): DomainParseResult<true> {
  const allowedFields = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedFields.has(key)) {
      const fieldPath = childPath(path, key);
      return failure(makeError('UNSUPPORTED_FIELD', fieldPath, "Unsupported field '" + fieldPath + "'."));
    }
  }
  return success(true);
}

function readNonEmptyString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): DomainParseResult<string> {
  const value = readString(record, key, path);
  if (isFailure(value)) return value;
  if (value.value.length === 0 || value.value.trim() !== value.value) {
    const fieldPath = childPath(path, key);
    return failure(makeError('INVALID_VALUE', fieldPath, "Expected a non-empty token at '" + fieldPath + "'."));
  }
  return value;
}

function readPath(
  record: Record<string, unknown>,
  key: string,
  path: string,
): DomainParseResult<string> {
  const value = readNonEmptyString(record, key, path);
  if (isFailure(value)) return value;
  if (!/^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/.test(value.value)) {
    const fieldPath = childPath(path, key);
    return failure(
      makeError(
        'INVALID_VALUE',
        fieldPath,
        "Input path at '" + fieldPath + "' must be a dotted identifier path.",
      ),
    );
  }
  return value;
}

function readIdentifier(
  record: Record<string, unknown>,
  path: string,
  context: ParseContext,
): DomainParseResult<string> {
  const value = readNonEmptyString(record, 'id', path);
  if (isFailure(value)) return value;
  if (context.identifiers.has(value.value)) {
    const fieldPath = childPath(path, 'id');
    return failure(
      makeError(
        'DUPLICATE_ID',
        fieldPath,
        "Identifier '" + value.value + "' is declared more than once.",
      ),
    );
  }
  context.identifiers.add(value.value);
  return value;
}

function readEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  path: string,
  values: ReadonlySet<string>,
  expected: string,
): DomainParseResult<T> {
  const value = readString(record, key, path);
  if (isFailure(value)) return value;
  if (!values.has(value.value)) {
    const fieldPath = childPath(path, key);
    return failure(
      makeError(
        'INVALID_VALUE',
        fieldPath,
        "Unsupported value at '" + fieldPath + "': " + quoted(value.value) + '.',
        expected,
        value.value,
      ),
    );
  }
  return success(value.value as T);
}

const INPUT_TYPES = new Set<string>(['boolean', 'number', 'string']);
const DECISIONS = new Set<string>(['allow', 'deny']);
const DEFAULT_STATUSES = new Set<string>(['allow', 'deny', 'unresolved']);
const RESOLUTION_PRIORITIES = new Set<string>(['highest']);
const RESOLUTION_UNRESOLVED = new Set<string>(['unresolved']);
const RESOLUTION_CONFLICT = new Set<string>(['conflict']);
const RESOLUTION_NO_MATCH = new Set<string>(['default']);
const NODE_KINDS = new Set<string>(SUPPORTED_NODE_KINDS);
const OPERATORS = new Set<string>(SUPPORTED_OPERATORS);
const RESULT_STATUSES = new Set<string>(SUPPORTED_RESULT_STATUSES);
const ERROR_CODES = new Set<string>(SUPPORTED_ERROR_CODES);
const FIXTURE_CATEGORIES = new Set<string>(['valid', 'boundary', 'unresolved', 'conflict', 'invalid']);
const TRACE_STAGES = new Set<string>(['input', 'literal', 'operator', 'rule', 'policy']);
const TRACE_OUTCOMES = new Set<string>(['unresolved', 'allow', 'deny', 'conflict', 'error']);

function isCompareOperator(value: string): value is CompareOperator {
  return value === 'eq' || value === 'lt' || value === 'lte' || value === 'gt' || value === 'gte';
}

function isDomainScalar(value: unknown): value is DomainScalar {
  return (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function isJsonValue(value: unknown, active: WeakSet<object>): value is DomainJsonValue {
  if (value === null) return true;
  if (typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) return false;
  if (active.has(value)) return false;
  active.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isJsonValue(item, active)) {
        valid = false;
        break;
      }
    }
  } else {
    for (const item of Object.values(value)) {
      if (!isJsonValue(item, active)) {
        valid = false;
        break;
      }
    }
  }
  active.delete(value);
  return valid;
}

function cloneJsonValue(value: unknown, path: string): DomainParseResult<DomainJsonValue> {
  if (!isJsonValue(value, new WeakSet<object>())) {
    return failure(
      makeError(
        'INVALID_VALUE',
        path,
        "Expected a JSON-serializable value at '" + path + "', got " + actualType(value) + '.',
      ),
    );
  }
  if (value === null || typeof value !== 'object') return success(value);
  if (Array.isArray(value)) {
    const items: DomainJsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = cloneJsonValue(value[index], indexPath(path, index));
      if (isFailure(item)) return item;
      items.push(item.value);
    }
    return success(items);
  }
  const entries: Array<readonly [string, DomainJsonValue]> = [];
  for (const [key, child] of Object.entries(value)) {
    const parsed = cloneJsonValue(child, childPath(path, key));
    if (isFailure(parsed)) return parsed;
    entries.push([key, parsed.value]);
  }
  return success(Object.fromEntries(entries));
}

function parseInputDefinition(
  value: unknown,
  path: string,
  context: ParseContext,
): DomainParseResult<DomainInputDefinition> {
  const record = readRecord(value, path);
  if (isFailure(record)) return record;
  const fields = rejectUnknownFields(record.value, ['path', 'type', 'required'], path);
  if (isFailure(fields)) return fields;
  const inputPath = readPath(record.value, 'path', path);
  if (isFailure(inputPath)) return inputPath;
  const inputType = readEnum<DomainInputType>(
    record.value,
    'type',
    path,
    INPUT_TYPES,
    'boolean | number | string',
  );
  if (isFailure(inputType)) return inputType;
  const required = readBoolean(record.value, 'required', path);
  if (isFailure(required)) return required;
  if (context.inputTypes !== undefined && context.inputTypes.has(inputPath.value)) {
    const fieldPath = childPath(path, 'path');
    return failure(
      makeError(
        'DUPLICATE_ID',
        fieldPath,
        "Input path '" + inputPath.value + "' is declared more than once.",
      ),
    );
  }
  context.inputTypes?.set(inputPath.value, inputType.value);
  return success(
    Object.freeze({
      path: inputPath.value,
      type: inputType.value,
      required: required.value,
    }),
  );
}

function parseExpressionValue(
  value: unknown,
  path: string,
  parser: InternalParser,
): DomainParseResult<ParsedExpression> {
  const record = readRecord(value, path);
  if (isFailure(record)) return record;
  if (parser.activeObjects.has(record.value)) {
    return failure(makeError('CIRCULAR_REFERENCE', path, "Circular expression reference at '" + path + "'."));
  }
  parser.activeObjects.add(record.value);
  try {
    const kindValue = readString(record.value, 'kind', path);
    if (isFailure(kindValue)) return kindValue;
    if (!NODE_KINDS.has(kindValue.value)) {
      const fieldPath = childPath(path, 'kind');
      return failure(
        makeError(
          'INVALID_DISCRIMINATOR',
          fieldPath,
          "Unsupported node kind at '" + fieldPath + "': " + quoted(kindValue.value) + '.',
          SUPPORTED_NODE_KINDS.join(' | '),
          kindValue.value,
        ),
      );
    }

    if (kindValue.value === 'literal') {
      const fields = rejectUnknownFields(record.value, ['id', 'kind', 'value'], path);
      if (isFailure(fields)) return fields;
      const id = readIdentifier(record.value, path, parser.context);
      if (isFailure(id)) return id;
      const literal = readField(record.value, 'value', path);
      if (isFailure(literal)) return failure(literal.error);
      if (!isDomainScalar(literal.value)) {
        const fieldPath = childPath(path, 'value');
        return failure(
          makeError(
            'INVALID_VALUE',
            fieldPath,
            "Literal value at '" + fieldPath + "' must be a JSON scalar.",
            'boolean | number | string | null',
            actualType(literal.value),
          ),
        );
      }
      const node = Object.freeze({ id: id.value, kind: 'literal' as const, value: literal.value });
      const type: ExpressionType =
        typeof literal.value === 'boolean'
          ? 'boolean'
          : typeof literal.value === 'number'
            ? 'number'
            : typeof literal.value === 'string'
              ? 'string'
              : 'unknown';
      return success({ node, type });
    }

    if (kindValue.value === 'input') {
      const fields = rejectUnknownFields(record.value, ['id', 'kind', 'path'], path);
      if (isFailure(fields)) return fields;
      const id = readIdentifier(record.value, path, parser.context);
      if (isFailure(id)) return id;
      const inputPath = readPath(record.value, 'path', path);
      if (isFailure(inputPath)) return inputPath;
      const declaredType = parser.context.inputTypes?.get(inputPath.value);
      if (parser.context.inputTypes !== undefined && declaredType === undefined) {
        const fieldPath = childPath(path, 'path');
        return failure(
          makeError(
            'INVALID_REFERENCE',
            fieldPath,
            "Input path '" + inputPath.value + "' is not declared by the function.",
          ),
        );
      }
      const node = Object.freeze({ id: id.value, kind: 'input' as const, path: inputPath.value });
      return success({ node, type: declaredType ?? 'unknown' });
    }

    if (kindValue.value === 'compare') {
      const fields = rejectUnknownFields(record.value, ['id', 'kind', 'operator', 'left', 'right'], path);
      if (isFailure(fields)) return fields;
      const id = readIdentifier(record.value, path, parser.context);
      if (isFailure(id)) return id;
      const operator = readString(record.value, 'operator', path);
      if (isFailure(operator)) return operator;
      if (!isCompareOperator(operator.value)) {
        const fieldPath = childPath(path, 'operator');
        return failure(
          makeError(
            'UNSUPPORTED_OPERATOR',
            fieldPath,
            "Unsupported comparison operator at '" + fieldPath + "': " + quoted(operator.value) + '.',
            'eq | lt | lte | gt | gte',
            operator.value,
          ),
        );
      }
      const left = parseExpressionValue(record.value.left, childPath(path, 'left'), parser);
      if (isFailure(left)) return left;
      const right = parseExpressionValue(record.value.right, childPath(path, 'right'), parser);
      if (isFailure(right)) return right;
      const comparable =
        operator.value === 'eq'
          ? left.value.type === 'unknown' ||
            right.value.type === 'unknown' ||
            left.value.type === right.value.type
          : left.value.type === 'number' && right.value.type === 'number';
      if (!comparable) {
        return failure(
          makeError(
            'TYPE_MISMATCH',
            childPath(path, 'operator'),
            "Operands for '" + operator.value + "' at '" + path + "' have incompatible types.",
          ),
        );
      }
      const node = Object.freeze({
        id: id.value,
        kind: 'compare' as const,
        operator: operator.value,
        left: left.value.node,
        right: right.value.node,
      });
      return success({ node, type: 'boolean' });
    }

    if (kindValue.value === 'logical') {
      const fields = rejectUnknownFields(record.value, ['id', 'kind', 'operator', 'operands'], path);
      if (isFailure(fields)) return fields;
      const id = readIdentifier(record.value, path, parser.context);
      if (isFailure(id)) return id;
      const operator = readString(record.value, 'operator', path);
      if (isFailure(operator)) return operator;
      if (operator.value !== 'and' && operator.value !== 'or') {
        const fieldPath = childPath(path, 'operator');
        return failure(
          makeError(
            'UNSUPPORTED_OPERATOR',
            fieldPath,
            "Unsupported logical operator at '" + fieldPath + "': " + quoted(operator.value) + '.',
            'and | or',
            operator.value,
          ),
        );
      }
      const operands = readArray(record.value, 'operands', path);
      if (isFailure(operands)) return operands;
      if (operands.value.length < 2) {
        const fieldPath = childPath(path, 'operands');
        return failure(
          makeError(
            'INVALID_VALUE',
            fieldPath,
            "Logical operator '" + operator.value + "' at '" + fieldPath + "' requires at least two operands.",
          ),
        );
      }
      const parsedOperands: DomainExpression[] = [];
      for (let index = 0; index < operands.value.length; index += 1) {
        const operand = parseExpressionValue(
          operands.value[index],
          indexPath(childPath(path, 'operands'), index),
          parser,
        );
        if (isFailure(operand)) return operand;
        if (operand.value.type !== 'boolean') {
          return failure(
            makeError(
              'TYPE_MISMATCH',
              indexPath(childPath(path, 'operands'), index),
              "Logical operand at '" +
                indexPath(childPath(path, 'operands'), index) +
                "' must be boolean.",
            ),
          );
        }
        parsedOperands.push(operand.value.node);
      }
      const node = Object.freeze({
        id: id.value,
        kind: 'logical' as const,
        operator: operator.value,
        operands: Object.freeze(parsedOperands),
      });
      return success({ node, type: 'boolean' });
    }

    const fields = rejectUnknownFields(record.value, ['id', 'kind', 'operand'], path);
    if (isFailure(fields)) return fields;
    const id = readIdentifier(record.value, path, parser.context);
    if (isFailure(id)) return id;
    const operand = parseExpressionValue(record.value.operand, childPath(path, 'operand'), parser);
    if (isFailure(operand)) return operand;
    if (operand.value.type !== 'boolean') {
      return failure(
        makeError(
          'TYPE_MISMATCH',
          childPath(path, 'operand'),
          "Not operand at '" + childPath(path, 'operand') + "' must be boolean.",
        ),
      );
    }
    const node = Object.freeze({ id: id.value, kind: 'not' as const, operand: operand.value.node });
    return success({ node, type: 'boolean' });
  } finally {
    parser.activeObjects.delete(record.value);
  }
}

export function parseExpression(value: unknown): DomainParseResult<DomainExpression> {
  const parser: InternalParser = {
    context: { identifiers: new Set<string>() },
    activeObjects: new WeakSet<object>(),
  };
  const parsed = parseExpressionValue(value, '$', parser);
  if (isFailure(parsed)) return parsed;
  return success(deepFreeze(parsed.value.node));
}

function parseResolution(
  value: unknown,
  path: string,
): DomainParseResult<DomainResolutionPolicy> {
  const record = readRecord(value, path);
  if (isFailure(record)) return record;
  const fields = rejectUnknownFields(
    record.value,
    ['priority', 'unresolved', 'conflict', 'noMatch'],
    path,
  );
  if (isFailure(fields)) return fields;
  const priority = readEnum<'highest'>(
    record.value,
    'priority',
    path,
    new Set<string>(['highest']),
    'highest',
  );
  if (isFailure(priority)) return priority;
  const unresolved = readEnum<'unresolved'>(
    record.value,
    'unresolved',
    path,
    new Set<string>(['unresolved']),
    'unresolved',
  );
  if (isFailure(unresolved)) return unresolved;
  const conflict = readEnum<'conflict'>(
    record.value,
    'conflict',
    path,
    new Set<string>(['conflict']),
    'conflict',
  );
  if (isFailure(conflict)) return conflict;
  const noMatch = readEnum<'default'>(
    record.value,
    'noMatch',
    path,
    new Set<string>(['default']),
    'default',
  );
  if (isFailure(noMatch)) return noMatch;
  return success(Object.freeze({
    priority: priority.value,
    unresolved: unresolved.value,
    conflict: conflict.value,
    noMatch: noMatch.value,
  }));
}

function parseRule(
  value: unknown,
  path: string,
  parser: InternalParser,
): DomainParseResult<DomainRule> {
  const record = readRecord(value, path);
  if (isFailure(record)) return record;
  const fields = rejectUnknownFields(record.value, ['id', 'priority', 'when', 'then'], path);
  if (isFailure(fields)) return fields;
  const id = readIdentifier(record.value, path, parser.context);
  if (isFailure(id)) return id;
  const priority = readFiniteNumber(record.value, 'priority', path);
  if (isFailure(priority)) return priority;
  const when = parseExpressionValue(record.value.when, childPath(path, 'when'), parser);
  if (isFailure(when)) return when;
  if (when.value.type !== 'boolean') {
    return failure(
      makeError(
        'TYPE_MISMATCH',
        childPath(path, 'when'),
        "Rule condition at '" + childPath(path, 'when') + "' must be boolean.",
      ),
    );
  }
  const decision = readEnum<DomainDecision>(
    record.value,
    'then',
    path,
    new Set<string>(['allow', 'deny']),
    'allow | deny',
  );
  if (isFailure(decision)) return decision;
  return success(Object.freeze({
    id: id.value,
    priority: priority.value,
    when: when.value.node,
    then: decision.value,
  }));
}

function parsePolicy(
  value: unknown,
  path: string,
  parser: InternalParser,
): DomainParseResult<DomainPolicy> {
  const record = readRecord(value, path);
  if (isFailure(record)) return record;
  const fields = rejectUnknownFields(
    record.value,
    ['id', 'defaultStatus', 'resolution', 'rules'],
    path,
  );
  if (isFailure(fields)) return fields;
  const id = readIdentifier(record.value, path, parser.context);
  if (isFailure(id)) return id;
  const defaultStatus = readEnum<DomainDecision | 'unresolved'>(
    record.value,
    'defaultStatus',
    path,
    new Set<string>(['allow', 'deny', 'unresolved']),
    'allow | deny | unresolved',
  );
  if (isFailure(defaultStatus)) return defaultStatus;
  const resolution = parseResolution(record.value.resolution, childPath(path, 'resolution'));
  if (isFailure(resolution)) return resolution;
  const rules = readArray(record.value, 'rules', path);
  if (isFailure(rules)) return rules;
  const parsedRules: DomainRule[] = [];
  for (let index = 0; index < rules.value.length; index += 1) {
    const rule = parseRule(
      rules.value[index],
      indexPath(childPath(path, 'rules'), index),
      parser,
    );
    if (isFailure(rule)) return rule;
    parsedRules.push(rule.value);
  }
  return success(Object.freeze({
    id: id.value,
    defaultStatus: defaultStatus.value,
    resolution: resolution.value,
    rules: Object.freeze(parsedRules),
  }));
}

function parseFunctionValue(
  value: unknown,
  path: string,
  identifiers: Set<string>,
): DomainParseResult<DomainFunction> {
  const record = readRecord(value, path);
  if (isFailure(record)) return record;
  const fields = rejectUnknownFields(
    record.value,
    ['id', 'name', 'description', 'inputs', 'policy'],
    path,
  );
  if (isFailure(fields)) return fields;

  const context: ParseContext = {
    identifiers,
    inputTypes: new Map<string, DomainInputType>(),
  };
  const id = readIdentifier(record.value, path, context);
  if (isFailure(id)) return id;
  const name = readNonEmptyString(record.value, 'name', path);
  if (isFailure(name)) return name;
  const description = readString(record.value, 'description', path);
  if (isFailure(description)) return description;
  const inputs = readArray(record.value, 'inputs', path);
  if (isFailure(inputs)) return inputs;
  const parsedInputs: DomainInputDefinition[] = [];
  for (let index = 0; index < inputs.value.length; index += 1) {
    const input = parseInputDefinition(
      inputs.value[index],
      indexPath(childPath(path, 'inputs'), index),
      context,
    );
    if (isFailure(input)) return input;
    parsedInputs.push(input.value);
  }
  const parser: InternalParser = {
    context,
    activeObjects: new WeakSet<object>(),
  };
  const policy = parsePolicy(record.value.policy, childPath(path, 'policy'), parser);
  if (isFailure(policy)) return policy;
  return success(Object.freeze({
    id: id.value,
    name: name.value,
    description: description.value,
    inputs: Object.freeze(parsedInputs),
    policy: policy.value,
  }));
}

export function parseFunction(value: unknown): DomainParseResult<DomainFunction> {
  return parseFunctionValue(value, '$', new Set<string>());
}

function parseDomainValue(value: unknown): DomainParseResult<DomainCatalog> {
  const record = readRecord(value, '$');
  if (isFailure(record)) return record;
  const fields = rejectUnknownFields(record.value, ['contractVersion', 'kind', 'functions'], '$');
  if (isFailure(fields)) return fields;
  const version = readString(record.value, 'contractVersion', '$');
  if (isFailure(version)) return version;
  if (version.value !== DOMAIN_CONTRACT_VERSION) {
    return failure(makeError(
      'UNSUPPORTED_VERSION',
      'contractVersion',
      'Unsupported contract version: ' + quoted(version.value) + '.',
      DOMAIN_CONTRACT_VERSION,
      version.value,
    ));
  }
  const kind = readString(record.value, 'kind', '$');
  if (isFailure(kind)) return kind;
  if (kind.value !== 'function-catalog') {
    return failure(makeError(
      'INVALID_DISCRIMINATOR',
      'kind',
      'Unsupported catalog kind: ' + quoted(kind.value) + '.',
      'function-catalog',
      kind.value,
    ));
  }
  const functions = readArray(record.value, 'functions', '$');
  if (isFailure(functions)) return functions;
  const identifiers = new Set<string>();
  const parsedFunctions: DomainFunction[] = [];
  for (let index = 0; index < functions.value.length; index += 1) {
    const domainFunction = parseFunctionValue(
      functions.value[index],
      indexPath('functions', index),
      identifiers,
    );
    if (isFailure(domainFunction)) return domainFunction;
    parsedFunctions.push(domainFunction.value);
  }
  return success(Object.freeze({
    contractVersion: DOMAIN_CONTRACT_VERSION,
    kind: 'function-catalog' as const,
    functions: Object.freeze(parsedFunctions),
  }));
}

export function parseDomain(value: unknown): DomainParseResult<DomainCatalog> {
  const parsed = parseDomainValue(value);
  if (isFailure(parsed)) return parsed;
  return success(deepFreeze(parsed.value));
}

function parseStringArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
  unique: boolean,
): DomainParseResult<readonly string[]> {
  const values = readArray(record, key, path);
  if (isFailure(values)) return values;
  const parsed: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < values.value.length; index += 1) {
    const item = values.value[index];
    const itemPath = indexPath(childPath(path, key), index);
    if (typeof item !== 'string' || item.length === 0 || item.trim() !== item) {
      return failure(makeError(
        'INVALID_SHAPE',
        itemPath,
        "Expected a non-empty string at '" + itemPath + "', got " + actualType(item) + '.',
        'string',
        actualType(item),
      ));
    }
    if (unique && seen.has(item)) {
      return failure(makeError('DUPLICATE_ID', itemPath, "Value '" + item + "' is repeated."));
    }
    seen.add(item);
    parsed.push(item);
  }
  return success(Object.freeze(parsed));
}

function parseDomainError(value: unknown, path: string): DomainParseResult<DomainError> {
  const record = readRecord(value, path);
  if (isFailure(record)) return record;
  const fields = rejectUnknownFields(
    record.value,
    ['code', 'message', 'path', 'nodeId', 'ruleIds'],
    path,
  );
  if (isFailure(fields)) return fields;
  const code = readString(record.value, 'code', path);
  if (isFailure(code)) return code;
  if (!ERROR_CODES.has(code.value)) {
    return failure(makeError(
      'INVALID_VALUE',
      childPath(path, 'code'),
      "Unsupported domain error code at '" + childPath(path, 'code') + "': " + quoted(code.value) + '.',
      SUPPORTED_ERROR_CODES.join(' | '),
      code.value,
    ));
  }
  const message = readNonEmptyString(record.value, 'message', path);
  if (isFailure(message)) return message;
  const parsed: {
    code: DomainError['code'];
    message: string;
    path?: string;
    nodeId?: string;
    ruleIds?: readonly string[];
  } = {
    code: code.value as DomainError['code'],
    message: message.value,
  };
  for (const optionalKey of ['path', 'nodeId'] as const) {
    if (!hasOwn(record.value, optionalKey)) continue;
    const optionalValue = readNonEmptyString(record.value, optionalKey, path);
    if (isFailure(optionalValue)) return optionalValue;
    parsed[optionalKey] = optionalValue.value;
  }
  if (hasOwn(record.value, 'ruleIds')) {
    const ruleIds = parseStringArray(record.value, 'ruleIds', path, true);
    if (isFailure(ruleIds)) return ruleIds;
    parsed.ruleIds = ruleIds.value;
  }
  return success(Object.freeze(parsed));
}

function parseTraceEvent(value: unknown, path: string): DomainParseResult<DomainTraceEvent> {
  const record = readRecord(value, path);
  if (isFailure(record)) return record;
  const fields = rejectUnknownFields(
    record.value,
    ['id', 'stage', 'nodeId', 'ruleId', 'operator', 'outcome', 'observed'],
    path,
  );
  if (isFailure(fields)) return fields;
  const id = readNonEmptyString(record.value, 'id', path);
  if (isFailure(id)) return id;
  const stage = readString(record.value, 'stage', path);
  if (isFailure(stage)) return stage;
  if (!TRACE_STAGES.has(stage.value)) {
    return failure(makeError(
      'INVALID_VALUE',
      childPath(path, 'stage'),
      "Unsupported trace stage at '" + childPath(path, 'stage') + "': " + quoted(stage.value) + '.',
    ));
  }
  const outcomeValue = readField(record.value, 'outcome', path);
  if (isFailure(outcomeValue)) return outcomeValue;
  const outcome: DomainTraceOutcome | undefined =
    typeof outcomeValue.value === 'boolean'
      ? outcomeValue.value
      : typeof outcomeValue.value === 'string' && TRACE_OUTCOMES.has(outcomeValue.value)
        ? (outcomeValue.value as DomainTraceOutcome)
        : undefined;
  if (outcome === undefined) {
    return failure(makeError(
      'INVALID_VALUE',
      childPath(path, 'outcome'),
      "Unsupported trace outcome at '" + childPath(path, 'outcome') + "'.",
    ));
  }

  const parsed: {
    id: string;
    stage: DomainTraceStage;
    nodeId?: string;
    ruleId?: string;
    operator?: DomainTraceEvent['operator'];
    outcome: DomainTraceOutcome;
    observed?: DomainJsonValue;
  } = {
    id: id.value,
    stage: stage.value as DomainTraceStage,
    outcome,
  };
  for (const optionalKey of ['nodeId', 'ruleId'] as const) {
    if (!hasOwn(record.value, optionalKey)) continue;
    const optionalValue = readNonEmptyString(record.value, optionalKey, path);
    if (isFailure(optionalValue)) return optionalValue;
    parsed[optionalKey] = optionalValue.value;
  }
  if (hasOwn(record.value, 'operator')) {
    const operator = readString(record.value, 'operator', path);
    if (isFailure(operator)) return operator;
    if (!OPERATORS.has(operator.value)) {
      return failure(makeError(
        'UNSUPPORTED_OPERATOR',
        childPath(path, 'operator'),
        "Unsupported trace operator at '" + childPath(path, 'operator') + "': " + quoted(operator.value) + '.',
      ));
    }
    parsed.operator = operator.value as DomainTraceEvent['operator'];
  }
  if (hasOwn(record.value, 'observed')) {
    const observed = cloneJsonValue(record.value.observed, childPath(path, 'observed'));
    if (isFailure(observed)) return observed;
    parsed.observed = observed.value;
  }
  return success(Object.freeze(parsed));
}

function parseProvenance(value: unknown, path: string): DomainParseResult<DomainProvenance> {
  const record = readRecord(value, path);
  if (isFailure(record)) return record;
  const fields = rejectUnknownFields(
    record.value,
    ['fixtureId', 'functionId', 'policyId', 'inputPaths', 'ruleIds'],
    path,
  );
  if (isFailure(fields)) return fields;
  const fixtureId = readNonEmptyString(record.value, 'fixtureId', path);
  if (isFailure(fixtureId)) return fixtureId;
  const functionId = readNonEmptyString(record.value, 'functionId', path);
  if (isFailure(functionId)) return functionId;
  const policyId = readNonEmptyString(record.value, 'policyId', path);
  if (isFailure(policyId)) return policyId;
  const inputPaths = parseStringArray(record.value, 'inputPaths', path, true);
  if (isFailure(inputPaths)) return inputPaths;
  const ruleIds = parseStringArray(record.value, 'ruleIds', path, true);
  if (isFailure(ruleIds)) return ruleIds;
  return success(Object.freeze({
    fixtureId: fixtureId.value,
    functionId: functionId.value,
    policyId: policyId.value,
    inputPaths: inputPaths.value,
    ruleIds: ruleIds.value,
  }));
}

export function parseExpectedResult(
  value: unknown,
  rootPath = '$',
): DomainParseResult<DomainExpectedResult> {
  const record = readRecord(value, rootPath);
  if (isFailure(record)) return record;
  const fields = rejectUnknownFields(
    record.value,
    ['status', 'value', 'matchedRuleIds', 'unresolvedPaths', 'errors', 'trace', 'provenance'],
    rootPath,
  );
  if (isFailure(fields)) return fields;
  const status = readString(record.value, 'status', rootPath);
  if (isFailure(status)) return status;
  if (!RESULT_STATUSES.has(status.value)) {
    return failure(makeError(
      'INVALID_VALUE',
      childPath(rootPath, 'status'),
      "Unsupported result status at '" + childPath(rootPath, 'status') + "': " + quoted(status.value) + '.',
      SUPPORTED_RESULT_STATUSES.join(' | '),
      status.value,
    ));
  }
  const resultValue = readField(record.value, 'value', rootPath);
  if (isFailure(resultValue)) return resultValue;
  if (resultValue.value !== null && typeof resultValue.value !== 'boolean') {
    return failure(makeError(
      'INVALID_SHAPE',
      childPath(rootPath, 'value'),
      "Expected boolean or null at '" + childPath(rootPath, 'value') + "', got " + actualType(resultValue.value) + '.',
      'boolean | null',
      actualType(resultValue.value),
    ));
  }
  const expectedValue = status.value === 'allow' ? true : status.value === 'deny' ? false : null;
  if (resultValue.value !== expectedValue) {
    return failure(makeError(
      'INVALID_VALUE',
      childPath(rootPath, 'value'),
      "Result value at '" + childPath(rootPath, 'value') + "' must match status '" + status.value + "'.",
    ));
  }

  const matchedRuleIds = parseStringArray(record.value, 'matchedRuleIds', rootPath, true);
  if (isFailure(matchedRuleIds)) return matchedRuleIds;
  const unresolvedPaths = parseStringArray(record.value, 'unresolvedPaths', rootPath, true);
  if (isFailure(unresolvedPaths)) return unresolvedPaths;
  const errorsValue = readArray(record.value, 'errors', rootPath);
  if (isFailure(errorsValue)) return errorsValue;
  const errors: DomainError[] = [];
  for (let index = 0; index < errorsValue.value.length; index += 1) {
    const error = parseDomainError(
      errorsValue.value[index],
      indexPath(childPath(rootPath, 'errors'), index),
    );
    if (isFailure(error)) return error;
    errors.push(error.value);
  }
  const traceValue = readArray(record.value, 'trace', rootPath);
  if (isFailure(traceValue)) return traceValue;
  const trace: DomainTraceEvent[] = [];
  const traceIds = new Set<string>();
  for (let index = 0; index < traceValue.value.length; index += 1) {
    const event = parseTraceEvent(
      traceValue.value[index],
      indexPath(childPath(rootPath, 'trace'), index),
    );
    if (isFailure(event)) return event;
    if (traceIds.has(event.value.id)) {
      return failure(makeError(
        'DUPLICATE_ID',
        childPath(indexPath(childPath(rootPath, 'trace'), index), 'id'),
        "Trace identifier '" + event.value.id + "' is declared more than once.",
      ));
    }
    traceIds.add(event.value.id);
    trace.push(event.value);
  }
  const provenance = parseProvenance(
    record.value.provenance,
    childPath(rootPath, 'provenance'),
  );
  if (isFailure(provenance)) return provenance;
  return success(Object.freeze({
    status: status.value as DomainResultStatus,
    value: expectedValue,
    matchedRuleIds: matchedRuleIds.value,
    unresolvedPaths: unresolvedPaths.value,
    errors: Object.freeze(errors),
    trace: Object.freeze(trace),
    provenance: provenance.value,
  }));
}

export function parseGoldenFixture(value: unknown): DomainParseResult<DomainGoldenFixture> {
  const rootPath = '$';
  const record = readRecord(value, rootPath);
  if (isFailure(record)) return record;
  const fields = rejectUnknownFields(
    record.value,
    ['id', 'kind', 'contractVersion', 'category', 'functionId', 'description', 'input', 'expected'],
    rootPath,
  );
  if (isFailure(fields)) return fields;
  const id = readNonEmptyString(record.value, 'id', rootPath);
  if (isFailure(id)) return id;
  const kind = readString(record.value, 'kind', rootPath);
  if (isFailure(kind)) return kind;
  if (kind.value !== 'golden-evaluation') {
    return failure(makeError(
      'INVALID_DISCRIMINATOR',
      childPath(rootPath, 'kind'),
      'Unsupported fixture kind: ' + quoted(kind.value) + '.',
      'golden-evaluation',
      kind.value,
    ));
  }
  const version = readString(record.value, 'contractVersion', rootPath);
  if (isFailure(version)) return version;
  if (version.value !== DOMAIN_CONTRACT_VERSION) {
    return failure(makeError(
      'UNSUPPORTED_VERSION',
      childPath(rootPath, 'contractVersion'),
      'Unsupported contract version: ' + quoted(version.value) + '.',
      DOMAIN_CONTRACT_VERSION,
      version.value,
    ));
  }
  const category = readString(record.value, 'category', rootPath);
  if (isFailure(category)) return category;
  if (!FIXTURE_CATEGORIES.has(category.value)) {
    return failure(makeError(
      'INVALID_VALUE',
      childPath(rootPath, 'category'),
      'Unsupported fixture category: ' + quoted(category.value) + '.',
    ));
  }
  const functionId = readNonEmptyString(record.value, 'functionId', rootPath);
  if (isFailure(functionId)) return functionId;
  const description = readString(record.value, 'description', rootPath);
  if (isFailure(description)) return description;
  const inputValue = cloneJsonValue(record.value.input, childPath(rootPath, 'input'));
  if (isFailure(inputValue)) return inputValue;
  if (!isRecord(inputValue.value)) {
    return failure(makeError('INVALID_SHAPE', childPath(rootPath, 'input'), "Fixture input must be an object."));
  }
  const expected = parseExpectedResult(
    record.value.expected,
    childPath(rootPath, 'expected'),
  );
  if (isFailure(expected)) return expected;
  return success(Object.freeze({
    id: id.value,
    kind: 'golden-evaluation' as const,
    contractVersion: DOMAIN_CONTRACT_VERSION,
    category: category.value as DomainFixtureCategory,
    functionId: functionId.value,
    description: description.value,
    input: inputValue.value as DomainJsonObject,
    expected: expected.value,
  }));
}

function parseManifestEntry(
  value: unknown,
  path: string,
): DomainParseResult<DomainFixtureManifest['fixtures'][number]> {
  const record = readRecord(value, path);
  if (isFailure(record)) return record;
  const fields = rejectUnknownFields(record.value, ['id', 'path', 'category'], path);
  if (isFailure(fields)) return fields;
  const id = readNonEmptyString(record.value, 'id', path);
  if (isFailure(id)) return id;
  const fixturePath = readNonEmptyString(record.value, 'path', path);
  if (isFailure(fixturePath)) return fixturePath;
  const category = readString(record.value, 'category', path);
  if (isFailure(category)) return category;
  if (!FIXTURE_CATEGORIES.has(category.value)) {
    return failure(makeError(
      'INVALID_VALUE',
      childPath(path, 'category'),
      'Unsupported fixture category: ' + quoted(category.value) + '.',
    ));
  }
  return success(Object.freeze({
    id: id.value,
    path: fixturePath.value,
    category: category.value as DomainFixtureCategory,
  }));
}

function parseManifestVocabulary(
  value: unknown,
  path: string,
  expected: readonly string[],
): DomainParseResult<readonly string[]> {
  const wrapper: Record<string, unknown> = { values: value };
  const parsed = parseStringArray(wrapper, 'values', path, true);
  if (isFailure(parsed)) return parsed;
  if (
    parsed.value.length !== expected.length ||
    parsed.value.some((item, index) => item !== expected[index])
  ) {
    return failure(makeError(
      'INVALID_VALUE',
      path,
      "Supported vocabulary at '" + path + "' does not match the domain contract.",
    ));
  }
  return parsed;
}

export function parseFixtureManifest(value: unknown): DomainParseResult<DomainFixtureManifest> {
  const rootPath = '$';
  const record = readRecord(value, rootPath);
  if (isFailure(record)) return record;
  const fields = rejectUnknownFields(
    record.value,
    ['contractVersion', 'fixtureSetId', 'functionsFile', 'fixtures', 'supported'],
    rootPath,
  );
  if (isFailure(fields)) return fields;
  const version = readString(record.value, 'contractVersion', rootPath);
  if (isFailure(version)) return version;
  if (version.value !== DOMAIN_CONTRACT_VERSION) {
    return failure(makeError(
      'UNSUPPORTED_VERSION',
      childPath(rootPath, 'contractVersion'),
      'Unsupported contract version: ' + quoted(version.value) + '.',
      DOMAIN_CONTRACT_VERSION,
      version.value,
    ));
  }
  const fixtureSetId = readNonEmptyString(record.value, 'fixtureSetId', rootPath);
  if (isFailure(fixtureSetId)) return fixtureSetId;
  const functionsFile = readNonEmptyString(record.value, 'functionsFile', rootPath);
  if (isFailure(functionsFile)) return functionsFile;
  const fixtures = readArray(record.value, 'fixtures', rootPath);
  if (isFailure(fixtures)) return fixtures;
  const parsedFixtures: DomainFixtureManifest['fixtures'][number][] = [];
  const fixtureIds = new Set<string>();
  for (let index = 0; index < fixtures.value.length; index += 1) {
    const fixture = parseManifestEntry(
      fixtures.value[index],
      indexPath(childPath(rootPath, 'fixtures'), index),
    );
    if (isFailure(fixture)) return fixture;
    if (fixtureIds.has(fixture.value.id)) {
      return failure(makeError(
        'DUPLICATE_ID',
        childPath(indexPath(childPath(rootPath, 'fixtures'), index), 'id'),
        "Fixture identifier '" + fixture.value.id + "' is declared more than once.",
      ));
    }
    fixtureIds.add(fixture.value.id);
    parsedFixtures.push(fixture.value);
  }

  const supported = readRecord(record.value.supported, childPath(rootPath, 'supported'));
  if (isFailure(supported)) return supported;
  const supportedFields = rejectUnknownFields(
    supported.value,
    ['nodeKinds', 'operators', 'statuses'],
    childPath(rootPath, 'supported'),
  );
  if (isFailure(supportedFields)) return supportedFields;
  const nodeKinds = parseManifestVocabulary(
    supported.value.nodeKinds,
    'supported.nodeKinds',
    SUPPORTED_NODE_KINDS,
  );
  if (isFailure(nodeKinds)) return nodeKinds;
  const operators = parseManifestVocabulary(
    supported.value.operators,
    'supported.operators',
    SUPPORTED_OPERATORS,
  );
  if (isFailure(operators)) return operators;
  const statuses = parseManifestVocabulary(
    supported.value.statuses,
    'supported.statuses',
    SUPPORTED_RESULT_STATUSES,
  );
  if (isFailure(statuses)) return statuses;
  return success(Object.freeze({
    contractVersion: DOMAIN_CONTRACT_VERSION,
    fixtureSetId: fixtureSetId.value,
    functionsFile: functionsFile.value,
    fixtures: Object.freeze(parsedFixtures),
    supported: Object.freeze({
      nodeKinds: nodeKinds.value as DomainFixtureManifest['supported']['nodeKinds'],
      operators: operators.value as DomainFixtureManifest['supported']['operators'],
      statuses: statuses.value as DomainFixtureManifest['supported']['statuses'],
    }),
  }));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return Object.freeze(value);
}

export function unwrapDomainParseResult<T>(result: DomainParseResult<T>): T {
  if (result.ok) return result.value;
  throw new DomainValidationError(result.error);
}

export function parseFunctionOrThrow(value: unknown): DomainFunction {
  return unwrapDomainParseResult(parseFunction(value));
}

export function parseDomainOrThrow(value: unknown): DomainCatalog {
  return unwrapDomainParseResult(parseDomain(value));
}

export function parseGoldenFixtureOrThrow(value: unknown): DomainGoldenFixture {
  return unwrapDomainParseResult(parseGoldenFixture(value));
}

export function parseFixtureManifestOrThrow(value: unknown): DomainFixtureManifest {
  return unwrapDomainParseResult(parseFixtureManifest(value));
}
