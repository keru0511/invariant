import { describe, expect, it } from 'vitest';
import accountAllowActive from '../../fixtures/domain-v0/cases/account-allow-active.json';
import accountConflict from '../../fixtures/domain-v0/cases/account-conflict.json';
import accountAmbiguous from '../../fixtures/domain-v0/cases/account-ambiguous-multiple-allows.json';
import accountUnresolvedMissingCountry from '../../fixtures/domain-v0/cases/account-unresolved-missing-country.json';
import memberAgeBoundary from '../../fixtures/domain-v0/cases/member-age-boundary.json';
import memberAgeUnderage from '../../fixtures/domain-v0/cases/member-age-underage.json';
import refundDenyOverLimit from '../../fixtures/domain-v0/cases/refund-deny-over-limit.json';
import refundInvalidType from '../../fixtures/domain-v0/cases/refund-invalid-type.json';
import functionCatalog from '../../fixtures/domain-v0/functions.json';
import { evaluate } from './evaluator';

const cases = [
  memberAgeBoundary,
  memberAgeUnderage,
  refundDenyOverLimit,
  accountAllowActive,
  accountUnresolvedMissingCountry,
  accountConflict,
  accountAmbiguous,
  refundInvalidType,
] as const;

function comparableError(error: { readonly code: string; readonly path?: string; readonly nodeId?: string; readonly ruleIds?: readonly string[] }) {
  return {
    code: error.code,
    path: error.path,
    nodeId: error.nodeId,
    ruleIds: error.ruleIds,
  };
}

describe('pure Domain evaluator', () => {
  it.each(cases)('evaluates the $id fixture without collapsing status', (fixture) => {
    const actual = evaluate(functionCatalog, fixture.functionId.split('.').at(-1)!, fixture.input);
    expect(actual.status).toBe(fixture.expected.status);
    expect(actual.value).toBe(fixture.expected.value);
    expect(actual.matchedRuleIds).toEqual(fixture.expected.matchedRuleIds);
    expect(actual.unresolvedPaths).toEqual(fixture.expected.unresolvedPaths);
    expect(actual.errors.map(comparableError))
      .toEqual(fixture.expected.errors.map((item) => comparableError(item)));
  });

  it('keeps boundary and exception priority semantics explicit', () => {
    const boundary = evaluate(functionCatalog, 'member-age', memberAgeBoundary.input);
    const underage = evaluate(functionCatalog, 'member-age', memberAgeUnderage.input);
    const overLimit = evaluate(functionCatalog, 'refund', refundDenyOverLimit.input);

    expect(boundary.status).toBe('allow');
    expect(underage.status).toBe('deny');
    expect(overLimit.status).toBe('deny');
    expect(overLimit.matchedRuleIds).toEqual(['rule.domain-v0.refund.deny-over-limit-or-refunded']);
  });

  it('returns conflict instead of choosing one same-priority decision', () => {
    const actual = evaluate(functionCatalog, 'account-review', accountConflict.input);
    expect(actual.status).toBe('conflict');
    expect(actual.value).toBeNull();
    expect(actual.errors).toEqual([expect.objectContaining({ code: 'RULE_CONFLICT' })]);
    expect(actual.matchedRuleIds).toEqual([
      'rule.domain-v0.account-review.deny-high-risk',
      'rule.domain-v0.account-review.allow-trusted-country',
    ]);
  });

  it('keeps same-priority same-decision matches explicitly ambiguous', () => {
    const actual = evaluate(functionCatalog, 'account-review', accountAmbiguous.input);
    expect(actual.status).toBe(accountAmbiguous.expected.status);
    expect(actual.status).not.toBe('unresolved');
    expect(actual.status).not.toBe('conflict');
    expect(actual.status).not.toBe('error');
    expect(actual.value).toBeNull();
    expect(actual.matchedRuleIds).toEqual(accountAmbiguous.expected.matchedRuleIds);
    expect(actual.errors.map(comparableError))
      .toEqual(accountAmbiguous.expected.errors.map((item) => comparableError(item)));
    expect(actual.trace.at(-1)).toEqual(expect.objectContaining({
      stage: 'policy',
      outcome: 'ambiguous',
    }));
  });

  it('keeps missing facts unresolved and records their provenance', () => {
    const actual = evaluate(functionCatalog, 'account-review', accountUnresolvedMissingCountry.input);
    expect(actual.status).toBe('unresolved');
    expect(actual.value).toBeNull();
    expect(actual.unresolvedPaths).toEqual(['account.country']);
    expect(actual.errors[0]).toEqual(expect.objectContaining({
      code: 'MISSING_INPUT',
      path: 'account.country',
    }));
    expect(actual.provenance.inputPaths).toEqual(['account.state', 'account.riskScore', 'account.country']);
  });

  it('returns stable trace and semantic output for repeated identical calls', () => {
    const first = evaluate(functionCatalog, 'account-review', accountAllowActive.input);
    const second = evaluate(functionCatalog, 'account-review', accountAllowActive.input);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.trace.length).toBeGreaterThan(0);
    expect(first.trace.every((item) => item.id.startsWith('trace.function.domain-v0.account-review.'))).toBe(true);
  });

  it('reports invalid function names and argument shapes explicitly', () => {
    const missingFunction = evaluate(functionCatalog, 'does-not-exist', {});
    const wrongType = evaluate(functionCatalog, 'refund', refundInvalidType.input);
    const extraArgument = evaluate(functionCatalog, 'member-age', { user: { age: 18, region: 'US' } });
    const scalarArguments = evaluate(functionCatalog, 'member-age', 18);

    expect(missingFunction).toEqual(expect.objectContaining({
      status: 'error',
      value: null,
      errors: [expect.objectContaining({ code: 'INVALID_FUNCTION' })],
    }));
    expect(wrongType.errors[0]).toEqual(expect.objectContaining({ code: 'TYPE_MISMATCH', path: 'order.total' }));
    expect(extraArgument.errors[0]).toEqual(expect.objectContaining({ code: 'INVALID_ARGS', path: 'user.region' }));
    expect(scalarArguments.errors[0]).toEqual(expect.objectContaining({ code: 'INVALID_ARGS', path: '$' }));
  });

  it('detects cyclic arguments without traversing forever', () => {
    const args: { user?: { age?: number; self?: unknown } } = { user: { age: 18 } };
    args.user!.self = args.user;
    const actual = evaluate(functionCatalog, 'member-age', args);
    expect(actual.status).toBe('error');
    expect(actual.errors[0]).toEqual(expect.objectContaining({ code: 'CYCLE_DETECTED', path: 'user.self' }));
  });

  it('never mutates caller-owned domain or arguments', () => {
    const domain = JSON.parse(JSON.stringify(functionCatalog)) as typeof functionCatalog;
    const args = JSON.parse(JSON.stringify(memberAgeBoundary.input));
    const beforeDomain = JSON.stringify(domain);
    const beforeArgs = JSON.stringify(args);
    evaluate(domain, 'member-age', args);
    expect(JSON.stringify(domain)).toBe(beforeDomain);
    expect(JSON.stringify(args)).toBe(beforeArgs);
  });
});
