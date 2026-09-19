/**
 * Immutable, runtime-validated decision record for the v0 domain contract.
 *
 * A record captures the domain version, an immutable context snapshot, the
 * evaluator's result and ordered trace, and an optional recommendation.  It
 * does not perform evaluation and has no runtime integration dependencies.
 */

import {
  assertKnownKeys,
  DecisionContext,
  DecisionContextInput,
  DecisionContextJSON,
  DecisionValidationError,
  DECISION_VALIDATION_ERROR_CODES,
  deepFreeze,
  isPlainObject,
  JsonValue,
  optionalField,
  parseFiniteNumber,
  parseIdentifier,
  parseJsonValue,
  parseNonEmptyString,
  requiredField,
  stableJsonStringify,
} from './decision-context';

export const DECISION_REFERENCE_KINDS = [
  'hardConstraint',
  'objective',
  'fact',
  'unknown',
  'alternative',
] as const;

export type DecisionReferenceKind = (typeof DECISION_REFERENCE_KINDS)[number];
/**
 * States are deliberately kept distinct so a record cannot collapse an
 * ambiguous or conflicting evaluation into a generic unresolved result.
 *
 * `error` is also first-class in v0: evaluator failures are stored in the
 * JSON `result` payload with this status and a null recommendation.  A
 * malformed record still fails with `DecisionValidationError` and is never
 * constructed.
 */
export const EVALUATION_STATUSES = [
  'resolved',
  'unresolved',
  'ambiguous',
  'conflict',
  'error',
] as const;

export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number];

const NON_RESOLVED_EVALUATION_STATUSES = new Set<EvaluationStatus>([
  'unresolved',
  'ambiguous',
  'conflict',
  'error',
]);

export interface DecisionReference {
  readonly kind: DecisionReferenceKind;
  readonly id: string;
}

export interface EvaluationTraceEntry {
  readonly step: number;
  readonly message: string;
  readonly references?: readonly DecisionReference[];
  readonly value?: JsonValue;
}

export interface DecisionEvaluation {
  readonly status: EvaluationStatus;
  readonly result: JsonValue;
  readonly trace: readonly EvaluationTraceEntry[];
}

export interface DecisionRecordJSON {
  readonly domainVersion: string;
  readonly contextSnapshot: DecisionContextJSON;
  readonly evaluation: DecisionEvaluation;
  readonly recommendationId: string | null;
}

export interface DecisionRecordInput {
  readonly domainVersion: string;
  readonly contextSnapshot: DecisionContextInput | DecisionContext;
  readonly evaluation: DecisionEvaluation;
  readonly recommendationId: string | null;
}

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function readArray(value: Record<string, unknown>, key: string, path: string): readonly unknown[] {
  const raw = requiredField(value, key, path);
  if (!Array.isArray(raw)) {
    throw new DecisionValidationError(
      DECISION_VALIDATION_ERROR_CODES.INVALID_TYPE,
      `Field "${key}" at ${path} must be an array.`,
      `${path}.${key}`,
    );
  }
  return raw;
}

function readStatus(value: unknown, path: string): EvaluationStatus {
  if (!EVALUATION_STATUSES.includes(value as EvaluationStatus)) {
    throw new DecisionValidationError(
      DECISION_VALIDATION_ERROR_CODES.INVALID_VALUE,
      `Evaluation status at ${path} must be one of ${EVALUATION_STATUSES.join(', ')}.`,
      path,
    );
  }
  return value as EvaluationStatus;
}

function readReferenceKind(value: unknown, path: string): DecisionReferenceKind {
  if (!DECISION_REFERENCE_KINDS.includes(value as DecisionReferenceKind)) {
    throw new DecisionValidationError(
      DECISION_VALIDATION_ERROR_CODES.INVALID_VALUE,
      `Reference kind at ${path} is not supported.`,
      path,
    );
  }
  return value as DecisionReferenceKind;
}

