/**
 * Versioned, runtime-validated decision context.
 *
 * This module is deliberately independent of Workers, MCP, storage, and
 * evaluators.  A context is a JSON value with a small, explicit v0 schema.
 */

export const DECISION_CONTEXT_VERSION = 0 as const;
export type DecisionContextVersion = typeof DECISION_CONTEXT_VERSION;

export type JsonPrimitive = null | boolean | number | string;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;

export const DECISION_VALIDATION_ERROR_CODES = {
  DANGLING_REFERENCE: 'DANGLING_REFERENCE',
  DUPLICATE_ID: 'DUPLICATE_ID',
  DUPLICATE_VALUE: 'DUPLICATE_VALUE',
  INCONSISTENT_RECORD: 'INCONSISTENT_RECORD',
  INVALID_JSON: 'INVALID_JSON',
  INVALID_TYPE: 'INVALID_TYPE',
  INVALID_VALUE: 'INVALID_VALUE',
  MISSING_FIELD: 'MISSING_FIELD',
  UNKNOWN_FIELD: 'UNKNOWN_FIELD',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
} as const;

export type DecisionValidationErrorCode =
  (typeof DECISION_VALIDATION_ERROR_CODES)[keyof typeof DECISION_VALIDATION_ERROR_CODES];

/** Stable, inspectable error thrown by all decision-model validators. */
export class DecisionValidationError extends Error {
  readonly name = 'DecisionValidationError';
  readonly code: DecisionValidationErrorCode;
  readonly path: string;

