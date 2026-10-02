import { parseDomainModel } from './patch';
import { runTests } from './test-runner';

/** Coverage of a structurally and semantically validated proposal, not a truth score. */
export function assessProposalCoverage(baseInput: unknown, candidateInput: unknown) {
  const base = parseDomainModel(baseInput), candidate = parseDomainModel(candidateInput);
  if (!base.ok || !candidate.ok) throw new Error('Invalid model for proposal assessment.');
  if (runTests(candidate.value.domain, base.value.examples).status === 'failed') {
    throw new Error('Candidate contradicts stored expectations.');
  }
  const baselineIds = new Set(base.value.examples.map((example) => example.id));
  const coveredFunctions = new Set(base.value.examples.map((example) => example.functionId));
  return Object.freeze({ scope: 'validated_examples_only' as const,
    storedExampleCount: base.value.examples.length,
    proposedExampleCount: candidate.value.examples.filter((example) => !baselineIds.has(example.id)).length,
    storedExampleStatus: base.value.examples.length === 0 ? 'empty' as const : 'passed' as const,
    functionsWithoutStoredExamples: Object.freeze(candidate.value.domain.functions.filter((fn) => !coveredFunctions.has(fn.id)).map((fn) => fn.id)),
    limitations: Object.freeze([
      'Existing expectations are validated before and after the patch; a mismatch rejects the proposal.',
      'Stored examples are fixed for this comparison, not independently proven facts.',
      'Newly proposed examples are not independent evidence for the proposal that generated them.',
      'Passing examples do not prove correctness outside those examples or resolve recorded unknowns and conflicts.',
    ]),
  });
}