function readReference(raw: unknown, path: string): DecisionReference {
  if (!isPlainObject(raw)) {
    throw new DecisionValidationError(
      DECISION_VALIDATION_ERROR_CODES.INVALID_TYPE,
      `Decision reference at ${path} must be an object.`,
      path,
    );
  }
  assertKnownKeys(raw, ['kind', 'id'], path);
  return {
    kind: readReferenceKind(requiredField(raw, 'kind', path), `${path}.kind`),
    id: parseIdentifier(requiredField(raw, 'id', path), `${path}.id`),
  };
}

function readTraceEntry(raw: unknown, path: string): EvaluationTraceEntry {
  if (!isPlainObject(raw)) {
    throw new DecisionValidationError(
      DECISION_VALIDATION_ERROR_CODES.INVALID_TYPE,
      `Evaluation trace entry at ${path} must be an object.`,
      path,
    );
  }
  assertKnownKeys(raw, ['step', 'message', 'references', 'value'], path);

  const step = parseFiniteNumber(requiredField(raw, 'step', path), `${path}.step`, 'Trace step');
  if (!Number.isInteger(step) || step < 0) {
    throw new DecisionValidationError(
      DECISION_VALIDATION_ERROR_CODES.INVALID_VALUE,
      `Trace step at ${path}.step must be a non-negative integer.`,
      `${path}.step`,
    );
  }

  let result: EvaluationTraceEntry = {
    step,
    message: parseNonEmptyString(requiredField(raw, 'message', path), `${path}.message`, 'Trace message'),
  };

  const references = optionalField(raw, 'references');
  if (references.present) {
    if (!Array.isArray(references.value)) {
      throw new DecisionValidationError(
        DECISION_VALIDATION_ERROR_CODES.INVALID_TYPE,
        `Trace references at ${path}.references must be an array.`,
        `${path}.references`,
      );
    }
    const parsedReferences: DecisionReference[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < references.value.length; index += 1) {
      const referencePath = `${path}.references[${index}]`;
      const reference = readReference(references.value[index], referencePath);
      const key = `${reference.kind}:${reference.id}`;
      if (seen.has(key)) {
        throw new DecisionValidationError(
          DECISION_VALIDATION_ERROR_CODES.DUPLICATE_ID,
          `Duplicate trace reference "${key}" at ${referencePath}.`,
          referencePath,
        );
      }
      seen.add(key);
      parsedReferences.push(reference);
    }
    result = { ...result, references: parsedReferences };
  }

  const traceValue = optionalField(raw, 'value');
  if (traceValue.present) {
    result = { ...result, value: parseJsonValue(traceValue.value, `${path}.value`) };
  }
  return result;
}

function readContextSnapshot(raw: unknown): DecisionContext {
  if (raw instanceof DecisionContext) {
    return raw;
  }
  return DecisionContext.fromJSON(raw);
}

function contextIds(context: DecisionContext): ReadonlyMap<DecisionReferenceKind, ReadonlySet<string>> {
  return new Map<DecisionReferenceKind, ReadonlySet<string>>([
    ['hardConstraint', new Set(context.hardConstraints.map((item) => item.id))],
    ['objective', new Set(context.objectives.map((item) => item.id))],
    ['fact', new Set(context.facts.map((item) => item.id))],
    ['unknown', new Set(context.unknowns.map((item) => item.id))],
    ['alternative', new Set(context.alternatives.map((item) => item.id))],
  ]);
}

function validateTraceReferences(
  trace: readonly EvaluationTraceEntry[],
  context: DecisionContext,
): void {
  const ids = contextIds(context);
  for (let traceIndex = 0; traceIndex < trace.length; traceIndex += 1) {
    const entry = trace[traceIndex];
    if (entry.references === undefined) {
      continue;
    }
    for (let referenceIndex = 0; referenceIndex < entry.references.length; referenceIndex += 1) {
      const reference = entry.references[referenceIndex];
      if (!ids.get(reference.kind)?.has(reference.id)) {
        throw new DecisionValidationError(
          DECISION_VALIDATION_ERROR_CODES.DANGLING_REFERENCE,
          `Trace reference "${reference.kind}:${reference.id}" does not exist in the context snapshot.`,
          `$.evaluation.trace[${traceIndex}].references[${referenceIndex}]`,
        );
      }
    }
  }
}

