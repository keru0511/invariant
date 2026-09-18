import { describe, expect, it } from 'vitest';
import accountUnresolvedMissingCountry from '../../fixtures/domain-v0/cases/account-unresolved-missing-country.json';
import functionCatalog from '../../fixtures/domain-v0/functions.json';
import { runTests, STORED_DOMAIN_EXAMPLES } from './test-runner';

describe('pure Domain example test runner', () => {
  it('runs every stored #23 example, including the threshold boundary', () => {
    const report = runTests(functionCatalog);

    expect(report.status).toBe('passed');
    expect(report.suiteStatus).toBe('tested');
    expect(report.total).toBe(STORED_DOMAIN_EXAMPLES.length);
    expect(report.passed).toBe(report.total);
    expect(report.failed).toBe(0);
    expect(report.examples.map((example) => example.exampleId)).toEqual(
      STORED_DOMAIN_EXAMPLES.map((example) => example.id),
    );
    expect(report.examples.map((example) => example.sourceId)).toEqual(
      STORED_DOMAIN_EXAMPLES.map((example) => example.functionId),
    );
    expect(report.examples.find((example) => example.exampleId.endsWith('member-age-boundary'))).toMatchObject({
      sourceId: 'function.domain-v0.member-age',
      sourcePath: 'cases/member-age-boundary.json',
      expected: { status: 'allow', value: true },
      actual: { status: 'allow', value: true },
      passed: true,
    });
  });

  it('compares resolved and unresolved states, not only nullable values', () => {
    const report = runTests(functionCatalog);
    const resolved = report.examples.find((example) => example.exampleId.endsWith('account-allow-active'));
    const unresolved = report.examples.find((example) => example.exampleId.endsWith('account-unresolved-missing-country'));

    expect(resolved).toMatchObject({
      expected: { status: 'allow', value: true },
      actual: { status: 'allow', value: true },
      passed: true,
    });
    expect(unresolved).toMatchObject({
      expected: { status: 'unresolved', value: null },
      actual: { status: 'unresolved', value: null },
      passed: true,
    });
  });

  it('fails an unchanged example when a production rule is mutated', () => {
    const mutated = JSON.parse(JSON.stringify(functionCatalog)) as typeof functionCatalog;
    const memberAge = mutated.functions.find((domainFunction) => domainFunction.name === 'member-age');
    const adultRule = memberAge?.policy.rules.find((rule) => rule.id.endsWith('allow-adult'));
    if (!adultRule) throw new Error('fixture rule not found');
    (adultRule.when as { operator?: string }).operator = 'gt';

    const report = runTests(mutated);
    const boundary = report.examples.find((example) => example.exampleId.endsWith('member-age-boundary'));

    expect(report.status).toBe('failed');
    expect(report.failed).toBeGreaterThan(0);
    expect(boundary).toMatchObject({
      exampleId: 'fixture.domain-v0.member-age-boundary',
      sourceId: 'function.domain-v0.member-age',
      expected: { status: 'allow', value: true },
      actual: { status: 'unresolved', value: null },
      passed: false,
    });
  });

  it('makes an empty suite explicit instead of reporting coverage', () => {
    const report = runTests(functionCatalog, []);

    expect(report).toEqual({
      status: 'empty',
      suiteStatus: 'empty',
      total: 0,
      passed: 0,
      failed: 0,
      examples: [],
    });
    expect(report).not.toHaveProperty('coverage');
  });

  it('is deterministic for identical domain and examples', () => {
    const first = runTests(functionCatalog);
    const second = runTests(functionCatalog);

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('keeps source IDs on failures and does not mutate the domain', () => {
    const domain = JSON.parse(JSON.stringify(functionCatalog)) as typeof functionCatalog;
    const before = JSON.stringify(domain);
    const report = runTests(domain, [accountUnresolvedMissingCountry as never]);

    expect(report.examples[0]).toMatchObject({
      exampleId: accountUnresolvedMissingCountry.id,
      sourceId: accountUnresolvedMissingCountry.functionId,
    });
    expect(JSON.stringify(domain)).toBe(before);
  });
});
