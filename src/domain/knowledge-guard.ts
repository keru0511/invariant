import type { EvaluationResult } from './evaluator';
import type { DomainUnknown, DomainConflict } from './patch';

export interface KnowledgeIssues {
  readonly unknowns: readonly DomainUnknown[];
  readonly conflicts: readonly DomainConflict[];
}

/**
 * A deterministic guard over a validated, immutable snapshot. Free-text
 * subjects are not reliable dependency edges: an unresolved item therefore
 * blocks the whole version until a separately reviewed version resolves it.
 * No inference, state mutation, I/O, or claim of real-world truth occurs here.
 */
export function guardKnowledge(result: EvaluationResult, issues?: KnowledgeIssues): EvaluationResult {
  if (!issues || (issues.unknowns.length === 0 && issues.conflicts.length === 0)) return result;
  const status = result.status === 'error' || result.status === 'conflict' || result.status === 'ambiguous'
    ? result.status : issues.conflicts.length > 0 ? 'conflict' : 'unresolved';
  return Object.freeze({
    ...result, status, value: null,
    errors: Object.freeze([...result.errors, Object.freeze({
      code: 'DOMAIN_KNOWLEDGE_INCOMPLETE' as const,
      message: 'Stored domain has unresolved knowledge or conflicts. Do not assert a decision.',
    })]),
    trace: Object.freeze([...result.trace, Object.freeze({
      id: 'trace.domain-knowledge.guard', stage: 'policy' as const, outcome: status,
    })]),
  });
}