function normalizeDecisionRecord(value: unknown, path: string): DecisionRecordJSON {
  if (!isPlainObject(value)) {
    throw new DecisionValidationError(
      DECISION_VALIDATION_ERROR_CODES.INVALID_TYPE,
      `DecisionRecord at ${path} must be a plain object.`,
      path,
    );
  }
  assertKnownKeys(value, ['domainVersion', 'contextSnapshot', 'evaluation', 'recommendationId'], path);

  const domainVersion = parseNonEmptyString(
    requiredField(value, 'domainVersion', path),
    `${path}.domainVersion`,
    'Domain version',
  );
  const contextSnapshot = readContextSnapshot(requiredField(value, 'contextSnapshot', path));

  const rawEvaluation = requiredField(value, 'evaluation', path);
  if (!isPlainObject(rawEvaluation)) {
    throw new DecisionValidationError(
      DECISION_VALIDATION_ERROR_CODES.INVALID_TYPE,
      `Evaluation at ${path}.evaluation must be a plain object.`,
      `${path}.evaluation`,
    );
  }
  assertKnownKeys(rawEvaluation, ['status', 'result', 'trace'], `${path}.evaluation`);
  const evaluationPath = `${path}.evaluation`;
  const rawTrace = readArray(rawEvaluation, 'trace', evaluationPath);
  const status = readStatus(requiredField(rawEvaluation, 'status', evaluationPath), `${evaluationPath}.status`);
  const result = parseJsonValue(
    requiredField(rawEvaluation, 'result', evaluationPath),
    `${evaluationPath}.result`,
  );
  const trace: EvaluationTraceEntry[] = [];
  const traceSteps = new Set<number>();
  for (let index = 0; index < rawTrace.length; index += 1) {
    const entry = readTraceEntry(rawTrace[index], `${evaluationPath}.trace[${index}]`);
    if (traceSteps.has(entry.step)) {
      throw new DecisionValidationError(
        DECISION_VALIDATION_ERROR_CODES.DUPLICATE_VALUE,
        `Duplicate evaluation trace step ${entry.step}.`,
        `${evaluationPath}.trace[${index}].step`,
      );
    }
    traceSteps.add(entry.step);
    trace.push(entry);
  }

  const recommendation = requiredField(value, 'recommendationId', path);
  const recommendationId = recommendation === null
    ? null
    : parseIdentifier(recommendation, `${path}.recommendationId`);

  if (status === 'resolved' && recommendationId === null) {
    throw new DecisionValidationError(
      DECISION_VALIDATION_ERROR_CODES.INCONSISTENT_RECORD,
      'A resolved evaluation must have a recommendationId.',
      `${path}.recommendationId`,
    );
  }
  if (NON_RESOLVED_EVALUATION_STATUSES.has(status) && recommendationId !== null) {
    throw new DecisionValidationError(
      DECISION_VALIDATION_ERROR_CODES.INCONSISTENT_RECORD,
      `A ${status} evaluation must have a null recommendationId.`,
      `${path}.recommendationId`,
    );
  }
  if (recommendationId !== null && !contextSnapshot.alternatives.some((item) => item.id === recommendationId)) {
    throw new DecisionValidationError(
      DECISION_VALIDATION_ERROR_CODES.DANGLING_REFERENCE,
      `Recommendation "${recommendationId}" does not exist in the context snapshot.`,
      `${path}.recommendationId`,
    );
  }
  validateTraceReferences(trace, contextSnapshot);

  const normalizedEvaluation: DecisionEvaluation = {
    status,
    result,
    trace,
  };
  const normalized: DecisionRecordJSON = {
    domainVersion,
    contextSnapshot: contextSnapshot.toJSON(),
    evaluation: normalizedEvaluation,
    recommendationId,
  };
  return deepFreeze(normalized);
}

