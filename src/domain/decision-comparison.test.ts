import { describe, expect, it } from 'vitest';
import { createDecisionRecord, DecisionRecordJSON } from './decision-record';
import { compareDecisionRecords } from './decision-comparison';

const context = {
  version: 0 as const,
  hardConstraints: [{ id: 'https', description: 'Use HTTPS.' }],
  objectives: [{ id: 'cost', description: 'Minimize cost.', weight: 1 }],
  outOfScope: [],
  facts: [{ id: 'flag', value: false as boolean }],
  unknowns: [{ id: 'traffic', description: 'Traffic is unknown.' }],
  alternatives: [
    { id: 'queue', description: 'Use a queue.' },
    { id: 'direct', description: 'Use a direct path.' },
  ],
};

function resolved(overrides: Partial<DecisionRecordJSON> = {}) {
  return createDecisionRecord({
    domainVersion: 'domain-v0',
    contextSnapshot: context,
    evaluation: { status: 'resolved', result: true, trace: [] },
    recommendationId: 'queue',
    ...overrides,
  });
}

function unresolved(overrides: Partial<DecisionRecordJSON> = {}) {
  return createDecisionRecord({
    domainVersion: 'domain-v0',
    contextSnapshot: context,
    evaluation: {
      status: 'unresolved',
      result: false,
      trace: [{ step: 0, message: 'Traffic is unknown.', references: [{ kind: 'unknown', id: 'traffic' }] }],
    },
    recommendationId: null,
    ...overrides,
  });
}

function withContext(changes: Partial<typeof context>) {
  return { ...context, ...changes };
}

describe('compareDecisionRecords', () => {
  it('AC: equal records are consistent', () => {
    const actual = compareDecisionRecords(resolved(), resolved());

    expect(actual).toEqual({ status: 'consistent', changed_inputs: [] });
  });

  it('AC: recommendation-only changes are inconsistent', () => {
    const actual = compareDecisionRecords(
      resolved(),
      resolved({ contextSnapshot: context, recommendationId: 'direct' }),
    );

    expect(actual).toEqual({ status: 'inconsistent', changed_inputs: [] });
  });

  it('AC: fact changes produce an exact before/after diff', () => {
    const actual = compareDecisionRecords(
      resolved(),
      resolved({ contextSnapshot: withContext({ facts: [{ id: 'flag', value: true }] }) }),
    );

    expect(actual).toEqual({
      status: 'inputs_changed',
      changed_inputs: [{ kind: 'fact', id: 'flag', before: false, after: true }],
    });
  });

  it('AC: constraint changes produce an exact before/after diff', () => {
    const actual = compareDecisionRecords(
      resolved(),
      resolved({ contextSnapshot: withContext({ hardConstraints: [{ id: 'https', description: 'Use mTLS.' }] }) }),
    );

    expect(actual).toEqual({
      status: 'inputs_changed',
      changed_inputs: [{ kind: 'constraint', id: 'https', before: 'Use HTTPS.', after: 'Use mTLS.' }],
    });
  });

  it('AC: objective weight changes produce an exact before/after diff', () => {
    const actual = compareDecisionRecords(
      resolved(),
      resolved({ contextSnapshot: withContext({ objectives: [{ id: 'cost', description: 'Minimize cost.', weight: 2 }] }) }),
    );

    expect(actual).toEqual({
      status: 'inputs_changed',
      changed_inputs: [{ kind: 'objective_weight', id: 'cost', before: 1, after: 2 }],
    });
  });

  it('AC: alternative changes produce an exact before/after diff', () => {
    const actual = compareDecisionRecords(
      resolved(),
      resolved({ contextSnapshot: withContext({ alternatives: [
        { id: 'queue', description: 'Use a worker queue.' },
        { id: 'direct', description: 'Use a direct path.' },
      ] }) }),
    );

    expect(actual).toEqual({
      status: 'inputs_changed',
      changed_inputs: [{ kind: 'alternative', id: 'queue', before: 'Use a queue.', after: 'Use a worker queue.' }],
    });
  });

  it('AC: different domain versions are not comparable', () => {
    const actual = compareDecisionRecords(
      resolved(),
      resolved({ domainVersion: 'domain-v1' }),
    );

    expect(actual).toEqual({ status: 'not_comparable', changed_inputs: [] });
  });

  it('AC: unresolved evaluation states stay unresolved and preserve false', () => {
    const first = unresolved();
    const second = unresolved();
    const actual = compareDecisionRecords(first, second);

    expect(first.evaluation.status).toBe('unresolved');
    expect(first.evaluation.result).toBe(false);
    expect(first.recommendationId).toBeNull();
    expect(actual).toEqual({ status: 'consistent', changed_inputs: [] });
  });

  it('AC: caller-supplied diffs are ignored and output is deterministic', () => {
    const left = { ...resolved().toJSON(), changed_inputs: [{ kind: 'fact', id: 'fake', before: 1, after: 2 }] };
    const first = compareDecisionRecords(left, resolved());
    const second = compareDecisionRecords(left, resolved());

    expect(first).toEqual({ status: 'consistent', changed_inputs: [] });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('sorts multiple exact diffs independently of context collection order', () => {
    const changed = withContext({
      facts: [{ id: 'flag', value: true }],
      alternatives: [
        { id: 'direct', description: 'Use a direct path.' },
        { id: 'queue', description: 'Use a worker queue.' },
      ],
    });
    const actual = compareDecisionRecords(resolved(), resolved({ contextSnapshot: changed }));

    expect(actual.changed_inputs).toEqual([
      { kind: 'fact', id: 'flag', before: false, after: true },
      { kind: 'alternative', id: 'queue', before: 'Use a queue.', after: 'Use a worker queue.' },
    ]);
  });
});
