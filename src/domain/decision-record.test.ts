import { describe, expect, it } from 'vitest';
import {
  createDecisionContext,
  DecisionValidationError,
} from './decision-context';
import {
  createDecisionRecord,
  DecisionRecord,
  decisionRecordEquals,
} from './decision-record';

function makeContext() {
  return createDecisionContext({
    version: 0,
    hardConstraints: [{ id: 'must-https', description: 'Use HTTPS.' }],
    objectives: [{ id: 'cost', description: 'Minimize cost.', weight: 0 }],
    outOfScope: ['branding'],
    facts: [{ id: 'flag', value: false }],
    unknowns: [{ id: 'traffic', description: 'Traffic is unknown.' }],
    alternatives: [
      { id: 'queue', description: 'Use a queue.' },
      { id: 'direct', description: 'Use a direct path.' },
    ],
  });
}

function expectValidationCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error('Expected validation to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(DecisionValidationError);
    expect((error as DecisionValidationError).code).toBe(code);
  }
}

describe('DecisionRecord', () => {
  it('round-trips a resolved record with result, trace, snapshot, and recommendation', () => {
    const record = createDecisionRecord({
      domainVersion: 'v0',
      contextSnapshot: makeContext(),
      evaluation: {
        status: 'resolved',
        result: 0,
        trace: [
          {
            step: 1,
            message: 'The queue satisfies the hard constraint.',
            references: [
              { kind: 'alternative', id: 'queue' },
              { kind: 'hardConstraint', id: 'must-https' },
            ],
            value: false,
          },
        ],
      },
      recommendationId: 'queue',
    });
    const roundTripped = DecisionRecord.fromJSON(JSON.parse(JSON.stringify(record)));

    expect(roundTripped.toJSON()).toEqual(record.toJSON());
    expect(roundTripped.equals(record)).toBe(true);
    expect(roundTripped.evaluationResult).toBe(0);
    expect(roundTripped.evaluationTrace[0]?.value).toBe(false);
    expect(roundTripped.recommendationId).toBe('queue');
  });

  it('preserves an unresolved result and an explicit null recommendation', () => {
    const record = createDecisionRecord({
      domainVersion: 'v0',
      contextSnapshot: makeContext(),
      evaluation: {
        status: 'unresolved',
        result: false,
        trace: [
          {
            step: 0,
            message: 'The traffic fact is not known.',
            references: [{ kind: 'unknown', id: 'traffic' }],
            value: 0,
          },
        ],
      },
      recommendationId: null,
    });
    const roundTripped = DecisionRecord.fromJSON(JSON.parse(JSON.stringify(record)));

    expect(roundTripped.evaluation.status).toBe('unresolved');
    expect(roundTripped.evaluation.result).toBe(false);
    expect(roundTripped.evaluationTrace[0]?.value).toBe(0);
    expect(roundTripped.recommendationId).toBeNull();
    expect(decisionRecordEquals(record, roundTripped)).toBe(true);
  });

  it('compares context collections and reference order semantically, but keeps trace order significant', () => {
    const context = makeContext().toJSON();
    const reorderedContext = {
      ...context,
      alternatives: [...context.alternatives].reverse(),
      facts: [...context.facts].reverse(),
    };
    const first = createDecisionRecord({
      domainVersion: 'v0',
      contextSnapshot: context,
      evaluation: {
        status: 'resolved',
        result: { score: 0, passed: false },
        trace: [
          {
            step: 0,
            message: 'First.',
            references: [
              { kind: 'alternative', id: 'queue' },
              { kind: 'objective', id: 'cost' },
            ],
          },
          { step: 1, message: 'Second.' },
        ],
      },
      recommendationId: 'queue',
    });
    const sameMeaning = createDecisionRecord({
      domainVersion: 'v0',
      contextSnapshot: reorderedContext,
      evaluation: {
        status: 'resolved',
        result: { passed: false, score: 0 },
        trace: [
          {
            step: 0,
            message: 'First.',
            references: [
              { kind: 'objective', id: 'cost' },
              { kind: 'alternative', id: 'queue' },
            ],
          },
          { step: 1, message: 'Second.' },
        ],
      },
      recommendationId: 'queue',
    });

    expect(decisionRecordEquals(first, sameMeaning)).toBe(true);

    const differentTraceOrder = createDecisionRecord({
      ...sameMeaning.toJSON(),
      evaluation: {
        ...sameMeaning.evaluation,
        trace: [...sameMeaning.evaluation.trace].reverse(),
      },
    });
    expect(decisionRecordEquals(first, differentTraceOrder)).toBe(false);

    const differentResult = createDecisionRecord({
      ...sameMeaning.toJSON(),
      evaluation: { ...sameMeaning.evaluation, result: 0 },
    });
    expect(decisionRecordEquals(first, differentResult)).toBe(false);
  });

  it('deep-freezes the record and its evaluation trace', () => {
    const record = createDecisionRecord({
      domainVersion: 'v0',
      contextSnapshot: makeContext(),
      evaluation: { status: 'unresolved', result: false, trace: [] },
      recommendationId: null,
    });

    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.evaluation)).toBe(true);
    expect(Object.isFrozen(record.evaluation.trace)).toBe(true);
    expect(Object.isFrozen(record.toJSON())).toBe(true);
  });

  it('rejects unknown, duplicate, dangling, and inconsistent record values', () => {
    const valid = {
      domainVersion: 'v0',
      contextSnapshot: makeContext().toJSON(),
      evaluation: {
        status: 'unresolved' as const,
        result: false,
        trace: [
          {
            step: 0,
            message: 'Waiting.',
            references: [{ kind: 'unknown' as const, id: 'traffic' }],
          },
        ],
      },
      recommendationId: null,
    };

    expectValidationCode(
      () => DecisionRecord.fromJSON({ ...valid, unexpected: true }),
      'UNKNOWN_FIELD',
    );
    expectValidationCode(
      () => DecisionRecord.fromJSON({
        ...valid,
        evaluation: {
          ...valid.evaluation,
          trace: [{ step: 0, message: 'A' }, { step: 0, message: 'B' }],
        },
      }),
      'DUPLICATE_VALUE',
    );
    expectValidationCode(
      () => DecisionRecord.fromJSON({
        ...valid,
        evaluation: {
          ...valid.evaluation,
          trace: [{
            step: 0,
            message: 'Duplicate reference.',
            references: [
              { kind: 'unknown', id: 'traffic' },
              { kind: 'unknown', id: 'traffic' },
            ],
          }],
        },
      }),
      'DUPLICATE_ID',
    );
    expectValidationCode(
      () => DecisionRecord.fromJSON({
        ...valid,
        evaluation: {
          ...valid.evaluation,
          trace: [{
            step: 0,
            message: 'Dangling reference.',
            references: [{ kind: 'alternative', id: 'missing' }],
          }],
        },
      }),
      'DANGLING_REFERENCE',
    );
    expectValidationCode(
      () => DecisionRecord.fromJSON({
        ...valid,
        evaluation: { ...valid.evaluation, status: 'resolved' },
        recommendationId: null,
      }),
      'INCONSISTENT_RECORD',
    );
    expectValidationCode(
      () => DecisionRecord.fromJSON({
        ...valid,
        evaluation: { ...valid.evaluation, status: 'unresolved' },
        recommendationId: 'queue',
      }),
      'INCONSISTENT_RECORD',
    );
    expectValidationCode(
      () => DecisionRecord.fromJSON({
        ...valid,
        evaluation: { ...valid.evaluation, status: 'resolved' },
        recommendationId: 'missing',
      }),
      'DANGLING_REFERENCE',
    );
    expectValidationCode(
      () => DecisionRecord.fromJSON({ ...valid, domainVersion: ' ' }),
      'INVALID_VALUE',
    );
  });
});
