import { describe, expect, it } from 'vitest';
import {
  createDecisionContext,
  DecisionContext,
  DecisionValidationError,
  decisionContextEquals,
} from './decision-context';

const contextInput = {
  version: 0 as const,
  hardConstraints: [
    { id: 'https-only', description: 'Transport must use HTTPS.' },
  ],
  objectives: [
    { id: 'cost', description: 'Keep operating cost low.', weight: 0 },
    { id: 'latency', description: 'Keep response time low.', weight: 0.8 },
  ],
  outOfScope: ['marketing copy', 'legacy migration'],
  facts: [
    { id: 'feature-flag', value: false },
    { id: 'budget', value: 0 },
    { id: 'nested-fact', value: { enabled: false, limit: 0 } },
  ],
  unknowns: [
    { id: 'traffic-shape', description: 'Peak traffic distribution is unknown.' },
  ],
  alternatives: [
    { id: 'queue', description: 'Use a queue-backed design.' },
    { id: 'direct', description: 'Use a direct request path.' },
  ],
};

function expectValidationCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error('Expected validation to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(DecisionValidationError);
    expect((error as DecisionValidationError).code).toBe(code);
  }
}

describe('DecisionContext', () => {
  it('round-trips every v0 field without losing false, zero, or nested JSON values', () => {
    const context = createDecisionContext(contextInput);
    const roundTripped = DecisionContext.fromJSON(JSON.parse(JSON.stringify(context)));

    expect(roundTripped.toJSON()).toEqual(context.toJSON());
    expect(decisionContextEquals(context, roundTripped)).toBe(true);
    expect(roundTripped.facts[0]?.value).toBe(false);
    expect(roundTripped.facts[1]?.value).toBe(0);
    expect(roundTripped.objectives[0]?.weight).toBe(0);
  });

  it('keeps hard constraints structurally separate from weighted objectives', () => {
    const context = createDecisionContext(contextInput);

    expect(context.hardConstraints).toEqual([
      { id: 'https-only', description: 'Transport must use HTTPS.' },
    ]);
    expect(context.hardConstraints[0]).not.toHaveProperty('weight');
    expect(context.objectives[0]).toEqual({
      id: 'cost',
      description: 'Keep operating cost low.',
      weight: 0,
    });
  });

  it('deep-clones and freezes the validated context', () => {
    const context = createDecisionContext(contextInput);

    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.hardConstraints)).toBe(true);
    expect(Object.isFrozen(context.facts[2]?.value)).toBe(true);
    expect(Object.isFrozen(context.toJSON())).toBe(true);
  });

  it('treats entity collections as sets for semantic equality while preserving JSON order', () => {
    const reordered = {
      ...contextInput,
      hardConstraints: [...contextInput.hardConstraints].reverse(),
      objectives: [...contextInput.objectives].reverse(),
      outOfScope: [...contextInput.outOfScope].reverse(),
      facts: [...contextInput.facts].reverse(),
      unknowns: [...contextInput.unknowns].reverse(),
      alternatives: [...contextInput.alternatives].reverse(),
    };
    const original = createDecisionContext(contextInput);
    const other = createDecisionContext(reordered);

    expect(original.toJSON().alternatives[0]?.id).toBe('queue');
    expect(other.toJSON().alternatives[0]?.id).toBe('direct');
    expect(decisionContextEquals(original, other)).toBe(true);
  });

  it('rejects unknown fields and unsupported JSON values with stable typed errors', () => {
    expectValidationCode(
      () => DecisionContext.fromJSON({ ...contextInput, unexpected: true }),
      'UNKNOWN_FIELD',
    );
    expectValidationCode(
      () => DecisionContext.fromJSON({
        ...contextInput,
        facts: [{ id: 'bad', value: undefined }],
      }),
      'INVALID_JSON',
    );
    expectValidationCode(
      () => DecisionContext.fromJSON({ ...contextInput, version: 1 }),
      'UNSUPPORTED_VERSION',
    );
  });

  it('rejects duplicate IDs and duplicate out-of-scope values', () => {
    expectValidationCode(
      () => DecisionContext.fromJSON({
        ...contextInput,
        objectives: [
          ...contextInput.objectives,
          { id: 'cost', description: 'Duplicate.', weight: 1 },
        ],
      }),
      'DUPLICATE_ID',
    );
    expectValidationCode(
      () => DecisionContext.fromJSON({
        ...contextInput,
        facts: [{ id: 'queue', value: true }],
      }),
      'DUPLICATE_ID',
    );
    expectValidationCode(
      () => DecisionContext.fromJSON({
        ...contextInput,
        outOfScope: ['same', 'same'],
      }),
      'DUPLICATE_VALUE',
    );
  });

  it('rejects invalid IDs, descriptions, weights, and collection values', () => {
    expectValidationCode(
      () => DecisionContext.fromJSON({
        ...contextInput,
        objectives: [{ id: 'bad', description: 'Bad weight.', weight: -1 }],
      }),
      'INVALID_VALUE',
    );
    expectValidationCode(
      () => DecisionContext.fromJSON({
        ...contextInput,
        alternatives: [{ id: ' ', description: 'Blank id.' }],
      }),
      'INVALID_VALUE',
    );
    expectValidationCode(
      () => DecisionContext.fromJSON({
        ...contextInput,
        outOfScope: [false],
      }),
      'INVALID_TYPE',
    );
  });
});
