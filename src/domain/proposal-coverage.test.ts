import { expect, it } from 'vitest';
import catalog from '../../fixtures/domain-v0/functions.json';
import example from '../../fixtures/domain-v0/cases/member-age-boundary.json';
import { assessProposalCoverage } from './proposal-coverage';
const model = (examples: unknown[] = [example]) => ({ contractVersion: 'domain-v0', kind: 'domain-model', version: 'v1',
  domain: structuredClone(catalog), types: [], examples, unknowns: [], conflicts: [] });
it('keeps an empty baseline explicit and does not turn generated examples into independent coverage', () => {
  const base = model([]), candidate = { ...model(), version: 'v2' };
  const result = assessProposalCoverage(base, candidate);
  expect(result.storedExampleStatus).toBe('empty');
  expect(result.storedExampleCount).toBe(0);
  expect(result.proposedExampleCount).toBe(1);
  expect(result.functionsWithoutStoredExamples).toContain(example.functionId);
});
it('refuses to describe a regressing model as validated', () => {
  const base = model(), candidate = model(); candidate.version = 'v2';
  candidate.domain.functions[0].policy.rules[0].then = 'deny';
  expect(() => assessProposalCoverage(base, candidate)).toThrow();
});
it('reports stored coverage without claiming the facts were independently established', () => {
  const result = assessProposalCoverage(model(), { ...model(), version: 'v2' });
  expect(result.storedExampleCount).toBe(1);
  expect(result.proposedExampleCount).toBe(0);
  expect(result.storedExampleStatus).toBe('passed');
  expect(result.functionsWithoutStoredExamples).not.toContain(example.functionId);
  expect(Object.isFrozen(result.functionsWithoutStoredExamples)).toBe(true);
});
it('rejects rewritten expected answers even if they agree with the modified candidate', () => {
  const base = model(), changed = structuredClone(example); changed.expected.value = false; changed.expected.status = 'deny';
  const candidate = model([changed]); candidate.domain.functions[0].policy.rules[0].then = 'deny';
  expect(() => assessProposalCoverage(base, candidate)).toThrow();
});
