import { describe, expect, it } from 'vitest';
import { parseDomain, parseExpression } from './runtime';
import { evaluate } from './evaluator';
import catalog from '../../fixtures/domain-v0/functions.json';

describe('snapshot representation invariants', () => {
  it('detaches frozen rule data from caller-owned mutable objects', () => {
    const source = structuredClone(catalog);
    const parsed = parseDomain(source);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const before = evaluate(parsed.value, 'member-age', { user: { age: 20 } });
    source.functions[0].policy.rules.length = 0;
    expect(evaluate(parsed.value, 'member-age', { user: { age: 20 } })).toEqual(before);
    expect(Object.isFrozen(parsed.value.functions[0].policy.rules)).toBe(true);
  });

  it('preserves decisions through JSON persistence without class prototypes', () => {
    const parsed = parseDomain(catalog);
    if (!parsed.ok) throw new Error(parsed.error.message);
    for (const age of [0, 17, 18, 19, 120]) {
      const args = { user: { age } };
      expect(evaluate(JSON.parse(JSON.stringify(parsed.value)), 'member-age', args))
        .toEqual(evaluate(parsed.value, 'member-age', args));
    }
  });

  it('rejects excessively deep expressions instead of throwing a stack overflow', () => {
    let expression: unknown = { id: 'leaf', kind: 'literal', value: true };
    for (let i = 0; i < 10000; i++) expression = { id: `not-${i}`, kind: 'not', operand: expression };
    expect(() => parseExpression(expression)).not.toThrow();
    expect(parseExpression(expression)).toMatchObject({ ok: false });
  });
});
