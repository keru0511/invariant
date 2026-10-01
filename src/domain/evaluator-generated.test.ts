import { expect, it } from 'vitest';
import { evaluate } from './evaluator';
import type { DomainCatalog } from './runtime';
import type { DomainExpression, DomainResultStatus } from './contract';

type Truth = boolean | null;

// Small reference semantics: no production evaluator/parser helpers are used.
function truth(node: DomainExpression, facts: Record<string, boolean>): Truth {
  switch (node.kind) {
    case 'literal': return node.value as boolean;
    case 'input': return Object.hasOwn(facts, node.path) ? facts[node.path] : null;
    case 'not': { const value = truth(node.operand, facts); return value === null ? null : !value; }
    case 'logical': {
      const values = node.operands.map((item) => truth(item, facts));
      if (node.operator === 'and') return values.includes(false) ? false : values.includes(null) ? null : true;
      return values.includes(true) ? true : values.includes(null) ? null : false;
    }
    default: throw new Error('This generated suite only uses Boolean expressions.');
  }
}
function reference(domain: DomainCatalog, facts: Record<string, boolean>): DomainResultStatus {
  const policy = domain.functions[0].policy;
  const possible = policy.rules.map((rule) => ({ rule, condition: truth(rule.when, facts) }))
    .filter((item) => item.condition !== false).sort((a, b) => b.rule.priority - a.rule.priority);
  if (!possible.length) return policy.defaultStatus;
  const selected = possible.filter((item) => item.rule.priority === possible[0].rule.priority);
  if (selected.some((item) => item.condition === null)) return 'unresolved';
  if (new Set(selected.map((item) => item.rule.then)).size > 1) return 'conflict';
  return selected.length > 1 ? 'ambiguous' : selected[0].rule.then;
}

it('matches independent three-valued semantics across 1000 reproducible generated policies', () => {
  let seed = 0x51a7e;
  const covered = new Set<DomainResultStatus>();
  const pick = (bound: number) => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) % bound;
  };
  for (let caseIndex = 0; caseIndex < 1000; caseIndex++) {
    let sequence = 0;
    const expression = (depth: number): DomainExpression => {
      const id = `node.${sequence++}`;
      const kind = depth === 0 ? pick(2) : pick(5);
      if (kind === 0) return { id, kind: 'literal', value: pick(2) === 1 };
      if (kind === 1) return { id, kind: 'input', path: ['x', 'y', 'z'][pick(3)] };
      if (kind === 2) return { id, kind: 'not', operand: expression(depth - 1) };
      return { id, kind: 'logical', operator: kind === 3 ? 'and' : 'or', operands: [expression(depth - 1), expression(depth - 1)] };
    };
    const domain: DomainCatalog = { contractVersion: 'domain-v0', kind: 'function-catalog', functions: [{
      id: 'function.generated', name: 'generated', description: 'Synthetic Boolean policy',
      inputs: ['x', 'y', 'z'].map((path) => ({ path, type: 'boolean', required: true })),
      policy: { id: 'policy.generated', defaultStatus: (['allow', 'deny', 'unresolved'] as const)[pick(3)],
        resolution: { priority: 'highest', unresolved: 'unresolved', conflict: 'conflict', ambiguous: 'ambiguous', noMatch: 'default' },
        rules: Array.from({ length: pick(6) }, (_, index) => ({ id: `rule.${index}`, priority: pick(4),
          when: expression(4), then: pick(2) === 0 ? 'allow' : 'deny' })),
      },
    }] };
    const facts: Record<string, boolean> = {};
    for (const key of ['x', 'y', 'z']) { const value = pick(3); if (value < 2) facts[key] = value === 1; }
    const expected = reference(domain, facts);
    covered.add(expected);
    const actual = evaluate(domain, 'generated', facts);
    expect(actual.status, `generated case ${caseIndex}`).toBe(expected);
    expect(actual.value).toBe(expected === 'allow' ? true : expected === 'deny' ? false : null);
    expect(evaluate(domain, 'generated', facts)).toEqual(actual);
  }
  expect([...covered].sort()).toEqual(['allow', 'ambiguous', 'conflict', 'deny', 'unresolved']);
}, 30_000);
