/**
 * Pure regression execution for the stored Domain v0 examples.
 *
 * The examples are compile-time Domain Core fixtures. Running them never
 * reads storage, calls a provider, or bypasses the production evaluator.
 */

import accountAllowActive from '../../fixtures/domain-v0/cases/account-allow-active.json';
import accountConflict from '../../fixtures/domain-v0/cases/account-conflict.json';
import accountUnresolvedMissingCountry from '../../fixtures/domain-v0/cases/account-unresolved-missing-country.json';
import memberAgeBoundary from '../../fixtures/domain-v0/cases/member-age-boundary.json';
import memberAgeUnderage from '../../fixtures/domain-v0/cases/member-age-underage.json';
import refundDenyOverLimit from '../../fixtures/domain-v0/cases/refund-deny-over-limit.json';
import refundInvalidType from '../../fixtures/domain-v0/cases/refund-invalid-type.json';
import fixtureManifest from '../../fixtures/domain-v0/manifest.json';
import type {
  DomainError,
  DomainExpectedResult,
  DomainGoldenFixture,
} from './contract';
import { evaluate, type EvaluationError, type EvaluationResult } from './evaluator';
import type { Domain } from './runtime';

export const STORED_DOMAIN_EXAMPLES: readonly DomainGoldenFixture[] = Object.freeze([
  memberAgeBoundary,
  memberAgeUnderage,
  refundDenyOverLimit,
  accountAllowActive,
  accountUnresolvedMissingCountry,
  accountConflict,
  refundInvalidType,
] as unknown as DomainGoldenFixture[]);

export type DomainTestSuiteStatus = 'tested' | 'empty';
export type DomainTestStatus = 'passed' | 'failed' | 'empty';

export interface DomainExampleTestResult {
  /** The stable #23 golden fixture ID. */
  readonly exampleId: string;
  /** The stable domain function ID that is the example's source. */
  readonly sourceId: string;
  /** The manifest path that supplied the example. */
  readonly sourcePath: string;
  /** Alias for the source fixture identity in the #23 vocabulary. */
  readonly fixtureId: string;
  readonly functionId: string;
  readonly expected: DomainExpectedResult;
  readonly actual: EvaluationResult;
  readonly passed: boolean;
}

export interface DomainTestReport {
  /** `empty` is an explicit suite state; it is not test coverage. */
  readonly status: DomainTestStatus;
  readonly suiteStatus: DomainTestSuiteStatus;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly examples: readonly DomainExampleTestResult[];
}

function functionName(functionId: string): string {
  return functionId.split('.').at(-1) ?? '';
}

function comparableError(error: DomainError | EvaluationError) {
  return {
    code: error.code,
    message: error.message,
    path: error.path,
    nodeId: error.nodeId,
    ruleIds: error.ruleIds,
  };
}

/**
 * Compare the stable semantic contract. Trace and provenance are retained in
 * each report entry but are intentionally not compared: direct production
 * evaluation has its own deterministic trace IDs and the `evaluation`
 * provenance sentinel, while a golden example carries its source identity.
 */
function matchesExpected(expected: DomainExpectedResult, actual: EvaluationResult): boolean {
  return JSON.stringify({
    status: expected.status,
    value: expected.value,
    matchedRuleIds: expected.matchedRuleIds,
    unresolvedPaths: expected.unresolvedPaths,
    errors: expected.errors.map(comparableError),
  }) === JSON.stringify({
    status: actual.status,
    value: actual.value,
    matchedRuleIds: actual.matchedRuleIds,
    unresolvedPaths: actual.unresolvedPaths,
    errors: actual.errors.map(comparableError),
  });
}

function sourcePathById(exampleId: string): string {
  return fixtureManifest.fixtures.find((fixture) => fixture.id === exampleId)?.path ?? '';
}

/**
 * Execute stored #23 examples through the production `evaluate` function.
 *
 * The optional examples argument exists only to make an empty suite a
 * first-class, testable state; the normal call is `runTests(domain)`.
 */
export function runTests(
  domain: Domain | unknown,
  examples: readonly DomainGoldenFixture[] = STORED_DOMAIN_EXAMPLES,
): DomainTestReport {
  const reports = examples.map((example): DomainExampleTestResult => {
    const actual = evaluate(domain, functionName(example.functionId), example.input);
    return Object.freeze({
      exampleId: example.id,
      sourceId: example.functionId,
      sourcePath: sourcePathById(example.id),
      fixtureId: example.id,
      functionId: example.functionId,
      expected: example.expected,
      actual,
      passed: matchesExpected(example.expected, actual),
    });
  });
  const passed = reports.filter((report) => report.passed).length;
  const total = reports.length;
  return Object.freeze({
    status: total === 0 ? 'empty' : passed === total ? 'passed' : 'failed',
    suiteStatus: total === 0 ? 'empty' : 'tested',
    total,
    passed,
    failed: total - passed,
    examples: Object.freeze(reports),
  });
}
