import { describe, expect, it } from 'vitest';
import { evaluate } from './evaluator';
import { guardKnowledge, type KnowledgeIssues } from './knowledge-guard';
import catalog from '../../fixtures/domain-v0/functions.json';

const unknowns: KnowledgeIssues = { unknowns: [{ id: 'u', kind: 'unknown', subject: 'scope', description: 'Not settled' }], conflicts: [] };
const conflicts: KnowledgeIssues = { unknowns: [], conflicts: [{ id: 'c', kind: 'conflict', subject: 'threshold', alternatives: ['18', '21'] }] };

describe('immutable knowledge guard', () => {
  it.each([20, 16])('withholds both allow and deny when knowledge is incomplete (%s)', (age) => {
    const original = evaluate(catalog, 'member-age', { user: { age } });
    const before = JSON.stringify(original);
    const result = guardKnowledge(original, unknowns);
    expect(result.status).toBe('unresolved');
    expect(result.value).toBeNull();
    expect(result.trace.at(-1)?.outcome).toBe('unresolved');
    expect(JSON.stringify(original)).toBe(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.errors)).toBe(true);
    expect(guardKnowledge(original, unknowns)).toEqual(result);
  });
  it('preserves validation errors and gives conflict precedence over missing knowledge', () => {
    const result = evaluate(catalog, 'member-age', { user: { age: 20 } });
    expect(guardKnowledge(result, { ...unknowns, conflicts: conflicts.conflicts }).status).toBe('conflict');
    const invalid = evaluate(catalog, 'member-age', { user: { age: '20' } });
    expect(guardKnowledge(invalid, conflicts).status).toBe('error');
    expect(guardKnowledge(invalid, conflicts).errors[0].code).toBe('TYPE_MISMATCH');
  });
  it('does not change a complete rule result or mistake legacy absence for proven truth', () => {
    const result = evaluate(catalog, 'member-age', { user: { age: 20 } });
    expect(guardKnowledge(result)).toBe(result);
    expect(guardKnowledge(result, { unknowns: [], conflicts: [] })).toBe(result);
  });
});