  constructor(code: DecisionValidationErrorCode, message: string, path = '$') {
    super(message);
    this.code = code;
    this.path = path;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface HardConstraint {
  readonly id: string;
  readonly description: string;
}

export interface WeightedObjective {
  readonly id: string;
  readonly description: string;
  readonly weight: number;
}

export interface Fact {
  readonly id: string;
  readonly description?: string;
  readonly value: JsonValue;
}

export interface Unknown {
  readonly id: string;
  readonly description: string;
}

export interface Alternative {
  readonly id: string;
  readonly description: string;
}

export interface DecisionContextJSON {
  readonly version: DecisionContextVersion;
  readonly hardConstraints: readonly HardConstraint[];
  readonly objectives: readonly WeightedObjective[];
  readonly outOfScope: readonly string[];
  readonly facts: readonly Fact[];
  readonly unknowns: readonly Unknown[];
  readonly alternatives: readonly Alternative[];
}

export type DecisionContextInput = DecisionContextJSON;

type PlainObject = Record<string, unknown>;

const hasOwn = (value: PlainObject, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

export function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function fail(
  code: DecisionValidationErrorCode,
  message: string,
  path = '$',
): never {
  throw new DecisionValidationError(code, message, path);
}

export function assertKnownKeys(
  value: PlainObject,
  allowedKeys: readonly string[],
  path: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(
        DECISION_VALIDATION_ERROR_CODES.UNKNOWN_FIELD,
        `Unknown field "${key}" at ${path}.`,
        `${path}.${key}`,
      );
    }
  }
}

export function requiredField(value: PlainObject, key: string, path: string): unknown {
  if (!hasOwn(value, key)) {
    fail(
      DECISION_VALIDATION_ERROR_CODES.MISSING_FIELD,
      `Missing required field "${key}" at ${path}.`,
      `${path}.${key}`,
    );
  }
  return value[key];
}

export function optionalField(
  value: PlainObject,
  key: string,
): { readonly present: boolean; readonly value: unknown } {
  return { present: hasOwn(value, key), value: value[key] };
}

export function parseNonEmptyString(value: unknown, path: string, label = 'value'): string {
  if (typeof value !== 'string') {
    fail(
      DECISION_VALIDATION_ERROR_CODES.INVALID_TYPE,
      `${label} at ${path} must be a string.`,
      path,
    );
  }
  if (value.length === 0 || value.trim().length === 0 || value !== value.trim()) {
    fail(
      DECISION_VALIDATION_ERROR_CODES.INVALID_VALUE,
      `${label} at ${path} must be a non-empty string without surrounding whitespace.`,
      path,
    );
  }
  return value;
}

export function parseIdentifier(value: unknown, path: string): string {
  return parseNonEmptyString(value, path, 'Identifier');
}

export function parseFiniteNumber(value: unknown, path: string, label = 'value'): number {
  if (typeof value !== 'number') {
    fail(
      DECISION_VALIDATION_ERROR_CODES.INVALID_TYPE,
      `${label} at ${path} must be a number.`,
      path,
    );
  }
  if (!Number.isFinite(value)) {
    fail(
      DECISION_VALIDATION_ERROR_CODES.INVALID_VALUE,
      `${label} at ${path} must be finite.`,
      path,
    );
  }
  return value;
}

export const MAX_JSON_VALUE_DEPTH = 512 as const;

export function parseJsonValue(value: unknown, path: string, ancestors = new Set<object>()): JsonValue {
  if (ancestors.size > MAX_JSON_VALUE_DEPTH) {
    fail(DECISION_VALIDATION_ERROR_CODES.INVALID_JSON, 'JSON nesting exceeds the supported limit.', path);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return parseFiniteNumber(value, path, 'JSON number');
  }

  if (typeof value !== 'object' || value === null) {
    fail(
      DECISION_VALIDATION_ERROR_CODES.INVALID_JSON,
      `Value at ${path} is not a JSON value.`,
      path,
    );
  }

  if (ancestors.has(value)) {
    fail(
      DECISION_VALIDATION_ERROR_CODES.INVALID_JSON,
      `Cyclic value at ${path} is not valid JSON.`,
      path,
    );
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          fail(
            DECISION_VALIDATION_ERROR_CODES.INVALID_JSON,
            `Sparse array entry at ${path}[${index}] is not valid JSON.`,
            `${path}[${index}]`,
          );
        }
        result.push(parseJsonValue(value[index], `${path}[${index}]`, ancestors));
      }
      return Object.freeze(result);
    }

    if (!isPlainObject(value)) {
      fail(
        DECISION_VALIDATION_ERROR_CODES.INVALID_JSON,
        `Value at ${path} must be a plain JSON object.`,
        path,
      );
    }

    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(value).sort()) {
      result[key] = parseJsonValue(value[key], `${path}.${key}`, ancestors);
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function readArray(value: PlainObject, key: string, path: string): readonly unknown[] {
  const raw = requiredField(value, key, path);
  if (!Array.isArray(raw)) {
    fail(
      DECISION_VALIDATION_ERROR_CODES.INVALID_TYPE,
      `Field "${key}" at ${path} must be an array.`,
      `${path}.${key}`,
    );
  }
  return raw;
}

function readVersion(value: PlainObject, path: string): DecisionContextVersion {
  const raw = requiredField(value, 'version', path);
  if (raw !== DECISION_CONTEXT_VERSION) {
    fail(
      DECISION_VALIDATION_ERROR_CODES.UNSUPPORTED_VERSION,
      `DecisionContext version at ${path}.version must be ${DECISION_CONTEXT_VERSION}.`,
      `${path}.version`,
    );
  }
  return DECISION_CONTEXT_VERSION;
}

function readDescription(value: PlainObject, path: string): string {
  return parseNonEmptyString(requiredField(value, 'description', path), `${path}.description`, 'Description');
}

function readEntityId(value: PlainObject, path: string): string {
  return parseIdentifier(requiredField(value, 'id', path), `${path}.id`);
}

function readTextEntity(
  raw: unknown,
  path: string,
  label: string,
): HardConstraint | WeightedObjective | Unknown | Alternative {
  if (!isPlainObject(raw)) {
    fail(
      DECISION_VALIDATION_ERROR_CODES.INVALID_TYPE,
      `${label} at ${path} must be an object.`,
      path,
    );
  }
  assertKnownKeys(raw, ['id', 'description'], path);
  return {
    id: readEntityId(raw, path),
    description: readDescription(raw, path),
  };
}

function readObjective(raw: unknown, path: string): WeightedObjective {
  if (!isPlainObject(raw)) {
    fail(
      DECISION_VALIDATION_ERROR_CODES.INVALID_TYPE,
      `Objective at ${path} must be an object.`,
      path,
    );
  }
  assertKnownKeys(raw, ['id', 'description', 'weight'], path);
  const weight = parseFiniteNumber(requiredField(raw, 'weight', path), `${path}.weight`, 'Objective weight');
  if (weight < 0) {
    fail(
      DECISION_VALIDATION_ERROR_CODES.INVALID_VALUE,
      `Objective weight at ${path}.weight must be non-negative.`,
      `${path}.weight`,
    );
  }
  return {
    id: readEntityId(raw, path),
    description: readDescription(raw, path),
    weight,
  };
}

function readFact(raw: unknown, path: string): Fact {
  if (!isPlainObject(raw)) {
    fail(
      DECISION_VALIDATION_ERROR_CODES.INVALID_TYPE,
      `Fact at ${path} must be an object.`,
      path,
    );
  }
  assertKnownKeys(raw, ['id', 'description', 'value'], path);
  const description = optionalField(raw, 'description');
  const result: Fact = {
    id: readEntityId(raw, path),
    value: parseJsonValue(requiredField(raw, 'value', path), `${path}.value`),
  };
  if (description.present) {
    return {
      ...result,
      description: parseNonEmptyString(description.value, `${path}.description`, 'Fact description'),
    };
  }
  return result;
}

function registerId(ids: Set<string>, id: string, path: string): void {
  if (ids.has(id)) {
    fail(
      DECISION_VALIDATION_ERROR_CODES.DUPLICATE_ID,
      `Duplicate decision entity id "${id}" at ${path}.`,
      path,
    );
  }
  ids.add(id);
}

function readUniqueTextValues(raw: readonly unknown[], path: string): readonly string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index += 1) {
    const itemPath = `${path}[${index}]`;
    const value = parseNonEmptyString(raw[index], itemPath, 'Out-of-scope item');
    if (seen.has(value)) {
      fail(
        DECISION_VALIDATION_ERROR_CODES.DUPLICATE_VALUE,
        `Duplicate out-of-scope value "${value}" at ${itemPath}.`,
        itemPath,
      );
    }
    seen.add(value);
    values.push(value);
  }
  return values;
}

