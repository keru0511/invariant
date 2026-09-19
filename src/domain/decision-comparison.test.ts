import { describe, expect, it } from 'vitest';
import { createDecisionRecord, DecisionRecordJSON } from './decision-record';
import { compareDecisionRecords } from './decision-comparison';

const context: DecisionRecordJSON['contextSnapshot'] = {
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

  it('AC: unknown changes produce an exact before/after diff', () => {
    const actual = compareDecisionRecords(
      resolved(),
      resolved({ contextSnapshot: withContext({
        unknowns: [{ id: 'traffic', description: 'Traffic volume is now known.' }],
      }) }),
    );

    expect(actual).toEqual({
      status: 'inputs_changed',
      changed_inputs: [{
        kind: 'unknown',
        id: 'traffic',
        before: 'Traffic is unknown.',
        after: 'Traffic volume is now known.',
      }],
    });
  });

  it('AC: out-of-scope changes produce an exact before/after diff', () => {
    const actual = compareDecisionRecords(
      resolved(),
      resolved({ contextSnapshot: withContext({ outOfScope: ['legacy migration'] }) }),
    );

    expect(actual).toEqual({
      status: 'inputs_changed',
      changed_inputs: [{
        kind: 'out_of_scope',
        id: 'legacy migration',
        before: null,
        after: 'legacy migration',
      }],
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

  it('AC: result/trace/evaluation drift with same recommendationId is not recommendation drift', () => {
    const actual = compareDecisionRecords(
      resolved(),
      resolved({
        evaluation: {
          status: 'resolved',
          result: false,
          trace: [{ step: 0, message: 'A different evaluator trace.' }],
        },
      }),
    );

    expect(actual).toEqual({ status: 'consistent', changed_inputs: [] });
  });

  it.each(['ambiguous', 'conflict', 'error'] as const)(
    'AC: %s DecisionRecord state is preserved during comparison',
    (status) => {
      const record = createDecisionRecord({
        domainVersion: 'domain-v0',
        contextSnapshot: context,
        evaluation: {
          status,
          result: status === 'error'
            ? { code: 'EVALUATOR_FAILURE', detail: 'provider failed' }
            : null,
          trace: status === 'error'
            ? [{ step: 0, message: 'provider failure' }]
            : [],
        },
        recommendationId: null,
      });
      const roundTripped = createDecisionRecord(JSON.parse(JSON.stringify(record)));

      expect(roundTripped.evaluation).toEqual(record.evaluation);
      expect(roundTripped.evaluation.status).toBe(status);
      expect(roundTripped.recommendationId).toBeNull();
      expect(compareDecisionRecords(record, roundTripped)).toEqual({
        status: 'consistent',
        changed_inputs: [],
      });
    },
  );

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
