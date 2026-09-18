/**
 * Deterministic comparison of two validated DecisionRecords.
 *
 * Only the two context snapshots and the records' own evaluation metadata are
 * considered.  A caller cannot make a recommendation change look like an
 * input change by supplying a precomputed diff.
 */

import {
  DecisionContext,
  isPlainObject,
  stableJsonStringify,
  type JsonValue,
} from './decision-context';
import {
  DecisionRecord,
  decisionRecordEquals,
} from './decision-record';

export const DECISION_COMPARISON_STATUSES = [
  'consistent',
  'inconsistent',
  'inputs_changed',
  'not_comparable',
] as const;

export type DecisionComparisonStatus = (typeof DECISION_COMPARISON_STATUSES)[number];

export type DecisionInputChangeKind =
  | 'fact'
  | 'constraint'
  | 'objective_weight'
  | 'alternative';

export interface DecisionInputChange {
  readonly kind: DecisionInputChangeKind;
  readonly id: string;
  readonly before: JsonValue | null;
  readonly after: JsonValue | null;
}

export interface DecisionComparison {
  readonly status: DecisionComparisonStatus;
  readonly changed_inputs: readonly DecisionInputChange[];
}

function recordWithoutCallerDiff(value: unknown): unknown {
  if (!isPlainObject(value) || value instanceof DecisionRecord) {
    return value;
  }

  // DecisionRecord itself is intentionally strict.  Comparison metadata is
  // not part of that record contract, but accepting and ignoring these two
  // common spellings here makes the comparison truth independent of a caller's
  // claimed diff.
  const copy = { ...value };
  delete copy.changed_inputs;
  delete copy.changedInputs;
  return copy;
}

function asDecisionRecord(value: unknown): DecisionRecord {
  return value instanceof DecisionRecord
    ? value
    : DecisionRecord.fromJSON(recordWithoutCallerDiff(value));
}

function sortedIds<T extends { readonly id: string }>(
  left: readonly T[],
  right: readonly T[],
): readonly string[] {
  return [...new Set([...left, ...right].map((item) => item.id))].sort();
}

function changedValues<T extends { readonly id: string }>(
  left: readonly T[],
  right: readonly T[],
  read: (item: T) => JsonValue,
  kind: DecisionInputChangeKind,
): readonly DecisionInputChange[] {
  const leftById = new Map(left.map((item) => [item.id, item]));
  const rightById = new Map(right.map((item) => [item.id, item]));
  const changes: DecisionInputChange[] = [];

  for (const id of sortedIds(left, right)) {
    const beforeItem = leftById.get(id);
    const afterItem = rightById.get(id);
    const before = beforeItem === undefined ? null : read(beforeItem);
    const after = afterItem === undefined ? null : read(afterItem);
    if (beforeItem === undefined || afterItem === undefined ||
        stableJsonStringify(before) !== stableJsonStringify(after)) {
      changes.push({ kind, id, before, after });
    }
  }
  return changes;
}

function compareInputs(left: DecisionContext, right: DecisionContext): readonly DecisionInputChange[] {
  const changes = [
    ...changedValues(left.facts, right.facts, (item) => item.value, 'fact'),
    ...changedValues(left.hardConstraints, right.hardConstraints, (item) => item.description, 'constraint'),
    ...changedValues(left.objectives, right.objectives, (item) => item.weight, 'objective_weight'),
    ...changedValues(left.alternatives, right.alternatives, (item) => item.description, 'alternative'),
  ];

  const kindOrder: Record<DecisionInputChangeKind, number> = {
    fact: 0,
    constraint: 1,
    objective_weight: 2,
    alternative: 3,
  };
  return changes.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.id.localeCompare(b.id));
}

/**
 * Compare two DecisionRecords from the earlier record to the later record.
 * Domain-version drift takes precedence over all other conclusions.
 */
export function compareDecisionRecords(left: unknown, right: unknown): DecisionComparison {
  const before = asDecisionRecord(left);
  const after = asDecisionRecord(right);

  if (before.domainVersion !== after.domainVersion) {
    return { status: 'not_comparable', changed_inputs: [] };
  }

  const changed_inputs = compareInputs(before.contextSnapshot, after.contextSnapshot);
  if (!before.contextSnapshot.equals(after.contextSnapshot)) {
    return { status: 'inputs_changed', changed_inputs };
  }

  if (before.recommendationId !== after.recommendationId ||
      !decisionRecordEquals(before, after)) {
    return { status: 'inconsistent', changed_inputs: [] };
  }

  return { status: 'consistent', changed_inputs: [] };
}

export const compareDecisionRecord = compareDecisionRecords;
export const detectRecommendationDrift = compareDecisionRecords;