function normalizeDecisionContext(value: unknown, path: string): DecisionContextJSON {
  if (!isPlainObject(value)) {
    fail(
      DECISION_VALIDATION_ERROR_CODES.INVALID_TYPE,
      `DecisionContext at ${path} must be a plain object.`,
      path,
    );
  }
  assertKnownKeys(
    value,
    ['version', 'hardConstraints', 'objectives', 'outOfScope', 'facts', 'unknowns', 'alternatives'],
    path,
  );

  const hardConstraintValues = readArray(value, 'hardConstraints', path);
  const objectiveValues = readArray(value, 'objectives', path);
  const outOfScopeValues = readArray(value, 'outOfScope', path);
  const factValues = readArray(value, 'facts', path);
  const unknownValues = readArray(value, 'unknowns', path);
  const alternativeValues = readArray(value, 'alternatives', path);

  const ids = new Set<string>();
  const hardConstraints: HardConstraint[] = [];
  for (let index = 0; index < hardConstraintValues.length; index += 1) {
    const itemPath = `${path}.hardConstraints[${index}]`;
    const item = readTextEntity(hardConstraintValues[index], itemPath, 'Hard constraint') as HardConstraint;
    registerId(ids, item.id, `${itemPath}.id`);
    hardConstraints.push(item);
  }

  const objectives: WeightedObjective[] = [];
  for (let index = 0; index < objectiveValues.length; index += 1) {
    const itemPath = `${path}.objectives[${index}]`;
    const item = readObjective(objectiveValues[index], itemPath);
    registerId(ids, item.id, `${itemPath}.id`);
    objectives.push(item);
  }

  const outOfScope = readUniqueTextValues(outOfScopeValues, `${path}.outOfScope`);

  const facts: Fact[] = [];
  for (let index = 0; index < factValues.length; index += 1) {
    const itemPath = `${path}.facts[${index}]`;
    const item = readFact(factValues[index], itemPath);
    registerId(ids, item.id, `${itemPath}.id`);
    facts.push(item);
  }

  const unknowns: Unknown[] = [];
  for (let index = 0; index < unknownValues.length; index += 1) {
    const itemPath = `${path}.unknowns[${index}]`;
    const item = readTextEntity(unknownValues[index], itemPath, 'Unknown') as Unknown;
    registerId(ids, item.id, `${itemPath}.id`);
    unknowns.push(item);
  }

  const alternatives: Alternative[] = [];
  for (let index = 0; index < alternativeValues.length; index += 1) {
    const itemPath = `${path}.alternatives[${index}]`;
    const item = readTextEntity(alternativeValues[index], itemPath, 'Alternative') as Alternative;
    registerId(ids, item.id, `${itemPath}.id`);
    alternatives.push(item);
  }

  const result: DecisionContextJSON = {
    version: readVersion(value, path),
    hardConstraints,
    objectives,
    outOfScope,
    facts,
    unknowns,
    alternatives,
  };
  return deepFreeze(result);
}

function canonicalJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalJson((value as JsonObject)[key]);
    }
    return result;
  }
  return value;
}

function canonicalContext(value: DecisionContextJSON): DecisionContextJSON {
  const compareStrings = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;
  const byId = <T extends { readonly id: string }>(items: readonly T[]): readonly T[] =>
    [...items]
      .sort((left, right) => compareStrings(left.id, right.id))
      .map((item) => canonicalJson(item as unknown as JsonValue) as T);

  return {
    version: value.version,
    hardConstraints: byId(value.hardConstraints),
    objectives: byId(value.objectives),
    outOfScope: [...value.outOfScope].sort(compareStrings),
    facts: byId(value.facts),
    unknowns: byId(value.unknowns),
    alternatives: byId(value.alternatives),
  };
}

export function stableJsonStringify(value: JsonValue): string {
  return JSON.stringify(canonicalJson(value));
}

function asContextJSON(value: unknown): DecisionContextJSON | null {
  if (value instanceof DecisionContext) {
    return value.toJSON();
  }
  try {
    return normalizeDecisionContext(value, '$');
  } catch (error) {
    if (error instanceof DecisionValidationError) {
      return null;
    }
    throw error;
  }
}

/** Immutable validated v0 decision context. */
export class DecisionContext {
  readonly version: DecisionContextVersion;
  readonly hardConstraints: readonly HardConstraint[];
  readonly objectives: readonly WeightedObjective[];
  readonly outOfScope: readonly string[];
  readonly facts: readonly Fact[];
  readonly unknowns: readonly Unknown[];
  readonly alternatives: readonly Alternative[];
  private readonly json: DecisionContextJSON;

  private constructor(json: DecisionContextJSON) {
    this.json = json;
    this.version = json.version;
    this.hardConstraints = json.hardConstraints;
    this.objectives = json.objectives;
    this.outOfScope = json.outOfScope;
    this.facts = json.facts;
    this.unknowns = json.unknowns;
    this.alternatives = json.alternatives;
    Object.freeze(this);
  }

  static create(input: DecisionContextInput): DecisionContext {
    return new DecisionContext(normalizeDecisionContext(input, '$'));
  }

  static fromJSON(input: unknown): DecisionContext {
    return new DecisionContext(normalizeDecisionContext(input, '$'));
  }

  toJSON(): DecisionContextJSON {
    return this.json;
  }

  equals(other: unknown): boolean {
    return decisionContextEquals(this, other);
  }
}

export function createDecisionContext(input: DecisionContextInput): DecisionContext {
  return DecisionContext.create(input);
}

export function parseDecisionContext(input: unknown): DecisionContext {
  return DecisionContext.fromJSON(input);
}

export function validateDecisionContext(input: unknown): DecisionContextJSON {
  return DecisionContext.fromJSON(input).toJSON();
}

export function isDecisionContext(input: unknown): input is DecisionContext {
  return input instanceof DecisionContext || asContextJSON(input) !== null;
}

/**
 * Semantic equality for contexts.
 * Entity collections and outOfScope are set-like and compare by id/value;
 * object key order is ignored.  The original collection order remains in
 * toJSON(), while trace order is handled by DecisionRecord and is significant.
 */
export function decisionContextEquals(left: unknown, right: unknown): boolean {
  const leftJSON = asContextJSON(left);
  const rightJSON = asContextJSON(right);
  if (leftJSON === null || rightJSON === null) {
    return false;
  }
  return stableJsonStringify(canonicalContext(leftJSON) as unknown as JsonValue) ===
    stableJsonStringify(canonicalContext(rightJSON) as unknown as JsonValue);
}

export const semanticDecisionContextEquals = decisionContextEquals;
