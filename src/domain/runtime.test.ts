import { describe, expect, it } from 'vitest';
import accountAllowActive from '../../fixtures/domain-v0/cases/account-allow-active.json';
import accountConflict from '../../fixtures/domain-v0/cases/account-conflict.json';
import accountUnresolvedMissingCountry from '../../fixtures/domain-v0/cases/account-unresolved-missing-country.json';
import memberAgeBoundary from '../../fixtures/domain-v0/cases/member-age-boundary.json';
import memberAgeUnderage from '../../fixtures/domain-v0/cases/member-age-underage.json';
import refundDenyOverLimit from '../../fixtures/domain-v0/cases/refund-deny-over-limit.json';
import refundInvalidType from '../../fixtures/domain-v0/cases/refund-invalid-type.json';
import functionCatalog from '../../fixtures/domain-v0/functions.json';
import fixtureManifest from '../../fixtures/domain-v0/manifest.json';
import {
  parseDomain,
  parseFixtureManifest,
  parseFunction,
  parseGoldenFixture,
  parseExpression,
  type DomainParseResult,
} from './runtime';

const fixtures = [
  memberAgeBoundary,
  memberAgeUnderage,
  refundDenyOverLimit,
  accountAllowActive,
  accountUnresolvedMissingCountry,
  accountConflict,
  refundInvalidType,
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectError<T>(
  result: DomainParseResult<T>,
  code: string,
  path: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(code);
  expect(result.error.path).toBe(path);
  expect(result.error.message).toBeTypeOf('string');
}

describe('Domain v0 runtime validation', () => {
  it('parses the #23 catalog, functions, manifest, and every golden fixture', () => {
    const catalog = parseDomain(functionCatalog);
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    expect(catalog.value.functions).toHaveLength(3);
    expect(catalog.value.functions.every((item) => Object.isFrozen(item))).toBe(true);

    const manifest = parseFixtureManifest(fixtureManifest);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    expect(manifest.value.fixtures).toHaveLength(fixtures.length);

    for (const source of catalog.value.functions) {
      const parsed = parseFunction(source);
      expect(parsed.ok).toBe(true);
    }
    for (const fixture of fixtures) {
      const parsed = parseGoldenFixture(fixture);
      expect(parsed.ok).toBe(true);
    }
  });

  it('preserves semantic data through JSON round-trip', () => {
    const domain = parseDomain(functionCatalog);
    expect(domain.ok).toBe(true);
    if (!domain.ok) return;
    const roundTrip = parseDomain(JSON.parse(JSON.stringify(domain.value)));
    expect(roundTrip.ok).toBe(true);
    if (!roundTrip.ok) return;
    expect(roundTrip.value).toEqual(domain.value);

    for (const fixture of fixtures) {
      const parsed = parseGoldenFixture(fixture);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      const reparsed = parseGoldenFixture(JSON.parse(JSON.stringify(parsed.value)));
      expect(reparsed.ok).toBe(true);
      if (reparsed.ok) expect(reparsed.value).toEqual(parsed.value);
    }
  });

  it('returns immutable canonical values rather than retaining input objects', () => {
    const source = clone(functionCatalog);
    const parsed = parseDomain(source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.isFrozen(parsed.value)).toBe(true);
    expect(Object.isFrozen(parsed.value.functions)).toBe(true);
    expect(Object.isFrozen(parsed.value.functions[0].policy.rules[0].when)).toBe(true);
    expect(parsed.value).not.toBe(source);
  });

  it('rejects missing fields, invalid discriminators, and unsupported versions', () => {
    const missingVersion = clone(functionCatalog) as Record<string, unknown>;
    delete missingVersion.contractVersion;
    expectError(parseDomain(missingVersion), 'MISSING_FIELD', 'contractVersion');

    const invalidKind = clone(functionCatalog) as Record<string, unknown>;
    invalidKind.kind = 'not-a-catalog';
    expectError(parseDomain(invalidKind), 'INVALID_DISCRIMINATOR', 'kind');

    const invalidVersion = clone(functionCatalog) as Record<string, unknown>;
    invalidVersion.contractVersion = 'domain-v9';
    expectError(parseDomain(invalidVersion), 'UNSUPPORTED_VERSION', 'contractVersion');

    const missingFunctionId = clone(functionCatalog) as {
      functions: Array<Record<string, unknown>>;
    };
    delete missingFunctionId.functions[0].id;
    expectError(parseDomain(missingFunctionId), 'MISSING_FIELD', 'functions[0].id');
  });

  it('rejects unsupported operators and malformed logical nodes', () => {
    const invalidOperator = clone(functionCatalog) as {
      functions: Array<{ policy: { rules: Array<{ when: Record<string, unknown> }> } }>;
    };
    invalidOperator.functions[0].policy.rules[0].when.operator = 'xor';
    expectError(
      parseDomain(invalidOperator),
      'UNSUPPORTED_OPERATOR',
      'functions[0].policy.rules[0].when.operator',
    );

    const invalidKind = clone(functionCatalog) as {
      functions: Array<{ policy: { rules: Array<{ when: Record<string, unknown> }> } }>;
    };
    invalidKind.functions[0].policy.rules[0].when.kind = 'call';
    expectError(
      parseDomain(invalidKind),
      'INVALID_DISCRIMINATOR',
      'functions[0].policy.rules[0].when.kind',
    );

    const standaloneLogical = {
      id: 'node.test.logical',
      kind: 'logical',
      operator: 'and',
      operands: [],
    };
    expectError(parseExpression(standaloneLogical), 'INVALID_VALUE', 'operands');
  });

  it('rejects invalid references, duplicate identifiers, and incompatible operands', () => {
    const invalidReference = clone(functionCatalog) as {
      functions: Array<{
        policy: {
          rules: Array<{
            when: { left: { path: string } };
          }>;
        };
      }>;
    };
    invalidReference.functions[0].policy.rules[0].when.left.path = 'user.missing';
    expectError(
      parseDomain(invalidReference),
      'INVALID_REFERENCE',
      'functions[0].policy.rules[0].when.left.path',
    );

    const duplicateInput = clone(functionCatalog) as {
      functions: Array<{
        inputs: Array<Record<string, unknown>>;
      }>;
    };
    duplicateInput.functions[0].inputs.push(clone(duplicateInput.functions[0].inputs[0]));
    expectError(
      parseDomain(duplicateInput),
      'DUPLICATE_ID',
      'functions[0].inputs[1].path',
    );

    const mismatchedOperands = {
      id: 'node.test.compare',
      kind: 'compare',
      operator: 'lt',
      left: { id: 'node.test.left', kind: 'literal', value: '18' },
      right: { id: 'node.test.right', kind: 'literal', value: 18 },
    };
    expectError(parseExpression(mismatchedOperands), 'TYPE_MISMATCH', 'operator');
  });

  it('keeps allow, deny, unresolved, conflict, and error semantically distinct', () => {
    const statuses = new Set(
      fixtures.map((fixture) => {
        const parsed = parseGoldenFixture(fixture);
        expect(parsed.ok).toBe(true);
        return parsed.ok ? parsed.value.expected.status : 'parse-error';
      }),
    );
    expect([...statuses]).toEqual(
      expect.arrayContaining(['allow', 'deny', 'unresolved', 'conflict', 'error']),
    );
    expect(statuses.size).toBe(5);
  });

  it('rejects non-JSON runtime values and preserves provenance/result structure', () => {
    const invalidObserved = clone(memberAgeBoundary) as {
      expected: { trace: Array<Record<string, unknown>> };
    };
    invalidObserved.expected.trace[0].observed = undefined;
    expectError(
      parseGoldenFixture(invalidObserved),
      'INVALID_VALUE',
      'expected.trace[0].observed',
    );

    const parsed = parseGoldenFixture(accountConflict);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.expected.provenance.fixtureId).toBe(accountConflict.id);
    expect(parsed.value.expected.errors[0].code).toBe('RULE_CONFLICT');
    expect(parsed.value.expected.value).toBeNull();
  });

});