function canonicalEvaluation(value: DecisionEvaluation): JsonValue {
  const trace = value.trace.map((entry) => {
    const normalized: Record<string, JsonValue> = {
      step: entry.step,
      message: entry.message,
    };
    if (entry.references !== undefined) {
      normalized.references = [...entry.references]
        .sort((left, right) => {
          const leftKey = `${left.kind}:${left.id}`;
          const rightKey = `${right.kind}:${right.id}`;
          return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
        })
        .map((reference) => ({ kind: reference.kind, id: reference.id }));
    }
    if (hasOwn(entry as unknown as Record<string, unknown>, 'value')) {
      normalized.value = entry.value as JsonValue;
    }
    return normalized;
  });
  return {
    status: value.status,
    result: value.result,
    // Trace order is meaningful; only reference order within a step is not.
    trace,
  };
}

function asRecordJSON(value: unknown): DecisionRecordJSON | null {
  if (value instanceof DecisionRecord) {
    return value.toJSON();
  }
  try {
    return normalizeDecisionRecord(value, '$');
  } catch (error) {
    if (error instanceof DecisionValidationError) {
      return null;
    }
    throw error;
  }
}

/** Immutable validated decision record. */
export class DecisionRecord {
  readonly domainVersion: string;
  readonly contextSnapshot: DecisionContext;
  readonly evaluation: DecisionEvaluation;
  readonly recommendationId: string | null;
  private readonly json: DecisionRecordJSON;

  private constructor(json: DecisionRecordJSON) {
    this.json = json;
    this.domainVersion = json.domainVersion;
    this.contextSnapshot = DecisionContext.fromJSON(json.contextSnapshot);
    this.evaluation = json.evaluation;
    this.recommendationId = json.recommendationId;
    Object.freeze(this);
  }

  /** Alias for callers that use the shorter record terminology. */
  get context(): DecisionContext {
    return this.contextSnapshot;
  }

  /** Alias for callers that want the result and trace at record level. */
  get evaluationResult(): JsonValue {
    return this.evaluation.result;
  }

  get evaluationTrace(): readonly EvaluationTraceEntry[] {
    return this.evaluation.trace;
  }

  static create(input: DecisionRecordInput): DecisionRecord {
    return new DecisionRecord(normalizeDecisionRecord(input, '$'));
  }

  static fromJSON(input: unknown): DecisionRecord {
    return new DecisionRecord(normalizeDecisionRecord(input, '$'));
  }

  toJSON(): DecisionRecordJSON {
    return this.json;
  }

  equals(other: unknown): boolean {
    return decisionRecordEquals(this, other);
  }
}

export function createDecisionRecord(input: DecisionRecordInput): DecisionRecord {
  return DecisionRecord.create(input);
}

export function parseDecisionRecord(input: unknown): DecisionRecord {
  return DecisionRecord.fromJSON(input);
}

export function validateDecisionRecord(input: unknown): DecisionRecordJSON {
  return DecisionRecord.fromJSON(input).toJSON();
}

export function isDecisionRecord(input: unknown): input is DecisionRecord {
  return input instanceof DecisionRecord || asRecordJSON(input) !== null;
}

/**
 * Semantic equality for records.  Context collections and JSON object key
 * order are ignored; evaluation trace array order is significant, while the
 * reference order inside each trace step is not.
 */
export function decisionRecordEquals(left: unknown, right: unknown): boolean {
  const leftJSON = asRecordJSON(left);
  const rightJSON = asRecordJSON(right);
  if (leftJSON === null || rightJSON === null) {
    return false;
  }
  return leftJSON.domainVersion === rightJSON.domainVersion &&
    leftJSON.recommendationId === rightJSON.recommendationId &&
    leftJSON.contextSnapshot !== undefined &&
    rightJSON.contextSnapshot !== undefined &&
    DecisionContext.fromJSON(leftJSON.contextSnapshot).equals(rightJSON.contextSnapshot) &&
    stableJsonStringify(canonicalEvaluation(leftJSON.evaluation)) ===
      stableJsonStringify(canonicalEvaluation(rightJSON.evaluation));
}

export const semanticDecisionRecordEquals = decisionRecordEquals;
