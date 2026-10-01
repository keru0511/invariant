import { describe, expect, it } from 'vitest';
import { evaluate } from './evaluator';
import type { DomainExpression, DomainFunction } from './contract';

const states = [false, true, undefined] as const;
const input = (id: string, path: string): DomainExpression => ({ id, kind: 'input', path });
function model(when: DomainExpression, extraRules: DomainFunction['policy']['rules'] = []) {
  return { contractVersion: 'domain-v0', kind: 'function-catalog', functions: [{
    id: 'function.law', name: 'law', description: 'Synthetic truth-table contract',
    inputs: [{ path: 'x', type: 'boolean', required: true }, { path: 'y', type: 'boolean', required: true }],
    policy: { id: 'policy.law', defaultStatus: 'deny',
      resolution: { priority: 'highest', unresolved: 'unresolved', conflict: 'conflict', ambiguous: 'ambiguous', noMatch: 'default' },
      rules: [{ id: 'rule.primary', priority: 10, when, then: 'allow' }, ...extraRules],
    },
  }] };
}
function args(x: boolean | undefined, y: boolean | undefined) {
  return { ...(x === undefined ? {} : { x }), ...(y === undefined ? {} : { y }) };
}

// Independent, explicit three-valued truth tables (F, T, missing). Expected
// outputs are specification data, not captured evaluator output.
const tables = {
  and: [['deny', 'deny', 'deny'], ['deny', 'allow', 'unresolved'], ['deny', 'unresolved', 'unresolved']],
  or: [['deny', 'allow', 'unresolved'], ['allow', 'allow', 'allow'], ['unresolved', 'allow', 'unresolved']],
} as const;

describe('three-valued decision laws', () => {
  for (const operator of ['and', 'or'] as const) {
    it(`${operator}: all nine truth-table entries are stable under operand reordering`, () => {
      for (const [i, x] of states.entries()) for (const [j, y] of states.entries()) {
        const operands = [input('node.x', 'x'), input('node.y', 'y')];
        for (const ordered of [operands, [...operands].reverse()]) {
          const domain = model({ id: 'node.logical', kind: 'logical', operator, operands: ordered });
          const result = evaluate(domain, 'law', args(x, y));
          expect(result.status, JSON.stringify({ operator, i, j })).toBe(tables[operator][i][j]);
          expect(result.value).toBe(result.status === 'allow' ? true : result.status === 'deny' ? false : null);
        }
      }
    });
  }

  it('adding genuinely missing facts cannot reverse an already resolved decision', () => {
    const expressions: DomainExpression[] = [
      { id: 'and', kind: 'logical', operator: 'and', operands: [input('ax', 'x'), input('ay', 'y')] },
      { id: 'or', kind: 'logical', operator: 'or', operands: [input('ox', 'x'), input('oy', 'y')] },
      { id: 'not', kind: 'not', operand: input('nx', 'x') },
    ];
    for (const expression of expressions) {
      const domain = model(expression, [{ id: 'rule.exception', priority: 20, then: 'deny', when: input('exception.y', 'y') }]);
      for (const x of states) for (const y of states) {
        const partial = evaluate(domain, 'law', args(x, y));
        if (partial.status !== 'allow' && partial.status !== 'deny') continue;
        for (const fullX of x === undefined ? [false, true] : [x]) {
          for (const fullY of y === undefined ? [false, true] : [y]) {
            const completed = evaluate(domain, 'law', args(fullX, fullY));
            expect(completed.status, JSON.stringify({ expression: expression.id, x, y, fullX, fullY })).toBe(partial.status);
          }
        }
      }
    }
  });

  it('unknown higher-priority exceptions block a lower-priority positive answer', () => {
    const domain = model(input('x', 'x'), [{ id: 'rule.exception', priority: 20, then: 'deny', when: input('y', 'y') }]);
    const result = evaluate(domain, 'law', { x: true });
    expect(result.status).toBe('unresolved');
    expect(result.value).toBeNull();
    expect(result.unresolvedPaths).toEqual(['y']);
  });
});
