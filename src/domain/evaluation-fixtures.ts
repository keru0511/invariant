import exception from '../../fixtures/evaluation-v0/cases/exception.json';
import missingFact from '../../fixtures/evaluation-v0/cases/missing-fact.json';
import threshold from '../../fixtures/evaluation-v0/cases/threshold.json';
import longContextConstraint from '../../fixtures/evaluation-v0/cases/long-context-constraint.json';
import recommendationDrift from '../../fixtures/evaluation-v0/cases/recommendation-drift.json';
import type { EvaluationFixture } from './evaluation';

export const OFFLINE_EVALUATION_FIXTURES: readonly EvaluationFixture[] = [
  exception,
  missingFact,
  threshold,
  longContextConstraint,
  recommendationDrift,
] as unknown as readonly EvaluationFixture[];

export function fixtureById(id: string): EvaluationFixture {
  const fixture = OFFLINE_EVALUATION_FIXTURES.find((candidate) => candidate.id === id);
  if (fixture === undefined) throw new Error(`Unknown evaluation fixture: ${id}.`);
  return fixture;
}
